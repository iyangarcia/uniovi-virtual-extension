// Auto-fill against the look-alike pages in server/test/fixtures/autofill, through the welcome page's
// «Conectar automáticamente» buttons, in Chrome for Testing with the built extension (extension/dist).
// Offline profile, the dev bridge failed, no relay (aiConnection off): the link is a fake one.
// usage: node verify-autofill.mjs [--headful]   (exit code 1 on any failure)
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { args, blockBridge, extensionWorker, FIXTURE_BASE, launchWithExtension, log, requireBuild, serveFixtures, sleep, until } from "./lib.mjs";

const opts = args();
const FAKE_RELAY = "https://relay.invalid";
const FAIL_TEXT = "No pude rellenarlo solo: el enlace está copiado, pégalo en el campo URL (Ctrl+V)";
let pass = 0;
let fail = 0;
const check = (ok, what) => {
  ok ? pass++ : fail++;
  log(ok ? "PASS" : "FAIL", what);
};

const dist = requireBuild();
const profile = mkdtempSync(join(tmpdir(), "uv-autofill-"));
const browser = await launchWithExtension(dist, profile, { headless: !opts.headful });
try {
  const bridge = await blockBridge(browser);
  await serveFixtures(browser);
  const { sw, extId } = await extensionWorker(browser);
  check(true, `bridge blocked (${await bridge.assertBlocked(sw)})`);
  await sw.evaluate((relay) => chrome.storage.local.set({ aiConnection: false, devRelayUrl: relay }), FAKE_RELAY);

  const origin = `chrome-extension://${extId}`;
  await browser.defaultBrowserContext().overridePermissions(origin, ["clipboard-read", "clipboard-write", "clipboard-sanitized-write"]);
  const welcome = await browser.newPage();
  await welcome.setViewport({ width: 1100, height: 900 });
  await welcome.goto(`${origin}/welcome.html`, { waitUntil: "load" });
  const store = (keys) => sw.evaluate((k) => chrome.storage.local.get(k), keys);
  const agent = await until(async () => (await store("agent")).agent, 5000);
  const link = `${FAKE_RELAY}/mcp/${agent.id}/${agent.token}`;
  await sleep(500);

  const pageState = (tab) =>
    tab.evaluate(() => ({
      state: { ...window.__state },
      confirmClicks: window.__confirmClicks,
      decoyClicks: window.__decoyClicks,
      advanceClicks: window.__advanceClicks,
      untrustedChecks: window.__untrustedChecks,
      risk: document.querySelector("[role=dialog] #risk")?.checked,
      note: document.getElementById("uniovi-virtual-autofill-note")?.innerText.replace(/\s+/g, " ") ?? "",
    }));

  /** Presses the card's button with `fixture` as that AI's start page; returns the fixture tab and the outcome. */
  async function runFill(ai, fixture) {
    await sw.evaluate((m) => chrome.storage.local.set({ devAutofillUrls: m }), { [ai]: `${FIXTURE_BASE}/${fixture}` });
    await welcome.bringToFront();
    await sleep(300);
    const tabP = browser.waitForTarget((t) => t.url().includes(`/__fixture/${fixture}`), { timeout: 15000 });
    const started = Date.now();
    await welcome.click(`button[data-ai="${ai}"]`);
    const tab = await (await tabP).page();
    const outcome = await until(() => welcome.evaluate((id) => document.querySelector(`#card-${id} .result`)?.dataset.outcome, ai), 40000, 300);
    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    const card = await welcome.evaluate((id) => document.querySelector(`#card-${id} .result`).textContent, ai);
    const page = await pageState(tab);
    await welcome.bringToFront();
    const clip = await welcome.evaluate(() => navigator.clipboard.readText().catch((e) => `ERR ${e.message}`));
    log(`   ${ai}/${fixture}: outcome=${outcome} in ${seconds}s state=${JSON.stringify(page.state).replace(link, "<link>")} note="${page.note}"`);
    check(clip === link, `${ai}/${fixture}: the link is on the clipboard${clip === link ? "" : ` (got ${clip.startsWith("ERR") ? clip : "something else"})`}`);
    return { tab, outcome, card, page };
  }

  // Claude and ChatGPT: one screen, name + URL, the confirm button untouched.
  for (const ai of ["claude", "chatgpt"]) {
    const { tab, outcome, card, page } = await runFill(ai, `${ai}.html`);
    check(outcome === "ok" && page.state.url === link && page.state.name === "Uniovi Virtual" && page.confirmClicks === 0 && !page.decoyClicks && /revisa los datos/.test(card),
      `${ai}: name + URL filled, confirm not clicked (${page.confirmClicks}), sidebar decoys ${page.decoyClicks ?? 0}, card "${card}"`);
    await tab.close();
  }

  // A page without the form: gives up, fills nothing, says so on the card and on the page.
  {
    const { tab, outcome, card, page } = await runFill("claude", "broken.html");
    check(outcome === "fill" && !page.state.url && page.confirmClicks === 0 && card === FAIL_TEXT && /No pude rellenarlo/.test(page.note), "broken: fallback message on the card and on the page");
    await tab.close();
  }

  // Decoy "Add"/"Create" buttons (in a form, a dialog with a field, a card with a field, a submit).
  {
    const { tab, outcome, page } = await runFill("claude", "decoy.html");
    check(outcome === "ok" && page.decoyClicks === 0 && page.confirmClicks === 0 && page.state.url === link, `decoy: filled, decoys pressed ${page.decoyClicks}`);
    await tab.close();
  }

  // Gemini developer mode: Create new (in a dialog with a search field) → URL → Next; the risk notice
  // and both Connects are hers; the name is written once its screen appears.
  {
    const { tab, outcome, card } = await runFill("gemini", "gemini.html");
    // The wizard's next screen (the risk notice) renders a moment after Next.
    await tab.waitForSelector("[role=dialog] #risk", { timeout: 5000 }).catch(() => undefined);
    const page = await pageState(tab);
    check(outcome === "ok" && page.state.url === link, `gemini: URL filled (outcome ${outcome})`);
    check(page.advanceClicks === 1, `gemini: Next pressed once (${page.advanceClicks})`);
    check(page.decoyClicks === 0, `gemini: page-level "Next" decoy untouched (${page.decoyClicks})`);
    check(page.risk === false && page.untrustedChecks === 0, `gemini: risk checkbox left alone (checked=${page.risk}, untrusted changes ${page.untrustedChecks})`);
    check(page.confirmClicks === 0, `gemini: Connect not clicked (${page.confirmClicks})`);
    check(/pulsado «Next»/.test(page.note) && /aviso/.test(card), `gemini: note "${page.note}" / card "${card}"`);

    // The student (a trusted click from the harness) ticks the notice and presses Connect.
    await tab.bringToFront();
    await tab.click("[role=dialog] #risk");
    await tab.click("[role=dialog] #connect1");
    const named = await until(async () => ((await pageState(tab)).state.name === "Uniovi Virtual" ? await pageState(tab) : null), 5000, 200);
    check(!!named && !named.state.description, `gemini: name written after her Connect, no other field touched (${JSON.stringify(named?.state ?? {}).replace(link, "<link>")})`);
    check(!!named && /escrito el nombre/.test(named.note), `gemini: note after the name "${named?.note}"`);
    await sleep(3000);
    const after = await pageState(tab);
    check(after.confirmClicks === 0 && after.untrustedChecks === 0, `gemini: 3 s later still no scripted Connect (${after.confirmClicks}) or checkbox change (${after.untrustedChecks})`);
    await tab.close();
  }
  log(`bridge requests failed: ${bridge.count()}`);
} catch (e) {
  fail++;
  log("FAIL exception", e.stack);
} finally {
  log(`RESULT pass=${pass} fail=${fail}`);
  await browser.close();
  rmSync(profile, { recursive: true, force: true, maxRetries: 5 });
  process.exitCode = fail ? 1 : 0;
}
