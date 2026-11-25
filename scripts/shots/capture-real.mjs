// Anonymized screenshot of a real AI page, for the student guide (docs/img). Connects to an already
// running, normal Chrome started with --remote-debugging-port=9333, where the person signed in by hand.
//
// Before the shot it anonymizes the page (only in this tab's DOM; nothing is sent anywhere):
//   - UV_REAL_NAME / UV_REAL_EMAIL (env, comma lists, never committed) → «Estudiante Uniovi» /
//     estudiante@example.com, in text and in aria-label / title / alt / placeholder;
//   - avatar images (in header / account buttons) → an initials SVG;
//   - chat history items (navigation lists) → neutral titles;
//   - cross-origin iframes removed; URL inputs show https://…/mcp/••••••••/••••••••.
// Then auditIdentity() must pass (also against UV_SECRETS, a comma list of the agent id / token),
// otherwise no file is written. A highlight is drawn if asked.
//
// It clicks nothing unless --click is given, and never an element whose text is a confirm word.
// usage: node capture-real.mjs --site claude|chatgpt|gemini --step <name> --out <dir>
//          [--highlight <selector> | --highlight-text <button text>] [--label <text>] [--n <number>]
//          [--click <selector>] [--hide <selector>] [--clip <selector>] [--pad <px>]
// --hide: display:none on those elements (e.g. a sidebar); --clip: crop to that element's box (+pad, default 24).
import puppeteer from "puppeteer";
import { mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { args, auditIdentity, clearHighlights, highlight, identityFromEnv, log, MASKED_LINK, sleep } from "./lib.mjs";

const ORIGINS = { claude: "https://claude.ai", chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com" };
const CONFIRM = /^(add|anadir|agregar|create|crear|save|guardar|confirm|confirmar|connect|conectar|done|listo|finish|finalizar|submit|enviar|ok|aceptar|allow|permitir|allow always|permitir siempre)$/;
const NEUTRAL_TITLES = ["Resumen tema 2", "Dudas examen", "Esquema Derecho Romano", "Plan de estudio semanal", "Preguntas de repaso", "Comentario de sentencia", "Apuntes tema 1", "Fechas de entrega"];
const FAKE_NAME = "Estudiante Uniovi";
const FAKE_EMAIL = "estudiante@example.com";

const opts = args();
const site = opts.site;
if (!ORIGINS[site] || typeof opts.step !== "string" || typeof opts.out !== "string") {
  console.error("usage: node capture-real.mjs --site claude|chatgpt|gemini --step <name> --out <dir> [--highlight <sel> | --highlight-text <text>] [--label <text>] [--n <k>] [--click <sel>] [--hide <sel>] [--clip <sel>] [--pad <px>]");
  process.exit(2);
}
const out = resolve(opts.out);
mkdirSync(out, { recursive: true });
const ident = identityFromEnv();
if (!ident.names.length || !ident.emails.length) log("warning: UV_REAL_NAME / UV_REAL_EMAIL not set, the audit only checks connector links and UV_SECRETS");

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
let failed = false;
try {
  const page = (await browser.pages()).find((p) => p.url().startsWith(ORIGINS[site]));
  if (!page) throw new Error(`no open tab on ${ORIGINS[site]}`);
  await page.bringToFront();
  await clearHighlights(page); // overlays left by an earlier run

  if (typeof opts.hide === "string") await page.$$eval(opts.hide, (els) => els.forEach((e) => e.style.setProperty("display", "none", "important")));

  const { width, height } = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  // Already at 2x: no resize (a resize closes open popovers).
  if (Math.abs((await page.evaluate(() => devicePixelRatio)) - 2) > 0.01) {
    await page.setViewport({ width, height, deviceScaleFactor: 2 });
    await sleep(300);
  }

  // After the viewport change, so a menu opened here stays open for the shot.
  if (typeof opts.click === "string") {
    const el = await page.waitForSelector(opts.click, { timeout: 10000 });
    const text = await el.evaluate((e) => (e.innerText || e.getAttribute("aria-label") || "").normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/\s+/g, " ").trim().toLowerCase());
    // A menu trigger ("Add ▾", aria-haspopup) only opens a menu, so its label may be a confirm word.
    const menuTrigger = await el.evaluate((e) => /^(menu|true)$/.test(e.getAttribute("aria-haspopup") ?? ""));
    if (CONFIRM.test(text) && !menuTrigger) throw new Error(`refusing to click a confirm button ("${text}"): the person presses it`);
    await el.click();
    await sleep(800);
  }

  await page.evaluate(
    ({ names, emails, fakeName, fakeEmail, titles, masked }) => {
      const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const pairs = [...names.map((n) => [n, fakeName]), ...emails.map((e) => [e, fakeEmail])].filter(([v]) => v);
      // Also each part of the name (first name alone, surname alone), longest first.
      for (const n of names) for (const part of n.split(/\s+/)) if (part.length > 2) pairs.push([part, fakeName.split(" ")[0]]);
      pairs.sort((a, b) => b[0].length - a[0].length);
      // Connector links shown as text (e.g. read-only after the AI checked the server) are masked too,
      // before the names, since the relay host can contain the maintainer's handle.
      const LINK = /[^\s"'<>]*\/mcp\/[A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?/g;
      const swap = (s) => pairs.reduce((acc, [from, to]) => acc.replace(new RegExp(esc(from), "gi"), to), s.replace(LINK, masked));
      const roots = [document];
      for (let i = 0; i < roots.length; i++) for (const el of roots[i].querySelectorAll("*")) if (el.shadowRoot) roots.push(el.shadowRoot);
      for (const root of roots) {
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
        for (let t = walker.nextNode(); t; t = walker.nextNode()) {
          const v = swap(t.nodeValue);
          if (v !== t.nodeValue) t.nodeValue = v;
        }
        for (const el of root.querySelectorAll("[aria-label], [title], [alt], [placeholder], [value], [href]")) {
          for (const a of ["aria-label", "title", "alt", "placeholder", "value", "href"]) {
            const v = el.getAttribute(a);
            if (v != null && swap(v) !== v) el.setAttribute(a, swap(v));
          }
        }
        // Avatars: images and background images inside header / account / profile controls.
        const initials = "data:image/svg+xml," + encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><circle cx="32" cy="32" r="32" fill="#6b7a8f"/><text x="32" y="41" font-family="Segoe UI,Arial,sans-serif" font-size="26" font-weight="600" fill="#fff" text-anchor="middle">EU</text></svg>`);
        const ACCOUNT = "header, [aria-label*='account' i], [aria-label*='cuenta' i], [aria-label*='profile' i], [aria-label*='perfil' i], [data-testid*='profile' i], [data-testid*='account' i], button[aria-haspopup]";
        for (const img of root.querySelectorAll("img")) {
          if (img.closest(ACCOUNT) || /avatar|profile|photo|googleusercontent/i.test(img.src + " " + img.alt + " " + img.className)) {
            img.srcset = "";
            img.src = initials;
            img.alt = fakeName;
          }
        }
        for (const el of root.querySelectorAll(`${ACCOUNT}, ${ACCOUNT} *`)) {
          if (/url\(/.test(getComputedStyle(el).backgroundImage)) el.style.backgroundImage = `url("${initials}")`;
        }
        // Chat history: the links/items of navigation lists get neutral titles.
        let k = 0;
        for (const nav of root.querySelectorAll("nav, [role='navigation'], mat-nav-list, aside")) {
          for (const item of nav.querySelectorAll("a[href*='/c/'], a[href*='/chat/'], a[href*='/app/'], [role='listitem'], mat-list-item, li")) {
            const leaf = [...item.querySelectorAll("*")].reverse().find((e) => !e.children.length && e.textContent.trim()) ?? item;
            if (leaf.textContent.trim().length > 2) leaf.textContent = titles[k++ % titles.length];
          }
        }
        // Connector links in inputs.
        for (const input of root.querySelectorAll("input, textarea")) {
          if (/\/mcp\//.test(input.value) || input.type === "url") {
            const proto = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            if (input.value) Object.getOwnPropertyDescriptor(proto, "value").set.call(input, masked);
            if (input.hasAttribute("value")) input.setAttribute("value", masked);
          }
        }
      }
      // Cross-origin iframes (account widgets, ads): gone.
      for (const f of document.querySelectorAll("iframe")) {
        try {
          if (new URL(f.src, location.href).origin !== location.origin) f.remove();
        } catch {
          f.remove();
        }
      }
    },
    { names: ident.names, emails: ident.emails, fakeName: FAKE_NAME, fakeEmail: FAKE_EMAIL, titles: NEUTRAL_TITLES, masked: MASKED_LINK },
  );

  await auditIdentity(page, ident);

  if (typeof opts.highlight === "string" || typeof opts["highlight-text"] === "string") {
    let target = opts.highlight;
    if (typeof opts["highlight-text"] === "string") {
      const clean = (v) => v.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
      const wanted = clean(opts["highlight-text"]);
      const handles = await page.$$("button, [role='button'], [role='menuitem'], a, input, label");
      for (const h of handles) {
        const t = clean(await h.evaluate((e) => e.innerText || e.getAttribute("aria-label") || ""));
        const box = await h.boundingBox();
        if (box && t === wanted) {
          target = h;
          break;
        }
      }
      if (typeof target !== "object") throw new Error(`nothing visible with the text "${opts["highlight-text"]}"`);
    }
    await highlight(page, target, typeof opts.label === "string" ? opts.label : "", { n: opts.n });
  }

  const file = join(out, `${opts.step}.png`);
  let clip;
  if (typeof opts.clip === "string") {
    const el = await page.waitForSelector(opts.clip, { timeout: 10000, visible: true });
    const box = await el.boundingBox();
    if (!box) throw new Error(`--clip ${opts.clip}: not visible`);
    const pad = Number(opts.pad ?? 24);
    const vw = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
    const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
    clip = { x, y, width: Math.min(vw.w - x, box.width + 2 * pad), height: Math.min(vw.h - y, box.height + 2 * pad) };
  }
  await page.screenshot({ path: file, ...(clip ? { clip } : {}) });
  log("saved", file);
} catch (e) {
  failed = true;
  log("FAIL", e.message);
} finally {
  await browser.disconnect();
  process.exitCode = failed ? 1 : 0;
}
