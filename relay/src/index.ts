// Uniovi Virtual relay: a Worker plus one Durable Object per student id (contract: shared/relay.ts).
// The Durable Object holds the student's extension WebSocket (hibernation API) and forwards each
// /mcp/<id>/... HTTP request over it. It stores nothing but sha256(secret) and logs no bodies or paths.

import { DurableObject } from "cloudflare:workers";
// The extension's 128 px icon, bundled as bytes (wrangler.toml rule "Data" for *.png).
import ICON from "../../extension/icons/icon128.png";
import {
  MAX_INFLIGHT,
  NOT_CONNECTED_BODY,
  PING,
  PONG,
  RELAY_PROTOCOL,
  type RelayRejected,
  type RelayRequest,
  type RelayResponse,
  type RelayWelcome,
} from "../../shared/relay.ts";
import {
  HELLO_TIMEOUT_MS,
  agentHttpResponse,
  bytesToBase64,
  contentLengthTooLarge,
  decodeResponseBody,
  isStale,
  parseHello,
  parseResponse,
  rateAllow,
  readCapped,
  requestHeaders,
  requestTimeout,
  route,
  sha256Hex,
  timingSafeEqual,
  type RateWindow,
} from "./logic.ts";

export interface Env {
  AGENTS: DurableObjectNamespace<AgentRoom>;
  /** Test-only (wrangler dev --var): lowers REQUEST_TIMEOUT_MS to force a 504. Never raises it. */
  TEST_REQUEST_TIMEOUT_MS?: string;
}

const HOME_PAGE =
  '<!doctype html><html lang="es"><head><meta charset="utf-8"><title>Uniovi Virtual</title>' +
  '<link rel="icon" type="image/png" sizes="128x128" href="/icon.png"></head><body>' +
  '<p>Uniovi Virtual: conecta tu Campus Virtual con tu IA. ' +
  '<a href="https://iyangarcia.github.io/uniovi-virtual-extension/">Guía de instalación</a></p></body></html>';

const text = (status: number, body: string) =>
  new Response(body, { status, headers: { "content-type": "text/plain; charset=utf-8" } });

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const r = route(request.method, url.pathname, url.search);
    switch (r.kind) {
      case "health":
        // A tiny page whose <link rel="icon"> lets favicon services (and AI sites) find the connector icon.
        return new Response(HOME_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      case "icon":
        return new Response(ICON, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
      case "agent":
        if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") return text(426, "Expected WebSocket");
        return env.AGENTS.get(env.AGENTS.idFromName(r.id)).fetch(request);
      case "mcp":
        return env.AGENTS.get(env.AGENTS.idFromName(r.id)).fetch(request);
      default:
        return text(404, "Not found");
    }
  },
} satisfies ExportedHandler<Env>;

interface Attachment {
  /** Stable socket id: WebSocket objects may be new wrappers after hibernation, so compare these. */
  sid: string;
  authed: boolean;
  /** ms epoch when the socket was accepted (unauthed) or authenticated (authed). */
  at: number;
}

interface Pending {
  sid: string;
  resolve: (r: Response) => void;
  timer: ReturnType<typeof setTimeout>;
}

const HASH_KEY = "secretHash";

const notConnected = () =>
  new Response(NOT_CONNECTED_BODY, { status: 503, headers: { "content-type": "application/json" } });

export class AgentRoom extends DurableObject<Env> {
  private pending = new Map<string, Pending>();
  private rate: RateWindow = { start: 0, count: 0 };

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Answered by the runtime without waking the object.
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair(PING, PONG));
  }

  override async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const r = route(request.method, url.pathname, url.search);
    if (r.kind === "agent") return this.acceptAgent();
    if (r.kind === "mcp") return this.forward(request, r.path);
    return text(404, "Not found");
  }

  // ---- agent sockets ----

  private acceptAgent(): Response {
    const pair = new WebSocketPair();
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ sid: crypto.randomUUID(), authed: false, at: Date.now() } satisfies Attachment);
    // Best effort: lost if the object hibernates, in which case the age check in webSocketMessage applies.
    setTimeout(() => {
      if (!this.attachment(server).authed) this.reject(server, "bad-hello");
    }, HELLO_TIMEOUT_MS);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  private attachment(ws: WebSocket): Attachment {
    const a = ws.deserializeAttachment() as Attachment | null;
    return a ?? { sid: "", authed: false, at: 0 };
  }

  /** The most recently authenticated open socket, if any. */
  private agent(): WebSocket | undefined {
    let best: WebSocket | undefined;
    let bestAt = -1;
    for (const ws of this.ctx.getWebSockets()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      const a = this.attachment(ws);
      if (a.authed && a.at > bestAt) {
        best = ws;
        bestAt = a.at;
      }
    }
    return best;
  }

  private reject(ws: WebSocket, reason: RelayRejected["reason"]) {
    try {
      ws.send(JSON.stringify({ type: "rejected", reason } satisfies RelayRejected));
      ws.close(1008, reason);
    } catch {
      // already closed
    }
  }

  override async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const a = this.attachment(ws);
    if (a.authed) {
      const res = parseResponse(message);
      if (res) this.settle(res);
      return;
    }
    if (Date.now() - a.at > HELLO_TIMEOUT_MS) return this.reject(ws, "bad-hello");
    const hello = parseHello(message);
    if (!hello.ok) return this.reject(ws, hello.reason);

    const hash = await sha256Hex(hello.hello.secret);
    // No other await between get and put: the input gate keeps two first hellos from racing.
    const stored = await this.ctx.storage.get<string>(HASH_KEY);
    if (stored === undefined) await this.ctx.storage.put(HASH_KEY, hash);
    else if (!timingSafeEqual(stored, hash)) return this.reject(ws, "bad-secret");

    const now = Date.now();
    ws.serializeAttachment({ sid: a.sid, authed: true, at: now } satisfies Attachment);
    ws.send(JSON.stringify({ type: "welcome", v: RELAY_PROTOCOL } satisfies RelayWelcome));
    for (const other of this.ctx.getWebSockets()) {
      const o = this.attachment(other);
      if (o.sid !== a.sid && o.authed) {
        try {
          other.close(1000, "replaced");
        } catch {
          // already closed
        }
        this.failPending(o.sid);
      }
    }
  }

  override async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, reason);
    } catch {
      // already closed
    }
    this.failPending(this.attachment(ws).sid);
  }

  override async webSocketError(ws: WebSocket): Promise<void> {
    this.failPending(this.attachment(ws).sid);
  }

  private failPending(sid: string) {
    for (const [rid, p] of this.pending) {
      if (p.sid !== sid) continue;
      clearTimeout(p.timer);
      this.pending.delete(rid);
      p.resolve(notConnected());
    }
  }

  private settle(res: RelayResponse) {
    const p = this.pending.get(res.rid);
    if (!p) return;
    clearTimeout(p.timer);
    this.pending.delete(res.rid);
    // The entry is gone from `pending` now, so every path below must resolve, or the AI's request
    // would hang (no timer left to answer it).
    const body = decodeResponseBody(res.body);
    if (!body) return p.resolve(text(502, "Response too large"));
    p.resolve(agentHttpResponse(res, body) ?? text(502, "Bad response from the extension"));
  }

  /**
   * Closes `ws` and fails its pending requests if it has gone silent (no auto-answered ping lately).
   * The extension notices too (missed pongs) and reconnects; until then the AI gets the fast 503.
   */
  private dead(ws: WebSocket): boolean {
    const lastPing = this.ctx.getWebSocketAutoResponseTimestamp(ws)?.getTime() ?? 0;
    if (!isStale(Math.max(lastPing, this.attachment(ws).at), Date.now())) return false;
    try {
      ws.close(1000, "stale");
    } catch {
      // already closed
    }
    this.failPending(this.attachment(ws).sid);
    return true;
  }

  // ---- HTTP forwarding ----

  private async forward(request: Request, path: string): Promise<Response> {
    if (!rateAllow(this.rate, Date.now())) return text(429, "Too many requests");
    const ws = this.agent();
    if (!ws) return notConnected();
    if (this.dead(ws)) return notConnected();
    if (this.pending.size >= MAX_INFLIGHT) return text(503, "Too many requests in flight");
    if (contentLengthTooLarge(request.headers.get("content-length"))) return text(413, "Request body too large");
    const body = await readCapped(request.body);
    if (!body) return text(413, "Request body too large");

    const rid = crypto.randomUUID();
    const msg: RelayRequest = {
      type: "request",
      rid,
      method: request.method,
      path,
      headers: requestHeaders(request.headers),
      ...(body.byteLength ? { body: bytesToBase64(body) } : {}),
    };
    // The agent may have gone while the body was read.
    if (ws.readyState !== WebSocket.OPEN) return notConnected();
    return new Promise<Response>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(rid);
        resolve(text(504, "The extension did not answer in time"));
      }, requestTimeout(this.env.TEST_REQUEST_TIMEOUT_MS));
      this.pending.set(rid, { sid: this.attachment(ws).sid, resolve, timer });
      try {
        ws.send(JSON.stringify(msg));
      } catch {
        clearTimeout(timer);
        this.pending.delete(rid);
        resolve(notConnected());
      }
    });
  }
}
