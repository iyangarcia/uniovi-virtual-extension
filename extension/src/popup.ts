import { rotateToken } from "./agent/index.ts";
import { AGENT_KEYS, aiConnectionEnabled, type AgentState } from "./agent/state.ts";
import { getSettings, send, type Settings, type SyncState } from "./messages.ts";
import { idbStore } from "./store/idb.ts";
import { copyText, flash, updateNotice } from "./ui/dom.ts";
import { currentLink } from "./ui/link.ts";
import { formatBytes, lastSyncLabel, statusSentence } from "./ui/status.ts";
import { pendingUpdate, UPDATE_KEYS } from "./ui/update.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const VERSION = chrome.runtime.getManifest().version;

const KEYS = [AGENT_KEYS.enabled, AGENT_KEYS.state, "syncState", "snapshot", UPDATE_KEYS.update] as const;

async function render() {
  const got = await chrome.storage.local.get([...KEYS]);
  const enabled = aiConnectionEnabled(got[AGENT_KEYS.enabled]);
  const agent = got[AGENT_KEYS.state] as AgentState | undefined;
  const sync = got.syncState as SyncState | undefined;
  const synced = !!sync?.lastSync || !!got.snapshot;

  const view = statusSentence({ enabled, ...(agent ? { agent } : {}), synced });
  const box = $("status");
  box.className = `status ${view.tone}`;
  box.querySelector(".text")!.textContent = view.text;
  box.querySelector(".hint")!.textContent = view.hint ?? "";

  const toggle = $<HTMLInputElement>("aiConnection");
  if (document.activeElement !== toggle) toggle.checked = enabled;

  const syncText = $("syncText");
  syncText.textContent = sync?.running || sync?.error ? sync.text : lastSyncLabel(sync?.lastSync);
  syncText.classList.toggle("error", !!sync?.error);
  $<HTMLButtonElement>("sync").disabled = !!sync?.running;

  const update = pendingUpdate(got[UPDATE_KEYS.update], VERSION);
  $("update").replaceChildren(...(update ? [updateNotice(update)] : []));

  // Technical detail, advanced section only.
  $("diag").textContent = `Versión ${VERSION} · conexión: ${agent?.state ?? "—"}${agent?.error ? ` (${agent.error})` : ""}`;
}

async function showLink() {
  $<HTMLInputElement>("linkBox").value = await currentLink();
}

async function showUsage() {
  try {
    const { files, bytes } = await idbStore.usage();
    $("usage").textContent = `Espacio usado: ${formatBytes(bytes)} en ${files} ${files === 1 ? "archivo" : "archivos"}`;
  } catch {
    $("usage").textContent = "Espacio usado: no disponible";
  }
}

async function initSettings() {
  const s = await getSettings();
  const save = async () => {
    const next: Settings = {
      courseScope: $<HTMLSelectElement>("courseScope").value as Settings["courseScope"],
      autoSync: $<HTMLInputElement>("autoSync").checked,
      autoSyncHours: Number($<HTMLInputElement>("autoSyncHours").value) || 6,
      downloadFiles: $<HTMLInputElement>("downloadFiles").checked,
      maxFileMB: Number($<HTMLInputElement>("maxFileMB").value) || 40,
      replyWindowDays: Number($<HTMLInputElement>("replyWindowDays").value) || 0,
      notify: $<HTMLInputElement>("notify").checked,
    };
    await chrome.storage.local.set({ settings: next });
  };
  $<HTMLSelectElement>("courseScope").value = s.courseScope;
  $<HTMLInputElement>("autoSync").checked = s.autoSync;
  $<HTMLInputElement>("autoSyncHours").value = String(s.autoSyncHours);
  $<HTMLInputElement>("downloadFiles").checked = s.downloadFiles;
  $<HTMLInputElement>("maxFileMB").value = String(s.maxFileMB);
  $<HTMLInputElement>("replyWindowDays").value = String(s.replyWindowDays);
  $<HTMLInputElement>("notify").checked = s.notify;
  for (const id of ["courseScope", "autoSync", "autoSyncHours", "downloadFiles", "maxFileMB", "replyWindowDays", "notify"]) {
    $(id).addEventListener("change", () => void save());
  }
}

$("aiConnection").addEventListener("change", () => {
  void chrome.storage.local.set({ [AGENT_KEYS.enabled]: $<HTMLInputElement>("aiConnection").checked });
});

$("copy").addEventListener("click", async () => {
  const ok = await copyText(await currentLink());
  flash($("copy"), ok ? "¡Copiado! Pégalo en tu IA" : "No se pudo copiar: míralo en Opciones avanzadas");
});

const openPage = (page: string) => void chrome.tabs.create({ url: chrome.runtime.getURL(page) }).then(() => window.close());
$("files").addEventListener("click", () => openPage("files.html"));
$("howto").addEventListener("click", () => openPage("welcome.html"));

$("sync").addEventListener("click", async () => {
  try {
    await send({ type: "start-sync" });
  } catch (err) {
    const t = $("syncText");
    t.textContent = err instanceof Error ? err.message : String(err);
    t.classList.add("error");
  }
});

$("rotate").addEventListener("click", () => ($("confirmRotate").hidden = false));
$("rotateNo").addEventListener("click", () => ($("confirmRotate").hidden = true));
$("rotateYes").addEventListener("click", async () => {
  const url = await rotateToken();
  $<HTMLInputElement>("linkBox").value = url;
  $("confirmRotate").hidden = true;
  const copied = await copyText(url);
  flash($("rotate"), copied ? "Enlace cambiado y copiado ✓" : "Enlace cambiado ✓", 2500);
});

$("advanced").addEventListener("toggle", () => {
  if (($("advanced") as HTMLDetailsElement).open) void showUsage();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (KEYS.some((k) => k in changes)) void render();
  if (AGENT_KEYS.identity in changes) void showLink();
});

void (async () => {
  await render();
  await initSettings();
  await showLink();
})();
