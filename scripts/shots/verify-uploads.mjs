// «Añadir archivo» on «Mis apuntes» (side panel page home.html, opened here as a 400 px wide tab) in
// Chrome for Testing with the built extension (extension/dist):
// a fresh offline profile, the dev bridge failed before anything is stored, generated files only.
// Adds an .xlsx and a .pdf (file input) and a .txt (drag and drop), checks they appear under «Mis
// archivos» and in IndexedDB; .zip, .xls and .ods are refused with their messages; a campus file has no
// «Borrar» and can't be deleted; an upload is deleted with the two-step button.
// usage: node verify-uploads.mjs [--headful]   (exit code 1 on any failure)
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, blockBridge, extensionWorker, launchWithExtension, log, REPO, requireBuild, sleep, until } from "./lib.mjs";

const { zipSync, strToU8 } = createRequire(join(REPO, "package.json"))("fflate");

const opts = args();
let pass = 0;
let fail = 0;
const check = (ok, what) => {
  ok ? pass++ : fail++;
  log(ok ? "PASS" : "FAIL", what);
};

// ------------------------------------------------------------------ generated files

function xlsx() {
  const cell = (ref, text) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;
  return zipSync({
    "[Content_Types].xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>',
    ),
    "_rels/.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/></Relationships>',
    ),
    "xl/workbook.xml": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Exámenes" sheetId="1" r:id="rId1"/></sheets></workbook>',
    ),
    "xl/_rels/workbook.xml.rels": strToU8(
      '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/></Relationships>',
    ),
    "xl/worksheets/sheet1.xml": strToU8(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">${cell("A1", "Asignatura")}${cell("B1", "Fecha")}</row><row r="2">${cell("A2", "Derecho Civil I")}${cell("B2", "15/01/2027")}</row></sheetData></worksheet>`,
    ),
  });
}

function pdf() {
  const objs = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 144] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null, // content stream, below
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const stream = "BT /F1 18 Tf 20 70 Td (Apuntes de prueba) Tj ET";
  objs[3] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let out = "%PDF-1.4\n";
  const offsets = objs.map((o, i) => {
    const at = out.length;
    out += `${i + 1} 0 obj\n${o}\nendobj\n`;
    return at;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

const dir = mkdtempSync(join(tmpdir(), "uv-uploads-files-"));
const files = {
  xlsx: join(dir, "Calendario exámenes.xlsx"),
  pdf: join(dir, "Mis notas tema 1.pdf"),
  zip: join(dir, "Trabajos.zip"),
  xls: join(dir, "Antiguo.xls"),
  ods: join(dir, "Hoja.ods"),
};
writeFileSync(files.xlsx, xlsx());
writeFileSync(files.pdf, pdf());
writeFileSync(files.zip, zipSync({ "a.txt": strToU8("hola") }));
writeFileSync(files.ods, zipSync({ mimetype: strToU8("application/vnd.oasis.opendocument.spreadsheet") }));
writeFileSync(files.xls, Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0, 0, 0]));
const XLSX = "Calendario exámenes.xlsx";
const PDF = "Mis notas tema 1.pdf";
const DROPPED = "<b>nota</b>.txt"; // a name with markup (not allowed on Windows disks, fine in a dropped File): must show as text

// ------------------------------------------------------------------ run

const dist = requireBuild();
const profile = mkdtempSync(join(tmpdir(), "uv-uploads-"));
const browser = await launchWithExtension(dist, profile, { headless: !opts.headful });
try {
  const bridge = await blockBridge(browser);
  const { sw, extId } = await extensionWorker(browser);
  check(true, `bridge blocked (${await bridge.assertBlocked(sw)})`);
  await sw.evaluate(() => chrome.storage.local.set({ aiConnection: false, devRelayUrl: "https://relay.invalid" }));

  const page = await browser.newPage();
  await page.setViewport({ width: 400, height: 900 });
  await page.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await page.waitForSelector("#addFile");

  const notes = () => page.$$eval("#uploadNotes li", (lis) => lis.map((li) => ({ kind: li.className, text: li.textContent })));
  const uploadRows = () =>
    page.evaluate(() =>
      [...document.querySelectorAll('details[data-course-id="0"] li.file')].map((li) => ({
        key: li.dataset.key,
        title: li.querySelector(".title")?.textContent,
        canDelete: !!li.querySelector('[data-action="delete"]'),
        hasNew: !!li.querySelector(".badge-new"),
      })),
    );
  /** Reads IndexedDB "uniovi" from the extension page: the files record, whether a blob exists, cached text keys. */
  const idb = (key) =>
    page.evaluate(
      (key) =>
        new Promise((resolve, reject) => {
          const req = indexedDB.open("uniovi");
          req.onerror = () => reject(req.error);
          req.onsuccess = () => {
            const db = req.result;
            const tx = db.transaction(["files", "blobs", "texts", "meta"], "readonly");
            const out = {};
            tx.objectStore("files").get(key).onsuccess = (e) => (out.file = e.target.result ?? null);
            tx.objectStore("blobs").get(key).onsuccess = (e) => (out.blob = !!e.target.result);
            tx.objectStore("texts").getAllKeys(IDBKeyRange.bound(`${key}|`, `${key}|￿`)).onsuccess = (e) => (out.texts = e.target.result);
            tx.objectStore("meta").get("snapshot").onsuccess = (e) => (out.snapshot = !!e.target.result);
            tx.oncomplete = () => {
              db.close();
              resolve(out);
            };
          };
        }),
      key,
    );

  // 1. Two readable files through «Añadir archivo» (the hidden file input).
  const input = await page.$("#fileInput");
  await input.uploadFile(files.xlsx, files.pdf);
  const n1 = await until(async () => ((await notes()).length >= 2 ? notes() : null), 15000);
  log("notes:", JSON.stringify(n1));
  check(n1?.some((n) => n.kind === "ok" && n.text === `${XLSX} añadido`), `«${XLSX} añadido»`);
  check(n1?.some((n) => n.kind === "ok" && n.text === `${PDF} añadido`), `«${PDF} añadido»`);
  const rows1 = await until(async () => ((await uploadRows()).length >= 2 ? uploadRows() : null), 10000);
  log("rows:", JSON.stringify(rows1));
  check(rows1?.length === 2 && rows1.some((r) => r.title === XLSX) && rows1.some((r) => r.title === PDF), "both under «Mis archivos»");
  check(await page.$eval('details[data-course-id="0"] summary .course', (e) => e.textContent).catch(() => "") === "Mis archivos", "group named «Mis archivos»");
  check(rows1?.every((r) => r.canDelete && !r.hasNew), "each upload has «Borrar» and no «Nuevo» badge");
  const xlsxKey = rows1?.find((r) => r.title === XLSX)?.key ?? "";
  const pdfKey = rows1?.find((r) => r.title === PDF)?.key ?? "";
  check(/^upload:[0-9a-f-]{36}$/.test(xlsxKey) && /^upload:[0-9a-f-]{36}$/.test(pdfKey), `keys upload:<uuid> (${xlsxKey})`);
  const x = await idb(xlsxKey);
  check(x.file?.path === `files/Mis archivos/${XLSX}` && x.blob, `stored as files/Mis archivos/… (${x.file?.path})`);
  const r = x.file?.resource ?? {};
  check(r.modname === "upload" && r.courseId === 0 && r.cmid === 0 && r.section === "Mis archivos" && r.url === "" && r.filename === XLSX && r.filesize > 0, "resource follows the upload contract");
  check(!x.snapshot, "no snapshot written (uploads never go into the snapshot)");

  // Clicking the title opens the viewer tab (home.html?open=<key>).
  const pdfRow = `li.file[data-key="${pdfKey}"]`;
  const tabP = browser.waitForTarget((t) => t.url().includes(`home.html?open=${encodeURIComponent(pdfKey)}`), { timeout: 10000 });
  await page.click(`${pdfRow} button.title`);
  const viewerTab = await (await tabP).page();
  await viewerTab.waitForSelector("iframe", { timeout: 10000 }).catch(() => null);
  check(!!(await viewerTab.$("iframe")) && (await viewerTab.title()) === PDF, `upload opens in the viewer (title «${await viewerTab.title()}»)`);
  await viewerTab.close();
  await page.bringToFront();

  // 2. Refused: an archive and the old Excel format.
  await input.uploadFile(files.zip, files.xls, files.ods);
  const n2 = await until(async () => {
    const n = await notes();
    return n.length >= 3 && n.some((x) => x.text.startsWith("Trabajos.zip")) ? n : null;
  }, 10000);
  log("notes:", JSON.stringify(n2));
  check(n2?.some((n) => n.kind === "error" && n.text === "Trabajos.zip: este tipo de archivo no se puede leer"), "«Trabajos.zip: este tipo de archivo no se puede leer»");
  check(n2?.some((n) => n.kind === "error" && n.text === "Antiguo.xls: guárdalo como .xlsx y vuelve a subirlo"), "«Antiguo.xls: guárdalo como .xlsx y vuelve a subirlo»");
  check(n2?.some((n) => n.kind === "error" && n.text === "Hoja.ods: guárdalo como .xlsx y vuelve a subirlo"), "«Hoja.ods: guárdalo como .xlsx y vuelve a subirlo»");
  check((await uploadRows()).length === 2, "refused files not added");

  // 3. Drag and drop: the hint shows while dragging; dropping adds the file.
  await page.evaluate((name) => {
    const dt = new DataTransfer();
    dt.items.add(new File(["Examen de Civil: 15 de enero"], name, { type: "text/plain" }));
    window.__dt = dt;
    document.body.dispatchEvent(new DragEvent("dragenter", { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new DragEvent("dragover", { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, DROPPED);
  check(await page.$eval("#dropHint", (e) => !e.hidden && getComputedStyle(e).display !== "none"), "drop hint visible while dragging");
  await page.evaluate(() => document.body.dispatchEvent(new DragEvent("drop", { dataTransfer: window.__dt, bubbles: true, cancelable: true })));
  const n3 = await until(async () => ((await notes()).some((n) => n.text === `${DROPPED} añadido`) ? notes() : null), 10000);
  check(!!n3, `«${DROPPED} añadido» after dropping`);
  check(await page.$eval("#dropHint", (e) => e.hidden), "drop hint hidden after the drop");
  check(!!(await until(async () => (await uploadRows()).some((r) => r.title === DROPPED), 5000)), "dropped file under «Mis archivos»");
  check((await page.$$("#list b, #uploadNotes b")).length === 0, "a file name with markup shows as text, never as HTML");

  // 4. A campus file (fixture, sent the way the content script sends it): no «Borrar», delete refused.
  const campus = { key: "99:/Tema1.pdf", cmid: 99, courseId: 7, section: "Tema 1", name: "Tema 1", modname: "resource", url: "https://www.campusvirtual.uniovi.es/pluginfile.php/1/mod_resource/content/1/Tema1.pdf", filename: "Tema1.pdf", timemodified: 1700000000 };
  await page.evaluate((resource, b64) => chrome.runtime.sendMessage({ type: "upload-file", resource, filename: resource.filename, contentType: "application/pdf", base64: b64 }), campus, pdf().toString("base64"));
  await page.reload({ waitUntil: "load" });
  const campusRow = await until(() => page.$(`li.file[data-key="${campus.key}"]`), 10000);
  check(!!campusRow && !(await page.$(`li.file[data-key="${campus.key}"] [data-action="delete"]`)), "campus file listed without «Borrar»");
  check(!(await page.$(`details[data-course-id="0"] li.file[data-key="${campus.key}"]`)), "campus file not in «Mis archivos»");
  const refused = await page.evaluate((key) => chrome.runtime.sendMessage({ type: "delete-upload", key }), campus.key);
  check(refused?.ok === false && (await idb(campus.key)).file, `delete-upload refuses a campus key (${JSON.stringify(refused)})`);

  // 5. Delete the PDF upload: first click asks «¿Seguro?», second deletes (page and IndexedDB, its
  // cached text too: the background extracts it a few seconds after the upload).
  const pdfTexts = await until(async () => (await idb(pdfKey)).texts.length > 0, 20000);
  check(!!pdfTexts, "PDF text extracted by the background before the delete");
  // «Borrar» is in the row's «⋯» menu: hidden until the menu opens, and the menu stays open between clicks.
  const del = `li.file[data-key="${pdfKey}"] [data-action="delete"]`;
  check(await page.$eval(del, (b) => !b.checkVisibility()), "«Borrar» hidden until «⋯» is opened");
  await page.click(`li.file[data-key="${pdfKey}"] button.more`);
  check(await page.$eval(del, (b) => b.checkVisibility()), "«⋯» shows «Borrar»");
  await page.click(del);
  check((await page.$eval(del, (b) => b.textContent)) === "¿Seguro?", "first click asks «¿Seguro?»");
  check(!!(await idb(pdfKey)).file, "nothing deleted after the first click");
  await page.click(del);
  const gone = await until(async () => !(await page.$(`li.file[data-key="${pdfKey}"]`)), 10000);
  check(!!gone, "deleted upload gone from the page");
  check((await notes()).some((n) => n.text === `${PDF} borrado`), `«${PDF} borrado»`);
  const after = await idb(pdfKey);
  check(after.file === null && after.blob === false && after.texts.length === 0, `deleted from IndexedDB (files, blobs, texts: ${JSON.stringify(after)})`);
  check(!!(await idb(xlsxKey)).file, "the other upload is still there");

  // The background extracts text a few seconds after an upload (xlsx: when the extractor supports it).
  await sleep(1000);
  const texts = await until(async () => ((await idb(xlsxKey)).texts.length ? (await idb(xlsxKey)).texts : null), 15000);
  log("INFO xlsx text cached:", texts ? "yes" : "not (yet)");
} catch (e) {
  fail++;
  log("FAIL exception", e.stack);
} finally {
  log(`RESULT pass=${pass} fail=${fail}`);
  await browser.close();
  rmSync(profile, { recursive: true, force: true });
  rmSync(dir, { recursive: true, force: true });
  process.exitCode = fail ? 1 : 0;
}
