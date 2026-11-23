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

/** Headers that describe one hop and must not be copied onto the forwarded response. */
const HOP_BY_HOP = new Set(["connection", "keep-alive", "transfer-encoding", "upgrade", "proxy-connection", "te", "trailer", "content-length"]);

export function forwardableHeaders(headers: IncomingHttpHeaders, bodyLength: number): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(headers)) if (v !== undefined && !HOP_BY_HOP.has(k.toLowerCase())) out[k] = v;
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
  return new Promise((resolve, reject) => {
    const req = request(
      { hostname: target.hostname, port: target.port, method: msg.method, path: msg.url.startsWith("/") ? msg.url : `/${msg.url}`, headers: msg.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => resolve({ statusCode: res.statusCode ?? 502, headers: res.headers, body: Buffer.concat(chunks) }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.setTimeout(LOCAL_TIMEOUT_MS, () => req.destroy(new Error("local service timed out")));
    req.end(msg.body ? Buffer.from(msg.body, "base64") : undefined);
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
          void forwardedResponse(localUrl, msg as unknown as ForwardedRequest).then((reply) => {
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
