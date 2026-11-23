import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import type { Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Snapshot } from "../../shared/types.ts";
import { parseTunnelUrl } from "../src/tunnel.ts";

// store.ts reads UNIOVI_DATA_DIR at import time, so point it at a temp dir before importing the server.
process.env.UNIOVI_DATA_DIR = mkdtempSync(join(tmpdir(), "uniovi-remote-test-"));
const store = await import("../src/store.ts");
const remote = await import("../src/remote.ts");
const mcp = await import("../src/mcp.ts");

const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const soon = Math.floor(Date.now() / 1000) + 5 * 86400;

const snap: Snapshot = {
  syncedAt: Math.floor(Date.now() / 1000),
  siteUrl: "https://campusvirtual.uniovi.es",
  warnings: [],
  courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "c" }],
  resources: [
    { key: "5:/apuntes.txt", cmid: 5, courseId: 1, section: "Tema 1", name: "Apuntes tema 1", modname: "resource", url: "https://campus/r/5", filename: "apuntes.txt" },
  ],
  assignments: [{ id: 1, cmid: 9, courseId: 1, name: "Práctica 2", dueDate: soon, intro: "", url: "https://campus/a/9" }],
  events: [],
  posts: [
    { id: 10, discussionId: 1, courseId: 1, forumName: "Avisos", subject: "Parcial", author: "P", created: unix("2026-11-16T09:00:00Z"), message: "El examen parcial de termodinámica será el 3 de diciembre.", url: "https://campus/p/10" },
  ],
};

let server: Server;
let base: string;
let token: string;

before(async () => {
  await store.saveSnapshot(snap);
  const r = snap.resources[0]!;
  await store.storeFile({ ...r, filename: "apuntes.txt" }, "FIS", "text/plain", new TextEncoder().encode("Introducción\nLa termodinámica estudia la energía.\nFin"));
  token = await remote.remoteToken();
  server = (await remote.startRemote(token, 0))!;
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(() => server.close());

async function connect(url: string) {
  const client = new Client({ name: "test", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)));
  return client;
}

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

test("token is persisted and stable", async () => {
  assert.equal(await remote.remoteToken(), token);
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(remote.tokenMatches(`/mcp/${token}`, token), true);
  assert.equal(remote.tokenMatches(`/mcp/${token}/`, token), true);
  assert.equal(remote.tokenMatches(`/mcp/${token}x`, token), false);
  assert.equal(remote.tokenMatches(`/x/${token}`, token), false);
});

test("MCP over HTTP: lists tools, has instructions, calls get_deadlines", async () => {
  const client = await connect(`${base}/mcp/${token}`);
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name);
  for (const n of ["search", "fetch", "get_deadlines", "get_exam_dates", "read_material", "sync_status"]) assert.ok(names.includes(n), n);
  assert.match(client.getInstructions() ?? "", /Uniovi Virtual/);
  const deadlines = text(await client.callTool({ name: "get_deadlines", arguments: {} }));
  assert.match(deadlines, /Práctica 2/);
  await client.close();
});

test("remote mode hides local paths", async () => {
  const client = await connect(`${base}/mcp/${token}`);
  const status = text(await client.callTool({ name: "sync_status", arguments: {} }));
  assert.doesNotMatch(status, /dataDir/);
  const list = text(await client.callTool({ name: "list_materials", arguments: {} }));
  assert.doesNotMatch(list, /localPath/);
  const body = text(await client.callTool({ name: "read_material", arguments: { key: "5:/apuntes.txt" } }));
  assert.match(body, /url: https:\/\/campus\/r\/5/);
  assert.doesNotMatch(body, /localPath/);
  await client.close();
});

test("search / fetch follow the ChatGPT connector shape", async () => {
  const client = await connect(`${base}/mcp/${token}`);
  const { results } = JSON.parse(text(await client.callTool({ name: "search", arguments: { query: "termodinamica" } }))) as {
    results: Array<{ id: string; title: string; url: string }>;
  };
  assert.deepEqual(results.map((r) => r.id).sort(), ["material:5:/apuntes.txt", "post:10"]);
  for (const r of results) assert.deepEqual(Object.keys(r).sort(), ["id", "title", "url"]);

  const doc = JSON.parse(text(await client.callTool({ name: "fetch", arguments: { id: "material:5:/apuntes.txt" } })));
  assert.deepEqual(Object.keys(doc).sort(), ["id", "metadata", "text", "title", "url"]);
  assert.match(doc.text, /estudia la energía/);

  const post = JSON.parse(text(await client.callTool({ name: "fetch", arguments: { id: "post:10" } })));
  assert.match(post.text, /3 de diciembre/);

  const bad = await client.callTool({ name: "fetch", arguments: { id: "nope:1" } });
  assert.equal(bad.isError, true);
  await client.close();
});

test("wrong token or path is a plain 404", async () => {
  const init = { method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream" }, body: "{}" };
  for (const path of [`/mcp/${remote.newToken()}`, "/mcp", "/", `/api/status`, `/mcp/${token}/extra`]) {
    const res = await fetch(base + path, init);
    assert.equal(res.status, 404, path);
  }
});

test("searchAll / fetchById directly", async () => {
  const results = await mcp.searchAll(snap, "parcial");
  assert.deepEqual(results.map((r) => r.id), ["post:10"]);
  const doc = await mcp.fetchById(snap, "post:10");
  assert.equal(doc.url, "https://campus/p/10");
});

test("parses the quick-tunnel URL out of cloudflared output", () => {
  const out = `2026-11-23T10:00:00Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-23T10:00:02Z INF +--------------------------------------------------------------------------------------------+
2026-11-23T10:00:02Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-23T10:00:02Z INF |  https://seasonal-quiet-lamp-river.trycloudflare.com                                       |`;
  assert.equal(parseTunnelUrl(out), "https://seasonal-quiet-lamp-river.trycloudflare.com");
  assert.equal(parseTunnelUrl("Requesting new quick Tunnel on trycloudflare.com..."), null);
});

test("--rotate-token makes a new token (runs last: the live server keeps the old one)", async () => {
  const rotated = await remote.remoteToken(true);
  assert.notEqual(rotated, token);
  assert.equal(await remote.remoteToken(), rotated);
});

test("liveRemoteUrl only reports the URL while its process is alive (feeds /api/status → popup)", async () => {
  const state = (await store.loadRemoteState())!;
  await store.saveRemoteState({ ...state, publicUrl: "https://a.trycloudflare.com/mcp/x", pid: process.pid });
  assert.equal(await store.liveRemoteUrl(), "https://a.trycloudflare.com/mcp/x");
  await store.saveRemoteState({ ...state, publicUrl: "https://a.trycloudflare.com/mcp/x", pid: 2 ** 22 + 12345 });
  assert.equal(await store.liveRemoteUrl(), undefined);
  await store.saveRemoteState({ token: state.token });
  assert.equal(await store.liveRemoteUrl(), undefined);
});
