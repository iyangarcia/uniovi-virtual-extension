// Welcome page: opened on install and from the popup ("Cómo conectarla"). Three live steps:
// extension installed, campus synced once, AI connected (an AI has made a request). Everything is
// built with textContent; the page re-renders on chrome.storage changes.
import { AGENT_KEYS, aiConnectionEnabled, type AgentState, type AgentStats } from "./agent/state.ts";
import { AI_SPECS, autoConnect, DEV_AUTOFILL_KEY } from "./autofill/index.ts";
import type { AiId } from "./autofill/types.ts";
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
  ok: string;
}

const CARDS: Record<AiId, CardText> = {
  claude: {
    plan: "Funciona con el plan gratuito (permite 1 conector personalizado).",
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En Claude: Personalizar → Conectores → Añadir conector personalizado.",
      "Nombre: Uniovi Virtual. URL: pega el enlace (Ctrl+V).",
      "Pulsa «Añadir».",
    ],
    ok: "✓ Listo: en la pestaña de Claude revisa los datos y pulsa tú «Añadir».",
  },
  chatgpt: {
    plan: "Necesitas ChatGPT Plus o superior: el plan gratuito no permite conectores.",
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En chatgpt.com/plugins pulsa «+» → «Add custom MCP server».",
      "Nombre: Uniovi Virtual. URL: pega el enlace (Ctrl+V).",
      "Marca que confías en la aplicación y pulsa el botón para crearla.",
      "¿Menú antiguo? Ajustes → Conectores → Avanzado → Modo desarrollador.",
    ],
    ok: "✓ Listo: en la pestaña de ChatGPT revisa los datos y pulsa tú el botón para crearlo.",
  },
  gemini: {
    plan: "Puede que aún no esté disponible en España: de momento solo aparece en EE. UU. y en inglés.",
    planWarn: true,
    steps: [
      "Pulsa «Conectar automáticamente» (o «Copiar enlace»).",
      "En Gemini: Ajustes → Apps conectadas → «Add a custom app».",
      "Nombre: Uniovi Virtual. URL: pega el enlace (Ctrl+V).",
      "Confirma para añadirla.",
    ],
    ok: "✓ Listo: en la pestaña de Gemini revisa los datos y pulsa tú el botón para añadirla.",
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
      result.textContent = outcome.ok ? text.ok : FAIL;
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

async function render() {
  const got = await chrome.storage.local.get([AGENT_KEYS.enabled, AGENT_KEYS.state, AGENT_KEYS.stats, "syncState", "snapshot", UPDATE_KEYS.update, DEV_AUTOFILL_KEY]);
  const sync = got.syncState as SyncState | undefined;
  const synced = !!sync?.lastSync || !!got.snapshot;
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

chrome.storage.onChanged.addListener((_changes, area) => {
  if (area === "local") void render();
});
void render();
