import { randomBytes } from "node:crypto";
import { request, type IncomingHttpHeaders } from "node:http";
import type { ProviderEvent, ProviderSession, TunnelProvider } from "./provider.ts";

// Tunnelmole (https://tunnelmole.com, MIT client) speaks a small JSON protocol over a websocket:
//   -> {type:"initialise", clientId, connectionInfo}
//   <- {type:"hostnameAssigned", hostname}                       public URL https://<hostname>
//   <- {type:"forwardedRequest", requestId, url, method, headers, body(base64)}
//   -> {type:"forwardedResponse", requestId, url, statusCode, headers, body(base64)}
// We implement it with Node's built-in WebSocket instead of bundling the npm client, which calls
// process.exit() on server messages, prints to stdout (the MCP channel), stores state in
// ~/.tmole.sh, sends telemetry by default, and forwards hop-by-hop headers verbatim: a chunked
// local response then reaches nginx with the body already de-chunked and comes back as 502.
// Its service listens on port 8083 only (443 refuses the upgrade), so it can't pass campus Wi-Fi.

export const TUNNELMOLE_ENDPOINT = "wss://service.tunnelmole.com:8083";
const CLIENT_VERSION = "2.4.3"; // protocol version we mirror
const LOCAL_TIMEOUT_MS = 120_000;
/** Concurrent forwarded requests; beyond this the reply is 503 (web AIs make a few at a time). */
const MAX_INFLIGHT = 16;
/** Base64 request bodies above this are refused before decoding (remote.ts caps MCP bodies far lower). */
const MAX_BODY_B64 = 8 * 1024 * 1024;

/** Headers that describe one hop and must not be copied onto the forwarded response. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length"]);

export function forwardableHeaders(headers: IncomingHttpHeaders, bodyLength: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
  out["content-length"] = String(bodyLength);
  return out;
}

/**
 * Request headers safe to send to the local endpoint. Hop-by-hop and framing headers from the
 * remote side are dropped and content-length is set from the decoded body: forwarding them
 * verbatim on a keep-alive socket let a lying content-length smuggle a second request.
 */
export function requestHeaders(headers: unknown, bodyLength: number, host: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (headers && typeof headers === "object")
    for (const [k, v] of Object.entries(headers as Record<string, unknown>)) {
      const key = k.toLowerCase();
      if (HOP_BY_HOP.has(key) || key === "host" || key === "expect") continue;
      if (typeof v === "string" || (Array.isArray(v) && v.every((x) => typeof x === "string"))) out[key] = v as string | string[];
    }
  out.host = host;
  out["content-length"] = String(bodyLength);
  return out;
}

/** The public URL from a hostnameAssigned message, or null for any other message. */
export function assignedUrl(msg: { type?: string; hostname?: unknown }): string | null {
  if (msg.type !== "hostnameAssigned" || typeof msg.hostname !== "string" || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(msg.hostname)) return null;
  return `https://${msg.hostname.toLowerCase()}`;
}

export interface ForwardedRequest {
  type: "forwardedRequest";
  requestId: string;
  url: string;
  method: string;
  headers: Record<string, string | string[]>;
  body?: string;
}

function forwardLocal(localUrl: string, msg: ForwardedRequest): Promise<{ statusCode: number; headers: IncomingHttpHeaders; body: Buffer }> {
  const target = new URL(localUrl);
  const body = typeof msg.body === "string" && msg.body ? Buffer.from(msg.body, "base64") : undefined;
  const method = typeof msg.method === "string" && /^[A-Z]{1,10}$/.test(msg.method) ? msg.method : "GET";
  const url = typeof msg.url === "string" ? msg.url : "/";
  return new Promise((resolve, reject) => {
    const req = request(
      {
        hostname: target.hostname,
        port: target.port,
        method,
        path: url.startsWith("/") ? url : `/${url}`,
        headers: requestHeaders(msg.headers, body?.length ?? 0, target.host),
        agent: false, // one connection per request: nothing to desync
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(LOCAL_TIMEOUT_MS, () => req.destroy(new Error("local service timed out")));
    req.end(body);
  });
}

/** Runs a forwarded request against the local endpoint and builds the reply (502 if it is down). */
export async function forwardedResponse(localUrl: string, req: ForwardedRequest) {
  let r: { statusCode: number; headers: Record<string, string | string[]>; body: Buffer };
  try {
    const local = await forwardLocal(localUrl, req);
    r = { statusCode: local.statusCode, headers: forwardableHeaders(local.headers, local.body.length), body: local.body };
  } catch {
    const body = Buffer.from("Local service unavailable");
    r = { statusCode: 502, headers: { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length) }, body };
  }
  return { type: "forwardedResponse", requestId: req.requestId, url: req.url, statusCode: r.statusCode, headers: r.headers, body: r.body.toString("base64") };
}

/** Messages after which the service will not serve this connection. */
const FATAL = new Set(["clientDisconnect", "hostnameAlreadyTaken", "invalidSubscription", "domainAlreadyReserved", "domainReservationError", "tooManyDomains"]);

export function tunnelmoleProvider(endpoint = TUNNELMOLE_ENDPOINT): TunnelProvider {
  return {
    name: "tunnelmole",
    timeoutHint: "tunnelmole uses port 8083, which some networks block.",
    available: () => typeof WebSocket === "function",
    start(localUrl, emit): ProviderSession {
      let closed = false;
      let inflight = 0;
      const ws = new WebSocket(endpoint);
      const down = (reason: string) => {
        if (closed) return;
        closed = true;
        emit({ type: "down", reason });
        try {
          ws.close();
        } catch {
          // already closing
        }
      };
      ws.addEventListener("open", () => {
        const clientId = randomBytes(16).toString("base64url");
        const connectionInfo = { isCli: false, isNpm: false, nodeVersion: process.version, tunnelmoleVersion: CLIENT_VERSION };
        ws.send(JSON.stringify({ type: "initialise", clientId, connectionInfo }));
      });
      ws.addEventListener("message", (e) => {
        let msg: { type?: string; hostname?: unknown; message?: unknown };
        try {
          msg = JSON.parse(String(e.data));
        } catch {
          return;
        }
        const url = assignedUrl(msg);
        if (url) {
          emit({ type: "ready", url });
        } else if (msg.type === "forwardedRequest") {
          const fwd = msg as unknown as ForwardedRequest;
          const tooBig = typeof fwd.body === "string" && fwd.body.length > MAX_BODY_B64;
          if (tooBig || inflight >= MAX_INFLIGHT) {
            const body = Buffer.from(tooBig ? "Payload too large" : "Busy");
            const headers = { "content-type": "text/plain; charset=utf-8", "content-length": String(body.length) };
            try {
              ws.send(JSON.stringify({ type: "forwardedResponse", requestId: fwd.requestId, url: fwd.url, statusCode: tooBig ? 413 : 503, headers, body: body.toString("base64") }));
            } catch {
              // socket closed
            }
            return;
          }
          inflight++;
          void forwardedResponse(localUrl, fwd).then((reply) => {
            inflight--;
            if (closed) return;
            try {
              ws.send(JSON.stringify(reply));
            } catch {
              // socket closed while the local request was in flight
            }
          });
        } else if (msg.type && FATAL.has(msg.type)) {
          down(`service sent ${msg.type}`);
        } else if (msg.type === "clientMessage" && typeof msg.message === "string") {
          emit({ type: "error", message: msg.message.slice(0, 300) });
        }
      });
      ws.addEventListener("error", () => emit({ type: "error", message: `websocket error (${endpoint})` } satisfies ProviderEvent));
      ws.addEventListener("close", (e) => down(`connection closed (${e.code})`));
      return {
        stop() {
          closed = true;
          try {
            ws.close();
          } catch {
            // already closing
          }
        },
      };
    },
  };
}
