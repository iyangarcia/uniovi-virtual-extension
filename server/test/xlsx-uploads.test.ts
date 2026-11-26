// Spreadsheets (xlsx extraction in shared/mcp/extract.ts) and the student's own uploads («Mis archivos»)
// in every MCP tool, against an in-memory DataStore.
import assert from "node:assert/strict";
import { test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { isUploadsFilter } from "../../shared/mcp/common.ts";
import { excelDate, kindOf, xlsxText } from "../../shared/mcp/extract.ts";
import { searchCachedMaterials } from "../../shared/mcp/scan.ts";
import { createMcpServer } from "../../shared/mcp/server.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import { type Resource, type Snapshot, UPLOAD_SECTION } from "../../shared/types.ts";

const XLSX = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
const NS = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';

const shared = [
  "Asignatura", // 0
  "Fecha", // 1
  "Aula", // 2
  "Introducción al Derecho", // 3
  "", // 4
  "I+D &amp; Co", // 5
];
const sharedXml = `<?xml version="1.0"?><sst ${NS}>${shared.map((s) => `<si><t>${s}</t></si>`).join("")}<si><r><rPr><b/></rPr><t xml:space="preserve">Derecho </t></r><r><t>Civil</t></r></si><si><t>漢</t><rPh sb="0" eb="1"><t>かん</t></rPh></si></sst>`;
// 6 = "Derecho Civil" (rich text runs), 7 = "漢" (phonetic hint left out)

const stylesXml = `<?xml version="1.0"?><styleSheet ${NS}><numFmts count="3"><numFmt numFmtId="164" formatCode="dd&quot;/&quot;mm&quot;/&quot;yyyy hh:mm"/><numFmt numFmtId="165" formatCode="[Red]0.00"/><numFmt numFmtId="166" formatCode="0.00&quot; dias&quot;"/></numFmts>
<cellXfs count="6"><xf numFmtId="0"/><xf numFmtId="14" applyNumberFormat="1"><alignment horizontal="left"/></xf><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="20"/><xf numFmtId="166"/></cellXfs></styleSheet>`;

const sheet1 = `<?xml version="1.0"?><worksheet ${NS}><cols><col min="1" max="3"/></cols><sheetData>
<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c></row>
<row r="2"><c r="A2" t="s"><v>6</v></c><c r="B2" s="1"><v>46027</v></c><c r="C2" t="inlineStr"><is><t>Aula 3</t></is></c></row>
<row r="3"/>
<row r="4"><c r="A4" t="s"><v>3</v></c><c r="C4"><v>3.1400000000000001</v></c><c r="E4" t="s"><v>4</v></c><c r="F4"/></row>
<row r="5"><c r="B5" t="b"><v>1</v></c><c r="C5" t="s"><v>5</v></c></row>
</sheetData></worksheet>`;

const sheet2 = `<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>
<x:row r="1"><x:c r="A1" s="2"><x:v>45658.5</x:v></x:c><x:c r="B1" s="3"><x:v>7.5</x:v></x:c><x:c r="C1" s="4"><x:v>0.75</x:v></x:c><x:c r="D1" s="5"><x:v>3.5</x:v></x:c></x:row>
<x:row r="2"><x:c r="A2" t="str"><x:f>A1</x:f><x:v>hola</x:v></x:c><x:c r="B2" t="e"><x:v>#DIV/0!</x:v></x:c><x:c r="C2" t="s"><x:v>7</x:v></x:c></x:row>
</x:sheetData></x:worksheet>`;

const workbook = `<?xml version="1.0"?><workbook ${NS}><sheets><sheet name="Calendario" sheetId="1" r:id="rId1"/><sheet name="Vacía" sheetId="3" r:id="rId3"/><sheet name="Notas" sheetId="2" r:id="rId2"/></sheets></workbook>`;
const rels = `<?xml version="1.0"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="worksheet" Target="/xl/worksheets/hoja2.xml"/><Relationship Id="rId3" Type="worksheet" Target="worksheets/sheet3.xml"/></Relationships>`;

const xlsx = () =>
  zipSync({
    "[Content_Types].xml": strToU8("<Types/>"),
    "xl/workbook.xml": strToU8(workbook),
    "xl/_rels/workbook.xml.rels": strToU8(rels),
    "xl/sharedStrings.xml": strToU8(sharedXml),
    "xl/styles.xml": strToU8(stylesXml),
    "xl/worksheets/sheet1.xml": strToU8(sheet1),
    "xl/worksheets/hoja2.xml": strToU8(sheet2),
    "xl/worksheets/sheet3.xml": strToU8(`<worksheet ${NS}><sheetData/></worksheet>`),
  });

/** Independent check of the expected date: the usual Unix conversion (serial - 25569 days). */
const viaUnix = (serial: number) => {
  const d = new Date((serial - 25569) * 86_400_000);
  return `${String(d.getUTCDate()).padStart(2, "0")}/${String(d.getUTCMonth() + 1).padStart(2, "0")}/${d.getUTCFullYear()}`;
};

test("xlsx: kind by extension or mimetype; binary .xls and .ods stay unreadable", () => {
  assert.equal(kindOf({ path: "files/x/notas.xlsx", contentType: "application/octet-stream" }), "xlsx");
  assert.equal(kindOf({ path: "files/x/NOTAS.XLSX", contentType: "" }), "xlsx");
  assert.equal(kindOf({ path: "files/x/download", contentType: XLSX }), "xlsx");
  assert.equal(kindOf({ path: "files/x/viejo.xls", contentType: "application/vnd.ms-excel" }), "other");
  assert.equal(kindOf({ path: "files/x/hoja.ods", contentType: "application/vnd.oasis.opendocument.spreadsheet" }), "other");
});

test("xlsx: sheets in workbook order, shared/inline/rich strings, numbers, dates, gaps, empty rows and sheets", () => {
  assert.equal(viaUnix(46027), "05/01/2026");
  assert.equal(
    xlsxText(xlsx()),
    [
      "--- sheet Calendario ---",
      "Asignatura | Fecha | Aula",
      "Derecho Civil | 05/01/2026 | Aula 3",
      "Introducción al Derecho |  | 3.14",
      " | TRUE | I+D & Co",
      "",
      "--- sheet Notas ---",
      "01/01/2025 12:00 | 7.5 | 18:00 | 3.5",
      "hola | #DIV/0! | 漢",
    ].join("\n"),
  );
});

test("excelDate: 1900 system with the phantom 29 Feb 1900", () => {
  assert.equal(excelDate(1), "01/01/1900");
  assert.equal(excelDate(59), "28/02/1900");
  assert.equal(excelDate(60), "29/02/1900");
  assert.equal(excelDate(61), "01/03/1900");
  for (const n of [45658, 46027, 47000]) assert.equal(excelDate(n), viaUnix(n));
  assert.equal(excelDate(45658.75), "01/01/2025 18:00");
  assert.equal(excelDate(0.5, "time"), "12:00");
  assert.equal(excelDate(45658.999999), "02/01/2025", "rounds to the next day");
});

test("xlsx: malformed or partial workbooks give what they can, never throw", () => {
  assert.equal(xlsxText(new Uint8Array([1, 2, 3, 4])), "");
  assert.equal(xlsxText(zipSync({ "xl/workbook.xml": strToU8(`<workbook><sheets><sheet name="X" r:id="rId9"/>`) })), "");
  assert.equal(xlsxText(zipSync({ "xl/worksheets/sheet1.xml": strToU8("<<<not xml>>> <row") })), "");
  assert.equal(xlsxText(zipSync({ "word/document.xml": strToU8("<w:document/>") })), "");
  // No workbook, no shared strings or styles: the worksheets themselves, in file order.
  const bare = zipSync({
    "xl/worksheets/sheet2.xml": strToU8(`<worksheet><sheetData><row><c><v>2</v></c><c t="s"><v>99</v></c><c t="inlineStr"><is><t>b</t></is></c></row></sheetData></worksheet>`),
    "xl/worksheets/sheet1.xml": strToU8(`<worksheet><sheetData><row r="1"><c r="A1" s="7"><v>46027</v></c></row></sheetData></worksheet>`),
  });
  assert.equal(xlsxText(bare), "--- sheet Hoja 1 ---\n46027\n\n--- sheet Hoja 2 ---\n2 |  | b");
});

// ---------------------------------------------------------------- uploads in the tools

const snap: Snapshot = {
  syncedAt: Math.floor(Date.now() / 1000),
  siteUrl: "https://campusvirtual.uniovi.es",
  warnings: [],
  courses: [
    { id: 1, shortname: "FIS", fullname: "Física", url: "c1" },
    { id: 2, shortname: "MIN", fullname: "Minería", url: "c2" },
  ],
  resources: [],
  assignments: [],
  events: [],
  posts: [],
};
const campus: Resource = { key: "1:/apuntes.txt", cmid: 1, courseId: 1, section: "Tema 1", name: "Apuntes", modname: "resource", url: "https://campus/r/1", filename: "apuntes.txt" };
snap.resources = [campus];
const upload = (uuid: string, name: string, t: number): Resource => ({ key: `upload:${uuid}`, cmid: 0, courseId: 0, section: UPLOAD_SECTION, name, modname: "upload", url: "", filename: name, timemodified: t });
const up1 = upload("aaa", "calendario exámenes.xlsx", 1_760_000_000);
const up2 = upload("bbb", "mis notas.txt", 1_770_000_000);
const bytes: Record<string, Uint8Array> = {
  [campus.key]: strToU8("El examen de FIS es tipo test."),
  [up1.key]: xlsx(),
  [up2.key]: strToU8("Resumen propio: examen de prácticas."),
};
const entry = (r: Resource, path: string, contentType: string): StoredFile => ({ key: r.key, path, size: bytes[r.key]!.byteLength, contentType, timemodified: r.timemodified ?? 1, storedAt: 1, resource: r });
const index: Record<string, StoredFile> = {
  [campus.key]: entry(campus, "files/FIS/Tema 1/apuntes.txt", "text/plain"),
  [up1.key]: entry(up1, `files/${UPLOAD_SECTION}/${up1.name}`, XLSX),
  [up2.key]: entry(up2, `files/${UPLOAD_SECTION}/${up2.name}`, "text/plain"),
};
const texts = new Map<string, string>();
const store: DataStore = {
  snapshot: async () => snap,
  index: async () => index,
  bytes: async (f) => bytes[f.key]!,
  readText: async (f) => texts.get(f.key) ?? null,
  writeText: async (f, t) => void texts.set(f.key, t),
};

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;
async function connect() {
  const server = createMcpServer(store, { remote: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const client = new Client({ name: "test", version: "0" });
  await client.connect(b);
  return client;
}
const call = async (c: Client, name: string, args: Record<string, unknown> = {}) => text(await c.callTool({ name, arguments: args }));

test("isUploadsFilter: whole-filter names for «Mis archivos», never a course such as Minería", () => {
  for (const f of ["Mis archivos", "mis ARCHIVOS", " subidos ", "subido", "Subidos por mí", "mine", "uploads", "0"]) assert.ok(isUploadsFilter(f), f);
  for (const f of [undefined, "", "Minería", "MIN", "FIS", "archivos", "mis"]) assert.ok(!isUploadsFilter(f), String(f));
});

test("list_materials: uploads first with no filter and with «Mis archivos», left out by a course filter", async () => {
  const c = await connect();
  try {
    const all = JSON.parse(await call(c, "list_materials")) as Array<Record<string, unknown>>;
    assert.deepEqual(all.map((i) => i.key), [up2.key, up1.key, campus.key], "newest upload first, then the campus");
    assert.deepEqual(all[1], { key: up1.key, course: UPLOAD_SECTION, name: up1.name, filename: up1.name, type: "subido por ti", modified: all[1]!.modified });
    assert.match(String(all[1]!.modified), /^2025-10-09/);
    for (const course of ["Mis archivos", "mis archivos", "subidos", "uploads"]) {
      const mine = JSON.parse(await call(c, "list_materials", { course })) as Array<{ key: string }>;
      assert.deepEqual(mine.map((i) => i.key), [up2.key, up1.key], course);
    }
    assert.deepEqual((JSON.parse(await call(c, "list_materials", { course: "FIS" })) as Array<{ key: string }>).map((i) => i.key), [campus.key]);
    assert.deepEqual(JSON.parse(await call(c, "list_materials", { course: "Minería" })), []);
    const q = JSON.parse(await call(c, "list_materials", { query: "calendario examenes" })) as Array<{ key: string }>;
    assert.deepEqual(q.map((i) => i.key), [up1.key], "query is accent-insensitive and applies to uploads");
  } finally {
    await c.close();
  }
});

test("read_material, search_materials, search/fetch, list_courses and sync_status see uploads", async () => {
  const c = await connect();
  try {
    const read = await call(c, "read_material", { key: up1.key });
    assert.match(read, /^# calendario exámenes\.xlsx — calendario exámenes\.xlsx\nMis archivos: uploaded by the student\nchars 0-/);
    assert.match(read, /--- sheet Calendario ---\nAsignatura \| Fecha \| Aula\nDerecho Civil \| 05\/01\/2026 \| Aula 3/);
    assert.doesNotMatch(read, /url: /);

    const hits = JSON.parse(await call(c, "search_materials", { query: "derecho civil" })) as Array<{ key: string; file: string; location: string }>;
    assert.deepEqual(hits[0], { key: up1.key, file: `${up1.name} (${up1.name})`, location: "sheet Calendario", snippet: (hits[0] as { snippet?: string }).snippet });
    const examen = (course?: string) => call(c, "search_materials", course ? { query: "examen", course } : { query: "examen" });
    assert.deepEqual((JSON.parse(await examen()) as Array<{ key: string }>).map((h) => h.key).sort(), [campus.key, up2.key].sort());
    assert.deepEqual((JSON.parse(await examen("Mis archivos")) as Array<{ key: string }>).map((h) => h.key), [up2.key]);
    assert.deepEqual((JSON.parse(await examen("FIS")) as Array<{ key: string }>).map((h) => h.key), [campus.key]);
    const cached = await searchCachedMaterials(store, { query: "examen", course: "mis archivos" });
    assert.deepEqual(cached.results.map((h) => [h.key, h.course, h.section]), [[up2.key, UPLOAD_SECTION, UPLOAD_SECTION]]);
    assert.deepEqual((await searchCachedMaterials(store, { query: "examen", courseId: 1 })).results.map((h) => h.key), [campus.key]);

    const found = JSON.parse(await call(c, "search", { query: "prácticas" })) as { results: Array<{ id: string; title: string; url: string }> };
    assert.deepEqual(found.results, [{ id: `material:${up2.key}`, title: `${up2.name} (${up2.name})`, url: "" }]);
    const fetched = JSON.parse(await call(c, "fetch", { id: `material:${up2.key}` })) as { title: string; text: string; metadata: { course?: string; section?: string } };
    assert.equal(fetched.title, up2.name);
    assert.match(fetched.text, /Resumen propio/);
    assert.equal(fetched.metadata.course, UPLOAD_SECTION);
    assert.equal(fetched.metadata.section, UPLOAD_SECTION);

    const courses = JSON.parse(await call(c, "list_courses")) as { courses: Array<{ id: number }>; uploads: number; uploadsCourse: string };
    assert.deepEqual(courses.courses.map((x) => x.id), [1, 2]);
    assert.equal(courses.uploads, 2);
    assert.equal(courses.uploadsCourse, UPLOAD_SECTION);
    assert.match(await call(c, "sync_status"), /"downloadedFiles":3,"uploads":2/);
  } finally {
    await c.close();
  }
});

// ---- review fixes: hostile files, number formats that look like dates, uploads before the first sync

test("xlsx: thousands of unclosed tags parse in linear time (was minutes for a 1 KB zip)", () => {
  const hostile = zipSync({ "xl/worksheets/sheet1.xml": strToU8(`<sheetData>${"<row>".repeat(100_000)}<row><c><v>1`) });
  assert.ok(hostile.byteLength < 5000);
  const t0 = Date.now();
  xlsxText(hostile);
  const sst = zipSync({ "xl/sharedStrings.xml": strToU8("<si><t>a".repeat(50_000)), "xl/worksheets/sheet1.xml": strToU8("<sheetData><row><c t=\"s\"><v>0</v></c></row></sheetData>") });
  xlsxText(sst);
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`);
});

test("xlsx: padding and fill escapes in a number format are not date codes", () => {
  const styles = `<styleSheet ${NS}><numFmts><numFmt numFmtId="170" formatCode="_-* #,##0 _P_t_s_-"/><numFmt numFmtId="171" formatCode="0.0*d"/></numFmts><cellXfs><xf numFmtId="0"/><xf numFmtId="170"/><xf numFmtId="171"/><xf numFmtId="14"/></cellXfs></styleSheet>`;
  const sheet = `<worksheet ${NS}><sheetData><row><c r="A1" s="1"><v>7.5</v></c><c r="B1" s="2"><v>0.25</v></c><c r="C1" s="3"><v>0</v></c></row></sheetData></worksheet>`;
  const out = xlsxText(zipSync({ "xl/styles.xml": strToU8(styles), "xl/worksheets/sheet1.xml": strToU8(sheet) }));
  assert.equal(out, "--- sheet Hoja 1 ---\n7.5 | 0.25 | 0");
});

test("before the first sync, the AI still finds the student's uploads", async () => {
  const fresh: DataStore = { ...store, snapshot: async () => null };
  const server = createMcpServer(fresh, { remote: true });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  try {
    const items = JSON.parse(await call(c, "list_materials")) as Array<{ key: string }>;
    assert.deepEqual(items.map((i) => i.key).sort(), [up1.key, up2.key].sort());
    const empty: DataStore = { ...fresh, index: async () => ({ [campus.key]: index[campus.key]! }) };
    const server2 = createMcpServer(empty, { remote: true });
    const [a2, b2] = InMemoryTransport.createLinkedPair();
    await server2.connect(a2);
    const c2 = new Client({ name: "test", version: "0" });
    await c2.connect(b2);
    assert.match(await call(c2, "list_materials"), /No Uniovi Virtual data synced yet/);
    await c2.close();
  } finally {
    await c.close();
  }
});
