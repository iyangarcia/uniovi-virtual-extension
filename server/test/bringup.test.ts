import assert from "node:assert/strict";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Snapshot } from "../../shared/types.ts";

// Regressions found while bringing up the server on a real machine (goals/02-next-steps.md).

process.env.UNIOVI_DATA_DIR = mkdtempSync(join(tmpdir(), "uniovi-bringup-test-"));
const store = await import("../src/store.ts");

test("concurrent writes of one JSON file don't fail (a shared tmp name raced: ENOENT/EPERM)", async () => {
  const base = { siteUrl: "x", warnings: [], courses: [], resources: [], assignments: [], events: [], posts: [] };
  const writes = Array.from({ length: 30 }, (_, i) => store.saveSnapshot({ ...base, syncedAt: i } as never));
  const results = await Promise.allSettled(writes);
  assert.deepEqual(results.filter((r) => r.status === "rejected"), []);
  // Writes are applied in call order, so the last one wins.
  assert.equal((await store.loadSnapshot())?.syncedAt, 29);
  assert.deepEqual(readdirSync(store.dataDir).filter((f) => f.endsWith(".tmp")), []);
});

test("cold search answers within the budget and leaves extraction to the background indexer", async () => {
  const search = await import("../../shared/mcp/search.ts");
  const core = await import("../../shared/mcp/extract.ts");
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
  } as unknown as Snapshot;
  await store.saveSnapshot(snap);
  const stored = await store.storeFile(resource as never, "FIS", "text/plain", new TextEncoder().encode("Intro\nLa TERMODINÁMICA estudia\nla energía y el calor.\nFin"));
  assert.equal(await extract.cachedTextOf(stored), null);

  const budget = search.searchBudget.ms;
  search.searchBudget.ms = 0; // budget already spent: must not extract inline
  try {
    const cold = await search.searchMaterials(store.nodeStore, { snapshot: snap, query: "termodinamica", limit: 10 });
    assert.deepEqual(cold.results, []);
    assert.equal(cold.pending, 1);
    await core.warmTextCache(store.nodeStore, [stored]); // what the cold search kicked off
    const warm = await search.searchMaterials(store.nodeStore, { snapshot: snap, query: "termodinamica energia", limit: 10 });
    assert.equal(warm.pending, 0);
    // Accent- and case-insensitive, terms may sit on adjacent lines.
    assert.deepEqual(warm.results.map((r) => r.key), ["7:/tema.txt"]);
  } finally {
    search.searchBudget.ms = budget;
  }
});
