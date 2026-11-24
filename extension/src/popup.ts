import type { NativeRequest } from "../../shared/helper.ts";
import type { BridgeStatus } from "../../shared/types.ts";
import { deriveHelperView, type HelperStateName, type HelperView, type NativeProbe } from "./helperState.ts";
import { getSettings, send, type Settings, type SyncState } from "./messages.ts";
import { probeNative, sendNative } from "./native.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderState(state: SyncState | undefined) {
  const el = $("status");
  const last = state?.lastSync ? `\nLast successful sync: ${new Date(state.lastSync).toLocaleString()}` : "";
  el.textContent = (state?.text ?? "Not synced yet") + last;
  el.classList.toggle("error", !!state?.error);
  $<HTMLButtonElement>("sync").disabled = !!state?.running;
}

// ---------------------------------------------------------------- local bridge + helper

const STATE_TEXT: Record<HelperStateName, string> = {
  "not-installed": "Asistente no instalado",
  stopped: "Asistente detenido",
  connecting: "Conectando…",
  ready: "Listo",
  error: "Error",
};

let busy = false;
let dataDirEdited = false;
let shownUrl: string | undefined;

async function bridgeStatus(): Promise<BridgeStatus | undefined> {
  try {
    return await send<BridgeStatus>({ type: "bridge-status" });
  } catch {
    return undefined;
  }
}

function renderBridge(s: BridgeStatus | undefined) {
  const el = $("bridge");
  // Not an error when down: the campus panel and notifications work without the helper or Claude.
  el.textContent = s ? `Asistente local conectado · datos en ${s.dataDir}` : "Asistente local no disponible · los datos se guardan aquí y se entregan cuando arranque";
  el.classList.remove("down");
}

function renderHelper(view: HelperView) {
  const dot = $("helperDot");
  dot.className = `dot ${view.state}`;
  let text = STATE_TEXT[view.state];
  if (view.state === "ready" && view.tunnelOff) text = "Listo (solo en este PC: conector web desactivado)";
  if (view.state === "connecting" && view.provider) text = `Conectando con ${view.provider}…`;
  if (view.state === "not-installed") text += " · el panel y los avisos funcionan igual";
  if (view.state === "stopped") text += " · pulsa Iniciar para usarlo con tu IA";
  $("helperState").textContent = text;

  const detail = $("helperDetail");
  detail.hidden = !view.detail;
  detail.textContent = view.detail ?? "";

  $("helperUrlBox").hidden = !view.url;
  if (view.url && view.url !== shownUrl) {
    $<HTMLInputElement>("remoteUrl").value = view.url;
    shownUrl = view.url;
  }
  $("tunnelProvider").textContent = view.provider ?? "localhost.run, tunnelmole o pinggy";

  $("helperControls").hidden = !view.controllable;
  $<HTMLButtonElement>("helperStart").hidden = view.running;
  $<HTMLButtonElement>("helperStop").hidden = !view.running;
  for (const id of ["helperStart", "helperStop", "changeDataDir", "tunnelEnabled"]) $<HTMLButtonElement>(id).disabled = busy;

  $("helperConfig").hidden = !view.controllable;
  $<HTMLInputElement>("tunnelEnabled").checked = !view.tunnelOff;
  const dir = $<HTMLInputElement>("dataDir");
  if (!dataDirEdited && view.dataDir && document.activeElement !== dir) dir.value = view.dataDir;
}

let lastNative: NativeProbe | undefined;

async function refresh(native?: NativeProbe) {
  const [probe, bridge] = await Promise.all([native ? Promise.resolve(native) : probeNative(), bridgeStatus()]);
  lastNative = probe;
  renderBridge(bridge);
  renderHelper(deriveHelperView(probe, bridge));
}

/** Runs a host command, shows its error inline, and re-renders from the status it returns. */
async function control(request: NativeRequest, pending: string) {
  if (busy) return;
  busy = true;
  $("helperState").textContent = pending;
  $("helperDetail").hidden = true;
  try {
    const status = await sendNative(request);
    busy = false;
    await refresh({ kind: "ok", status });
  } catch (err) {
    busy = false;
    await refresh();
    const detail = $("helperDetail");
    detail.textContent = err instanceof Error ? err.message : String(err);
    detail.hidden = false;
  }
}

function initHelper() {
  $("copyRemote").addEventListener("click", async () => {
    if (!shownUrl) return;
    await navigator.clipboard.writeText(shownUrl);
    $("copyRemote").textContent = "Copiada ✓";
    setTimeout(() => ($("copyRemote").textContent = "Copiar URL del conector"), 1500);
  });
  $("helperStart").addEventListener("click", () => void control({ type: "start" }, "Iniciando…"));
  $("helperStop").addEventListener("click", () => void control({ type: "stop" }, "Deteniendo…"));
  // The helper restarts after a config change, so the connector URL will change too.
  $("tunnelEnabled").addEventListener("change", () => {
    void control({ type: "setTunnel", enabled: $<HTMLInputElement>("tunnelEnabled").checked }, "Aplicando…");
  });
  const dir = $<HTMLInputElement>("dataDir");
  dir.addEventListener("input", () => (dataDirEdited = true));
  $("changeDataDir").addEventListener("click", async () => {
    const value = dir.value.trim();
    if (!value) return;
    await control({ type: "setDataDir", dataDir: value }, "Cambiando la carpeta…");
    if (!$("helperDetail").hidden) return; // keep the typed path so it can be corrected
    dataDirEdited = false;
    if (lastNative?.kind === "ok") dir.value = lastNative.status.dataDir;
  });
  // Poll while the popup is open, so connecting → ready (and new URLs) show up without reopening it.
  // The bridge is polled every 2 s; the native host (a node.exe + netstat per probe) only every 10 s.
  let tick = 0;
  setInterval(() => {
    if (!busy) void refresh(++tick % 5 === 0 ? undefined : lastNative);
  }, 2000);
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
  document.querySelectorAll("fieldset input, fieldset select").forEach((el) => el.addEventListener("change", () => void save()));
}

$("sync").addEventListener("click", async () => {
  try {
    await send({ type: "start-sync" });
  } catch (err) {
    renderState({ running: false, text: err instanceof Error ? err.message : String(err), error: true });
  }
});

chrome.storage.onChanged.addListener((changes) => {
  if (changes.syncState) renderState(changes.syncState.newValue as SyncState);
});

void (async () => {
  const { syncState } = await chrome.storage.local.get("syncState");
  renderState(syncState as SyncState | undefined);
  await initSettings();
  initHelper();
  await refresh();
})();
