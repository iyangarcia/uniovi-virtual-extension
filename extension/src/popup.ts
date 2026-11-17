import type { BridgeStatus } from "../../shared/types.ts";
import { getSettings, send, type Settings, type SyncState } from "./messages.ts";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

function renderState(state: SyncState | undefined) {
  const el = $("status");
  const last = state?.lastSync ? `\nLast successful sync: ${new Date(state.lastSync).toLocaleString()}` : "";
  el.textContent = (state?.text ?? "Not synced yet") + last;
  el.classList.toggle("error", !!state?.error);
  $<HTMLButtonElement>("sync").disabled = !!state?.running;
}

async function renderBridge() {
  const el = $("bridge");
  try {
    const s = await send<BridgeStatus>({ type: "bridge-status" });
    el.textContent = `Claude connected · data in ${s.dataDir}`;
    el.classList.remove("down");
  } catch {
    // Not an error: the campus panel and notifications work without Claude.
    el.textContent = "Claude not open · data is kept here and handed over when you open Claude";
    el.classList.remove("down");
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
  document.querySelectorAll("input, select").forEach((el) => el.addEventListener("change", () => void save()));
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
  await renderBridge();
})();
