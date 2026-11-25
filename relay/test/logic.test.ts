import { test } from "node:test";
import assert from "node:assert/strict";
import { AGENT_PING_MS, MAX_BODY_BYTES, MAX_RESPONSE_BYTES, REQUEST_TIMEOUT_MS } from "../../shared/relay.ts";
import {
  RATE_LIMIT_PER_MINUTE,
  STALE_AFTER_MS,
  isStale,
  agentHttpResponse,
  base64ToBytes,
  bytesToBase64,
  contentLengthTooLarge,
  decodeResponseBody,
  filterHeaders,
  parseHello,
  parseResponse,
  rateAllow,
  readCapped,
  requestHeaders,
  requestTimeout,
  responseHeaders,
  route,
  sha256Hex,
  timingSafeEqual,
} from "../src/logic.ts";

const ID = "abcdefghijABCDEFGHIJ_-";
const SECRET = "a".repeat(43);

test("route: health, agent, mcp", () => {
  assert.deepEqual(route("GET", "/", ""), { kind: "health" });
  assert.deepEqual(route("HEAD", "/", ""), { kind: "health" });
  assert.deepEqual(route("POST", "/", ""), { kind: "not-found" });
  assert.deepEqual(route("GET", `/agent/${ID}`, ""), { kind: "agent", id: ID });
  assert.deepEqual(route("POST", `/agent/${ID}`, ""), { kind: "not-found" });
  assert.deepEqual(route("POST", `/mcp/${ID}/tok`, ""), { kind: "mcp", id: ID, path: "/tok" });
  assert.deepEqual(route("GET", `/mcp/${ID}/tok/x/y`, "?a=1&b=2"), { kind: "mcp", id: ID, path: "/tok/x/y?a=1&b=2" });
  assert.deepEqual(route("DELETE", `/mcp/${ID}/`, ""), { kind: "mcp", id: ID, path: "/" });
});

test("route: everything else is not-found", () => {
  for (const p of [
    "/foo",
    "/agent",
    "/agent/",
    `/agent/${ID}/x`,
    "/agent/short",
    `/agent/${ID}x`,
    "/mcp",
    `/mcp/${ID}`,
    "/mcp/bad/x",
    "/mcp/abcdefghijABCDEFGHIJ_!/x",
    `/MCP/${ID}/x`,
    `//mcp/${ID}/x`,
  ]) {
    assert.deepEqual(route("GET", p, ""), { kind: "not-found" }, p);
  }
});

test("filterHeaders keeps only allow-listed names, lower-cased", () => {
  const h = new Headers({
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
    "Mcp-Session-Id": "s",
    Authorization: "Bearer x",
    Cookie: "c=1",
    "CF-Connecting-IP": "1.2.3.4",
    "X-Forwarded-For": "1.2.3.4",
  });
  assert.deepEqual(requestHeaders(h), {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-session-id": "s",
  });
  assert.deepEqual(
    responseHeaders({ "Content-Type": "text/plain", "Set-Cookie": "x", "Cache-Control": "no-store", allow: 5, "www-authenticate": "Bearer" }),
    { "content-type": "text/plain", "cache-control": "no-store", "www-authenticate": "Bearer" },
  );
  assert.deepEqual(filterHeaders([["A", "1"], ["b", "2"]], ["a"]), { a: "1" });
});

test("contentLengthTooLarge", () => {
  assert.equal(contentLengthTooLarge(null), false);
  assert.equal(contentLengthTooLarge("abc"), false);
  assert.equal(contentLengthTooLarge(String(MAX_BODY_BYTES)), false);
  assert.equal(contentLengthTooLarge(String(MAX_BODY_BYTES + 1)), true);
  assert.equal(contentLengthTooLarge("11", 10), true);
});

const streamOf = (...chunks: number[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const n of chunks) c.enqueue(new Uint8Array(n).fill(7));
      c.close();
    },
  });

test("readCapped returns the bytes up to the cap, null above it", async () => {
  assert.equal((await readCapped(null))!.byteLength, 0);
  assert.equal((await readCapped(streamOf(3, 4), 7))!.byteLength, 7);
  assert.deepEqual([...(await readCapped(streamOf(2, 1), 7))!], [7, 7, 7]);
  assert.equal(await readCapped(streamOf(3, 4, 1), 7), null);
});

test("base64 round trip, including large and binary data", () => {
  const big = new Uint8Array(200_000).map((_, i) => i % 256);
  assert.deepEqual(base64ToBytes(bytesToBase64(big)), big);
  assert.equal(bytesToBase64(new TextEncoder().encode("hola")), "aG9sYQ==");
  assert.equal(bytesToBase64(new Uint8Array(0)), "");
});

test("parseHello", () => {
  const ok = parseHello(JSON.stringify({ type: "hello", v: 1, secret: SECRET, agent: "0.2.0" }));
  assert.deepEqual(ok, { ok: true, hello: { type: "hello", v: 1, secret: SECRET, agent: "0.2.0" } });
  assert.deepEqual(parseHello("not json"), { ok: false, reason: "bad-hello" });
  assert.deepEqual(parseHello(new ArrayBuffer(4)), { ok: false, reason: "bad-hello" });
  assert.deepEqual(parseHello(JSON.stringify({ type: "response" })), { ok: false, reason: "bad-hello" });
  assert.deepEqual(parseHello(JSON.stringify({ type: "hello", v: 2, secret: SECRET })), { ok: false, reason: "protocol" });
  assert.deepEqual(parseHello(JSON.stringify({ type: "hello", v: 1, secret: "short" })), { ok: false, reason: "bad-hello" });
  assert.deepEqual(parseHello(JSON.stringify({ type: "hello", v: 1, secret: "a".repeat(42) + "=" })), { ok: false, reason: "bad-hello" });
  assert.deepEqual(parseHello("null"), { ok: false, reason: "bad-hello" });
  const noAgent = parseHello(JSON.stringify({ type: "hello", v: 1, secret: SECRET }));
  assert.ok(noAgent.ok && noAgent.hello.agent === "");
});

test("parseResponse validates and filters headers", () => {
  const r = parseResponse(
    JSON.stringify({ type: "response", rid: "r1", status: 200, headers: { "Content-Type": "application/json", "Set-Cookie": "x" }, body: "e30=" }),
  );
  assert.deepEqual(r, { type: "response", rid: "r1", status: 200, headers: { "content-type": "application/json" }, body: "e30=" });
  assert.deepEqual(parseResponse(JSON.stringify({ type: "response", rid: "r", status: 202, headers: {} })), {
    type: "response",
    rid: "r",
    status: 202,
    headers: {},
  });
  const nl = String.fromCharCode(13, 10);
  for (const bad of [`a${nl}set-cookie: x=1`, "café ☕", `x${String.fromCharCode(0)}y`]) {
    assert.equal(parseResponse(bad), null, bad);
  }
});

test("decodeResponseBody caps the response size", () => {
  assert.equal(decodeResponseBody(undefined)!.byteLength, 0);
  assert.deepEqual([...decodeResponseBody("AQID")!], [1, 2, 3]);
  assert.equal(decodeResponseBody(bytesToBase64(new Uint8Array(10)), 10)!.byteLength, 10);
  assert.equal(decodeResponseBody(bytesToBase64(new Uint8Array(11)), 10), null);
  assert.equal(decodeResponseBody("A".repeat(Math.ceil(((MAX_RESPONSE_BYTES + 3) * 4) / 3))), null);
  assert.equal(decodeResponseBody("!!not base64!!"), null);
});

test("sha256Hex and timingSafeEqual", async () => {
  assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  const a = await sha256Hex(SECRET);
  assert.equal(timingSafeEqual(a, await sha256Hex(SECRET)), true);
  assert.equal(timingSafeEqual(a, await sha256Hex("b".repeat(43))), false);
  assert.equal(timingSafeEqual("abc", "abcd"), false);
  assert.equal(timingSafeEqual("", ""), true);
});

test("rateAllow: fixed window per minute", () => {
  const w = { start: 0, count: 0 };
  const t0 = 1_000_000;
  for (let i = 0; i < RATE_LIMIT_PER_MINUTE; i++) assert.equal(rateAllow(w, t0 + i), true);
  assert.equal(rateAllow(w, t0 + 500), false);
  assert.equal(rateAllow(w, t0 + 59_999), false);
  assert.equal(rateAllow(w, t0 + 60_000), true);
  assert.equal(w.count, 1);
});

test("isStale: a socket is dead after two missed pings plus margin, not before", () => {
  assert.equal(STALE_AFTER_MS, AGENT_PING_MS * 2 + 5_000);
  assert.equal(isStale(1_000, 1_000 + AGENT_PING_MS), false);
  assert.equal(isStale(1_000, 1_000 + STALE_AFTER_MS), false);
  assert.equal(isStale(1_000, 1_000 + STALE_AFTER_MS + 1), true);
});

test("requestTimeout only lowers the contract value", () => {
  assert.equal(requestTimeout(undefined), REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeout(""), REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeout("abc"), REQUEST_TIMEOUT_MS);
  assert.equal(requestTimeout("3000"), 3000);
  assert.equal(requestTimeout("10"), 1000);
  assert.equal(requestTimeout("999999"), REQUEST_TIMEOUT_MS);
});

test("agentHttpResponse: a malformed agent header gives null (the relay answers 502), never a throw", async () => {
  const body = new TextEncoder().encode("{}");
  const ok = agentHttpResponse({ type: "response", rid: "r", status: 200, headers: { "content-type": "application/json" } }, body);
  assert.equal(ok?.status, 200);
  assert.equal(await ok?.text(), "{}");
  const empty = agentHttpResponse({ type: "response", rid: "r", status: 204, headers: {} }, body);
  assert.equal(empty?.status, 204);
  assert.equal(empty?.body, null);
  for (const bad of ["a\r\nset-cookie: x=1", "café ☕", "x\u0000y"]) {
    // parseResponse keeps the allow-listed names; their values come from the agent unchecked.
    const parsed = parseResponse(JSON.stringify({ type: "response", rid: "r", status: 200, headers: { "content-type": bad } }));
    assert.ok(parsed, "still a well-formed frame");
    assert.equal(agentHttpResponse(parsed!, body), null, JSON.stringify(bad));
  }
});
