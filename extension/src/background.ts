import { isImportant, seenAll } from "../../shared/digest.ts";
import { BRIDGE_URL, type BridgeStatus, type Snapshot } from "../../shared/types.ts";
import { getSettings, type Message, type Reply, type SyncState } from "./messages.ts";

const CAMPUS_TAB_PATTERNS = ["https://*.campusvirtual.uniovi.es/*", "https://campusvirtual.uniovi.es/*"];

async function setState(patch: Partial<SyncState>) {
  const { syncState } = await chrome.storage.local.get("syncState");
  const next = { ...(syncState as SyncState | undefined), ...patch } as SyncState;
  await chrome.storage.local.set({ syncState: next });
  await chrome.action.setBadgeText({ text: next.running ? "…" : next.error ? "!" : "" });
  await chrome.action.setBadgeBackgroundColor({ color: next.error ? "#c62828" : "#1565c0" });
}

async function bridge(path: string, init?: RequestInit): Promise<Response> {
  let res: Response;
  try {
    res = await fetch(BRIDGE_URL + path, init);
  } catch {
    throw new Error("Claude bridge not running (open Claude Code/Desktop, or run `npm run serve`).");
  }
  if (!res.ok) throw new Error(`Bridge ${path}: HTTP ${res.status} ${await res.text()}`);
  return res;
}

// ---------------------------------------------------------------- snapshot handling

/** Stores the snapshot locally (panel source of truth), notifies about new posts, then tries the bridge. */
async function onSnapshot(snapshot: Snapshot) {
  const { snapshot: prev, seen } = (await chrome.storage.local.get(["snapshot", "seen"])) as { snapshot?: Snapshot; seen?: unknown };
  await chrome.storage.local.set({
    snapshot,
    pendingBridge: true,
    // First sync ever: treat everything as seen, otherwise the panel opens with 300 "new" items.
    ...(seen ? {} : { seen: seenAll(snapshot) }),
  });
  if (prev) await notifyNewPosts(prev, snapshot);
  await flushBridge();
}

async function flushBridge() {
  const { pendingBridge, snapshot } = (await chrome.storage.local.get(["pendingBridge", "snapshot"])) as {
    pendingBridge?: boolean;
    snapshot?: Snapshot;
  };
  if (!pendingBridge || !snapshot) return;
  try {
    await bridge("/api/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(snapshot) });
    await chrome.storage.local.set({ pendingBridge: false });
  } catch {
    // Claude closed; retried by the alarm.
  }
}

async function notifyNewPosts(prev: Snapshot, next: Snapshot) {
  if (!(await getSettings()).notify) return;
  const known = new Set(prev.posts.map((p) => p.id));
  const fresh = next.posts.filter((p) => !known.has(p.id)).sort((a, b) => b.created - a.created);
  if (!fresh.length) return;
  const course = (id: number) => next.courses.find((c) => c.id === id)?.fullname ?? "";

  const important = fresh.filter(isImportant);
  for (const p of important.slice(0, 3)) {
    chrome.notifications.create(`post:${p.id}`, {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: p.subject || "Nuevo aviso",
      message: p.message.replace(/\s+/g, " ").slice(0, 200),
      contextMessage: course(p.courseId),
      priority: 2,
      requireInteraction: true,
    });
  }
  const rest = fresh.length - Math.min(important.length, 3);
  if (rest > 0) {
    const others = fresh.filter((p) => !important.slice(0, 3).includes(p));
    chrome.notifications.create("posts:new", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: `${rest} ${rest === 1 ? "mensaje nuevo" : "mensajes nuevos"} en Uniovi Virtual`,
      message: others.slice(0, 3).map((p) => `• ${p.subject}`).join("\n"),
    });
  }
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { snapshot } = (await chrome.storage.local.get("snapshot")) as { snapshot?: Snapshot };
  if (!snapshot) return;
  const postId = /^post:(\d+)$/.exec(id)?.[1];
  const url = postId ? snapshot.posts.find((p) => p.id === Number(postId))?.url : `${snapshot.siteUrl}/my/`;
  if (url) await chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------- sync triggering

/**
 * Tabs opened before the extension was installed/updated have no content script, and
 * sendMessage fails with "Receiving end does not exist". Inject it then and retry once.
 */
async function sendRunSync(tabId: number): Promise<Reply | undefined> {
  const msg = { type: "run-sync" } satisfies Message;
  try {
    return (await chrome.tabs.sendMessage(tabId, msg)) as Reply | undefined;
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return (await chrome.tabs.sendMessage(tabId, msg)) as Reply | undefined;
  }
}

async function triggerSync(tabId?: number): Promise<void> {
  const tabs = tabId !== undefined ? [{ id: tabId }] : await chrome.tabs.query({ url: CAMPUS_TAB_PATTERNS });
  const tab = tabs.find((t) => t.id !== undefined);
  if (!tab?.id) throw new Error("Abre Uniovi Virtual (con sesión iniciada) en una pestaña y vuelve a sincronizar.");
  const reply = await sendRunSync(tab.id);
  if (!reply?.ok) throw new Error(reply && !reply.ok ? reply.error : "La pestaña no responde; recárgala.");
  await setState({ running: true, text: "Empezando…", error: false });
}

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case "bridge-status":
      return (await (await bridge("/api/status")).json()) as BridgeStatus;

    case "snapshot-collected":
      await onSnapshot(msg.snapshot);
      return null;

    case "upload-file": {
      const bytes = Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0));
      await bridge(`/api/files?key=${encodeURIComponent(msg.resource.key)}`, {
        method: "PUT",
        headers: {
          "Content-Type": msg.contentType,
          "X-Resource": encodeURIComponent(JSON.stringify({ ...msg.resource, filename: msg.filename })),
        },
        body: bytes,
      });
      return null;
    }

    case "start-sync":
      await triggerSync();
      return null;

    case "progress":
      await setState({
        running: msg.running,
        text: msg.text,
        error: msg.error ?? false,
        ...(!msg.running && !msg.error ? { lastSync: Date.now() } : {}),
      });
      return null;

    case "page-ready": {
      const settings = await getSettings();
      const { syncState } = await chrome.storage.local.get("syncState");
      const state = syncState as SyncState | undefined;
      const stale = !state?.lastSync || Date.now() - state.lastSync > settings.autoSyncHours * 3600_000;
      if (settings.autoSync && stale && !state?.running && sender.tab?.id !== undefined) {
        await triggerSync(sender.tab.id).catch((e) => console.warn("[uniovi] auto-sync", e));
      }
      return null;
    }

    case "run-sync":
      return null; // handled by content script
  }
}

chrome.runtime.onMessage.addListener((msg: Message, sender, sendResponse: (r: Reply) => void) => {
  if (msg.type === "run-sync") return false;
  handle(msg, sender).then(
    (data) => sendResponse({ ok: true, data }),
    (err: unknown) => sendResponse({ ok: false, error: err instanceof Error ? err.message : String(err) }),
  );
  return true; // async response
});

// ---------------------------------------------------------------- alarms

async function ensureAlarms() {
  if (!(await chrome.alarms.get("periodic-sync"))) await chrome.alarms.create("periodic-sync", { periodInMinutes: 60 });
  // Cheap localhost probe: delivers a stored snapshot as soon as Claude (and so the bridge) starts.
  if (!(await chrome.alarms.get("bridge-flush"))) await chrome.alarms.create("bridge-flush", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(() => void ensureAlarms());
chrome.runtime.onStartup.addListener(() => void ensureAlarms());

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "bridge-flush") return flushBridge();
  if (alarm.name !== "periodic-sync") return;
  const settings = await getSettings();
  const { syncState } = await chrome.storage.local.get("syncState");
  const state = syncState as SyncState | undefined;
  if (!settings.autoSync || state?.running) return;
  if (state?.lastSync && Date.now() - state.lastSync < settings.autoSyncHours * 3600_000) return;
  await triggerSync().catch(() => undefined); // no campus tab open: skip silently
});
