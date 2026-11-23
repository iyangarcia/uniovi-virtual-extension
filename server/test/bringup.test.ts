import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { tunnelLogParser } from "../src/tunnel.ts";

// Regressions found while bringing up --remote on a real machine (goals/02-next-steps.md).

process.env.UNIOVI_DATA_DIR = mkdtempSync(join(tmpdir(), "uniovi-bringup-test-"));
const store = await import("../src/store.ts");
const http = await import("../src/http.ts");

// Real cloudflared 2026.11.1 output on a network that blocks port 7844: the URL is printed,
// but no connection is ever registered, so the URL only answers Cloudflare error 1033.
const BLOCKED = `2026-11-23T17:33:27Z INF Requesting new quick Tunnel on trycloudflare.com...
2026-11-23T17:33:31Z INF +--------------------------------------------------------------------------------------------+
2026-11-23T17:33:31Z INF |  Your quick Tunnel has been created! Visit it at (it may take some time to be reachable):  |
2026-11-23T17:33:31Z INF |  https://mentor-gilbert-tim-mesh.trycloudflare.com                                         |
2026-11-23T17:33:31Z INF +--------------------------------------------------------------------------------------------+
2026-11-23T17:33:31Z INF Initial protocol quic
2026-11-23T17:33:37Z ERR Serve tunnel error error="accept stream listener error: failed to accept QUIC stream: timeout: no recent network activity" connIndex=0 event=0 ip=198.41.200.233
2026-11-23T17:33:52Z ERR Unable to establish connection with Cloudflare edge error="DialContext error: dial tcp 198.41.200.73:7844: i/o timeout" connIndex=0 event=0 ip=198.41.200.73
`;

test("tunnel URL is not announced until cloudflared registers a connection", () => {
  const parse = tunnelLogParser();
  const events = parse(BLOCKED);
  assert.deepEqual(events.filter((e) => e.type !== "error"), [{ type: "url", url: "https://mentor-gilbert-tim-mesh.trycloudflare.com" }]);
  const errors = events.flatMap((e) => (e.type === "error" ? [e.message] : []));
  assert.equal(errors.length, 2);
  assert.match(errors[0]!, /failed to accept QUIC stream/);
  assert.doesNotMatch(errors[0]!, /connIndex|ip=/);

  // Chunks split mid-line, CRLF endings, and repeated registrations (one per HA connection).
  const later = [
    ...parse("2026-11-23T17:34:00Z INF Registered tunnel conn"),
    ...parse("ection connIndex=0 connection=abc event=0 ip=198.41.200.13 location=mad01 protocol=quic\r\n"),
    ...parse("2026-11-23T17:34:01Z INF Registered tunnel connection connIndex=1 location=mad05 protocol=quic\r\n"),
  ];
  assert.deepEqual(later, [{ type: "ready", url: "https://mentor-gilbert-tim-mesh.trycloudflare.com" }]);
});

test("a registration line before any URL does not produce a ready event", () => {
  const parse = tunnelLogParser();
  assert.deepEqual(parse("x INF Registered tunnel connection connIndex=0\n"), []);
});

test("concurrent writes of remote.json don't fail (shared tmp name raced: ENOENT/EPERM)", async () => {
  const writes = Array.from({ length: 30 }, (_, i) =>
    store.saveRemoteState({ token: "t", publicUrl: i % 2 ? `https://x${i}.trycloudflare.com/mcp/t` : undefined, pid: i % 2 ? process.pid : undefined }),
  );
  const results = await Promise.allSettled(writes);
  assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
  // Writes are applied in call order, so the last one wins.
  assert.equal((await store.loadRemoteState())?.publicUrl, "https://x29.trycloudflare.com/mcp/t");
  assert.deepEqual(readdirSync(store.dataDir).filter((f) => f.endsWith(".tmp")), []);
});

test("bridge /api/status reports remoteUrl only while the --remote process is alive", async () => {
  const server = (await http.startHttp(0))!;
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    await store.saveRemoteState({ token: "t", publicUrl: "https://a.trycloudflare.com/mcp/t", pid: process.pid });
    assert.equal(((await (await fetch(`${base}/api/status`)).json()) as { remoteUrl?: string }).remoteUrl, "https://a.trycloudflare.com/mcp/t");
    await store.saveRemoteState({ token: "t" }); // what shutdown writes
    assert.equal(((await (await fetch(`${base}/api/status`)).json()) as { remoteUrl?: string }).remoteUrl, undefined);
  } finally {
    server.close();
  }
});

test("cold search answers within the budget and leaves extraction to the background indexer", async () => {
  const mcp = await import("../src/mcp.ts");
  const extract = await import("../src/extract.ts");
  const resource = { key: "7:/tema.txt", cmid: 7, courseId: 1, section: "Tema 2", name: "Tema 2", modname: "resource", url: "https://campus/r/7", filename: "tema.txt" };
  const snap = {
    syncedAt: Math.floor(Date.now() / 1000),
    siteUrl: "https://campusvirtual.uniovi.es",
    warnings: [],
    courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "c" }],
    resources: [resource],
    assignments: [],
    events: [],
    posts: [],
  } as unknown as Parameters<typeof mcp.searchMaterials>[0];
  await store.saveSnapshot(snap);
  const stored = await store.storeFile(resource as never, "FIS", "text/plain", new TextEncoder().encode("Intro\nLa TERMODINÁMICA estudia\nla energía y el calor.\nFin"));
  assert.equal(await extract.cachedTextOf(stored), null);

  const budget = mcp.searchBudget.ms;
  mcp.searchBudget.ms = 0; // budget already spent: must not extract inline
  try {
    const cold = await mcp.searchMaterials(snap, "termodinamica", undefined, 10);
    assert.deepEqual(cold.results, []);
    assert.equal(cold.pending, 1);
    await extract.warmTextCache([stored]); // what the cold search kicked off
    const warm = await mcp.searchMaterials(snap, "termodinamica energia", undefined, 10);
    assert.equal(warm.pending, 0);
    // Accent- and case-insensitive, terms may sit on adjacent lines.
    assert.deepEqual(warm.results.map((r) => r.key), ["7:/tema.txt"]);
  } finally {
    mcp.searchBudget.ms = budget;
  }
});
