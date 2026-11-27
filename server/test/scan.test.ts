// The "Mis apuntes" page searches cached text only (shared/mcp/scan.ts) and so never bundles unpdf.
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";
import { searchCachedMaterials } from "../../shared/mcp/scan.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import type { Snapshot } from "../../shared/types.ts";

const file = (cmid: number, filename: string, contentType: string): StoredFile => ({
  key: `${cmid}:/${filename}`,
  path: `files/FIS/Tema 1/${filename}`,
  size: 10,
  contentType,
  timemodified: 100,
  storedAt: 100,
  resource: { key: `${cmid}:/${filename}`, cmid, courseId: 1, section: "Tema 1", name: `Material ${cmid}`, modname: "resource", url: "u", filename },
});

test("cached-only search: finds cached text, counts the rest as pending, never reads bytes", async () => {
  const files = [file(1, "tema1.pdf", "application/pdf"), file(2, "tema2.pdf", "application/pdf"), file(3, "datos.bin", "application/octet-stream")];
  const texts: Record<string, string> = { "1:/tema1.pdf": "--- page 1 ---\nIntro\n--- page 2 ---\nLa entropía crece" };
  const snap = { courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "" }] } as unknown as Snapshot;
  const store: DataStore = {
    snapshot: async () => snap,
    index: async () => Object.fromEntries(files.map((f) => [f.key, f])),
    bytes: async () => assert.fail("the page must not extract"),
    readText: async (f) => texts[f.key] ?? null,
    writeText: async () => assert.fail("the page must not write the cache"),
  };
  const r = await searchCachedMaterials(store, { query: "ENTROPIA", snapshot: snap });
  assert.equal(r.scanned, 2, "datos.bin has no text to search");
  assert.equal(r.pending, 1, "tema2.pdf isn't extracted yet");
  assert.deepEqual(
    r.results.map((h) => [h.key, h.course, h.locationKind, h.locationNumber]),
    [["1:/tema1.pdf", "FIS", "page", 2]],
  );
});

test("home.js (side panel) does not bundle the PDF parser", async () => {
  const out = await esbuild.build({
    entryPoints: [fileURLToPath(new URL("../../extension/src/home.ts", import.meta.url))],
    bundle: true,
    write: false,
    metafile: true,
    format: "esm",
    platform: "browser",
    logLevel: "silent",
  });
  const inputs = Object.keys(out.metafile.inputs);
  assert.deepEqual(inputs.filter((p) => /unpdf|shared[\\/]mcp[\\/]extract\.ts/.test(p)), []);
  assert.ok(out.outputFiles[0]!.contents.byteLength < 200_000, `home.js is ${out.outputFiles[0]!.contents.byteLength} bytes`);
});
