import { isImportant, seenAll } from "../../shared/digest.ts";
import { isWarming, warmTextCache } from "../../shared/mcp/extract.ts";
import { LATEST_RELEASE_API } from "../../shared/release.ts";
import { BRIDGE_URL, type BridgeStatus, type Resource, type Snapshot } from "../../shared/types.ts";
import { initAgent, startAgent } from "./agent/index.ts";
import { getSettings, type Message, type Reply, type SyncState } from "./messages.ts";
import { idbStore } from "./store/idb.ts";
import { shouldCheck, UPDATE_KEYS, updateFromRelease } from "./ui/update.ts";

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

/**
 * Stores the snapshot locally (chrome.storage for the panel, IndexedDB for the AI), notifies about
 * new posts, then tries the optional local bridge (Claude Code / Desktop users).
 */
async function onSnapshot(snapshot: Snapshot) {
  await idbStore.saveSnapshot(snapshot);
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

// ---------------------------------------------------------------- optional local bridge (Claude Code / Desktop)

async function bridgeStatus(): Promise<BridgeStatus> {
  return (await (await bridge("/api/status")).json()) as BridgeStatus;
}

// ---------------------------------------------------------------- update notice

const UPDATE_ALARM = "update-check";

/**
 * The unpacked extension can't auto-update: at most once a day, ask GitHub for the latest release
 * and store `update` when it is newer than this version (removed when it isn't). Failures are silent.
 * `force` (dev/test, via devLatestReleaseApi) skips the daily throttle.
 */
async function checkForUpdate(force = false) {
  const got = await chrome.storage.local.get([UPDATE_KEYS.checkedAt, UPDATE_KEYS.devApi]);
  const now = Date.now();
  if (!force && !shouldCheck(got[UPDATE_KEYS.checkedAt], now)) return;
  await chrome.storage.local.set({ [UPDATE_KEYS.checkedAt]: now });
  const dev = got[UPDATE_KEYS.devApi];
  const api = typeof dev === "string" && /^https?:\/\//.test(dev) ? dev : LATEST_RELEASE_API;
  try {
    const res = await fetch(api, { headers: { Accept: "application/vnd.github+json" }, cache: "no-store" });
    if (!res.ok) return;
    const update = updateFromRelease(await res.json(), chrome.runtime.getManifest().version);
    if (update) await chrome.storage.local.set({ [UPDATE_KEYS.update]: update });
    else await chrome.storage.local.remove(UPDATE_KEYS.update);
  } catch {
    // Offline or GitHub unreachable: try again tomorrow.
  }
}

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && UPDATE_KEYS.devApi in changes && changes[UPDATE_KEYS.devApi]!.newValue) void checkForUpdate(true);
});

chrome.notifications.onClicked.addListener(async (id) => {
  const { snapshot } = (await chrome.storage.local.get("snapshot")) as { snapshot?: Snapshot };
  if (!snapshot) return;
  const postId = /^post:(\d+)$/.exec(id)?.[1];
  const url = postId ? snapshot.posts.find((p) => p.id === Number(postId))?.url : `${snapshot.siteUrl}/my/`;
  if (url) await chrome.tabs.create({ url });
  chrome.notifications.clear(id);
});

// ---------------------------------------------------------------- file ingest

/** Stores one downloaded file in IndexedDB, then (optionally, silently) copies it to the local bridge. */
async function ingestFile(resource: Resource, filename: string, contentType: string, base64: string) {
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  const snapshot = (await idbStore.snapshot()) ?? ((await chrome.storage.local.get("snapshot")).snapshot as Snapshot | undefined);
  const course = snapshot?.courses.find((c) => c.id === resource.courseId)?.shortname ?? String(resource.courseId);
  await idbStore.putFile({ ...resource, filename }, course, contentType, bytes);
  scheduleWarm();
  // Claude Code / Desktop users with `npm run serve` running also get the file on disk. Never required.
  await bridge(`/api/files?key=${encodeURIComponent(resource.key)}`, {
    method: "PUT",
    headers: { "Content-Type": contentType, "X-Resource": encodeURIComponent(JSON.stringify({ ...resource, filename })) },
    body: bytes,
  }).catch(() => undefined);
}

let warmTimer: ReturnType<typeof setTimeout> | undefined;

/** Extracts text of newly stored files a few seconds after the last upload, one at a time. */
function scheduleWarm(delayMs = 3000) {
  clearTimeout(warmTimer);
  warmTimer = setTimeout(() => void warmAll(), delayMs);
}

async function warmAll() {
  // A run already in progress only knows the files it started with: wait for it, then go again.
  if (isWarming(idbStore)) await warmTextCache(idbStore, []);
  await warmTextCache(idbStore, Object.values(await idbStore.index()));
}

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
      return bridgeStatus();

    case "snapshot-collected":
      await onSnapshot(msg.snapshot);
      return null;

    case "upload-file":
      await ingestFile(msg.resource, msg.filename, msg.contentType, msg.base64);
      return null;

    case "known-files":
      // Skipped (unreadable) files count as known, so the content script doesn't fetch them again.
      return { ...(await idbStore.skippedFiles()), ...(await idbStore.knownFiles()) };

    case "skip-file":
      await idbStore.markSkipped(msg.resource);
      return null;

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

    case "open-files":
      await chrome.tabs.create({ url: chrome.runtime.getURL("files.html") });
      return null;

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
  if (!(await chrome.alarms.get(UPDATE_ALARM))) await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void ensureAlarms();
  void startAgent();
  // Left over from the goal-04 helper (its tunnel URL changed per run; the relay link doesn't).
  void chrome.storage.local.remove("knownRemoteUrl");
  if (reason === "install") void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
});
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarms();
  void startAgent();
});

// Every time the worker starts (install, browser start, or woken by an event/alarm after Chrome
// stopped it): reconnect to the relay and finish any text extraction left undone.
initAgent();
scheduleWarm(10_000);

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name === "bridge-flush") return flushBridge();
  if (alarm.name === UPDATE_ALARM) return checkForUpdate();
  if (alarm.name !== "periodic-sync") return;
  const settings = await getSettings();
  const { syncState } = await chrome.storage.local.get("syncState");
  const state = syncState as SyncState | undefined;
  if (!settings.autoSync || state?.running) return;
  if (state?.lastSync && Date.now() - state.lastSync < settings.autoSyncHours * 3600_000) return;
  await triggerSync().catch(() => undefined); // no campus tab open: skip silently
});
