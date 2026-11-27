import { isImportant, seenAll } from "../../shared/digest.ts";
import { isWarming, warmTextCache } from "../../shared/mcp/extract.ts";
import { LATEST_RELEASE_API } from "../../shared/release.ts";
import { isUpload, type Resource, type Snapshot, UPLOAD_SECTION } from "../../shared/types.ts";
import { initAgent, startAgent } from "./agent/index.ts";
import { type BridgeDeps, DEV_BRIDGE_KEY, devBridgeOn, sendToBridge } from "./bridge.ts";
import type { KnownFile } from "./download.ts";
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

// Dev bridge (bridge.ts): off unless chrome.storage.local.devBridge === true.
const bridgeDeps: BridgeDeps = {
  isOn: async () => devBridgeOn(await chrome.storage.local.get(DEV_BRIDGE_KEY)),
  fetch: (input, init) => fetch(input, init),
};

// ---------------------------------------------------------------- snapshot handling

/**
 * Stores the snapshot locally (chrome.storage for the panel, IndexedDB for the AI), notifies about
 * new posts, then, for developers who switched it on, delivers it to the local dev bridge.
 */
async function onSnapshot(snapshot: Snapshot) {
  await idbStore.saveSnapshot(snapshot);
  const { snapshot: prev, seen } = (await chrome.storage.local.get(["snapshot", "seen"])) as { snapshot?: Snapshot; seen?: unknown };
  await chrome.storage.local.set({
    snapshot,
    ...((await bridgeDeps.isOn()) ? { pendingBridge: true } : {}),
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
    const body = JSON.stringify(snapshot);
    if (await sendToBridge(bridgeDeps, "/api/snapshot", { method: "POST", headers: { "Content-Type": "application/json" }, body })) {
      await chrome.storage.local.set({ pendingBridge: false });
    }
  } catch {
    // Dev server not running; retried by the alarm.
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
  if (area !== "local") return;
  if (UPDATE_KEYS.devApi in changes && changes[UPDATE_KEYS.devApi]!.newValue) void checkForUpdate(true);
  if (DEV_BRIDGE_KEY in changes) {
    void ensureAlarms();
    // Switched on: deliver the snapshot already stored. (Files reach the bridge as they are downloaded.)
    if (changes[DEV_BRIDGE_KEY]!.newValue === true) void chrome.storage.local.set({ pendingBridge: true }).then(flushBridge);
  }
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

/** Stores one downloaded file in IndexedDB, then, if the developer switched it on, copies it to the dev bridge. */
async function ingestFile(resource: Resource, filename: string, contentType: string, bytes: Uint8Array) {
  let course = UPLOAD_SECTION; // the student's own files ("Mis apuntes" → «Añadir archivo») belong to no course
  if (!isUpload(resource)) {
    const snapshot = (await idbStore.snapshot()) ?? ((await chrome.storage.local.get("snapshot")).snapshot as Snapshot | undefined);
    course = snapshot?.courses.find((c) => c.id === resource.courseId)?.shortname ?? String(resource.courseId);
  }
  await idbStore.putFile({ ...resource, filename }, course, contentType, bytes);
  scheduleWarm();
  // Developers with `npm run serve` running also get the file on disk. Never required.
  await sendToBridge(bridgeDeps, `/api/files?key=${encodeURIComponent(resource.key)}`, {
    method: "PUT",
    headers: { "Content-Type": contentType, "X-Resource": encodeURIComponent(JSON.stringify({ ...resource, filename })) },
    body: bytes as Uint8Array<ArrayBuffer>,
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

/** Sent by one of the extension's own pages (not a content script in a campus tab). */
const fromExtensionPage = (sender: chrome.runtime.MessageSender) => sender.id === chrome.runtime.id && !!sender.url?.startsWith(chrome.runtime.getURL(""));

async function handle(msg: Message, sender: chrome.runtime.MessageSender): Promise<unknown> {
  switch (msg.type) {
    case "snapshot-collected":
      await onSnapshot(msg.snapshot);
      return null;

    case "upload-file":
      // The student's own files come only from the extension's pages (the side panel's «Mis apuntes»), never from a campus tab.
      {
        const upload = isUpload(msg.resource);
        if (upload !== msg.resource.key.startsWith("upload:") || (upload && !fromExtensionPage(sender))) throw new Error("No permitido");
      }
      await ingestFile(msg.resource, msg.filename, msg.contentType, Uint8Array.from(atob(msg.base64), (c) => c.charCodeAt(0)));
      return null;

    case "upload-text": {
      // Every sync reads every activity again: store only what changed, so the text cache stays warm.
      const bytes = new TextEncoder().encode(msg.text);
      if (await idbStore.sameBytes(msg.resource.key, bytes)) return false;
      await ingestFile(msg.resource, msg.resource.filename, "text/plain", bytes);
      return true;
    }

    case "delete-upload":
      // Only the student's own files: a campus file would just come back with the next sync.
      if (!msg.key.startsWith("upload:") || !fromExtensionPage(sender)) throw new Error("Solo se pueden borrar los archivos que añadiste tú");
      await idbStore.deleteFile(msg.key);
      return null;

    case "known-files": {
      // Skipped files (unreadable, too large) count as known, so the content script doesn't fetch them again.
      const skipped = Object.fromEntries(Object.entries(await idbStore.skippedFiles()).map(([k, t]) => [k, { timemodified: t }]));
      return { ...skipped, ...(await idbStore.knownFiles()) } satisfies Record<string, KnownFile>;
    }

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

    case "open-panel":
      await openPanel(sender.tab?.windowId);
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
  // Developers only (devBridge): delivers a stored snapshot as soon as the dev server starts.
  if (!(await bridgeDeps.isOn())) await chrome.alarms.clear("bridge-flush");
  else if (!(await chrome.alarms.get("bridge-flush"))) await chrome.alarms.create("bridge-flush", { periodInMinutes: 1 });
  if (!(await chrome.alarms.get(UPDATE_ALARM))) await chrome.alarms.create(UPDATE_ALARM, { delayInMinutes: 1, periodInMinutes: 360 });
}

// ---------------------------------------------------------------- side panel

// The extension icon opens the side panel (home.html, manifest side_panel); there is no popup.
// Set on every worker start: cheap, and it also covers updates from a version that had a popup.
void chrome.sidePanel?.setPanelBehavior({ openPanelOnActionClick: true }).catch((e) => console.warn("[uniovi] side panel", e));

/**
 * From the campus panel's «Abrir Uniovi Virtual» click. sidePanel.open() needs that click's user
 * gesture, so it is the first call here (no await before it); if Chrome still refuses, home.html
 * opens as a tab.
 */
async function openPanel(windowId: number | undefined): Promise<void> {
  try {
    if (windowId === undefined) throw new Error("no window");
    await chrome.sidePanel.open({ windowId });
  } catch (e) {
    console.warn("[uniovi] side panel open", e);
    await chrome.tabs.create({ url: chrome.runtime.getURL("home.html") });
  }
}

chrome.runtime.onInstalled.addListener(({ reason }) => {
  void ensureAlarms();
  void startAgent();
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
