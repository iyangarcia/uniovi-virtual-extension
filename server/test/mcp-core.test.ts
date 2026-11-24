// The shared MCP core (shared/mcp/) against an in-memory DataStore: no disk, no server modules.
import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { extname, kindOf, textOf, warmTextCache } from "../../shared/mcp/extract.ts";
import { searchBudget, searchMaterials } from "../../shared/mcp/search.ts";
import { createMcpServer } from "../../shared/mcp/server.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import type { Resource, Snapshot } from "../../shared/types.ts";

const P = "http://schemas.openxmlformats.org";
const docx = (paragraphs: string[]) =>
  zipSync({
    "word/document.xml": strToU8(
      `<?xml version="1.0"?><w:document xmlns:w="${P}/wordprocessingml/2006/main"><w:body>${paragraphs
        .map((p) => `<w:p><w:r><w:t>${p}</w:t></w:r></w:p>`)
        .join("")}</w:body></w:document>`,
    ),
  });
const slide = (lines: string[]) =>
  strToU8(
    `<?xml version="1.0"?><p:sld xmlns:a="${P}/drawingml/2006/main" xmlns:p="${P}/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${lines
      .map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`)
      .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`,
  );
const pptx = () => zipSync({ "ppt/slides/slide1.xml": slide(["Introducción"]), "ppt/slides/slide2.xml": slide(["La entropía crece", "siempre"]) });

const resource = (cmid: number, courseId: number, section: string, filename: string): Resource & { filename: string } => ({
  key: `${cmid}:/${filename}`,
  cmid,
  courseId,
  section,
  name: `Material ${cmid}`,
  modname: "resource",
  url: `https://campus/r/${cmid}`,
  filename,
});

const snap: Snapshot = {
  syncedAt: Math.floor(Date.now() / 1000),
  siteUrl: "https://campusvirtual.uniovi.es",
  warnings: [],
  courses: [
    { id: 1, shortname: "FIS", fullname: "Física", url: "c1" },
    { id: 2, shortname: "MAT", fullname: "Matemáticas", url: "c2" },
  ],
  resources: [],
  assignments: [],
  events: [],
  posts: [],
};

const contents: Array<[Resource & { filename: string }, string, Uint8Array]> = [
  [resource(1, 1, "Tema 1", "notas.txt"), "text/plain", strToU8("Intro\nLa TERMODINÁMICA estudia\nla energía.")],
  [resource(2, 1, "Tema 2", "tema2.pptx"), "application/vnd.openxmlformats-officedocument.presentationml.presentation", pptx()],
  [resource(3, 2, "Tema 1", "guion.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", docx(["Entropía y matrices"])],
  [resource(4, 2, "Tema 1", "datos.bin"), "application/octet-stream", new Uint8Array([0, 1, 2])],
];
snap.resources = contents.map(([r]) => r);

/** A Map of bytes plus a text cache, counting byte reads (one per extraction). */
function memoryStore(opts: { local?: boolean } = {}) {
  const bytes = new Map<string, Uint8Array>();
  const index: Record<string, StoredFile> = {};
  const texts = new Map<string, string>();
  const stats = { bytes: 0, readText: 0 };
  for (const [r, contentType, b] of contents) {
    const f: StoredFile = {
      key: r.key,
      path: `files/${snap.courses.find((c) => c.id === r.courseId)!.shortname}/${r.section}/${r.filename}`,
      size: b.byteLength,
      contentType,
      timemodified: 100,
      storedAt: 100,
      resource: r,
    };
    index[r.key] = f;
    bytes.set(r.key, b);
  }
  const id = (f: StoredFile) => `${f.key}|${f.timemodified}|${f.size}`;
  const store: DataStore = {
    snapshot: async () => snap,
    index: async () => index,
    bytes: async (f) => {
      stats.bytes++;
      const b = bytes.get(f.key);
      if (!b) throw new Error(`missing ${f.key}`);
      return b;
    },
    readText: async (f) => {
      stats.readText++;
      return texts.get(id(f)) ?? null;
    },
    writeText: async (f, t) => {
      texts.set(id(f), t);
    },
    ...(opts.local ? { localPath: (f: StoredFile) => `/data/${f.path}`, dataDir: "/data" } : {}),
  };
  return { store, index, texts, stats };
}

test("extname and kindOf work without node:path", () => {
  assert.equal(extname("files/a.b/tema.PDF"), ".PDF");
  assert.equal(extname("files/x/.hidden"), "");
  assert.equal(extname("files/x/sin"), "");
  const { index } = memoryStore();
  assert.deepEqual(
    Object.values(index).map((f) => kindOf(f)),
    ["text", "pptx", "docx", "other"],
  );
  assert.equal(kindOf({ path: "x/download", contentType: "application/pdf" }), "pdf");
  assert.equal(kindOf({ path: "x/readme", contentType: "text/markdown" }), "text");
});

test("textOf extracts once, then reads the store's cache; concurrent calls share one extraction", async () => {
  const { store, index, texts, stats } = memoryStore();
  const f = index["2:/tema2.pptx"]!;
  const [a, b] = await Promise.all([textOf(store, f), textOf(store, f)]);
  assert.equal(a, "--- slide 1 ---\nIntroducción\n\n--- slide 2 ---\nLa entropía crece\nsiempre");
  assert.equal(b, a);
  assert.equal(stats.bytes, 1);
  assert.equal(texts.size, 1);
  assert.equal(await textOf(store, f), a);
  assert.equal(stats.bytes, 1, "second call came from the cache");
  assert.equal(await textOf(store, index["3:/guion.docx"]!), "Entropía y matrices");
  assert.equal(await textOf(store, index["4:/datos.bin"]!), null);
});

test("searchMaterials returns structured hits with course, section and page/slide", async () => {
  const { store } = memoryStore();
  const { results, scanned, pending } = await searchMaterials(store, { query: "entropia" });
  assert.equal(scanned, 3);
  assert.equal(pending, 0);
  assert.deepEqual(results, [
    {
      key: "2:/tema2.pptx",
      courseId: 1,
      course: "FIS",
      section: "Tema 2",
      name: "Material 2",
      filename: "tema2.pptx",
      location: "slide 2",
      locationKind: "slide",
      locationNumber: 2,
      snippet: "--- slide 2 --- La entropía crece siempre",
    },
    {
      key: "3:/guion.docx",
      courseId: 2,
      course: "MAT",
      section: "Tema 1",
      name: "Material 3",
      filename: "guion.docx",
      location: "",
      locationKind: undefined,
      locationNumber: undefined,
      snippet: "Entropía y matrices",
    },
  ]);
  // Course filters: by name (as the tools take it) and by id.
  assert.deepEqual((await searchMaterials(store, { query: "entropia", course: "matemat" })).results.map((h) => h.key), ["3:/guion.docx"]);
  assert.deepEqual((await searchMaterials(store, { query: "entropia", courseId: 1 })).results.map((h) => h.key), ["2:/tema2.pptx"]);
  assert.equal((await searchMaterials(store, { query: "entropia", limit: 1 })).results.length, 1);
  // Accent/case-insensitive, terms on adjacent lines.
  assert.deepEqual((await searchMaterials(store, { query: "termodinamica energia" })).results.map((h) => h.key), ["1:/notas.txt"]);
});

test("searchMaterials past the budget answers from the cache and leaves extraction to the warmer", async () => {
  const { store, stats } = memoryStore();
  const saved = searchBudget.ms;
  searchBudget.ms = 0;
  try {
    const cold = await searchMaterials(store, { query: "entropia" });
    assert.deepEqual(cold.results, []);
    assert.equal(cold.pending, 3);
    await warmTextCache(store, Object.values(await store.index()));
    assert.equal(stats.bytes, 3);
    const warm = await searchMaterials(store, { query: "entropia" });
    assert.equal(warm.pending, 0);
    assert.equal(warm.results.length, 2);
  } finally {
    searchBudget.ms = saved;
  }
});

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

async function connect(store: DataStore, remote: boolean) {
  const server = createMcpServer(store, { remote, version: "9.9.9" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}

test("MCP round trip: tools listed, version passed, local paths only in local mode", async () => {
  const { store } = memoryStore({ local: true });
  const remote = await connect(store, true);
  try {
    assert.equal(remote.getServerVersion()?.version, "9.9.9");
    const names = (await remote.listTools()).tools.map((t) => t.name).sort();
    assert.deepEqual(names, [
      "fetch",
      "get_deadlines",
      "get_exam_dates",
      "get_forum_post",
      "list_courses",
      "list_materials",
      "read_material",
      "search",
      "search_forums",
      "search_materials",
      "sync_status",
    ]);
    assert.deepEqual((await remote.listPrompts()).prompts.map((p) => p.name).sort(), ["estudiar_tema", "preparar_examen", "semana"]);
    assert.doesNotMatch(text(await remote.callTool({ name: "list_materials", arguments: {} })), /localPath|\/data\//);
    assert.doesNotMatch(text(await remote.callTool({ name: "sync_status", arguments: {} })), /dataDir/);
    const bin = text(await remote.callTool({ name: "read_material", arguments: { key: "4:/datos.bin" } }));
    assert.match(bin, /https:\/\/campus\/r\/4/);
    assert.doesNotMatch(bin, /localPath/);
    const doc = text(await remote.callTool({ name: "read_material", arguments: { key: "1:/notas.txt" } }));
    assert.match(doc, /url: https:\/\/campus\/r\/1/);
    const hits = JSON.parse(text(await remote.callTool({ name: "search_materials", arguments: { query: "entropia" } })));
    assert.deepEqual(hits[0], { key: "2:/tema2.pptx", file: "Material 2 (tema2.pptx)", location: "slide 2", snippet: "--- slide 2 --- La entropía crece siempre" });
  } finally {
    await remote.close();
  }

  const local = await connect(store, false);
  try {
    assert.match(text(await local.callTool({ name: "list_materials", arguments: {} })), /"localPath": "\/data\/files\/FIS\/Tema 1\/notas.txt"/);
    assert.match(text(await local.callTool({ name: "sync_status", arguments: {} })), /"dataDir": "\/data"/);
    assert.match(text(await local.callTool({ name: "read_material", arguments: { key: "1:/notas.txt" } })), /localPath: \/data\/files/);
  } finally {
    await local.close();
  }

  // A store without local extras (the extension) never shows paths, even in local mode.
  const ext = await connect(memoryStore().store, false);
  try {
    assert.doesNotMatch(text(await ext.callTool({ name: "list_materials", arguments: {} })), /localPath/);
    assert.match(text(await ext.callTool({ name: "read_material", arguments: { key: "4:/datos.bin" } })), /https:\/\/campus\/r\/4/);
  } finally {
    await ext.close();
  }
});
