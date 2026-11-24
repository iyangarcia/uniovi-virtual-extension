// Which campus files the extension downloads (extension/src/readable.ts) and the IndexedDB store's
// pure label helpers (extension/src/store/paths.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import { fileExt, isReadableFile } from "../../extension/src/readable.ts";
import { fileLabel, labelSegment, textKey, withClashTag } from "../../extension/src/store/paths.ts";

test("fileExt takes the last segment's extension, lower-case", () => {
  assert.equal(fileExt("Tema1.PDF"), "pdf");
  assert.equal(fileExt("a/b.c/notas"), "");
  assert.equal(fileExt("https://x/pluginfile.php/1/mod_resource/content/0/Práctica.docx?forcedownload=1"), "docx");
  assert.equal(fileExt(".bashrc"), "");
  assert.equal(fileExt("archivo."), "");
  assert.equal(fileExt(undefined), "");
});

test("readable types are downloaded", () => {
  for (const f of ["a.pdf", "a.doc", "a.docx", "a.ppt", "a.pptx", "a.xls", "a.xlsx", "a.odt", "a.ods", "a.odp", "a.txt", "a.md", "a.csv", "a.json", "a.xml", "a.html"])
    assert.equal(isReadableFile({ filename: f }), true, f);
  for (const f of ["main.c", "x.h", "x.cpp", "Main.java", "s.py", "app.js", "app.ts", "q.sql"]) assert.equal(isReadableFile({ filename: f }), true, f);
  for (const f of ["a.png", "a.jpg", "a.JPEG", "a.gif", "a.webp", "a.svg"]) assert.equal(isReadableFile({ filename: f }), true, f);
});

test("archives, binaries and media are not", () => {
  for (const f of ["a.zip", "a.gz", "a.tar", "a.rar", "a.7z", "setup.exe", "x.msi", "disk.iso", "lib.jar", "clase.mp4", "audio.mp3", "v.mkv", "w.wav"])
    assert.equal(isReadableFile({ filename: f }), false, f);
});

test("extension wins over mimetype; mimetype decides when there is no extension", () => {
  assert.equal(isReadableFile({ filename: "apuntes.pdf", mimetype: "application/octet-stream" }), true);
  assert.equal(isReadableFile({ filename: "codigo.zip", mimetype: "text/plain" }), false);
  assert.equal(isReadableFile({ filename: "descarga.dat", mimetype: "application/pdf" }), true); // unknown ext → mime
  assert.equal(isReadableFile({ filename: "sin-extension", mimetype: "application/pdf" }), true);
  assert.equal(isReadableFile({ filename: "sin-extension", mimetype: "application/zip" }), false);
  assert.equal(isReadableFile({ mimetype: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" }), true);
  assert.equal(isReadableFile({ mimetype: "image/png" }), true);
  assert.equal(isReadableFile({ mimetype: "video/mp4" }), false);
  assert.equal(isReadableFile({ mimetype: "application/octet-stream" }), false);
  assert.equal(isReadableFile({ filename: "datos.bin" }), false);
});

test("undefined when nothing is known yet (decide after the redirect)", () => {
  assert.equal(isReadableFile({}), undefined);
  assert.equal(isReadableFile({ filename: "README" }), undefined);
});

test("file labels: files/<course>/<section>/<file>, no slashes inside segments", () => {
  assert.equal(fileLabel("FIS", "Tema 1", "notas.pdf"), "files/FIS/Tema 1/notas.pdf");
  assert.equal(fileLabel("", "", "a.pdf"), "files/Curso/General/a.pdf");
  assert.equal(fileLabel("A/B", "Tema\n 2 / bis", "x\\y.pdf"), "files/A_B/Tema 2 _ bis/x_y.pdf");
  assert.equal(labelSegment("   "), "_");
  assert.equal([...labelSegment("é".repeat(200))].length, 80);
});

test("clash tags are stable and distinct per key", () => {
  const a = withClashTag("files/F/T/a.pdf", "1:/x/a.pdf");
  assert.match(a, /^files\/F\/T\/[0-9a-f]{6}-a\.pdf$/);
  assert.equal(a, withClashTag("files/F/T/a.pdf", "1:/x/a.pdf"));
  assert.notEqual(a, withClashTag("files/F/T/a.pdf", "1:/y/a.pdf"));
  assert.equal(textKey({ key: "1:/a", timemodified: 5, size: 9 }), "1:/a|5|9");
});
