import type { Resource, Snapshot } from "../../shared/types.ts";

// Messages between the extension pages (side panel home.html, welcome.html) / content script / background service worker.
// Only the background worker talks to the local dev bridge (127.0.0.1), and only when devBridge is
// set (bridge.ts): content scripts are subject to the page's network restrictions, the worker is not.
//
// chrome.storage.local keys: snapshot (latest Snapshot), seen (Seen, for "new since last
// visit"), devBridge + pendingBridge (developers only: snapshot not yet delivered to the dev bridge), syncState, settings, update + updateCheckedAt (ui/update.ts), and the
// agent's keys (agent, aiConnection, agentState, agentStats, devRelayUrl; see agent/state.ts).
// The student's files and the snapshot the AI reads live in IndexedDB (store/idb.ts).

export type Message =
  | { type: "snapshot-collected"; snapshot: Snapshot } // content -> background: store, notify, deliver
  | { type: "upload-file"; resource: Resource; filename: string; contentType: string; base64: string } // content -> background: store in IndexedDB (+ dev bridge if on); also the side panel («Añadir archivo») -> background for the student's own files (isUpload)
  | { type: "delete-upload"; key: string } // side panel -> background: delete one of the student's own files (key `upload:…` only)
  | { type: "upload-text"; resource: Resource & { filename: string }; text: string } // content -> background: an activity's or course page's text as a .txt file; replies true if it changed
  | { type: "known-files" } // content -> background: Record<key, KnownFile> (download.ts) of stored + deliberately skipped files
  | { type: "skip-file"; resource: Resource } // content -> background: not a readable type or too large, don't fetch again
  | { type: "start-sync" } // side panel -> background
  | { type: "run-sync" } // background -> content script
  | { type: "open-panel" } // content (campus panel) -> background: open the side panel (or home.html as a tab)
  | { type: "page-ready" } // content script -> background (may trigger auto-sync)
  | { type: "progress"; text: string; running: boolean; error?: boolean };

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type { AgentState, AgentStateName, AgentStats } from "./agent/state.ts";

export interface Settings {
  courseScope: "inprogress" | "all";
  autoSync: boolean;
  autoSyncHours: number;
  downloadFiles: boolean;
  maxFileMB: number;
  replyWindowDays: number;
  notify: boolean;
  /** Sync the student's own grades so the AI can read them. */
  syncGrades: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  courseScope: "inprogress",
  autoSync: true,
  autoSyncHours: 6,
  downloadFiles: true,
  maxFileMB: 40,
  replyWindowDays: 120,
  notify: true,
  syncGrades: true,
};

export async function getSettings(): Promise<Settings> {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...(settings as Partial<Settings> | undefined) };
}

export interface SyncState {
  running: boolean;
  text: string;
  error?: boolean;
  lastSync?: number;
}

export async function send<T>(msg: Message): Promise<T> {
  const reply = (await chrome.runtime.sendMessage(msg)) as Reply<T> | undefined;
  if (!reply) throw new Error("No reply from background worker");
  if (!reply.ok) throw new Error(reply.error);
  return reply.data;
}
