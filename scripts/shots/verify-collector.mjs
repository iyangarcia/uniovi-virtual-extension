// The collector against a mock campus (server/test/fixtures/campus/routes.mjs): every kind of
// activity ends up with its full text (pages, links, books, quizzes, assignments, the course page),
// and files linked from them are listed for download. Runs extension/src/collector.ts bundled on the
// fly in a plain Chrome for Testing page on a made-up host (https://campus.test), all requests
// answered by the mock: nothing reaches a real site.
// usage: node verify-collector.mjs   (exit code 1 on any failure)
import { build } from "esbuild";
import puppeteer from "puppeteer";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { log, REPO } from "./lib.mjs";

const { pages, ws } = await import(pathToFileURL(join(REPO, "server/test/fixtures/campus/routes.mjs")).href);
const ORIGIN = "https://campus.test";
let pass = 0;
let fail = 0;
const check = (ok, what) => {
  ok ? pass++ : fail++;
  log(ok ? "PASS" : "FAIL", what);
};

const bundle = await build({
  stdin: { contents: `export { collect } from "./extension/src/collector.ts"; export { MoodleClient } from "./extension/src/moodle.ts";`, resolveDir: REPO, loader: "ts" },
  bundle: true,
  format: "iife",
  globalName: "uv",
  write: false,
});

const browser = await puppeteer.launch({ headless: true, args: ["--host-resolver-rules=MAP * ~NOTFOUND"] });
try {
  const tab = await browser.newPage();
  const requested = [];
  await tab.setRequestInterception(true);
  tab.on("request", (req) => {
    const u = new URL(req.url());
    if (u.origin !== ORIGIN) return req.abort();
    const path = u.pathname + u.search;
    requested.push(path);
    if (u.pathname === "/lib/ajax/service.php") {
      const name = u.searchParams.get("info");
      const body = name in ws ? [{ error: false, data: ws[name] }] : [{ error: true, exception: { message: "Servicio no disponible", errorcode: "servicenotavailable" } }];
      return req.respond({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    }
    if (path === "/my/") return req.respond({ status: 200, contentType: "text/html", body: "<!doctype html><title>Área personal</title>" });
    if (u.pathname.startsWith("/pluginfile.php/")) return req.respond({ status: 200, contentType: "application/pdf", body: "%PDF-1.4" });
    const html = pages[path];
    return html ? req.respond({ status: 200, contentType: "text/html; charset=utf-8", body: html }) : req.respond({ status: 404, contentType: "text/html", body: "Not found" });
  });
  await tab.goto(`${ORIGIN}/my/`);
  await tab.addScriptTag({ content: bundle.outputFiles[0].text });
  const { snapshot, texts } = await tab.evaluate(async (origin) => {
    const texts = {};
    const snapshot = await uv.collect(new uv.MoodleClient({ wwwroot: origin, sesskey: "x" }), {
      courseScope: "inprogress",
      replyWindowDays: 7,
      onProgress: () => undefined,
      onText: (r, t) => (texts[r.key] = { name: r.name, modname: r.modname, filename: r.filename, text: t }),
    });
    return { snapshot, texts };
  }, ORIGIN);

  const res = (key) => snapshot.resources.find((r) => r.key === key);
  const text = (key) => texts[key]?.text ?? "";
  log("resources:", snapshot.resources.map((r) => `${r.key} ${r.modname} "${r.name}"`).join(" · "));
  log("warnings:", snapshot.warnings.join(" | "));
  for (const [k, v] of Object.entries(texts)) log(`--- ${k} ${v.modname} ${v.filename} ---\n${v.text}`);

  // Course page: section summaries from every tab (teacher, evaluation rules, outside links spelled out).
  check(/Ana Fernández López/.test(text("course7:page")) && /examen final 70 %/.test(text("course7:page")) && /la persona y su capacidad/.test(text("course7:page")), "course page: teacher, evaluation and every tab's summary");
  check(text("course7:page").includes("<https://guias.example.es/derecho-civil-i>"), "course page: outside link spelled out");
  check(!!res("course7:page") && texts["course7:page"]?.filename === "Página de la asignatura DCI.txt", "course page listed as a material");
  // Activities found only on the section pages (resources.php leaves quizzes and assignments out).
  check(res("21:link")?.modname === "quiz" && res("21:link")?.name === "Test del tema 1" && res("21:link")?.section === "Tema 1", `quiz found with its name and section (${JSON.stringify(res("21:link"))})`);
  check(/Apertura:\s*lunes, 1 de diciembre/.test(text("21:link")) && /restan 0,25/.test(text("21:link")) && /Intentos permitidos: 1/.test(text("21:link")) && !/Intentar resolver/.test(text("21:link")), "quiz: dates, instructions, attempts; no button text");
  check(/Fecha de entrega:\s*10 de diciembre/.test(text("22:link")) && /máximo de 3 páginas/.test(text("22:link")) && /Estado de la entrega \| No entregado/.test(text("22:link")), "assignment: due date, full description, status table");
  check(res("22:file:/mod_assign/introattachment/0/sentencia.pdf")?.modname === "activity-file" && !res("22:file:/mod_assign/introattachment/0/sentencia.pdf").url.includes("forcedownload"), "assignment attachment listed for download");
  check(/Díez-Picazo/.test(text("11:link")) && /Semana \| Lectura/.test(text("11:link")) && !!res("11:file:/mod_page/content/3/esquema-tema1.pdf"), "page: full text, table, linked file");
  check(snapshot.resources.filter((r) => r.cmid === 11 && r.modname === "page").length === 1, "page listed once (resources.php and section page)");
  check(res("12:link")?.url === "https://www.boe.es/buscar/act.php?id=BOE-A-1889-4763" && /boe\.es/.test(text("12:link")), "link: target URL as the material URL and in its text");
  check(/Concepto de persona/.test(text("14:link")) && /Capacidad jurídica/.test(text("14:link")) && requested.includes("/mod/book/tool/print/index.php?id=14"), "book: every chapter (print view)");
  // Never in a text: page chrome, scripts.
  check(Object.values(texts).every((t) => !/script text|Área personal|Universidad de Oviedo/.test(t.text)), "no navigation, footer or script text");
  // Files and forums are not read as pages.
  check(!texts["13:/"] && !requested.some((p) => p.startsWith("/mod/forum/view.php?id=") || p.startsWith("/mod/resource/view.php?id=13&forceview")), "files and forums not read as pages");
  check(res("13:/")?.modname === "resource", "file still listed as a file");
} catch (e) {
  fail++;
  log("FAIL exception", e.stack);
} finally {
  log(`RESULT pass=${pass} fail=${fail}`);
  await browser.close();
  process.exitCode = fail ? 1 : 0;
}
