// extract.ts (plain text, DOCX, PPTX) and read_material paging (offset / maxChars / nextOffset).
// PDF is not covered: generating a valid PDF needs a writer library the project doesn't depend on.
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { before, test } from "node:test";
import { strToU8, zipSync } from "fflate";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Resource, Snapshot } from "../../shared/types.ts";

// store.ts reads UNIOVI_DATA_DIR at import time, so point it at a temp dir before importing the server.
process.env.UNIOVI_DATA_DIR = mkdtempSync(join(tmpdir(), "uniovi-extract-test-"));
const store = await import("../src/store.ts");
const extract = await import("../src/extract.ts");
const mcp = await import("../src/mcp.ts");

const res = (cmid: number, filename: string): Resource & { filename: string } => ({
  key: `${cmid}:/${filename}`,
  cmid,
  courseId: 1,
  section: "Tema 1",
  name: `Material ${cmid}`,
  modname: "resource",
  url: `https://campus/r/${cmid}`,
  filename,
});

const P = "http://schemas.openxmlformats.org";

function docx(paragraphs: string[]): Uint8Array {
  const body = paragraphs.map((p) => `<w:p><w:r><w:t xml:space="preserve">${p}</w:t></w:r></w:p>`).join("");
  return zipSync({ "word/document.xml": strToU8(`<?xml version="1.0"?><w:document xmlns:w="${P}/wordprocessingml/2006/main"><w:body>${body}</w:body></w:document>`) });
}

const slideXml = (lines: string[]) =>
  `<?xml version="1.0"?><p:sld xmlns:a="${P}/drawingml/2006/main" xmlns:p="${P}/presentationml/2006/main"><p:cSld><p:spTree><p:sp><p:txBody>${lines
    .map((l) => `<a:p><a:r><a:t>${l}</a:t></a:r></a:p>`)
    .join("")}</p:txBody></p:sp></p:spTree></p:cSld></p:sld>`;

function pptx(): Uint8Array {
  return zipSync({
    // slide10 sorts before slide2 as a string: slides must be ordered numerically.
    "ppt/slides/slide10.xml": strToU8(slideXml(["Conclusiones"])),
    "ppt/slides/slide1.xml": strToU8(slideXml(["Termodinámica", "Primer principio"])),
    "ppt/slides/slide2.xml": strToU8(slideXml(["Entropía &amp; desorden"])),
    "ppt/notesSlides/notesSlide2.xml": strToU8(slideXml(["Recordar el ejemplo"])),
    "ppt/presentation.xml": strToU8(slideXml(["not a slide"])),
  });
}

// 2500 chars of distinct 10-char chunks, so every page can be checked exactly.
const longText = Array.from({ length: 250 }, (_, i) => `L${String(i).padStart(4, "0")}-----`).join("");

const files = {
  txt: { r: res(1, "notas.txt"), type: "text/plain", bytes: strToU8("Hola\nmundo ñ") },
  docx: { r: res(2, "guion.docx"), type: "application/vnd.openxmlformats-officedocument.wordprocessingml.document", bytes: docx(["Práctica 1", "Entregar &lt;código&gt; antes del viernes", "   "]) },
  pptx: { r: res(3, "tema1.pptx"), type: "application/vnd.openxmlformats-officedocument.presentationml.presentation", bytes: pptx() },
  long: { r: res(4, "largo.txt"), type: "text/plain", bytes: strToU8(longText) },
  bin: { r: res(5, "datos.bin"), type: "application/octet-stream", bytes: new Uint8Array([0, 1, 2]) },
};

const stored: Record<string, Awaited<ReturnType<typeof store.storeFile>>> = {};

before(async () => {
  const snap: Snapshot = {
    syncedAt: Math.floor(Date.now() / 1000),
    siteUrl: "https://campusvirtual.uniovi.es",
    warnings: [],
    courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "c" }],
    resources: Object.values(files).map((f) => f.r),
    assignments: [],
    events: [],
    posts: [],
  };
  await store.saveSnapshot(snap);
  for (const [name, f] of Object.entries(files)) stored[name] = await store.storeFile(f.r, "FIS", f.type, f.bytes);
});

test("kindOf picks the extractor from the extension or content type", () => {
  assert.equal(extract.kindOf(stored.txt!), "text");
  assert.equal(extract.kindOf(stored.docx!), "docx");
  assert.equal(extract.kindOf(stored.pptx!), "pptx");
  assert.equal(extract.kindOf(stored.bin!), "other");
});

test("plain text is decoded as UTF-8", async () => {
  assert.equal(await extract.textOf(stored.txt!), "Hola\nmundo ñ");
});

test("DOCX: one line per non-empty paragraph, XML entities decoded", async () => {
  assert.equal(await extract.textOf(stored.docx!), "Práctica 1\nEntregar <código> antes del viernes");
});

test("PPTX: slides in numeric order with markers, notes attached, other parts ignored", async () => {
  assert.equal(
    await extract.textOf(stored.pptx!),
    "--- slide 1 ---\nTermodinámica\nPrimer principio\n\n" +
      "--- slide 2 ---\nEntropía & desorden\n[notes] Recordar el ejemplo\n\n" +
      "--- slide 10 ---\nConclusiones",
  );
});

test("unsupported formats return null; extracted text is cached", async () => {
  assert.equal(await extract.textOf(stored.bin!), null);
  assert.equal(await extract.cachedTextOf(stored.docx!), "Práctica 1\nEntregar <código> antes del viernes");
});

// ---------------------------------------------------------------- read_material paging

const text = (r: unknown) => (r as { content: Array<{ text: string }> }).content[0]!.text;

async function client() {
  const server = mcp.createMcpServer();
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a);
  const c = new Client({ name: "test", version: "0" });
  await c.connect(b);
  return c;
}

const read = async (c: Client, args: Record<string, unknown>) => {
  const r = await c.callTool({ name: "read_material", arguments: { key: files.long.r.key, ...args } });
  return { out: text(r), isError: (r as { isError?: boolean }).isError === true };
};

const body = (out: string) => out.slice(out.indexOf("\n\n") + 2);

test("read_material pages with offset/maxChars and nextOffset until the end", async () => {
  const c = await client();
  assert.equal(longText.length, 2500);

  const p1 = await read(c, { maxChars: 1000 });
  assert.match(p1.out, /chars 0-1000 of 2500 \(nextOffset: 1000\)/);
  assert.equal(body(p1.out), longText.slice(0, 1000));

  const p2 = await read(c, { offset: 1000, maxChars: 1000 });
  assert.match(p2.out, /chars 1000-2000 of 2500 \(nextOffset: 2000\)/);
  assert.equal(body(p2.out), longText.slice(1000, 2000));

  const p3 = await read(c, { offset: 2000, maxChars: 1000 });
  assert.match(p3.out, /chars 2000-2500 of 2500\n/);
  assert.doesNotMatch(p3.out, /nextOffset/);
  assert.equal(body(p3.out), longText.slice(2000));

  // Default maxChars (40000) returns everything at once.
  const all = await read(c, {});
  assert.match(all.out, /chars 0-2500 of 2500\n/);
  assert.equal(body(all.out), longText);
  await c.close();
});

test("read_material with an offset past the end says so instead of an empty page", async () => {
  const c = await client();
  const r = await read(c, { offset: 40_000 });
  assert.equal(r.isError, true);
  assert.match(r.out, /offset 40000 is past the end \(2500 chars\)/);
  assert.doesNotMatch(r.out, /chars 40000-40000/);

  // Exactly at the end is past it too: there is nothing left to read.
  assert.match((await read(c, { offset: 2500 })).out, /past the end/);
  await c.close();
});
