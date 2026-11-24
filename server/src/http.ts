import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { BRIDGE_PORT, type BridgeStatus, type Resource, type Snapshot } from "../../shared/types.ts";
import { dataDir, liveRemote, loadIndex, loadSnapshot, saveSnapshot, storeFile } from "./store.ts";
import { VERSION } from "./version.ts";

// Ingest endpoint for the browser extension. Bound to 127.0.0.1 only.
// Access control:
//  - Host header must be loopback (blocks DNS-rebinding from web pages).
//  - If an Origin header is present it must be a chrome-extension:// origin
//    (optionally pinned with UNIOVI_EXTENSION_ID). Web pages always send Origin
//    on cross-origin fetches, so they cannot read or write.

const MAX_SNAPSHOT = 64 * 1024 * 1024;
const MAX_FILE = 128 * 1024 * 1024;

function allowed(req: IncomingMessage): boolean {
  const host = (req.headers.host ?? "").replace(/:\d+$/, "");
  if (host !== "127.0.0.1" && host !== "localhost") return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  const pinned = process.env.UNIOVI_EXTENSION_ID;
  return pinned ? origin === `chrome-extension://${pinned}` : origin.startsWith("chrome-extension://");
}

async function readBody(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req as AsyncIterable<Buffer>) {
    size += chunk.length;
    if (size > limit) throw Object.assign(new Error("Payload too large"), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

async function route(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");

  if (req.method === "GET" && url.pathname === "/api/status") {
    const [snapshot, index, remote] = await Promise.all([loadSnapshot(), loadIndex(), liveRemote()]);
    const knownFiles: Record<string, number> = {};
    for (const f of Object.values(index)) knownFiles[f.key] = f.timemodified;
    const status: BridgeStatus = {
      ok: true,
      version: VERSION,
      helperVersion: VERSION,
      dataDir,
      lastSync: snapshot?.syncedAt,
      knownFiles,
      remoteUrl: remote.remoteUrl,
      tunnel: remote.tunnel,
    };
    return send(res, 200, status);
  }

  if (req.method === "POST" && url.pathname === "/api/snapshot") {
    const snapshot = JSON.parse((await readBody(req, MAX_SNAPSHOT)).toString("utf8")) as Snapshot;
    if (!Array.isArray(snapshot.courses) || typeof snapshot.syncedAt !== "number") {
      return send(res, 400, { error: "Not a snapshot" });
    }
    await saveSnapshot(snapshot);
    console.error(`[bridge] snapshot: ${snapshot.courses.length} courses, ${snapshot.resources.length} resources`);
    return send(res, 200, { ok: true });
  }

  if (req.method === "PUT" && url.pathname === "/api/files") {
    const header = req.headers["x-resource"];
    if (typeof header !== "string") return send(res, 400, { error: "Missing X-Resource header" });
    const resource = JSON.parse(decodeURIComponent(header)) as Resource & { filename: string };
    if (!resource.key || !resource.filename) return send(res, 400, { error: "Bad resource metadata" });
    const bytes = await readBody(req, MAX_FILE);
    const snapshot = await loadSnapshot();
    const course = snapshot?.courses.find((c) => c.id === resource.courseId);
    const stored = await storeFile(
      resource,
      course?.shortname ?? String(resource.courseId),
      req.headers["content-type"] ?? "application/octet-stream",
      new Uint8Array(bytes),
    );
    return send(res, 200, { ok: true, path: stored.path });
  }

  send(res, 404, { error: "Not found" });
}

/** Shown when a port is in a Windows excluded range. */
export const RESERVED_HINT = "Check with: netsh int ipv4 show excludedportrange protocol=tcp";

// UNIOVI_BRIDGE_PORT: dev/test override so parallel runs do not fight over 47823 (the extension always uses 47823).
export const BRIDGE_LISTEN_PORT = Number(process.env.UNIOVI_BRIDGE_PORT) || BRIDGE_PORT;

export function startHttp(port = BRIDGE_LISTEN_PORT): Promise<Server | null> {
  const server = createServer((req, res) => {
    if (!allowed(req)) return send(res, 403, { error: "Forbidden" });
    route(req, res).catch((err: Error & { status?: number }) => {
      console.error("[bridge]", err);
      send(res, err.status ?? 500, { error: err.message });
    });
  });
  return new Promise((resolvePromise) => {
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        // Another instance (e.g. Claude Desktop + Claude Code) already serves ingest; both read the same files.
        console.error(`[bridge] port ${port} in use; assuming another instance is ingesting`);
        resolvePromise(null);
      } else {
        // EACCES = port inside a Windows reserved range (Hyper-V/WSL). Degrade like "in use" instead of
        // crashing the stdio MCP server or the helper.
        console.error(`[bridge] cannot listen on ${port} (${err.code ?? err.message}); ingest disabled.${err.code === "EACCES" ? ` Reserved by Windows. ${RESERVED_HINT}` : ""}`);
        resolvePromise(null);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      console.error(`[bridge] listening on http://127.0.0.1:${(server.address() as { port: number }).port}, data in ${dataDir}`);
      resolvePromise(server);
    });
  });
}
