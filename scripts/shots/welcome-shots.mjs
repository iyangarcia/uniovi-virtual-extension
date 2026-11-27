// The welcome page screenshots for the docs: welcome-empty.png (fresh profile, nothing synced yet)
// and welcome.png (after seeding a small FAKE snapshot: invented courses, one assignment, one forum
// post with an exam date). Light theme, 1100 px wide, DSF 2. Also the side panel (home.html) at 360 px:
// panel-empty.png (fresh: «Conecta tu IA» card), panel.png (seeded, after a first AI request: status
// line + Mis apuntes) and panel-ajustes.png («Ajustes» open). Offline profile, AI connection off, the
// dev bridge failed before anything is seeded. Never real campus data.
// usage: node welcome-shots.mjs [--out <dir>] [--headful]   (default out: scripts/shots/out)
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { args, auditIdentity, blockBridge, extensionWorker, launchWithExtension, log, maskLink, requireBuild, SHOTS_DIR, sleep, until } from "./lib.mjs";

const opts = args();
const out = resolve(typeof opts.out === "string" ? opts.out : join(SHOTS_DIR, "out"));
mkdirSync(out, { recursive: true });

const day = 86400;
const now = Math.floor(Date.now() / 1000);
const CAMPUS = "https://www.campusvirtual.uniovi.es";
const res = (cmid, courseId, section, name, filename, ageDays) => ({
  key: `${cmid}:/${filename}`, cmid, courseId, section, name, modname: "resource",
  url: `${CAMPUS}/mod/resource/view.php?id=${cmid}`, filename, timemodified: now - ageDays * day,
});
const resources = [
  res(11, 101, "Tema 1. La persona", "Apuntes del tema 1", "tema1.txt", 30),
  res(12, 101, "Tema 2. Capacidad", "Esquema del tema 2", "esquema-tema2.txt", 6),
  res(21, 102, "Tema 1. Fuentes", "Fuentes del Derecho Romano", "fuentes.txt", 12),
];
const snapshot = {
  syncedAt: now, siteUrl: CAMPUS, warnings: [], events: [],
  courses: [
    { id: 101, shortname: "DCIV1", fullname: "Derecho Civil I", url: `${CAMPUS}/course/view.php?id=101` },
    { id: 102, shortname: "DROM", fullname: "Derecho Romano", url: `${CAMPUS}/course/view.php?id=102` },
  ],
  resources,
  assignments: [{ id: 7, cmid: 70, courseId: 101, name: "Comentario de sentencia", dueDate: now + 5 * day, intro: "Entrega en PDF", url: `${CAMPUS}/mod/assign/view.php?id=70` }],
  posts: [{ id: 501, discussionId: 50, courseId: 102, forumName: "Avisos", subject: "Fecha del examen final", author: "Profesora", created: now - day, message: "El examen final será el 20 de enero de 2027 a las 10:00 en el aula A.", url: `${CAMPUS}/mod/forum/discuss.php?d=50` }],
};

const dist = requireBuild();
const profile = mkdtempSync(join(tmpdir(), "uv-welcome-"));
const browser = await launchWithExtension(dist, profile, { headless: !opts.headful });
let failed = false;
try {
  const bridge = await blockBridge(browser);
  const { sw, extId } = await extensionWorker(browser);
  log("bridge blocked:", await bridge.assertBlocked(sw));
  await sw.evaluate(() => chrome.storage.local.set({ aiConnection: false }));
  const store = (k) => sw.evaluate((k) => chrome.storage.local.get(k), k);

  const page = await browser.newPage();
  await page.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await page.setViewport({ width: 1100, height: 900, deviceScaleFactor: 2 });
  const shoot = async (name, target = page, before = async () => undefined) => {
    await target.reload({ waitUntil: "load" });
    await sleep(800);
    await before();
    await maskLink(target, "input[type=url], input#linkBox").catch(() => undefined);
    const ident = await store("agent");
    await auditIdentity(target, { secrets: [ident.agent?.id, ident.agent?.token, ident.agent?.secret] });
    await target.screenshot({ path: join(out, name), fullPage: true });
    log("saved", join(out, name));
  };
  await page.goto(`chrome-extension://${extId}/welcome.html`, { waitUntil: "load" });
  await shoot("welcome-empty.png");

  // The side panel is home.html; a tab of the panel's usual width shows the same page.
  const panel = await browser.newPage();
  await panel.emulateMediaFeatures([{ name: "prefers-color-scheme", value: "light" }]);
  await panel.setViewport({ width: 360, height: 760, deviceScaleFactor: 2 });
  await panel.goto(`chrome-extension://${extId}/home.html`, { waitUntil: "load" });
  await shoot("panel-empty.png", panel);
  await page.bringToFront();

  // Seed the fake snapshot through the same messages the content script sends.
  const send = (m) => page.evaluate((msg) => chrome.runtime.sendMessage(msg), m);
  if (!(await send({ type: "snapshot-collected", snapshot }))?.ok) throw new Error("snapshot-collected failed");
  for (const r of resources) {
    const base64 = Buffer.from(`${r.name}: texto de ejemplo`).toString("base64");
    if (!(await send({ type: "upload-file", resource: r, filename: r.filename, contentType: "text/plain", base64 }))?.ok) throw new Error(`upload ${r.filename} failed`);
  }
  await send({ type: "progress", text: "2 asignaturas, 3 materiales, 1 mensaje", running: false });
  await until(async () => !!(await store("syncState")).syncState?.lastSync, 5000);
  await shoot("welcome.png");

  // As if an AI had already asked once (the welcome page's step 3): the panel drops the card.
  await sw.evaluate(() => chrome.storage.local.set({ agentStats: { requests: 1 } }));
  await panel.bringToFront();
  await shoot("panel.png", panel);
  await shoot("panel-ajustes.png", panel, async () => {
    await panel.evaluate(() => (document.getElementById("settings").open = true));
    await sleep(300);
  });
  log(`bridge requests failed: ${bridge.count()}`);
} catch (e) {
  failed = true;
  log("FAIL", e.stack);
} finally {
  await browser.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = failed ? 1 : 0;
}
