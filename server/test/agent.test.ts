// The extension's relay agent (extension/src/agent/): pure helpers, and the real connection + MCP
// handler against a fake relay that implements shared/relay.ts (test/helpers/fake-relay.ts).
import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { AgentConnection } from "../../extension/src/agent/connection.ts";
import { mcpHandler } from "../../extension/src/agent/mcp.ts";
import {
  answer,
  backoffMs,
  filterHeaders,
  fromBase64,
  isValidIdentity,
  newIdentity,
  parseRelayMessage,
  pathHasToken,
  safeEqual,
  toBase64,
} from "../../extension/src/agent/protocol.ts";
import { aiConnectionEnabled, relayBases, type AgentStateName } from "../../extension/src/agent/state.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import { connectorUrl, ID_RE, MAX_INFLIGHT, SECRET_RE, TOKEN_RE, type RelayRequest } from "../../shared/relay.ts";
import type { Snapshot } from "../../shared/types.ts";
import { startFakeRelay, type FakeRelay } from "./helpers/fake-relay.ts";

// ---------------------------------------------------------------- pure helpers

test("identity: id/token 22 chars, secret 43, base64url, all different", () => {
  const a = newIdentity();
  const b = newIdentity();
  assert.match(a.id, ID_RE);
  assert.match(a.token, TOKEN_RE);
  assert.match(a.secret, SECRET_RE);
  assert.ok(isValidIdentity(a));
  assert.notEqual(a.id, b.id);
  assert.notEqual(a.secret, b.secret);
  assert.equal(isValidIdentity({ ...a, token: "short" }), false);
  assert.equal(isValidIdentity(null), false);
});

test("token check: /<token>, /<token>/…, ?query; anything else is 404", () => {
  const t = "abcdefghijklmnopqrstuv";
  assert.ok(pathHasToken(`/${t}`, t));
  assert.ok(pathHasToken(`/${t}/`, t));
  assert.ok(pathHasToken(`/${t}/sub/path`, t));
  assert.ok(pathHasToken(`/${t}?x=1`, t));
  for (const p of ["", "/", t, `/${t}x`, `/${t.slice(0, -1)}`, `//${t}`, `/x/${t}`, `/${t.toUpperCase()}`]) assert.equal(pathHasToken(p, t), false, p);
  assert.ok(safeEqual("abc", "abc"));
  assert.equal(safeEqual("abd", "abc"), false);
  assert.equal(safeEqual("ab", "abc"), false);
  assert.equal(safeEqual("abcd", "abc"), false);
});

test("relay message parsing rejects malformed frames", () => {
  assert.deepEqual(parseRelayMessage('{"type":"welcome","v":1}'), { type: "welcome", v: 1 });
  assert.deepEqual(parseRelayMessage('{"type":"rejected","reason":"bad-secret"}'), { type: "rejected", reason: "bad-secret" });
  const r = parseRelayMessage('{"type":"request","rid":"1","method":"POST","path":"/t","headers":{"accept":"x","n":5}}');
  assert.deepEqual(r, { type: "request", rid: "1", method: "POST", path: "/t", headers: { accept: "x" }, body: undefined });
  for (const bad of ["pong", "{", "null", "[]", '{"type":"request","rid":1}', '{"type":"request","rid":"1","method":"POST","path":"/","body":5}', '{"type":"x"}', 42])
    assert.equal(parseRelayMessage(bad), null, String(bad));
});

test("header allow-lists, base64 round trip", () => {
  assert.deepEqual(filterHeaders({ "Content-Type": "a", Cookie: "s", accept: "b" }, ["content-type", "accept"]), { "content-type": "a", accept: "b" });
  assert.deepEqual(filterHeaders(new Headers({ "set-cookie": "x", "mcp-session-id": "s" }), ["mcp-session-id"]), { "mcp-session-id": "s" });
  const bytes = new Uint8Array(70_000).map((_, i) => i % 251);
  assert.deepEqual(fromBase64(toBase64(bytes)), bytes);
});

test("backoff: 1 s doubling to 60 s, ±25 % jitter", () => {
  const mid = () => 0.5;
  assert.deepEqual([0, 1, 2, 3, 4, 5, 6, 7, 50].map((a) => backoffMs(a, mid)), [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000, 60000]);
  assert.equal(backoffMs(0, () => 0), 750);
  assert.equal(backoffMs(10, () => 1), 75000);
});

test("state helpers: aiConnection defaults on; relay bases from http or ws", () => {
  assert.ok(aiConnectionEnabled(undefined));
  assert.ok(aiConnectionEnabled(true));
  assert.equal(aiConnectionEnabled(false), false);
  assert.deepEqual(relayBases(undefined, "https://r.example.dev"), { http: "https://r.example.dev", ws: "wss://r.example.dev" });
  assert.deepEqual(relayBases("ws://127.0.0.1:48900/", "https://r"), { http: "http://127.0.0.1:48900", ws: "ws://127.0.0.1:48900" });
  assert.deepEqual(relayBases("http://127.0.0.1:1", "https://r"), { http: "http://127.0.0.1:1", ws: "ws://127.0.0.1:1" });
  assert.deepEqual(relayBases("javascript:alert(1)", "https://r"), { http: "https://r", ws: "wss://r" });
});

test("answer(): 404 wrong token, 405 non-POST, headers filtered both ways", async () => {
  const token = "abcdefghijklmnopqrstuv";
  let seen: Headers | undefined;
  const handler = async (req: Request) => {
    seen = req.headers;
    return new Response("{}", { status: 200, headers: { "content-type": "application/json", "set-cookie": "x", "mcp-session-id": "s" } });
  };
  const req = (path: string, method = "POST"): RelayRequest => ({
    type: "request",
    rid: "r1",
    method,
    path,
    headers: { "content-type": "application/json", cookie: "secret", accept: "application/json" },
    body: toBase64(new TextEncoder().encode("{}")),
  });
  assert.equal((await answer(req("/wrong"), token, handler)).status, 404);
  assert.equal(seen, undefined);
  const get = await answer(req(`/${token}`, "GET"), token, handler);
  assert.equal(get.status, 405);
  assert.equal(get.headers.allow, "POST");
  const ok = await answer(req(`/${token}`), token, handler);
  assert.equal(ok.status, 200);
  assert.equal(ok.rid, "r1");
  assert.deepEqual(ok.headers, { "content-type": "application/json", "mcp-session-id": "s" });
  assert.equal(seen!.get("cookie"), null);
  assert.equal(seen!.get("accept"), "application/json");
  const boom = await answer(req(`/${token}`), token, async () => {
    throw new Error("boom");
  });
  assert.equal(boom.status, 500);
});

// ---------------------------------------------------------------- end to end over a fake relay

const snap: Snapshot = {
  syncedAt: Math.floor(Date.now() / 1000),
  siteUrl: "https://campusvirtual.uniovi.es",
  warnings: [],
  courses: [{ id: 1, shortname: "DCIV", fullname: "Derecho Civil", url: "c1" }],
  resources: [{ key: "1:/tema1.txt", cmid: 1, courseId: 1, section: "Tema 1", name: "Tema 1", modname: "resource", url: "u", filename: "tema1.txt" }],
  assignments: [{ id: 1, cmid: 2, courseId: 1, name: "Comentario de sentencia", dueDate: Math.floor(Date.now() / 1000) + 86400 * 3, intro: "", url: "a" }],
  events: [],
  posts: [],
};

function memoryStore(): DataStore {
  const text = "La usucapión es un modo de adquirir la propiedad.";
  const f: StoredFile = {
    key: "1:/tema1.txt",
    path: "files/DCIV/Tema 1/tema1.txt",
    size: text.length,
    contentType: "text/plain",
    timemodified: 1,
    storedAt: 1,
    resource: snap.resources[0]!,
  };
  const texts = new Map<string, string>();
  return {
    snapshot: async () => snap,
    index: async () => ({ [f.key]: f }),
    bytes: async () => new TextEncoder().encode(text),
    readText: async (x) => texts.get(x.key) ?? null,
    writeText: async (x, t) => void texts.set(x.key, t),
  };
}

let relay: FakeRelay;
before(async () => {
  relay = await startFakeRelay();
});
after(async () => {
  await relay.close();
});

const waitFor = async (cond: () => boolean, ms = 5000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("timeout");
    await new Promise((r) => setTimeout(r, 10));
  }
};

function makeAgent(identity = newIdentity(), extra: Partial<ConstructorParameters<typeof AgentConnection>[0]> = {}) {
  const states: AgentStateName[] = [];
  const conn = new AgentConnection({
    url: `${relay.url.replace(/^http/, "ws")}/agent/${identity.id}`,
    secret: identity.secret,
    token: () => identity.token,
    version: "test",
    handler: mcpHandler(memoryStore(), "test"),
    onState: (s) => states.push(s),
    random: () => 0, // shortest backoff (750 ms) keeps the test fast
    ...extra,
  });
  return { conn, identity, states };
}

test("MCP tool calls through the relay to the agent; wrong token 404; stop disconnects", async () => {
  const { conn, identity, states } = makeAgent();
  conn.start();
  await waitFor(() => conn.state === "connected");
  assert.deepEqual(states.slice(0, 2), ["connecting", "connected"]);

  const client = new Client({ name: "t", version: "0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(connectorUrl(identity.id, identity.token, relay.url))));
  const tools = await client.listTools();
  assert.ok(tools.tools.some((t) => t.name === "read_material"));
  const calls: Array<[string, Record<string, unknown>, RegExp]> = [
    ["list_courses", {}, /Derecho Civil/],
    ["get_deadlines", { daysAhead: 14 }, /Comentario de sentencia/],
    ["list_materials", {}, /tema1\.txt/],
    ["read_material", { key: "1:/tema1.txt" }, /usucapión/],
    ["search_materials", { query: "usucapion" }, /usucapi/],
  ];
  for (const [name, args, re] of calls) {
    const r = await client.callTool({ name, arguments: args });
    const text = (r.content as Array<{ text: string }>).map((c) => c.text).join("\n");
    assert.match(text, re, `${name}: ${text.slice(0, 300)}`);
    assert.doesNotMatch(text, /localPath|dataDir/);
  }
  await client.close();

  const bad = await fetch(connectorUrl(identity.id, "x".repeat(22), relay.url), { method: "POST", body: "{}" });
  assert.equal(bad.status, 404);

  conn.stop();
  assert.equal(conn.state, "off");
  await waitFor(() => !relay.agents.has(identity.id));
  const gone = await fetch(connectorUrl(identity.id, identity.token, relay.url), { method: "POST", body: "{}" });
  assert.equal(gone.status, 503);
});

test("reconnects with backoff after the socket drops", async () => {
  const { conn, identity, states } = makeAgent();
  conn.start();
  await waitFor(() => conn.state === "connected");
  relay.killAgents();
  await waitFor(() => states.includes("offline"));
  await waitFor(() => conn.state === "connected" && relay.agents.has(identity.id), 4000);
  assert.ok(states.filter((s) => s === "connected").length >= 2);
  conn.stop();
});

test("a wrong secret is rejected and not retried", async () => {
  const owner = makeAgent();
  owner.conn.start();
  await waitFor(() => owner.conn.state === "connected");
  owner.conn.stop();
  const thief = makeAgent({ ...newIdentity(), id: owner.identity.id });
  thief.conn.start();
  await waitFor(() => thief.conn.state === "rejected");
  await new Promise((r) => setTimeout(r, 1200)); // longer than the shortest backoff
  assert.equal(thief.states.filter((s) => s === "connecting").length, 1);
  assert.equal(thief.conn.active, false);
});

test("requests beyond MAX_INFLIGHT get 503 from the agent (injected fake socket)", async () => {
  const sent: string[] = [];
  const fake = {
    readyState: 1,
    send: (d: string) => void sent.push(d),
    close: () => undefined,
    onopen: null as ((ev: unknown) => void) | null,
    onmessage: null as ((ev: { data: unknown }) => void) | null,
    onclose: null as ((ev: { code?: number }) => void) | null,
    onerror: null as ((ev: unknown) => void) | null,
  };
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const id = newIdentity();
  const conn = new AgentConnection({
    url: "ws://fake/agent/x",
    secret: id.secret,
    token: () => id.token,
    version: "test",
    handler: async () => {
      await gate;
      return new Response("{}", { headers: { "content-type": "application/json" } });
    },
    wsFactory: () => fake,
  });
  conn.start();
  fake.onopen!({});
  assert.deepEqual(JSON.parse(sent[0]!), { type: "hello", v: 1, secret: id.secret, agent: "test" });
  fake.onmessage!({ data: '{"type":"welcome","v":1}' });
  assert.equal(conn.state, "connected");
  for (let i = 0; i <= MAX_INFLIGHT; i++)
    fake.onmessage!({ data: JSON.stringify({ type: "request", rid: `r${i}`, method: "POST", path: `/${id.token}`, headers: {} }) });
  assert.equal(conn.inFlight, MAX_INFLIGHT);
  await waitFor(() => sent.length === 2);
  const busy = JSON.parse(sent[1]!);
  assert.equal(busy.rid, `r${MAX_INFLIGHT}`);
  assert.equal(busy.status, 503);
  release();
  await waitFor(() => sent.length === 2 + MAX_INFLIGHT);
  assert.ok(sent.slice(2).every((m) => JSON.parse(m).status === 200));
  assert.equal(conn.inFlight, 0);
  conn.stop();
});
