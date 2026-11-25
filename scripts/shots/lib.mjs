// Shared helpers for the browser scripts in scripts/shots/ (Chrome for Testing through puppeteer).
// Safety rules (CLAUDE.md): never real campus data near these scripts, and the dev bridge on
// 127.0.0.1:47823 is always failed before anything is seeded into the extension.
import puppeteer from "puppeteer";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SHOTS_DIR = dirname(fileURLToPath(import.meta.url));
export const REPO = resolve(SHOTS_DIR, "../..");
export const DIST = join(REPO, "extension/dist");
export const FIXTURES = join(REPO, "server/test/fixtures/autofill");
export const FIXTURE_BASE = "https://campusvirtual.uniovi.es/__fixture";
export const BRIDGE = "http://127.0.0.1:47823";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

/** Polls `fn` until it returns something truthy, or `ms` runs out (then returns the last value). */
export async function until(fn, ms = 10000, step = 200) {
  const end = Date.now() + ms;
  let v;
  while (Date.now() < end) {
    v = await fn();
    if (v) return v;
    await sleep(step);
  }
  return v;
}

/** `--name value` / `--flag` command-line options. */
export function args(argv = process.argv.slice(2)) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) out[a.slice(2)] = true;
    else out[a.slice(2)] = argv[++i];
  }
  return out;
}

export function requireBuild(dist = DIST) {
  if (!existsSync(join(dist, "manifest.json"))) throw new Error(`no build at ${dist}: run "npm run build" at the repository root first`);
  return dist;
}

/** Spanish UI and content language for a new profile (same prefs as the chrome://extensions shots). */
function spanishProfile(userDataDir) {
  mkdirSync(join(userDataDir, "Default"), { recursive: true });
  const prefs = join(userDataDir, "Default", "Preferences");
  if (!existsSync(prefs)) writeFileSync(prefs, JSON.stringify({ intl: { accept_languages: "es-ES,es", selected_languages: "es-ES,es" } }));
  const state = join(userDataDir, "Local State");
  if (!existsSync(state)) writeFileSync(state, JSON.stringify({ intl: { app_locale: "es" } }));
}

/**
 * Chrome for Testing with the unpacked extension. `offline` (default) makes every hostname resolve to
 * nothing except 127.0.0.1, so fixture runs can't reach a real site even by mistake.
 */
export async function launchWithExtension(distPath, userDataDir, { headless = true, offline = true, width = 1200, height = 900 } = {}) {
  spanishProfile(userDataDir);
  return puppeteer.launch({
    headless,
    pipe: true,
    protocolTimeout: 60000,
    userDataDir,
    enableExtensions: [distPath],
    args: ["--lang=es-ES", "--accept-lang=es-ES", `--window-size=${width},${height}`, ...(offline ? ["--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1"] : [])],
    env: { ...process.env, LANGUAGE: "es" },
  });
}

/**
 * Fails every request to the dev bridge (127.0.0.1:47823), browser-wide (the service worker too),
 * so fixture data never lands in a developer's real ~/uniovi-data. Call `assertBlocked(sw)` before
 * seeding anything: it throws unless a probe from the service worker was refused by this block.
 */
export async function blockBridge(browser) {
  const session = await browser.target().createCDPSession();
  let blocked = 0;
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `${BRIDGE}/*` }] });
  session.on("Fetch.requestPaused", (e) => {
    blocked++;
    session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "ConnectionRefused" }).catch(() => undefined);
  });
  return {
    count: () => blocked,
    async assertBlocked(sw) {
      const before = blocked;
      const probe = await sw.evaluate((u) => fetch(`${u}/api/status`).then((r) => `status ${r.status}`, (e) => `failed: ${e.message}`), BRIDGE);
      if (!probe.startsWith("failed") || blocked === before) throw new Error(`bridge ${BRIDGE} is NOT blocked (${probe}): refusing to seed fixture data`);
      return probe;
    },
  };
}

/** Serves server/test/fixtures/autofill/* at https://campusvirtual.uniovi.es/__fixture/* (an origin the extension may script). */
export async function serveFixtures(browser, dir = FIXTURES) {
  const session = await browser.target().createCDPSession();
  await session.send("Fetch.enable", { patterns: [{ urlPattern: `${FIXTURE_BASE}/*` }] });
  session.on("Fetch.requestPaused", async (e) => {
    try {
      const name = new URL(e.request.url).pathname.replace("/__fixture/", "");
      if (name.includes("..")) throw new Error("bad path");
      const body = readFileSync(join(dir, name));
      const type = name.endsWith(".js") ? "text/javascript" : "text/html; charset=utf-8";
      await session.send("Fetch.fulfillRequest", { requestId: e.requestId, responseCode: 200, responseHeaders: [{ name: "content-type", value: type }], body: body.toString("base64") });
    } catch {
      await session.send("Fetch.failRequest", { requestId: e.requestId, errorReason: "Failed" }).catch(() => undefined);
    }
  });
}

/** The extension's service worker (waits for it) and its id. */
export async function extensionWorker(browser) {
  const target = await browser.waitForTarget((t) => t.type() === "service_worker" && t.url().endsWith("background.js"), { timeout: 20000 });
  const sw = await target.worker();
  await until(async () => (await sw.evaluate(() => typeof chrome.storage)) === "object");
  return { sw, extId: new URL(target.url()).host };
}

/**
 * Draws a highlight around an element: a #e8590c 4px rounded ring, the rest of the page dimmed, and
 * an orange label below (or above) it. `target` is a selector (puppeteer syntax, `pierce/` works)
 * or an ElementHandle. `n` prefixes the label with a step number.
 */
export async function highlight(page, target, label, { n, pad = 8, below = true } = {}) {
  const el = typeof target === "string" ? await page.waitForSelector(target, { timeout: 10000 }) : target;
  await el.scrollIntoView().catch(() => undefined);
  const b = await el.boundingBox();
  if (!b) throw new Error(`highlight: "${label}" has no box`);
  const text = n ? `${n}. ${label}` : label;
  await page.evaluate(
    (b, text, pad, below) => {
      const ring = document.createElement("div");
      ring.dataset.uvShot = "ring";
      Object.assign(ring.style, {
        position: "fixed", left: `${b.x - pad}px`, top: `${b.y - pad}px`, width: `${b.width + 2 * pad}px`, height: `${b.height + 2 * pad}px`,
        border: "4px solid #e8590c", borderRadius: "14px", boxShadow: "0 0 0 9999px rgba(0,0,0,.28)", zIndex: 2147483646, pointerEvents: "none", boxSizing: "border-box",
      });
      const tag = document.createElement("div");
      tag.dataset.uvShot = "label";
      tag.textContent = text;
      Object.assign(tag.style, {
        position: "fixed", zIndex: 2147483647, background: "#e8590c", color: "#fff", font: "600 18px/1.3 'Segoe UI', system-ui, sans-serif",
        padding: "8px 14px", borderRadius: "10px", whiteSpace: "nowrap", pointerEvents: "none",
      });
      document.documentElement.append(ring, tag);
      const fitsBelow = b.y + b.height + pad + 12 + tag.offsetHeight < innerHeight;
      const top = below && fitsBelow ? b.y + b.height + pad + 12 : Math.max(8, b.y - pad - tag.offsetHeight - 12);
      tag.style.top = `${top}px`;
      tag.style.left = `${Math.max(12, Math.min(b.x - pad, innerWidth - tag.offsetWidth - 12))}px`;
    },
    { x: b.x, y: b.y, width: b.width, height: b.height }, text, pad, below,
  );
}

export async function clearHighlights(page) {
  await page.evaluate(() => document.querySelectorAll("[data-uv-shot]").forEach((e) => e.remove()));
}

export const MASKED_LINK = "https://…/mcp/••••••••/••••••••";

/**
 * Shows a masked link in the inputs matching `selector` (native setter, no events, so the page's own
 * state keeps the real value). Returns the previous values, for restoreLink().
 */
export async function maskLink(page, selector, masked = MASKED_LINK) {
  return page.$$eval(
    selector,
    (els, masked) =>
      els.map((el) => {
        const old = el.value;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, "value").set.call(el, masked);
        return old;
      }),
    masked,
  );
}

export async function restoreLink(page, selector, values) {
  await page.$$eval(
    selector,
    (els, values) =>
      els.forEach((el, i) => {
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        if (values[i] !== undefined) Object.getOwnPropertyDescriptor(proto, "value").set.call(el, values[i]);
      }),
    values,
  );
}

const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
export const MCP_LINK_RE = /\/mcp\/[A-Za-z0-9_-]{6,}/;

/**
 * Gate before every screenshot: collects the visible text, every attribute value and every input
 * value of every frame (open shadow roots included) and throws if a real name, email, secret or an
 * unmasked connector link (/mcp/<id>) shows up. The error names the category, never the value.
 */
export async function auditIdentity(page, { names = [], emails = [], secrets = [] } = {}) {
  const needles = [
    ...names.filter(Boolean).map((v) => ["name", v]),
    ...emails.filter(Boolean).map((v) => ["email", v]),
    ...secrets.filter(Boolean).map((v) => ["secret", v]),
  ];
  const hits = [];
  for (const frame of page.frames()) {
    let text;
    try {
      text = await frame.evaluate(() => {
        const out = [document.title, document.body?.innerText ?? ""];
        const walk = (root) => {
          for (const el of root.querySelectorAll("*")) {
            for (const a of el.attributes) out.push(a.value);
            if ("value" in el && typeof el.value === "string") out.push(el.value);
            if (el.shadowRoot) {
              out.push(el.shadowRoot.textContent ?? "");
              walk(el.shadowRoot);
            }
          }
        };
        walk(document);
        return out.join("\n");
      });
    } catch (err) {
      throw new Error(`auditIdentity: could not read frame ${frame.url().slice(0, 60)} (${err.message}); remove it before the shot`);
    }
    const folded = fold(text);
    for (const [kind, v] of needles) if (folded.includes(fold(v))) hits.push(kind);
    if (MCP_LINK_RE.test(text)) hits.push("connector link");
  }
  if (hits.length) throw new Error(`auditIdentity: found ${[...new Set(hits)].join(", ")} on the page; not taking the shot`);
}

/** Identity values from the environment (never committed): UV_REAL_NAME, UV_REAL_EMAIL, UV_SECRETS (comma list). */
export function identityFromEnv(extraSecrets = []) {
  const list = (v) => (v ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  return {
    names: list(process.env.UV_REAL_NAME),
    emails: list(process.env.UV_REAL_EMAIL),
    secrets: [...list(process.env.UV_SECRETS), ...extraSecrets.filter(Boolean)],
  };
}
