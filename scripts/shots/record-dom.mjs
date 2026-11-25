// Records the DOM of an AI's connector screens, to tune the auto-fill specs (extension/src/autofill/).
// Connects to an already running, normal Chrome started with --remote-debugging-port=9333 (sign-in
// happens there by hand, never through this script). It never clicks or types anything.
//
// Each snapshot writes to --out (keep it OUTSIDE the repository: raw dumps hold personal data):
//   <site>-<n>.raw.html      the open dialog's (or main's) outerHTML, raw. Never commit it.
//   <site>-<n>.summary.json  a sanitized outline: tags, roles, labels, button texts, input types,
//                            disabled, dialog/form nesting. Other text is dropped. Fails if
//                            UV_REAL_NAME / UV_REAL_EMAIL (env) appear in it.
// usage: node record-dom.mjs --site claude|chatgpt|gemini --out <dir> [--once]
//        without --once: press Enter for each snapshot, q + Enter to quit.
import puppeteer from "puppeteer";
import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { args, identityFromEnv, log } from "./lib.mjs";

const ORIGINS = { claude: "https://claude.ai", chatgpt: "https://chatgpt.com", gemini: "https://gemini.google.com" };
const opts = args();
const site = opts.site;
if (!ORIGINS[site] || typeof opts.out !== "string") {
  console.error("usage: node record-dom.mjs --site claude|chatgpt|gemini --out <dir> [--once]");
  process.exit(2);
}
const out = resolve(opts.out);
mkdirSync(out, { recursive: true });
const ident = identityFromEnv();
const fold = (s) => String(s ?? "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

const browser = await puppeteer.connect({ browserURL: "http://127.0.0.1:9333", defaultViewport: null });
const pages = await browser.pages();
const page = pages.find((p) => p.url().startsWith(ORIGINS[site]));
if (!page) {
  console.error(`no open tab on ${ORIGINS[site]}`);
  await browser.disconnect();
  process.exit(1);
}

let n = 0;
async function snapshot() {
  n++;
  const { raw, summary } = await page.evaluate(() => {
    const SHORT = 80;
    const clip = (s) => (s ?? "").replace(/\s+/g, " ").trim().slice(0, SHORT);
    const dialogs = [...document.querySelectorAll("[role='dialog'], [role='alertdialog'], dialog[open]")].filter((d) => d.getClientRects().length);
    const root = dialogs.at(-1) ?? document.querySelector("main") ?? document.body;
    const labelOf = (el) => {
      const parts = [el.getAttribute("aria-label"), el.getAttribute("placeholder")];
      for (const id of (el.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean)) parts.push(document.getElementById(id)?.textContent);
      if (el.id) for (const l of document.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`)) parts.push(l.textContent);
      parts.push(el.closest("label")?.textContent);
      return clip(parts.filter(Boolean).join(" | "));
    };
    const INTERESTING = "button, [role], input, textarea, select, label, form, dialog, h1, h2, h3, a[href], mat-dialog-container, mat-form-field, mat-checkbox, mat-dialog-actions, mat-dialog-content";
    const items = [];
    for (const el of root.querySelectorAll(INTERESTING)) {
      if (!el.getClientRects().length) continue;
      const tag = el.tagName.toLowerCase();
      const item = { tag };
      const role = el.getAttribute("role");
      if (role) item.role = role;
      if (el.closest("form")) item.inForm = true;
      if (el.closest("[role='dialog'], [role='alertdialog'], dialog")) item.inDialog = true;
      if (/^(input|textarea|select)$/.test(tag)) {
        item.type = el.getAttribute("type") ?? tag;
        if (el.getAttribute("name")) item.name = el.getAttribute("name");
        item.label = labelOf(el);
        item.hasValue = !!el.value;
        if (el.type === "checkbox") item.checked = el.checked;
      } else if (tag === "button" || role === "button" || role === "menuitem" || role === "tab" || role === "checkbox") {
        item.text = clip(el.innerText || el.textContent);
        if (el.getAttribute("aria-label")) item.ariaLabel = clip(el.getAttribute("aria-label"));
        if (el.hasAttribute("type")) item.typeAttr = el.getAttribute("type");
      } else if (tag === "label" || /^h[1-3]$/.test(tag)) {
        item.text = clip(el.textContent);
      }
      if (el.disabled || el.getAttribute("aria-disabled") === "true") item.disabled = true;
      items.push(item);
    }
    return { raw: root.outerHTML, summary: { url: location.origin + location.pathname, dialogs: dialogs.length, root: root.tagName.toLowerCase(), items } };
  });
  const json = JSON.stringify(summary, null, 2);
  const folded = fold(json);
  for (const v of [...ident.names, ...ident.emails]) {
    if (folded.includes(fold(v))) throw new Error("the summary contains the real name or email: not writing it; dismiss that part of the page and retry");
  }
  writeFileSync(join(out, `${site}-${n}.raw.html`), raw);
  writeFileSync(join(out, `${site}-${n}.summary.json`), json);
  log(`snapshot ${n}: ${summary.items.length} elements, ${summary.dialogs} dialog(s) → ${out}`);
}

try {
  if (opts.once) await snapshot();
  else {
    const rl = createInterface({ input: process.stdin });
    log("Enter = snapshot, q + Enter = quit");
    for await (const line of rl) {
      if (line.trim() === "q") break;
      await snapshot().catch((e) => log("snapshot failed:", e.message));
    }
    rl.close();
  }
} finally {
  await browser.disconnect();
}
