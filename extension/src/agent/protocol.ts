import {
  ID_RE,
  MAX_RESPONSE_BYTES,
  REQUEST_HEADERS,
  RESPONSE_HEADERS,
  SECRET_RE,
  TOKEN_RE,
  type RelayMessage,
  type RelayRequest,
  type RelayResponse,
} from "../../../shared/relay.ts";

// Pure pieces of the agent (no chrome APIs; server/test imports them): identity generation, the
// token check, relay message parsing, header filtering, base64 and the reconnect backoff.

export interface AgentIdentity {
  /** 22 chars base64url; names the student's Durable Object on the relay (public, in the URL). */
  id: string;
  /** 43 chars base64url; proves to the relay that this extension owns `id`. Never leaves the hello. */
  secret: string;
  /** 22 chars base64url; secret path segment of the connector URL, checked here. Rotatable. */
  token: string;
}

export function randomB64url(bytes: number, getRandomValues = (a: Uint8Array) => crypto.getRandomValues(a)): string {
  const a = getRandomValues(new Uint8Array(bytes));
  return toBase64(a).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** 16 bytes → 22 chars (id, token); 32 bytes → 43 chars (secret). */
export const newToken = () => randomB64url(16);
export const newIdentity = (): AgentIdentity => ({ id: randomB64url(16), secret: randomB64url(32), token: newToken() });

export function isValidIdentity(x: unknown): x is AgentIdentity {
  const i = x as Partial<AgentIdentity> | null;
  return !!i && typeof i === "object" && ID_RE.test(i.id ?? "") && SECRET_RE.test(i.secret ?? "") && TOKEN_RE.test(i.token ?? "");
}

/** Constant-time string comparison (time depends only on the length of `expected`). */
export function safeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  for (let i = 0; i < expected.length; i++) diff |= (actual.charCodeAt(i) | 0) ^ expected.charCodeAt(i);
  return diff === 0;
}

/**
 * Does a relayed path (`/<token>`, `/<token>/…`, optionally with `?query`) carry our token?
 * The relay forwards everything after /mcp/<id> without checking it; the agent answers 404 otherwise.
 */
export function pathHasToken(path: string, token: string): boolean {
  const pathname = path.split(/[?#]/, 1)[0]!;
  if (!pathname.startsWith("/")) return false;
  const seg = pathname.slice(1).split("/", 1)[0]!;
  return safeEqual(seg, token);
}

/** Parses a relay frame; null for anything malformed (ignored by the agent). */
export function parseRelayMessage(data: unknown): RelayMessage | null {
  if (typeof data !== "string") return null;
  let m: unknown;
  try {
    m = JSON.parse(data);
  } catch {
    return null;
  }
  if (!m || typeof m !== "object") return null;
  const o = m as Record<string, unknown>;
  switch (o.type) {
    case "welcome":
      return typeof o.v === "number" ? (o as unknown as RelayMessage) : null;
    case "rejected":
      return typeof o.reason === "string" ? (o as unknown as RelayMessage) : null;
    case "request": {
      if (typeof o.rid !== "string" || typeof o.method !== "string" || typeof o.path !== "string") return null;
      if (o.body !== undefined && typeof o.body !== "string") return null;
      const headers: Record<string, string> = {};
      if (o.headers && typeof o.headers === "object") {
        for (const [k, v] of Object.entries(o.headers as Record<string, unknown>)) if (typeof v === "string") headers[k] = v;
      }
      return { type: "request", rid: o.rid, method: o.method, path: o.path, headers, body: o.body as string | undefined };
    }
    default:
      return null;
  }
}

/** Keeps only allow-listed headers, with lower-case names. */
export function filterHeaders(h: Record<string, string> | Headers, allow: readonly string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const entries = h instanceof Headers ? [...h.entries()] : Object.entries(h);
  for (const [k, v] of entries) {
    const name = k.toLowerCase();
    if (allow.includes(name)) out[name] = v;
  }
  return out;
}

/** Reconnect delay: exponential from 1 s to 60 s, with ±25 % jitter. `attempt` starts at 0. */
export function backoffMs(attempt: number, random = Math.random): number {
  const base = Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(attempt, 16)));
  return Math.round(base * (0.75 + random() * 0.5));
}

export function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

export function fromBase64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const jsonError = (rid: string, status: number, message: string): RelayResponse => ({
  type: "response",
  rid,
  status,
  headers: { "content-type": "application/json" },
  body: toBase64(new TextEncoder().encode(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32000, message } }))),
});

/** A handler that answers one HTTP request (in the extension: a fresh stateless MCP server). */
export type RequestHandler = (req: Request) => Promise<Response>;

/**
 * Turns one RelayRequest into a RelayResponse: token check (404), method check (only POST: a
 * stateless server has no GET stream or session to DELETE), header allow-lists both ways, and the
 * response size limit. Never throws.
 */
export async function answer(msg: RelayRequest, token: string, handler: RequestHandler): Promise<RelayResponse> {
  const plain = (status: number, text: string, extra: Record<string, string> = {}): RelayResponse => ({
    type: "response",
    rid: msg.rid,
    status,
    headers: { "content-type": "text/plain; charset=utf-8", ...extra },
    body: toBase64(new TextEncoder().encode(text)),
  });
  if (!pathHasToken(msg.path, token)) return plain(404, "Not found");
  if (msg.method !== "POST") return plain(405, "Method not allowed", { allow: "POST" });
  try {
    const req = new Request("http://agent.invalid/mcp", {
      method: "POST",
      headers: filterHeaders(msg.headers, REQUEST_HEADERS),
      body: msg.body ? (fromBase64(msg.body) as Uint8Array<ArrayBuffer>) : undefined,
    });
    const res = await handler(req);
    const body = new Uint8Array(await res.arrayBuffer());
    if (body.byteLength > MAX_RESPONSE_BYTES) return jsonError(msg.rid, 502, "Response too large");
    return {
      type: "response",
      rid: msg.rid,
      status: res.status,
      headers: filterHeaders(res.headers, RESPONSE_HEADERS),
      ...(body.byteLength ? { body: toBase64(body) } : {}),
    };
  } catch (err) {
    return jsonError(msg.rid, 500, `Internal error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

/** 503 used when MAX_INFLIGHT requests are already running. */
export const busyResponse = (rid: string): RelayResponse => jsonError(rid, 503, "Too many requests in flight; try again.");
