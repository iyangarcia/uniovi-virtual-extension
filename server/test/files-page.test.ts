// Pure logic of the "Mis apuntes" page (extension/src/files/model.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { StoredFile } from "../../shared/mcp/store.ts";
import type { Resource, Snapshot } from "../../shared/types.ts";
import {
  blobMime,
  buildEntries,
  displayTitle,
  downloadName,
  fileType,
  filterEntries,
  formatDate,
  formatSize,
  groupEntries,
  cleanSnippet,
  hitPage,
  pageUrl,
  viewerPath,
  isNew,
  locationLabel,
  openMode,
  parseDeepLink,
  safeCampusUrl,
  sortEntries,
  typeLabel,
} from "../../extension/src/files/model.ts";

const res = (cmid: number, courseId: number, section: string, name: string, filename: string, timemodified: number, modname = "resource"): Resource => ({
  key: `${cmid}:/${filename}`,
  cmid,
  courseId,
  section,
  name,
  modname,
  url: `https://www.campusvirtual.uniovi.es/mod/resource/view.php?id=${cmid}`,
  filename,
  timemodified,
});

const resources = [
  res(1, 10, "Tema 1", "Apuntes tema 1", "tema1.pdf", 1000),
  res(2, 10, "Tema 1", "Ejercicios", "ejercicios.pdf", 3000),
  res(3, 10, "Tema 2", "Soluciones", "soluciones.pdf", 2000),
  res(4, 10, "Prácticas", "Código", "proyecto.zip", 1500),
  res(5, 20, "Introducción", "Guion", "guion.docx", 2500),
  res(6, 20, "Introducción", "Diagramas", "zz-diagrama.png", 500, "folder"),
];
const snapshot: Snapshot = {
  syncedAt: 5000,
  siteUrl: "https://www.campusvirtual.uniovi.es",
  courses: [
    { id: 20, shortname: "MAT", fullname: "Matemáticas", url: "" },
    { id: 10, shortname: "FIS", fullname: "Física", url: "" },
  ],
  resources,
  posts: [],
  assignments: [],
  events: [],
  warnings: [],
};
const stored = (r: Resource, contentType: string, size: number, storedAt: number): StoredFile => ({
  key: r.key,
  path: `files/X/${r.section}/${r.filename}`,
  size,
  contentType,
  timemodified: r.timemodified!,
  storedAt,
  resource: r,
});
const index: Record<string, StoredFile> = Object.fromEntries(
  [
    stored(resources[0]!, "application/pdf", 2048, 100),
    stored(resources[1]!, "application/pdf", 4096, 200),
    stored(resources[2]!, "application/pdf", 1_500_000, 300),
    stored(resources[4]!, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", 9000, 400),
    stored(resources[5]!, "image/png", 10, 500),
    // Stored earlier, no longer in the snapshot: still listed, after the campus ones.
    stored(res(99, 10, "Tema 9", "Antiguo", "antiguo.txt", 10), "text/plain", 5, 50),
  ].map((f) => [f.key, f]),
);
const skipped = { "4:/proyecto.zip": 1500 };
const entries = buildEntries(snapshot, index, skipped);
const keys = (list: { key: string }[]) => list.map((e) => e.key.split(":")[0]);

test("type label from extension, then MIME", () => {
  assert.equal(fileType("a.PDF"), "pdf");
  assert.equal(fileType("a.docx"), "word");
  assert.equal(fileType("a.odt"), "word");
  assert.equal(fileType("a.pptx"), "powerpoint");
  assert.equal(fileType("a.xlsx"), "excel");
  assert.equal(fileType("a.jpeg"), "image");
  assert.equal(fileType("main.c"), "text");
  assert.equal(fileType("datos.csv"), "text");
  assert.equal(fileType("p.zip"), "other");
  assert.equal(fileType(undefined, "application/pdf"), "pdf");
  assert.equal(fileType("sin-ext", "application/vnd.openxmlformats-officedocument.presentationml.presentation"), "powerpoint");
  assert.equal(fileType("sin-ext", "text/plain"), "text");
  assert.deepEqual(
    ["pdf", "word", "powerpoint", "excel", "image", "text"].map((t) => typeLabel(t as never)),
    ["PDF", "Word", "PowerPoint", "Excel", "Imagen", "Texto"],
  );
});

test("PDF, images and text open in Chrome; Office files are downloaded", () => {
  for (const f of ["a.pdf", "a.png", "a.txt", "a.java"]) assert.equal(openMode(fileType(f)), "open", f);
  for (const f of ["a.docx", "a.pptx", "a.xlsx", "a.doc", "a.zip"]) assert.equal(openMode(fileType(f)), "download", f);
});

test("blob MIME: viewable types Chrome shows, nothing that could run as a page", () => {
  assert.equal(blobMime("a.pdf", "application/octet-stream"), "application/pdf");
  assert.equal(blobMime("x", "application/pdf"), "application/pdf");
  assert.equal(blobMime("a.jpg", ""), "image/jpeg");
  assert.equal(blobMime("a.png", "application/octet-stream"), "image/png");
  assert.equal(blobMime("a.txt", "text/plain"), "text/plain; charset=utf-8");
  assert.equal(blobMime("a.py", "application/octet-stream"), "text/plain; charset=utf-8");
  // HTML and SVG from the campus must not render inside the extension's origin.
  assert.equal(blobMime("index.html", "text/html"), "text/plain; charset=utf-8");
  assert.equal(blobMime("dibujo.svg", "image/svg+xml"), "text/plain; charset=utf-8");
  const docx = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  assert.equal(blobMime("a.docx", docx), docx);
  assert.equal(blobMime("a.bin", ""), "application/octet-stream");
});

test("entries: stored files plus skipped ones, in campus order, unknown last", () => {
  assert.deepEqual(keys(entries), ["1", "2", "3", "4", "5", "6", "99"]);
  const zip = entries.find((e) => e.key === "4:/proyecto.zip")!;
  assert.equal(zip.stored, false);
  assert.equal(zip.type, "other");
  assert.equal(entries.find((e) => e.key === "1:/tema1.pdf")!.stored, true);
  // A readable resource neither stored nor skipped (still downloading) isn't listed; the zip is,
  // because its name already says it stays on the campus.
  const partial = buildEntries(snapshot, {}, {});
  assert.deepEqual(keys(partial), ["4"]);
  // Folder files show their file name; resources their activity name.
  assert.equal(displayTitle(resources[5]!), "zz-diagrama.png");
  assert.equal(displayTitle(resources[0]!), "Apuntes tema 1");
  assert.equal(buildEntries(null, {}, {}).length, 0);
});

test("entries: an archive inside a folder or a section is listed as a campus link without ever being skipped", () => {
  const folderZip: Resource = { ...res(7, 10, "Tema 1", "Material", "x.zip", 0, "folder"), key: "7:/x.zip", timemodified: undefined };
  const sectionVideo: Resource = { ...res(0, 10, "Tema 2", "clase.mp4", "clase.mp4", 0, "section-file"), key: "section3:/clase.mp4", timemodified: undefined };
  // Links, pages and forums are not files: never listed even with an unknown extension.
  const link: Resource = { ...res(8, 10, "Tema 1", "Web", "web.zip", 0, "url"), key: "8:link" };
  const pending: Resource = { ...res(9, 10, "Tema 1", "Tema", "tema.pdf", 0, "folder"), key: "9:/tema.pdf" };
  const list = buildEntries({ ...snapshot, resources: [folderZip, sectionVideo, link, pending] }, {}, {});
  assert.deepEqual(list.map((e) => e.key), ["7:/x.zip", "section3:/clase.mp4"]);
  const zip = list[0]!;
  assert.equal(zip.stored, false);
  assert.equal(zip.title, "x.zip");
  assert.equal(zip.type, "other");
  assert.equal(zip.date, 0);
  assert.equal(zip.url, folderZip.url);
});

test("grouping by course and section follows the campus order", () => {
  const g = groupEntries(entries, snapshot.courses, "course");
  assert.deepEqual(g.map((c) => c.name), ["Matemáticas", "Física"]);
  assert.deepEqual(g[0]!.sections.map((s) => s.name), ["Introducción"]);
  assert.deepEqual(g[1]!.sections.map((s) => s.name), ["Tema 1", "Tema 2", "Prácticas", "Tema 9"]);
  assert.deepEqual(keys(g[1]!.sections[0]!.files), ["1", "2"]);
  assert.equal(g[1]!.count, 5);
  // A course missing from the snapshot still gets a group, last.
  const orphan = groupEntries([{ ...entries[0]!, courseId: 77 }, ...entries], snapshot.courses, "course");
  assert.equal(orphan.at(-1)!.name, "Asignatura 77");
});

test("sort by name (Spanish, numeric) and by date newest first", () => {
  assert.deepEqual(
    sortEntries(entries, "name").map((e) => e.title),
    ["Antiguo", "Apuntes tema 1", "Código", "Ejercicios", "Guion", "Soluciones", "zz-diagrama.png"],
  );
  assert.deepEqual(keys(sortEntries(entries, "date")), ["2", "5", "3", "4", "1", "6", "99"]);
  const g = groupEntries(entries, snapshot.courses, "date");
  assert.equal(g[1]!.sections.length, 1);
  assert.equal(g[1]!.sections[0]!.name, "");
  assert.deepEqual(keys(g[1]!.sections[0]!.files), ["2", "3", "4", "1", "99"]);
  const n = ["Tema 10", "tema 2", "Tema 1"].map((title, i) => ({ ...entries[0]!, title, order: i }));
  assert.deepEqual(sortEntries(n, "name").map((e) => e.title), ["Tema 1", "tema 2", "Tema 10"]);
});

test("filter matches title, file name and section, accent- and case-insensitive", () => {
  assert.deepEqual(keys(filterEntries(entries, "codigo")), ["4"]);
  assert.deepEqual(keys(filterEntries(entries, "PRACTICAS")), ["4"]);
  assert.deepEqual(keys(filterEntries(entries, "tema 1")), ["1", "2"]);
  assert.deepEqual(keys(filterEntries(entries, "introduccion guion")), ["5"]);
  assert.deepEqual(keys(filterEntries(entries, "diagrama.png")), ["6"]);
  assert.equal(filterEntries(entries, "   ").length, entries.length);
  assert.equal(filterEntries(entries, "nada").length, 0);
});

test("'Nuevo' means stored after the previous visit; never on a first visit or for skipped files", () => {
  assert.equal(isNew({ stored: true, storedAt: 300 }, 200), true);
  assert.equal(isNew({ stored: true, storedAt: 200 }, 200), false);
  assert.equal(isNew({ stored: true, storedAt: 300 }, undefined), false);
  assert.equal(isNew({ stored: false }, 100), false);
});

test("dates in Madrid time, Spanish; sizes with a decimal comma", () => {
  assert.equal(formatDate(Date.UTC(2026, 10, 14, 12) / 1000), "14 nov 2026");
  // 23:30 UTC on 31 Dec is already 1 Jan in Madrid.
  assert.equal(formatDate(Date.UTC(2026, 11, 31, 23, 30) / 1000), "1 ene 2027");
  assert.equal(formatDate(0), "");
  assert.equal(formatSize(500), "500 B");
  assert.equal(formatSize(2048), "2 KB");
  assert.equal(formatSize(820 * 1024), "820 KB");
  assert.equal(formatSize(1.4 * 1024 * 1024), "1,4 MB");
  assert.equal(formatSize(undefined), "");
});

test("search hits: Spanish location and #page=N only for PDF pages", () => {
  assert.equal(locationLabel({ locationKind: "page", locationNumber: 2 }), "página 2");
  assert.equal(locationLabel({ locationKind: "slide", locationNumber: 3 }), "diapositiva 3");
  assert.equal(locationLabel({}), "");
  assert.equal(hitPage("pdf", { locationKind: "page", locationNumber: 2 }), 2);
  assert.equal(hitPage("pdf", {}), undefined);
  assert.equal(hitPage("powerpoint", { locationKind: "slide", locationNumber: 2 }), undefined);
  assert.equal(pageUrl("blob:x", 2), "blob:x#page=2");
  assert.equal(pageUrl("blob:x"), "blob:x");
  assert.equal(cleanSnippet("--- page 2 --- Ejercicio 4: el trapecio --- page 3 ---"), "Ejercicio 4: el trapecio");
  assert.equal(cleanSnippet("a\n--- slide 10 ---\n  b"), "a b");
});

test("deep links, campus links and download names are sanitised", () => {
  assert.deepEqual(parseDeepLink("?course=12&q=%20derivadas%20"), { course: 12, q: "derivadas" });
  assert.deepEqual(parseDeepLink("?course=abc&q="), {});
  // Viewer mode: the key round-trips through the URL, page only with a file.
  const key = "12:/Tema 2/ejercicios & soluciones#1.pdf";
  assert.deepEqual(parseDeepLink(`?${viewerPath(key, 3).split("?")[1]}`), { open: key, page: 3 });
  assert.equal(viewerPath("1:/a.pdf"), "home.html?open=1%3A%2Fa.pdf");
  assert.deepEqual(parseDeepLink("?page=4"), {});
  assert.equal(safeCampusUrl("javascript:alert(1)"), null);
  assert.equal(safeCampusUrl("not a url"), null);
  assert.equal(safeCampusUrl("https://www.campusvirtual.uniovi.es/x"), "https://www.campusvirtual.uniovi.es/x");
  assert.equal(safeCampusUrl("https://campusvirtual.uniovi.es/x"), "https://campusvirtual.uniovi.es/x");
  // Only https and only the campus: no plain http, no other sites, no look-alike hosts.
  assert.equal(safeCampusUrl("http://www.campusvirtual.uniovi.es/x"), null);
  assert.equal(safeCampusUrl("https://example.com/x"), null);
  assert.equal(safeCampusUrl("https://evilcampusvirtual.uniovi.es/x"), null);
  assert.equal(safeCampusUrl("https://campusvirtual.uniovi.es.evil.com/x"), null);
  assert.equal(safeCampusUrl("https://campusvirtual.uniovi.es@evil.com/x"), null);
  assert.equal(safeCampusUrl("data:text/html,hi"), null);
  assert.equal(downloadName({ filename: "a/b:c.docx", title: "T" }), "a_b_c.docx");
  assert.equal(downloadName({ title: "Guion" }), "Guion");
});
