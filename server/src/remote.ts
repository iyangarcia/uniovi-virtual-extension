import { randomBytes, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { createMcpServer } from "./mcp.ts";
import { loadRemoteState, saveRemoteState } from "./store.ts";

// Remote MCP endpoint for web clients (claude.ai, ChatGPT, Gemini), reached through a tunnel.
// Separate from the ingest bridge (http.ts), whose loopback-only checks stay as they are.
// Access control is the secret path: only /mcp/<token> is served; everything else, including
// a wrong token, is a plain 404 so the endpoint can't be discovered. All tools are read-only.

export const REMOTE_PORT = 47824;
const MAX_BODY = 1024 * 1024;
const RATE_PER_MINUTE = 240;

export function newToken(): string {
  return randomBytes(24).toString("base64url");
}

/** The persisted token, created on first use or when `rotate` is set. */
export async function remoteToken(rotate = false): Promise<string> {
  const state = await loadRemoteState();
  if (state?.token && !rotate) return state.token;
  const token = newToken();
  await saveRemoteState({ token });
  return token;
}

export function tokenMatches(path: string, token: string): boolean {
  const m = /^\/mcp\/([A-Za-z0-9_-]+)\/?$/.exec(path);
  if (!m) return false;
  const a = Buffer.from(m[1]!);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > MAX_BODY) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  if (!size) return undefined;
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw Object.assign(new Error("Invalid JSON"), { status: 400 });
  }
}

function plain(res: ServerResponse, status: number, text: string) {
  res.writeHead(status, { "Content-Type": "text/plain; charset=utf-8" });
  res.end(text);
}

export function startRemote(token: string, port = REMOTE_PORT): Promise<Server | null> {
  let windowStart = Date.now();
  let count = 0;

  const server = createServer((req, res) => {
    const path = new URL(req.url ?? "/", "http://x").pathname;
    if (!tokenMatches(path, token)) return plain(res, 404, "Not found");

    if (Date.now() - windowStart > 60_000) {
      windowStart = Date.now();
      count = 0;
    }
    if (++count > RATE_PER_MINUTE) return plain(res, 429, "Too many requests");

    void (async () => {
      const body = req.method === "POST" ? await readBody(req) : undefined;
      // Stateless: a fresh server + transport per request (the tools read from disk on every call anyway).
      const mcp = createMcpServer({ remote: true });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      await transport.handleRequest(req, res, body);
    })().catch((err: Error & { status?: number }) => {
      console.error("[remote]", err);
      if (!res.headersSent) plain(res, err.status ?? 500, err.status ? err.message : "Internal error");
    });
  });

  return new Promise((resolvePromise) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        console.error(`[remote] port ${port} in use; is another --remote instance running?`);
        resolvePromise(null);
      } else {
        throw err;
      }
    });
    server.listen(port, "127.0.0.1", () => resolvePromise(server));
  });
}
