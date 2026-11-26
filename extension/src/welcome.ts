// Welcome page: opened on install and from the popup ("Cómo conectarla"). Three live steps:
// extension installed, campus synced once, AI connected (an AI has made a request). Everything is
// built with textContent; the page re-renders when one of its chrome.storage keys changes.
import { AGENT_KEYS, aiConnectionEnabled, type AgentState, type AgentStats } from "./agent/state.ts";
import { AI_SPECS, autoConnect, DEV_AUTOFILL_KEY } from "./autofill/index.ts";
import type { AiId, FillResult } from "./autofill/types.ts";
import type { SyncState } from "./messages.ts";
import { idbStore } from "./store/idb.ts";
import { copyText, flash, h, updateNotice } from "./ui/dom.ts";
import { currentLink } from "./ui/link.ts";
import { lastSyncLabel, statusSentence } from "./ui/status.ts";
import { pendingUpdate, UPDATE_KEYS } from "./ui/update.ts";

const CAMPUS_URL = "https://www.campusvirtual.uniovi.es/";
const VERSION = chrome.runtime.getManifest().version;
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

let link = "";
let devUrls: Partial<Record<AiId, string>> = {};

interface CardText {
  plan: string;
  planWarn?: boolean;
  steps: string[];
  /** Shown on the card after a fill; a function when it depends on how far the fill got. */
  ok: string | ((result: FillResult) => string);
}

const CARDS: Record<AiId, CardText> = {
  claude: {
    plan: "Funciona con el plan gratuito (permite 1 conector personalizado).",
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En claude.ai: Plugins (o Personalizar → Conectores) → «Add» → «Add custom connector».",
      "Nombre: Uniovi Virtual. URL: pega el enlace (Ctrl+V).",
      "Pulsa «Continue» (o «Añadir» si Claude está en español).",
    ],
    ok: "✓ Listo: en la pestaña de Claude revisa los datos y pulsa tú «Continue» (o «Añadir»).",
  },
  chatgpt: {
    plan: "Funciona también con el plan gratuito.",
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En chatgpt.com/plugins pulsa «Añadir» → «Añadir servidor MCP personalizado» (en inglés: «Add» → «Add custom MCP server»).",
      "Nombre: Uniovi Virtual. URL del servidor: pega el enlace (Ctrl+V).",
      "En «Autenticación» elige «Sin autenticación» (si no, no conecta).",
      "Marca «Lo entiendo y quiero continuar» y pulsa «Crear como complemento».",
    ],
    ok: "✓ Listo: en la pestaña de ChatGPT revisa los datos (Autenticación: «Sin autenticación»), marca el aviso y pulsa tú «Crear como complemento».",
  },
  gemini: {
    plan: "Avanzado: en España funciona desde el «Modo desarrollador» de Gemini, con más pasos y en inglés.",
    planWarn: true,
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En gemini.google.com/devmode?hl=en: «Create new» → pega el enlace en «MCP server URL» (Ctrl+V) → «Next».",
      "Marca tú el aviso y pulsa «Connect».",
      "Nombre: Uniovi Virtual → «Connect». Al preguntar, responde «Permitir siempre».",
    ],
    ok: (r) =>
      r.advanced
        ? "✓ Enlace pegado: en la pestaña de Gemini marca tú el aviso y pulsa «Connect». Después escribo yo el nombre; revísalo y pulsa «Connect» otra vez."
        : r.name
          ? "✓ Listo: en la pestaña de Gemini revisa los datos y pulsa tú el botón para añadirla."
          : "✓ Enlace pegado: en la pestaña de Gemini pulsa «Next», marca el aviso y pulsa «Connect». Después escribo yo el nombre.",
  },
};

const FAIL = "No pude rellenarlo solo: el enlace está copiado, pégalo en el campo URL (Ctrl+V)";

function card(id: AiId): HTMLElement {
  const spec = AI_SPECS[id];
  const text = CARDS[id];
  const result = h("div", { class: "result", hidden: "" });
  const auto = h("button", { class: "big", "data-ai": id }, "Conectar automáticamente");
  const copy = h("button", { class: "plain" }, "Copiar enlace");

  copy.addEventListener("click", async () => {
    flash(copy, (await copyText(link)) ? "¡Copiado!" : "No se pudo copiar");
  });

  auto.addEventListener("click", () => {
    // Both calls start inside the click: the clipboard needs focus (the AI tab takes it next) and
    // permissions.request needs the user gesture.
    const copied = copyText(link);
    const dev = devUrls[id];
    const permission = dev ? Promise.resolve(true) : chrome.permissions.request({ origins: [spec.origin] });
    auto.disabled = true;
    result.hidden = true;
    delete result.dataset.outcome;
    void (async () => {
      await copied;
      const outcome = await autoConnect(spec, link, permission, dev ?? spec.startUrl);
      result.hidden = false;
      result.className = `result ${outcome.ok ? "ok" : "warn"}`;
      result.textContent = !outcome.ok ? FAIL : typeof text.ok === "string" ? text.ok : text.ok(outcome.result);
      result.dataset.outcome = outcome.ok ? "ok" : outcome.reason;
      auto.disabled = false;
    })();
  });

  return h(
    "div",
    { class: "card", id: `card-${id}` },
    h("h3", {}, spec.label),
    h("p", { class: `plan${text.planWarn ? " warn" : ""}` }, text.plan),
    result,
    h("div", { class: "actions" }, auto, copy),
    h("ol", {}, ...text.steps.map((s) => h("li", {}, s))),
  );
}

function setStep(el: HTMLElement, done: boolean, n: string) {
  el.classList.toggle("done", done);
  el.querySelector(".mark")!.textContent = done ? "✓" : n;
}

// Only these keys change what the page shows. The snapshot itself is not one: it is large, and
// syncState.lastSync already says whether a sync happened.
const KEYS = [AGENT_KEYS.enabled, AGENT_KEYS.state, AGENT_KEYS.stats, AGENT_KEYS.identity, AGENT_KEYS.devRelayUrl, "syncState", UPDATE_KEYS.update, DEV_AUTOFILL_KEY] as const;

async function render() {
  const got = await chrome.storage.local.get([...KEYS]);
  const sync = got.syncState as SyncState | undefined;
  const synced = !!sync?.lastSync;
  const agent = got[AGENT_KEYS.state] as AgentState | undefined;
  const stats = got[AGENT_KEYS.stats] as AgentStats | undefined;
  devUrls = (got[DEV_AUTOFILL_KEY] as typeof devUrls | undefined) ?? {};

  // Step 2
  setStep($("step2"), synced, "2");
  if (synced) {
    let files = "";
    try {
      const n = (await idbStore.usage()).files;
      if (n) files = ` · ${n} ${n === 1 ? "archivo guardado" : "archivos guardados"}`;
    } catch {
      // usage is a nicety
    }
    $("step2text").textContent = `✓ Ya tienes tus asignaturas. ${lastSyncLabel(sync?.lastSync)}${files}.`;
    $("openCampus").textContent = "Volver al Campus Virtual";
  }

  // Step 3: done once an AI has actually asked for something.
  setStep($("step3"), (stats?.requests ?? 0) > 0, "3");
  const view = statusSentence({ enabled: aiConnectionEnabled(got[AGENT_KEYS.enabled]), ...(agent ? { agent } : {}), synced });
  const status = $("aiStatus");
  status.className = `status ${view.tone}`;
  status.textContent = view.text;
  $("aiHint").textContent = view.hint ?? "";

  const update = pendingUpdate(got[UPDATE_KEYS.update], VERSION);
  $("update").replaceChildren(...(update ? [updateNotice(update)] : []));

  link = await currentLink();
  $("maint").hidden = !link.includes("example.workers.dev");
}

$("openCampus").addEventListener("click", () => void chrome.tabs.create({ url: CAMPUS_URL }));
$("openFiles").addEventListener("click", (e) => {
  e.preventDefault();
  void chrome.tabs.create({ url: chrome.runtime.getURL("files.html") });
});
$("cards").replaceChildren(...(Object.keys(AI_SPECS) as AiId[]).map(card));

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && KEYS.some((k) => k in changes)) void render();
});
void render();
