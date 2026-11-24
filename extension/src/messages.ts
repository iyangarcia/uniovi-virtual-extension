import type { BridgeStatus, Resource, Snapshot } from "../../shared/types.ts";

// Messages between popup / content script / background service worker.
// Only the background worker talks to the local bridge (127.0.0.1): content scripts are
// subject to the page's network restrictions, the extension worker is not.
//
// chrome.storage.local keys: snapshot (latest Snapshot), seen (Seen, for "new since last
// visit"), pendingBridge (snapshot not yet delivered to the bridge), syncState, settings, and the
// agent's keys (agent, aiConnection, agentState, agentStats, devRelayUrl; see agent/state.ts).
// The student's files and the snapshot the AI reads live in IndexedDB (store/idb.ts).

export type Message =
  | { type: "bridge-status" }
  | { type: "snapshot-collected"; snapshot: Snapshot } // content -> background: store, notify, deliver
  | { type: "upload-file"; resource: Resource; filename: string; contentType: string; base64: string } // content -> background: store in IndexedDB (+ bridge if up)
  | { type: "known-files" } // content -> background: Record<key, timemodified> of stored + deliberately skipped files
  | { type: "skip-file"; resource: Resource } // content -> background: not a readable type, don't fetch again
  | { type: "start-sync" } // popup -> background
  | { type: "run-sync" } // background -> content script
  | { type: "page-ready" } // content script -> background (may trigger auto-sync)
  | { type: "progress"; text: string; running: boolean; error?: boolean };

export type Reply<T = unknown> = { ok: true; data: T } | { ok: false; error: string };

export type { AgentState, AgentStateName, AgentStats } from "./agent/state.ts";

export type BridgeStatusReply = Reply<BridgeStatus>;

export interface Settings {
  courseScope: "inprogress" | "all";
  autoSync: boolean;
  autoSyncHours: number;
  downloadFiles: boolean;
  maxFileMB: number;
  replyWindowDays: number;
  notify: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  courseScope: "inprogress",
  autoSync: true,
  autoSyncHours: 6,
  downloadFiles: true,
  maxFileMB: 40,
  replyWindowDays: 120,
  notify: true,
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
