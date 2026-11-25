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
      "get_grades",
      "get_teachers",
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
    assert.match(text(await local.callTool({ name: "list_materials", arguments: {} })), /"localPath":"\/data\/files\/FIS\/Tema 1\/notas.txt"/);
    assert.match(text(await local.callTool({ name: "sync_status", arguments: {} })), /"dataDir":"\/data"/);
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

test("tool output is compact JSON, with short file types", async () => {
  const c = await connect(memoryStore().store, true);
  try {
    const out = text(await c.callTool({ name: "list_materials", arguments: {} }));
    assert.doesNotMatch(out, /\n|": /, "no indentation or spacing");
    const items = JSON.parse(out) as Array<{ key: string; type?: string }>;
    assert.deepEqual(
      items.map((i) => i.type),
      ["text/plain", "pptx", "docx", "application/octet-stream"],
    );
    assert.doesNotMatch(text(await c.callTool({ name: "sync_status", arguments: {} })), /\n/);
  } finally {
    await c.close();
  }
});

test("read_material returns 15000 chars by default and says how to continue", async () => {
  const long = Array.from({ length: 4000 }, (_, i) => `linea ${i}`).join("\n");
  const r = resource(9, 1, "Tema 9", "largo.txt");
  const f: StoredFile = { key: r.key, path: "files/FIS/Tema 9/largo.txt", size: long.length, contentType: "text/plain", timemodified: 1, storedAt: 1, resource: r };
  const store: DataStore = {
    snapshot: async () => ({ ...snap, resources: [r] }),
    index: async () => ({ [r.key]: f }),
    bytes: async () => strToU8(long),
    readText: async () => null,
    writeText: async () => {},
  };
  const c = await connect(store, true);
  try {
    const out = text(await c.callTool({ name: "read_material", arguments: { key: r.key } }));
    assert.ok(out.includes(`chars 0-15000 of ${long.length} (nextOffset: 15000)`));
    const page = out.slice(out.indexOf("\n\n") + 2);
    assert.ok(page.startsWith(long.slice(0, 15000)));
    assert.ok(page.endsWith(`\n\n[${long.length - 15000} more chars: call read_material with offset 15000 to continue.]`));
    assert.ok(out.length < 15_300);
    // The next page continues where the first stopped; fetch is capped the same way.
    assert.match(text(await c.callTool({ name: "read_material", arguments: { key: r.key, offset: 15000 } })), /chars 15000-30000 of/);
    const fetched = JSON.parse(text(await c.callTool({ name: "fetch", arguments: { id: `material:${r.key}` } }))) as { text: string };
    assert.match(fetched.text, /nextOffset: 15000/);
  } finally {
    await c.close();
  }
});

test("activities stored as text (extension/src/activity.ts): named by kind, readable and searchable", async () => {
  const items: Array<[Resource & { filename: string }, string]> = [
    [{ key: "22:link", cmid: 22, courseId: 1, section: "Tema 1", name: "Comentario de sentencia", modname: "assign", url: "u22", filename: "Comentario de sentencia.txt" }, "Fecha de entrega: 10 de diciembre\nComenta la sentencia en 3 páginas."],
    [{ key: "21:link", cmid: 21, courseId: 1, section: "Tema 1", name: "Test del tema 1", modname: "quiz", url: "u21", filename: "Test del tema 1.txt" }, "Intentos permitidos: 1"],
    [{ key: "12:link", cmid: 12, courseId: 1, section: "", name: "Código Civil", modname: "url", url: "https://www.boe.es/x", filename: "Código Civil.txt" }, "https://www.boe.es/x"],
    [{ key: "course1:page", cmid: 0, courseId: 1, section: "", name: "Página de la asignatura FIS", modname: "coursepage", url: "c1", filename: "Página de la asignatura FIS.txt" }, "Profesora responsable: Ana Fernández"],
    [{ key: "22:file:/mod_assign/introattachment/0/sentencia.pdf", cmid: 22, courseId: 1, section: "Tema 1", name: "Comentario de sentencia: sentencia.pdf", modname: "activity-file", url: "u", filename: "sentencia.pdf", mimetype: "application/pdf" }, ""],
  ];
  const index = Object.fromEntries(
    items.filter(([r]) => r.modname !== "activity-file").map(([r, t]) => [r.key, { key: r.key, path: `files/FIS/${r.section}/${r.filename}`, size: strToU8(t).length, contentType: "text/plain", timemodified: 1, storedAt: 1, resource: r } satisfies StoredFile]),
  );
  const store: DataStore = {
    snapshot: async () => ({ ...snap, resources: items.map(([r]) => r) }),
    index: async () => index,
    bytes: async (f) => strToU8(items.find(([r]) => r.key === f.key)![1]),
    readText: async () => null,
    writeText: async () => {},
  };
  const c = await connect(store, true);
  try {
    const list = JSON.parse(text(await c.callTool({ name: "list_materials", arguments: {} }))) as Array<{ key: string; type?: string; url: string }>;
    assert.deepEqual(list.map((i) => i.type), ["assignment", "quiz", "link", "course page", "pdf"]);
    assert.match(text(await c.callTool({ name: "read_material", arguments: { key: "22:link" } })), /Comenta la sentencia en 3 páginas/);
    assert.match(text(await c.callTool({ name: "search_materials", arguments: { query: "Fernández" } })), /course1:page/);
  } finally {
    await c.close();
  }
});

test("get_grades, get_teachers and my groups", async () => {
  const s: Snapshot = {
    ...snap,
    grades: [
      { courseId: 1, category: ["Teoría"], name: "Parcial 1", kind: "Elemento manual", total: false, grade: "7,50", range: "0–10", percentage: "75,00 %", feedback: "Bien", contribution: "-" },
      { courseId: 1, category: ["Teoría"], name: "Test 1", kind: "Cuestionario", total: false, grade: "-", range: "0–10", percentage: "-" },
      { courseId: 1, category: [], name: "Total del curso", kind: "Cálculo total", total: true, grade: "-", range: "0–10" },
      { courseId: 2, category: [], name: "Examen", total: false, grade: "9,00", range: "0–10" },
    ],
    teachers: [
      { courseId: 1, name: "FERNÁNDEZ LÓPEZ,ANA", role: "Profesor", groups: ["PA-01", "PA-02"] },
      { courseId: 1, name: "GARCÍA RUIZ,PEDRO", role: "Profesor", groups: ["PA-01"] },
    ],
    myGroups: { 1: ["PA-02"] },
  };
  const store = (snapshot: Snapshot): DataStore => ({ snapshot: async () => snapshot, index: async () => ({}), bytes: async () => new Uint8Array(), readText: async () => null, writeText: async () => {} });
  const c = await connect(store(s), true);
  try {
    const grades = JSON.parse(text(await c.callTool({ name: "get_grades", arguments: { course: "FIS", gradedOnly: true } }))) as Array<{ course: string; items: Array<Record<string, unknown>> }>;
    assert.equal(grades.length, 1);
    assert.deepEqual(grades[0]!.items.map((i) => i.name), ["Parcial 1", "Total del curso"]);
    assert.deepEqual(grades[0]!.items[0], { category: "Teoría", name: "Parcial 1", kind: "Elemento manual", grade: "7,50", range: "0–10", percentage: "75,00 %", feedback: "Bien" });
    const all = JSON.parse(text(await c.callTool({ name: "get_grades", arguments: {} }))) as Array<{ items: unknown[] }>;
    assert.deepEqual(all.map((x) => x.items.length), [3, 1]);
    const teachers = JSON.parse(text(await c.callTool({ name: "get_teachers", arguments: { course: "FIS" } }))) as Array<{ myGroups: string[]; teachers: Array<{ name: string; sharesMyGroups: string[] }> }>;
    assert.deepEqual(teachers[0]!.myGroups, ["PA-02"]);
    assert.deepEqual(teachers[0]!.teachers.map((t) => [t.name, t.sharesMyGroups]), [["FERNÁNDEZ LÓPEZ,ANA", ["PA-02"]], ["GARCÍA RUIZ,PEDRO", []]]);
    assert.match(text(await c.callTool({ name: "list_courses", arguments: {} })), /"myGroups":\["PA-02"\]/);
  } finally {
    await c.close();
  }
  // Grades switched off in the extension: the snapshot has no `grades`, and the tool says why.
  const { grades: _off, ...noGrades } = s;
  const c2 = await connect(store(noGrades), true);
  try {
    assert.match(text(await c2.callTool({ name: "get_grades", arguments: {} })), /turned them off/);
  } finally {
    await c2.close();
  }
});

test("search_forums: 15 posts by default, excerpts flattened and cut at 300 chars", async () => {
  const body = `Primera línea\n\n${"x".repeat(500)}`;
  const posts = Array.from({ length: 20 }, (_, i) => ({
    id: i + 1,
    discussionId: i + 1,
    courseId: 1,
    forumName: "Avisos",
    subject: `Aviso ${i + 1}`,
    author: "Profe",
    created: snap.syncedAt - i * 60,
    message: body,
    url: `https://campus/d/${i + 1}`,
  }));
  const store: DataStore = { ...memoryStore().store, snapshot: async () => ({ ...snap, posts } as Snapshot) };
  const c = await connect(store, true);
  try {
    const list = JSON.parse(text(await c.callTool({ name: "search_forums", arguments: {} }))) as Array<{ id: number; excerpt: string; url: string }>;
    assert.equal(list.length, 15);
    assert.equal(list[0]!.id, 1);
    assert.equal(list[0]!.url, "https://campus/d/1");
    assert.equal(list[0]!.excerpt, `Primera línea ${"x".repeat(286)}…`);
    assert.equal(JSON.parse(text(await c.callTool({ name: "search_forums", arguments: { limit: 20 } }))).length, 20);
  } finally {
    await c.close();
  }
});
