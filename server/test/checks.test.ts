// Tests added by the mutation audit (goals/03-verify-checks.md): each one kills a mutation of
// mcp.ts / http.ts that the original suite let through.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http, { type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { BridgeStatus, Snapshot } from "../../shared/types.ts";

// store.ts reads UNIOVI_DATA_DIR at import time, so point it at a temp dir before importing the server.
process.env.UNIOVI_DATA_DIR = mkdtempSync(join(tmpdir(), "uniovi-checks-test-"));
const store = await import("../src/store.ts");
const mcp = await import("../src/mcp.ts");
// The tools themselves live in shared/mcp/; remote mode is what the extension serves to web AIs.
const core = await import("../../shared/mcp/server.ts");
const search = await import("../../shared/mcp/search.ts");
const fetchById = (s: Snapshot, id: string) => core.fetchById(store.nodeStore, s, id);
const searchAll = (s: Snapshot, query: string, limit?: number) => search.searchAll(store.nodeStore, s, query, limit);
const bridge = await import("../src/http.ts");

const now = Math.floor(Date.now() / 1000);

const snap: Snapshot = {
  syncedAt: now,
  siteUrl: "https://campusvirtual.uniovi.es",
  warnings: [],
  courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "c" }],
  resources: [
    { key: "5:/apuntes.txt", cmid: 5, courseId: 1, section: "Tema 1", name: "Apuntes tema 1", modname: "resource", url: "https://campus/r/5", filename: "apuntes.txt" },
    { key: "6:/datos.bin", cmid: 6, courseId: 1, section: "Tema 1", name: "Datos", modname: "resource", url: "https://campus/r/6", filename: "datos.bin" },
  ],
  assignments: [],
  events: [],
  posts: [
    { id: 10, discussionId: 1, courseId: 1, forumName: "Avisos", subject: "Parcial", author: "P", created: now - 3 * 86400, message: "El examen parcial será el 3 de diciembre.", url: "https://campus/p/10" },
    { id: 11, discussionId: 2, courseId: 1, forumName: "Avisos", subject: "Cambio de aula", author: "P", created: now - 86400, message: "El examen se hará en el aula B-2.", url: "https://campus/p/11" },
  ],
};

before(async () => {
  await store.saveSnapshot(snap);
  // Several matching lines in one file: search must still return one result per file.
  const text = "Tema 1\nLa entropía mide el desorden.\nOtra línea.\nLa entropía nunca disminuye.\nFin";
  await store.storeFile({ ...snap.resources[0]!, filename: "apuntes.txt" }, "FIS", "text/plain", new TextEncoder().encode(text));
  await store.storeFile({ ...snap.resources[1]!, filename: "datos.bin" }, "FIS", "application/octet-stream", new Uint8Array([1, 2, 3]));
});

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

async function inMemoryClient(remoteMode: boolean) {
  const server = remoteMode ? core.createMcpServer(store.nodeStore, { remote: true }) : mcp.createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

// ---------------------------------------------------------------- remote mode (shared core) vs the Node server

test("remote: sync_status and list_materials hide local paths, local mode shows them", async () => {
  const r = await inMemoryClient(true);
  assert.doesNotMatch(text(await r.callTool({ name: "sync_status", arguments: {} })), /dataDir/);
  assert.doesNotMatch(text(await r.callTool({ name: "list_materials", arguments: {} })), /localPath/);
  await r.close();
  const l = await inMemoryClient(false);
  assert.match(text(await l.callTool({ name: "sync_status", arguments: {} })), /dataDir/);
  assert.match(text(await l.callTool({ name: "list_materials", arguments: {} })), /localPath/);
  await l.close();
});

test("remote: read_material on an unsupported file gives the campus url, not the local path", async () => {
  const client = await inMemoryClient(true);
  const out = text(await client.callTool({ name: "read_material", arguments: { key: "6:/datos.bin" } }));
  assert.match(out, /https:\/\/campus\/r\/6/);
  assert.doesNotMatch(out, /localPath/);
  assert.ok(!out.includes(store.dataDir.replace(/\\/g, "\\\\")) && !out.includes(store.dataDir), "no data dir in output");
  await client.close();

  // Local mode still points at the file on disk.
  const localClient = await inMemoryClient(false);
  assert.match(text(await localClient.callTool({ name: "read_material", arguments: { key: "6:/datos.bin" } })), /localPath/);
  await localClient.close();
});

test("fetch(material) never reveals local paths", async () => {
  const doc = await fetchById(snap, "material:5:/apuntes.txt");
  assert.match(doc.text, /url: https:\/\/campus\/r\/5/);
  assert.doesNotMatch(doc.text, /localPath/);
  assert.ok(!doc.text.includes(store.dataDir));
  const bin = await fetchById(snap, "material:6:/datos.bin");
  assert.doesNotMatch(bin.text, /localPath/);
});

test("search tool returns exactly {results:[{id,title,url}]}", async () => {
  const client = await inMemoryClient(true);
  try {
    const body = JSON.parse(text(await client.callTool({ name: "search", arguments: { query: "entropia" } })));
    assert.deepEqual(Object.keys(body), ["results"]);
    assert.deepEqual(body.results, [{ id: "material:5:/apuntes.txt", title: body.results[0].title, url: "https://campus/r/5" }]);
  } finally {
    await client.close();
  }
});

test("fetch(post) has the connector shape too", async () => {
  const doc = await fetchById(snap, "post:10");
  assert.deepEqual(Object.keys(doc).sort(), ["id", "metadata", "text", "title", "url"]);
  assert.equal(doc.id, "post:10");
  assert.equal(doc.title, "Parcial");
  assert.deepEqual(doc.metadata, { course: "FIS", forum: "Avisos" });
});

test("fetch errors are user errors naming the problem", async () => {
  const client = await inMemoryClient(true);
  const missingPost = await client.callTool({ name: "fetch", arguments: { id: "post:999" } });
  assert.equal(missingPost.isError, true);
  assert.match(text(missingPost), /No post with id 999/);
  const missingFile = await client.callTool({ name: "fetch", arguments: { id: "material:404:/nada.pdf" } });
  assert.equal(missingFile.isError, true);
  assert.match(text(missingFile), /not downloaded/);
  const unknown = await client.callTool({ name: "fetch", arguments: { id: "nope:1" } });
  assert.equal(unknown.isError, true);
  assert.match(text(unknown), /Unknown id/);
  await client.close();
});

test("searchAll: one result per file, posts need every term, newest post first, limit honoured", async () => {
  const hits = await searchAll(snap, "entropia");
  assert.deepEqual(hits.map((h) => h.id), ["material:5:/apuntes.txt"]);

  assert.deepEqual((await searchAll(snap, "examen diciembre")).map((h) => h.id), ["post:10"]);
  assert.deepEqual((await searchAll(snap, "examen")).map((h) => h.id), ["post:11", "post:10"]);
  assert.equal((await searchAll(snap, "examen", 1)).length, 1);
});

// ---------------------------------------------------------------- http.ts (ingest bridge)
// Port 0: a running bridge may hold BRIDGE_PORT, so the real ingest server runs on an ephemeral port.

let bridgeServer: Server;
let bridgePort: number;

before(async () => {
  bridgeServer = (await bridge.startHttp(0))!;
  bridgePort = (bridgeServer.address() as AddressInfo).port;
});

after(() => bridgeServer?.close());

function request(method: string, path: string, headers: Record<string, string>, body?: string) {
  return new Promise<{ status: number; json: unknown }>((resolvePromise, reject) => {
    const req = http.request({ host: "127.0.0.1", port: bridgePort, method, path, headers }, (res) => {
      let data = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (data += c));
      res.on("end", () => resolvePromise({ status: res.statusCode ?? 0, json: data ? JSON.parse(data) : null }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("bridge: Host must be loopback (DNS rebinding)", async () => {
  assert.equal((await request("GET", "/api/status", { Host: `127.0.0.1:${bridgePort}` })).status, 200);
  assert.equal((await request("GET", "/api/status", { Host: "localhost" })).status, 200);
  assert.equal((await request("GET", "/api/status", { Host: "evil.example" })).status, 403);
  assert.equal((await request("GET", "/api/status", { Host: "127.0.0.1.evil.example" })).status, 403);
});

test("bridge: only chrome-extension:// origins, pinned when UNIOVI_EXTENSION_ID is set", async () => {
  const host = { Host: "127.0.0.1" };
  assert.equal((await request("GET", "/api/status", { ...host, Origin: "https://campusvirtual.uniovi.es" })).status, 403);
  assert.equal((await request("GET", "/api/status", { ...host, Origin: "chrome-extension://abc" })).status, 200);
  process.env.UNIOVI_EXTENSION_ID = "pinnedid";
  try {
    assert.equal((await request("GET", "/api/status", { ...host, Origin: "chrome-extension://abc" })).status, 403);
    assert.equal((await request("GET", "/api/status", { ...host, Origin: "chrome-extension://pinnedid" })).status, 200);
  } finally {
    delete process.env.UNIOVI_EXTENSION_ID;
  }
});

test("bridge: /api/status reports the last sync and the stored files", async () => {
  const s = (await request("GET", "/api/status", { Host: "127.0.0.1" })).json as BridgeStatus;
  assert.equal(s.ok, true);
  assert.equal(s.lastSync, snap.syncedAt);
  assert.deepEqual(Object.keys(s.knownFiles).sort(), ["5:/apuntes.txt", "6:/datos.bin"]);
  assert.equal("remoteUrl" in s, false);
});

test("bridge: rejects a POST that is not a snapshot", async () => {
  const res = await request("POST", "/api/snapshot", { Host: "127.0.0.1", "Content-Type": "application/json" }, "{}");
  assert.equal(res.status, 400);
  assert.equal((await store.loadSnapshot())?.syncedAt, snap.syncedAt, "stored snapshot untouched");
});
