import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import {
  ID_RE,
  MAX_BODY_BYTES,
  MAX_INFLIGHT,
  NOT_CONNECTED_BODY,
  PING,
  PONG,
  RELAY_PROTOCOL,
  REQUEST_HEADERS,
  REQUEST_TIMEOUT_MS,
  RESPONSE_HEADERS,
  SECRET_RE,
  type RelayResponse,
} from "../../../shared/relay.ts";

// A small stand-in for the Cloudflare relay (relay/), implementing shared/relay.ts faithfully for
// agent tests: WebSocket /agent/<id> with hello + secret hash, ping/pong, and HTTP /mcp/<id>/...
// forwarded as RelayRequest. Hand-rolled RFC 6455 (text, close, ping frames; no fragmentation),
// because the repo has no WebSocket server dependency. Also runnable standalone:
//   node server/test/helpers/fake-relay.ts <port> [logfile]

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export interface RelayLogEntry {
  t: number;
  ev: "connect" | "welcome" | "rejected" | "ping" | "close" | "request" | "response";
  id?: string;
  detail?: string;
}

class Socket {
  private buf = Buffer.alloc(0);
  onText: (s: string) => void = () => undefined;
  onClose: () => void = () => undefined;
  closed = false;

  readonly raw: Duplex;

  constructor(raw: Duplex) {
    this.raw = raw;
    raw.on("data", (d: Buffer) => this.feed(d));
    raw.on("close", () => this.end());
    raw.on("error", () => this.end());
  }

  private end() {
    if (this.closed) return;
    this.closed = true;
    this.onClose();
  }

  private feed(d: Buffer) {
    this.buf = Buffer.concat([this.buf, d]);
    for (;;) {
      if (this.buf.length < 2) return;
      const op = this.buf[0]! & 0x0f;
      const masked = (this.buf[1]! & 0x80) !== 0;
      let len = this.buf[1]! & 0x7f;
      let off = 2;
      if (len === 126) {
        if (this.buf.length < 4) return;
        len = this.buf.readUInt16BE(2);
        off = 4;
      } else if (len === 127) {
        if (this.buf.length < 10) return;
        len = Number(this.buf.readBigUInt64BE(2));
        off = 10;
      }
      const maskOff = off;
      if (masked) off += 4;
      if (this.buf.length < off + len) return;
      const payload = Buffer.from(this.buf.subarray(off, off + len));
      if (masked) for (let i = 0; i < len; i++) payload[i]! ^= this.buf[maskOff + (i % 4)]!;
      this.buf = this.buf.subarray(off + len);
      if (op === 1) this.onText(payload.toString("utf8"));
      else if (op === 8) {
        this.frame(8, payload.subarray(0, 2));
        this.raw.end();
        this.end();
      } else if (op === 9) this.frame(10, payload);
    }
  }

  private frame(op: number, payload: Buffer) {
    if (this.closed || this.raw.destroyed) return;
    const len = payload.length;
    const head = len < 126 ? Buffer.from([0x80 | op, len]) : len < 65536 ? Buffer.alloc(4) : Buffer.alloc(10);
    if (len >= 126 && len < 65536) {
      head[0] = 0x80 | op;
      head[1] = 126;
      head.writeUInt16BE(len, 2);
    } else if (len >= 65536) {
      head[0] = 0x80 | op;
      head[1] = 127;
      head.writeBigUInt64BE(BigInt(len), 2);
    }
    this.raw.write(Buffer.concat([head, payload]));
  }

  send(s: string) {
    this.frame(1, Buffer.from(s, "utf8"));
  }

  close(code = 1000) {
    const p = Buffer.alloc(2);
    p.writeUInt16BE(code);
    this.frame(8, p);
    this.raw.end();
    this.end();
  }

  /** Simulates a network drop: no close frame. */
  kill() {
    this.raw.destroy();
    this.end();
  }
}

interface Pending {
  resolve: (r: RelayResponse) => void;
}

export interface FakeRelay {
  server: Server;
  port: number;
  url: string;
  log: RelayLogEntry[];
  /** Currently accepted agent socket per id. */
  agents: Map<string, Socket>;
  /** Drops every agent socket without a close frame. */
  killAgents(): void;
  close(): Promise<void>;
}

export async function startFakeRelay(port = 0, onLog?: (e: RelayLogEntry) => void): Promise<FakeRelay> {
  const hashes = new Map<string, Buffer>();
  const agents = new Map<string, Socket>();
  const pending = new Map<string, Pending>();
  const sockets = new Set<Duplex>();
  const log: RelayLogEntry[] = [];
  const note = (e: Omit<RelayLogEntry, "t">) => {
    const entry = { t: Date.now(), ...e };
    log.push(entry);
    if (log.length > 5000) log.shift();
    onLog?.(entry);
  };

  const server = createServer(async (req, res) => {
    const m = /^\/mcp\/([^/?#]+)(\/.*)?$/.exec(req.url ?? "");
    if (!m || !ID_RE.test(m[1]!)) return void res.writeHead(404).end("Not found");
    const id = m[1]!;
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req as AsyncIterable<Buffer>) {
      size += c.length;
      if (size > MAX_BODY_BYTES) return void res.writeHead(413).end("Too large");
      chunks.push(c);
    }
    const agent = agents.get(id);
    if (!agent) return void res.writeHead(503, { "content-type": "application/json" }).end(NOT_CONNECTED_BODY);
    if (pending.size >= MAX_INFLIGHT) return void res.writeHead(503).end("Busy");
    const headers: Record<string, string> = {};
    for (const h of REQUEST_HEADERS) {
      const v = req.headers[h];
      if (typeof v === "string") headers[h] = v;
    }
    const rid = randomUUID();
    const body = Buffer.concat(chunks);
    note({ ev: "request", id, detail: `${req.method} ${m[2] ?? ""}` });
    const reply = await new Promise<RelayResponse | null>((resolve) => {
      const timer = setTimeout(() => {
        pending.delete(rid);
        resolve(null);
      }, REQUEST_TIMEOUT_MS);
      pending.set(rid, {
        resolve: (r) => {
          clearTimeout(timer);
          pending.delete(rid);
          resolve(r);
        },
      });
      agent.send(
        JSON.stringify({ type: "request", rid, method: req.method ?? "GET", path: m[2] ?? "/", headers, ...(body.length ? { body: body.toString("base64") } : {}) }),
      );
    });
    if (!reply) return void res.writeHead(504).end("Timeout");
    note({ ev: "response", id, detail: String(reply.status) });
    const out: Record<string, string> = {};
    for (const h of RESPONSE_HEADERS) if (reply.headers[h] !== undefined) out[h] = reply.headers[h];
    res.writeHead(reply.status, out).end(reply.body ? Buffer.from(reply.body, "base64") : undefined);
  });

  server.on("upgrade", (req: IncomingMessage, raw: Duplex) => {
    sockets.add(raw);
    raw.on("close", () => sockets.delete(raw));
    const m = /^\/agent\/([^/?#]+)$/.exec(req.url ?? "");
    const key = req.headers["sec-websocket-key"];
    if (!m || !ID_RE.test(m[1]!) || typeof key !== "string") return void raw.end("HTTP/1.1 404 Not Found\r\n\r\n");
    const id = m[1]!;
    const accept = createHash("sha1").update(key + GUID).digest("base64");
    raw.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const ws = new Socket(raw);
    let accepted = false;
    note({ ev: "connect", id });
    ws.onText = (text) => {
      if (text === PING) {
        note({ ev: "ping", id });
        return ws.send(PONG);
      }
      let msg: { type?: string; v?: number; secret?: string; rid?: string };
      try {
        msg = JSON.parse(text);
      } catch {
        return;
      }
      if (!accepted) {
        const reject = (reason: string) => {
          note({ ev: "rejected", id, detail: reason });
          ws.send(JSON.stringify({ type: "rejected", reason }));
          ws.close(4001);
        };
        if (msg.type !== "hello" || typeof msg.secret !== "string" || !SECRET_RE.test(msg.secret)) return reject("bad-hello");
        if (msg.v !== RELAY_PROTOCOL) return reject("protocol");
        const h = createHash("sha256").update(msg.secret).digest();
        const stored = hashes.get(id);
        if (stored && !timingSafeEqual(stored, h)) return reject("bad-secret");
        hashes.set(id, h);
        accepted = true;
        const prev = agents.get(id);
        agents.set(id, ws);
        if (prev && prev !== ws) prev.close(4000);
        note({ ev: "welcome", id });
        return ws.send(JSON.stringify({ type: "welcome", v: RELAY_PROTOCOL }));
      }
      if (msg.type === "response" && typeof msg.rid === "string") pending.get(msg.rid)?.resolve(msg as unknown as RelayResponse);
    };
    ws.onClose = () => {
      note({ ev: "close", id });
      if (agents.get(id) === ws) agents.delete(id);
    };
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const actual = (server.address() as { port: number }).port;
  return {
    server,
    port: actual,
    url: `http://127.0.0.1:${actual}`,
    log,
    agents: agents as Map<string, Socket>,
    killAgents: () => {
      for (const s of agents.values()) s.kill();
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of sockets) s.destroy();
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

if (import.meta.main) {
  const port = Number(process.argv[2] ?? 48900);
  const file = process.argv[3];
  const { appendFileSync } = await import("node:fs");
  const relay = await startFakeRelay(port, (e) => {
    const line = JSON.stringify(e);
    if (file) appendFileSync(file, line + "\n");
    else console.log(line);
  });
  console.log(`fake relay on ${relay.url}`);
}
