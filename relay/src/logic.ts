// Pure relay logic: routing, validation, header filtering, limits, hashing. No Workers APIs, so Node's test
// runner can import it directly (relay/test/logic.test.ts). The Worker and Durable Object live in index.ts.

import {
  ID_RE,
  MAX_BODY_BYTES,
  MAX_RESPONSE_BYTES,
  RELAY_PROTOCOL,
  REQUEST_HEADERS,
  REQUEST_TIMEOUT_MS,
  RESPONSE_HEADERS,
  SECRET_RE,
  type AgentHello,
  type RelayRejected,
  type RelayResponse,
} from "../../shared/relay.ts";

/** Requests per student per minute before 429; protects the shared free-plan quota (100k requests/day). */
export const RATE_LIMIT_PER_MINUTE = 120;
export const RATE_WINDOW_MS = 60_000;
/** An agent socket that hasn't sent a valid hello by then is rejected. */
export const HELLO_TIMEOUT_MS = 10_000;

export type Route =
  | { kind: "health" }
  | { kind: "agent"; id: string }
  | { kind: "mcp"; id: string; /** "/<rest>" plus the query string, as forwarded in RelayRequest.path. */ path: string }
  | { kind: "not-found" };

/** Maps a request to a route. `pathname` is the raw (still percent-encoded) URL path; `search` includes "?". */
export function route(method: string, pathname: string, search: string): Route {
  if (pathname === "/") return method === "GET" || method === "HEAD" ? { kind: "health" } : { kind: "not-found" };
  const agent = /^\/agent\/([^/]+)$/.exec(pathname);
  if (agent) {
    const id = agent[1]!;
    return method === "GET" && ID_RE.test(id) ? { kind: "agent", id } : { kind: "not-found" };
  }
  const mcp = /^\/mcp\/([^/]+)(\/.*)$/.exec(pathname);
  if (mcp) {
    const id = mcp[1]!;
    return ID_RE.test(id) ? { kind: "mcp", id, path: mcp[2]! + search } : { kind: "not-found" };
  }
  return { kind: "not-found" };
}

/** Keeps only the allow-listed headers, with lower-case names. */
export function filterHeaders(
  headers: Iterable<[string, string]> | Record<string, unknown>,
  allow: readonly string[],
): Record<string, string> {
  const entries: Iterable<[string, unknown]> =
    Symbol.iterator in headers ? (headers as Iterable<[string, string]>) : Object.entries(headers);
  const out: Record<string, string> = {};
  for (const [name, value] of entries) {
    const key = name.toLowerCase();
    if (typeof value === "string" && allow.includes(key)) out[key] = value;
  }
  return out;
}

export const requestHeaders = (h: Iterable<[string, string]>) => filterHeaders(h, REQUEST_HEADERS);
export const responseHeaders = (h: Record<string, unknown>) => filterHeaders(h, RESPONSE_HEADERS);

/** True when a declared Content-Length is already over the limit. Missing/invalid → false (the read is capped anyway). */
export function contentLengthTooLarge(value: string | null, max = MAX_BODY_BYTES): boolean {
  if (value === null || !/^\d+$/.test(value.trim())) return false;
  return Number(value.trim()) > max;
}

/** Reads a body stream, stopping as soon as it exceeds `max` bytes (→ null). */
export async function readCapped(stream: ReadableStream<Uint8Array> | null, max = MAX_BODY_BYTES): Promise<Uint8Array | null> {
  if (!stream) return new Uint8Array(0);
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const step = 0x8000;
  for (let i = 0; i < bytes.length; i += step) bin += String.fromCharCode(...bytes.subarray(i, i + step));
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Upper bound of the decoded size of a base64 string, to refuse huge responses before decoding them. */
export const base64DecodedLength = (b64: string) => Math.floor((b64.length * 3) / 4);

export type HelloResult = { ok: true; hello: AgentHello } | { ok: false; reason: RelayRejected["reason"] };

/** Validates the first message of an agent socket. */
export function parseHello(data: string | ArrayBuffer): HelloResult {
  if (typeof data !== "string") return { ok: false, reason: "bad-hello" };
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return { ok: false, reason: "bad-hello" };
  }
  if (!isObject(msg) || msg.type !== "hello") return { ok: false, reason: "bad-hello" };
  if (msg.v !== RELAY_PROTOCOL) return { ok: false, reason: "protocol" };
  if (typeof msg.secret !== "string" || !SECRET_RE.test(msg.secret)) return { ok: false, reason: "bad-hello" };
  const agent = typeof msg.agent === "string" ? msg.agent.slice(0, 64) : "";
  return { ok: true, hello: { type: "hello", v: RELAY_PROTOCOL, secret: msg.secret, agent } };
}

/** Validates a RelayResponse from an authenticated agent; anything else → null (ignored). */
export function parseResponse(data: string | ArrayBuffer): RelayResponse | null {
  if (typeof data !== "string") return null;
  let msg: unknown;
  try {
    msg = JSON.parse(data);
  } catch {
    return null;
  }
  if (!isObject(msg) || msg.type !== "response" || typeof msg.rid !== "string") return null;
  if (typeof msg.status !== "number" || !Number.isInteger(msg.status) || msg.status < 200 || msg.status > 599) return null;
  if (!isObject(msg.headers)) return null;
  if (msg.body !== undefined && typeof msg.body !== "string") return null;
  return {
    type: "response",
    rid: msg.rid,
    status: msg.status,
    headers: responseHeaders(msg.headers),
    ...(msg.body ? { body: msg.body } : {}),
  };
}

/** Decodes a response body, or null when it is not valid base64 or over the response cap. */
export function decodeResponseBody(b64: string | undefined, max = MAX_RESPONSE_BYTES): Uint8Array | null {
  if (!b64) return new Uint8Array(0);
  if (base64DecodedLength(b64) > max + 2) return null;
  let bytes: Uint8Array;
  try {
    bytes = base64ToBytes(b64);
  } catch {
    return null;
  }
  return bytes.byteLength > max ? null : bytes;
}

/**
 * The HTTP response for the AI client, or null when the agent's status/headers can't make one (e.g. a
 * header value with a newline or a non-Latin-1 character makes `new Response` throw). Never throws.
 */
export function agentHttpResponse(res: RelayResponse, body: Uint8Array): Response | null {
  const nullBody = res.status === 204 || res.status === 205 || res.status === 304;
  try {
    return new Response(nullBody ? null : (body as Uint8Array<ArrayBuffer>), { status: res.status, headers: res.headers });
  } catch {
    return null;
  }
}

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time comparison for equal-length strings (the hex hashes always are). */
export function timingSafeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) diff |= (a.charCodeAt(i) | 0) ^ (b.charCodeAt(i) | 0);
  return diff === 0;
}

/** Fixed-window counter. Mutates and returns whether this request is allowed. */
export interface RateWindow {
  start: number;
  count: number;
}
export function rateAllow(w: RateWindow, now: number, limit = RATE_LIMIT_PER_MINUTE, windowMs = RATE_WINDOW_MS): boolean {
  if (now - w.start >= windowMs) {
    w.start = now;
    w.count = 0;
  }
  if (w.count >= limit) return false;
  w.count++;
  return true;
}

/** The request timeout: the contract value, or a lower one from a test-only var (never higher, never below 1 s). */
export function requestTimeout(override: string | undefined): number {
  const n = Number(override);
  if (!override || !Number.isFinite(n)) return REQUEST_TIMEOUT_MS;
  return Math.min(REQUEST_TIMEOUT_MS, Math.max(1_000, Math.floor(n)));
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}
