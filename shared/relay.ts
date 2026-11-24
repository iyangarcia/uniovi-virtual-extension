// Contract between the extension (the "agent", which answers MCP requests from the student's own data)
// and the relay (a Cloudflare Worker + one Durable Object per student, relay/). The relay only forwards
// bytes; it never stores or logs request bodies. Pure types and constants: no runtime dependencies,
// usable from the extension, the relay and Node tests.
//
//   AI client ── POST https://<relay>/mcp/<id>/<token> ──► Worker ──► Durable Object `id`
//                                                                         │  WebSocket (hibernation)
//   extension service worker ◄── RelayRequest ───────────────────────────┘
//                            ─── RelayResponse ──► Durable Object ──► HTTP response to the AI
//
// Connector URL given to the student: `${RELAY_URL}/mcp/${id}/${token}` (stable; "Cambiar enlace"
// rotates `token` only).
//
// Agent connection: `new WebSocket(`${RELAY_WS_URL}/agent/${id}`)`, then the agent sends AgentHello
// as its first message. Browsers can't set headers on a WebSocket, hence the hello message.
//  - First hello ever for an id: the Durable Object stores sha256(secret) and accepts.
//  - Later hellos must present the same secret (constant-time compare of the hashes), else
//    RelayRejected { reason: "bad-secret" } and close. A newer accepted connection replaces the older.
//  - Until the hello is accepted, nothing is forwarded to that socket.
//
// Keepalive: every AGENT_PING_MS the agent sends the text frame PING; the Durable Object answers PONG
// via state.setWebSocketAutoResponse (doesn't wake it). The traffic also keeps the MV3 service worker
// alive (Chrome 116+).
//
// Forwarding: for each HTTP request on /mcp/<id>/<token>[/...] the Durable Object sends a
// RelayRequest and waits up to REQUEST_TIMEOUT_MS for the RelayResponse with the same rid.
//  - No agent connected → 503 with NOT_CONNECTED_BODY (a JSON-RPC error the AI shows the student).
//  - Timeout → 504. Request body over MAX_BODY_BYTES → 413. More than MAX_INFLIGHT pending → 503.
//  - The relay does NOT check the token: it forwards `path` (everything after /mcp/<id>) and the
//    agent answers 404 for a wrong token. That keeps the relay free of per-student secrets besides
//    the hash.
//  - Only REQUEST_HEADERS are forwarded to the agent, and only RESPONSE_HEADERS back to the client.
//  - Any other path on the relay → 404. CORS is not needed (AI clients call server-side).
//  - Only the not-connected 503 has a JSON body; 413/429/502/504 and the in-flight 503 are text/plain.
//    The relay also rate-limits each student (relay/src/logic.ts RATE_LIMIT_PER_MINUTE → 429).
//  - The agent answers only POST (stateless MCP, JSON responses); GET/DELETE → 405 with `allow: POST`,
//    so the SDK client does not hold a GET SSE stream open until the relay timeout.
//  - Hello timeouts are reported as RelayRejected { reason: "bad-hello" }.
//  - Tests point the extension at a local relay with chrome.storage.local.devRelayUrl (dev only).

/** Set after `npx wrangler deploy` (see relay/DESPLIEGUE.md). No trailing slash. */
export const RELAY_URL = "https://uniovi-relay.example.workers.dev";
export const RELAY_WS_URL = RELAY_URL.replace(/^http/, "ws");

export const RELAY_PROTOCOL = 1;
export const AGENT_PING_MS = 20_000;
export const PING = "ping";
export const PONG = "pong";
export const REQUEST_TIMEOUT_MS = 60_000;
export const MAX_BODY_BYTES = 8 * 1024 * 1024;
export const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_INFLIGHT = 16;

/** id and token: 22 chars of base64url (128 bits). secret: 43 chars (256 bits). */
export const ID_RE = /^[A-Za-z0-9_-]{22}$/;
export const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
export const SECRET_RE = /^[A-Za-z0-9_-]{43}$/;

/** Lower-case header names forwarded client → agent. */
export const REQUEST_HEADERS = ["content-type", "accept", "mcp-protocol-version", "mcp-session-id", "last-event-id", "user-agent"] as const;
/** Lower-case header names forwarded agent → client. */
export const RESPONSE_HEADERS = ["content-type", "mcp-session-id", "mcp-protocol-version", "cache-control", "allow", "www-authenticate"] as const;

export interface AgentHello {
  type: "hello";
  v: typeof RELAY_PROTOCOL;
  secret: string;
  /** Extension version, for the relay's own diagnostics only. */
  agent: string;
}

export interface RelayWelcome {
  type: "welcome";
  v: typeof RELAY_PROTOCOL;
}

export interface RelayRejected {
  type: "rejected";
  reason: "bad-secret" | "bad-hello" | "protocol";
}

export interface RelayRequest {
  type: "request";
  /** Unique per Durable Object while pending. */
  rid: string;
  method: string;
  /** Path after /mcp/<id>, starting with "/", e.g. "/<token>". Query string included if any. */
  path: string;
  headers: Record<string, string>;
  /** base64 of the request body; omitted when empty. */
  body?: string;
}

export interface RelayResponse {
  type: "response";
  rid: string;
  status: number;
  headers: Record<string, string>;
  /** base64 of the response body; omitted when empty. */
  body?: string;
}

export type AgentMessage = AgentHello | RelayResponse;
export type RelayMessage = RelayWelcome | RelayRejected | RelayRequest;

/** JSON-RPC error body for "the student's Chrome isn't connected" (HTTP 503). Spanish: students read it via the AI. */
export const NOT_CONNECTED_BODY = JSON.stringify({
  jsonrpc: "2.0",
  id: null,
  error: {
    code: -32001,
    message:
      "Uniovi Virtual no está conectado: abre Chrome en el ordenador del estudiante (con la extensión Uniovi Virtual activada) y vuelve a intentarlo.",
  },
});

export const connectorUrl = (id: string, token: string, base = RELAY_URL) => `${base}/mcp/${id}/${token}`;
