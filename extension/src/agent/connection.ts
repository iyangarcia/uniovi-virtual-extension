import { AGENT_PING_MS, MAX_INFLIGHT, PING, PONG, RELAY_PROTOCOL, type AgentHello, type RelayResponse } from "../../../shared/relay.ts";
import { answer, backoffMs, busyResponse, parseRelayMessage, type RequestHandler } from "./protocol.ts";
import type { AgentStateName } from "./state.ts";

// The agent's WebSocket to the relay: hello, keepalive ping, reconnect with backoff, and answering
// relayed requests. No chrome APIs: everything environment-specific is injected, so Node tests can
// drive it with a fake relay (Node 24 has a global WebSocket).

/** The subset of the browser WebSocket used here. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code?: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type AgentEvent = "connect" | "pong" | "close" | "request";

export interface AgentOptions {
  /** Full WebSocket URL: `${relayWsUrl}/agent/${id}`. */
  url: string;
  secret: string;
  /** Read on every request, so a rotated token applies at once. */
  token: () => string;
  /** Extension version, sent in the hello. */
  version: string;
  handler: RequestHandler;
  wsFactory?: (url: string) => WebSocketLike;
  onState?: (state: AgentStateName, error?: string) => void;
  onEvent?: (ev: AgentEvent) => void;
  pingMs?: number;
  /** No welcome within this long after opening → close and retry. */
  helloTimeoutMs?: number;
  random?: () => number;
}

const OPEN = 1;

export class AgentConnection {
  private readonly o: Required<Omit<AgentOptions, "onState" | "onEvent">> & Pick<AgentOptions, "onState" | "onEvent">;
  private ws: WebSocketLike | null = null;
  private running = false;
  private attempt = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private pingTimer: ReturnType<typeof setInterval> | undefined;
  private helloTimer: ReturnType<typeof setTimeout> | undefined;
  private lastPong = 0;
  private inflight = 0;
  state: AgentStateName = "off";

  constructor(opts: AgentOptions) {
    this.o = {
      wsFactory: (url) => new WebSocket(url) as unknown as WebSocketLike,
      pingMs: AGENT_PING_MS,
      helloTimeoutMs: 15_000,
      random: Math.random,
      ...opts,
    };
  }

  /** True while started and a socket is open or opening (or a reconnect is scheduled). */
  get active(): boolean {
    return this.running && (this.ws !== null || this.reconnectTimer !== undefined);
  }

  get inFlight(): number {
    return this.inflight;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.attempt = 0;
    this.connect();
  }

  stop(state: AgentStateName = "off", error?: string): void {
    this.running = false;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.teardown();
    this.setState(state, error);
  }

  private setState(state: AgentStateName, error?: string) {
    this.state = state;
    this.o.onState?.(state, error);
  }

  private teardown() {
    clearInterval(this.pingTimer);
    clearTimeout(this.helloTimer);
    this.pingTimer = this.helloTimer = undefined;
    const ws = this.ws;
    this.ws = null;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try {
        ws.close(1000, "bye");
      } catch {
        // already closed
      }
    }
  }

  private connect() {
    this.reconnectTimer = undefined;
    if (!this.running) return;
    this.setState("connecting");
    let ws: WebSocketLike;
    try {
      ws = this.o.wsFactory(this.o.url);
    } catch (err) {
      return this.retry(err instanceof Error ? err.message : String(err));
    }
    this.ws = ws;
    ws.onopen = () => {
      const hello: AgentHello = { type: "hello", v: RELAY_PROTOCOL, secret: this.o.secret, agent: this.o.version };
      ws.send(JSON.stringify(hello));
      this.helloTimer = setTimeout(() => this.drop("no welcome from relay"), this.o.helloTimeoutMs);
    };
    ws.onmessage = (ev) => this.onMessage(ws, ev.data);
    ws.onerror = () => undefined; // onclose follows with the details
    ws.onclose = (ev) => {
      if (this.ws !== ws) return;
      this.o.onEvent?.("close");
      this.drop(ev.code && ev.code !== 1000 ? `closed (${ev.code}${ev.reason ? ` ${ev.reason}` : ""})` : "closed");
    };
  }

  /** Lost the socket (or gave up on it): reconnect later if still running. */
  private drop(reason: string) {
    this.teardown();
    if (this.running) this.retry(reason);
  }

  private retry(reason: string) {
    this.ws = null;
    const delay = backoffMs(this.attempt++, this.o.random);
    this.setState("offline", reason);
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => this.connect(), delay);
  }

  private onMessage(ws: WebSocketLike, data: unknown) {
    if (data === PONG) {
      this.lastPong = Date.now();
      this.o.onEvent?.("pong");
      return;
    }
    const msg = parseRelayMessage(data);
    if (!msg) return;
    switch (msg.type) {
      case "welcome":
        clearTimeout(this.helloTimer);
        this.attempt = 0;
        this.lastPong = Date.now();
        this.setState("connected");
        this.o.onEvent?.("connect");
        clearInterval(this.pingTimer);
        this.pingTimer = setInterval(() => this.ping(ws), this.o.pingMs);
        return;
      case "rejected":
        // Another extension owns this id (or the protocol moved on): retrying can't help.
        this.stop("rejected", msg.reason);
        return;
      case "request":
        this.o.onEvent?.("request");
        if (this.inflight >= MAX_INFLIGHT) return this.reply(ws, busyResponse(msg.rid));
        this.inflight++;
        void answer(msg, this.o.token(), this.o.handler)
          .then((res) => this.reply(ws, res))
          .finally(() => this.inflight--);
        return;
    }
  }

  private ping(ws: WebSocketLike) {
    if (ws !== this.ws || ws.readyState !== OPEN) return;
    // Three missed pongs: the socket is half-open (sleep, network change). Start over.
    if (Date.now() - this.lastPong > this.o.pingMs * 3 + 1000) return this.drop("relay stopped answering");
    ws.send(PING);
  }

  private reply(ws: WebSocketLike, res: RelayResponse) {
    // The socket may have been replaced meanwhile; the relay times the request out then.
    if (ws.readyState === OPEN) ws.send(JSON.stringify(res));
  }
}
