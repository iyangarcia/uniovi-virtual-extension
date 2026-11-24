// A Node agent for the relay (protocol in shared/relay.ts), the same job the extension's service worker does:
// connect to <relay>/agent/<id>, say hello, ping every AGENT_PING_MS, and answer each RelayRequest with a
// web-standard handler `(Request) => Promise<Response>`. `mcpHandler` turns any McpServer factory into such
// a handler (token check + stateless Streamable HTTP with JSON responses). Used by e2e.mjs; reusable for
// other MCP servers. Needs Node 22+ (global WebSocket).

import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";

const PROTOCOL = 1;
const PING = "ping";
const PING_MS = 20_000;

/**
 * @param {{ wsBase: string, id: string, secret: string, handle: (req: Request) => Promise<Response>,
 *           agent?: string, pingMs?: number }} opts
 * @returns {{ ws: WebSocket, ready: Promise<{ type: "welcome" } | { type: "rejected", reason: string }>,
 *             closed: Promise<{ code: number, reason: string }>, close: () => void }}
 */
export function startNodeAgent({ wsBase, id, secret, handle, agent = "node-agent", pingMs = PING_MS }) {
  const ws = new WebSocket(`${wsBase}/agent/${id}`);
  let ping;
  let settleReady;
  const ready = new Promise((r) => (settleReady = r));
  const closed = new Promise((r) => {
    ws.addEventListener("close", (e) => {
      clearInterval(ping);
      settleReady({ type: "closed", code: e.code, reason: e.reason });
      r({ code: e.code, reason: e.reason });
    });
  });
  ws.addEventListener("open", () => {
    ws.send(JSON.stringify({ type: "hello", v: PROTOCOL, secret, agent }));
    ping = setInterval(() => ws.readyState === WebSocket.OPEN && ws.send(PING), pingMs);
  });
  ws.addEventListener("message", async (e) => {
    if (typeof e.data !== "string" || e.data === "pong") return;
    let msg;
    try {
      msg = JSON.parse(e.data);
    } catch {
      return;
    }
    if (msg.type === "welcome" || msg.type === "rejected") return settleReady(msg);
    if (msg.type !== "request") return;
    let res;
    try {
      res = await handle(toRequest(msg));
    } catch {
      res = new Response("agent error", { status: 500 });
    }
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(await toRelayResponse(msg.rid, res)));
  });
  return { ws, ready, closed, close: () => ws.close(1000, "bye") };
}

/** RelayRequest → Request (the host is irrelevant; handlers look at the path). */
export function toRequest(msg) {
  const hasBody = msg.body && msg.method !== "GET" && msg.method !== "HEAD";
  return new Request(`http://agent.invalid${msg.path}`, {
    method: msg.method,
    headers: msg.headers,
    body: hasBody ? Buffer.from(msg.body, "base64") : undefined,
  });
}

/** Response → RelayResponse. */
export async function toRelayResponse(rid, res) {
  const headers = {};
  res.headers.forEach((v, k) => (headers[k] = v));
  const bytes = Buffer.from(await res.arrayBuffer());
  return { type: "response", rid, status: res.status, headers, ...(bytes.length ? { body: bytes.toString("base64") } : {}) };
}

/** True when `path` ("/<token>[/...][?...]") is addressed to this token. */
export const tokenMatches = (path, token) =>
  path === `/${token}` || path.startsWith(`/${token}/`) || path.startsWith(`/${token}?`);

/**
 * Stateless MCP over Streamable HTTP: a fresh server + transport per request, JSON responses.
 * @param {{ token: string, createServer: () => import("@modelcontextprotocol/sdk/server/mcp.js").McpServer }} opts
 */
export function mcpHandler({ token, createServer }) {
  return async (req) => {
    const url = new URL(req.url);
    if (!tokenMatches(url.pathname + url.search, token)) return new Response("Not found", { status: 404 });
    const server = createServer();
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      // The JSON body is fully built by now; closing frees the per-request server.
      void server.close();
    }
  };
}
