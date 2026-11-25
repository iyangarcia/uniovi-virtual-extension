import type { Resource, Snapshot } from "../../shared/types.ts";
import { collect } from "./collector.ts";
import { decideResponse, type KnownFile, needsDownload, readLimited } from "./download.ts";
import { getSettings, send, type Message, type Reply } from "./messages.ts";
import { MoodleClient, readPageConfig } from "./moodle.ts";
import { isDashboard, mountPanel } from "./panel.ts";

let running = false;

function progress(text: string, isRunning = true, error = false) {
  void chrome.runtime.sendMessage({ type: "progress", text, running: isRunning, error } satisfies Message);
}

chrome.runtime.onMessage.addListener((msg: Message, _sender, sendResponse: (r: Reply) => void) => {
  if (msg.type !== "run-sync") return false;
  if (running) {
    sendResponse({ ok: false, error: "A sync is already running in this tab" });
    return false;
  }
  if (!readPageConfig()) {
    sendResponse({ ok: false, error: "Not logged in to Uniovi Virtual in this tab" });
    return false;
  }
  sendResponse({ ok: true, data: null });
  void runSync();
  return false;
});

// Only act on Moodle pages where the user is logged in.
if (readPageConfig()) {
  if (isDashboard()) mountPanel(() => void runSync());
  void chrome.runtime.sendMessage({ type: "page-ready" } satisfies Message);
  // Files that couldn't be downloaded during the last sync (a failure, or the sync was cut short) go now.
  setTimeout(() => void (running ? undefined : uploadPendingFiles(false).catch((e) => console.warn("[uniovi] files", e))), 3000);
}

async function runSync() {
  if (running) return;
  running = true;
  try {
    const cfg = readPageConfig();
    if (!cfg) throw new Error("No has iniciado sesión (falta sesskey)");
    const settings = await getSettings();
    const texts: Array<{ resource: Resource & { filename: string }; text: string }> = [];
    const snapshot = await collect(new MoodleClient(cfg), {
      courseScope: settings.courseScope,
      replyWindowDays: settings.replyWindowDays,
      onProgress: (t) => progress(t),
      onText: (resource, text) => texts.push({ resource, text }),
    });
    // Stored in the extension (chrome.storage for the panel, IndexedDB for the AI).
    await send({ type: "snapshot-collected", snapshot });
    // Pages, links, quizzes, assignments and the course pages: stored as text, only when changed.
    let changedTexts = 0;
    for (const [i, t] of texts.entries()) {
      progress(`Guardando páginas ${i + 1}/${texts.length}`);
      if (await send<boolean>({ type: "upload-text", ...t })) changedTexts++;
    }
    const files = await uploadPendingFiles(true);
    const summary =
      `${snapshot.courses.length} asignaturas, ${snapshot.resources.length} materiales, ${snapshot.posts.length} mensajes` +
      (files.uploaded + changedTexts ? ` · ${files.uploaded + changedTexts} archivos nuevos` : "") +
      (files.failed ? ` (${files.failed} fallidos)` : "");
    progress(summary, false);
  } catch (err) {
    progress(err instanceof Error ? err.message : String(err), false, true);
  } finally {
    running = false;
  }
}

/**
 * Downloads new/changed readable files into the extension's storage (via the background). Needs
 * the campus tab (same-origin fetch with the session cookie). Archives, binaries, media and files
 * over the size limit are not downloaded: they stay campus links in the snapshot (see download.ts).
 */
async function uploadPendingFiles(reportProgress: boolean): Promise<{ uploaded: number; failed: number }> {
  const settings = await getSettings();
  if (!settings.downloadFiles) return { uploaded: 0, failed: 0 };
  const known = await send<Record<string, KnownFile>>({ type: "known-files" });
  const { snapshot } = (await chrome.storage.local.get("snapshot")) as { snapshot?: Snapshot };
  if (!snapshot) return { uploaded: 0, failed: 0 };
  const maxBytes = settings.maxFileMB * 1024 * 1024;
  const todo = snapshot.resources.filter((r) => needsDownload(r, known, maxBytes));
  let uploaded = 0;
  let failed = 0;
  for (const [i, r] of todo.entries()) {
    if (reportProgress) progress(`Guardando archivos ${i + 1}/${todo.length}: ${r.filename ?? r.name}`);
    try {
      if (await uploadFile(r, maxBytes)) uploaded++;
    } catch (err) {
      failed++;
      console.warn("[uniovi] file", r.url, err);
    }
  }
  return { uploaded, failed };
}

/** Returns false when the file is not stored: not a readable type or too large (recorded, so not fetched again). */
async function uploadFile(r: Resource, maxBytes: number): Promise<boolean> {
  const res = await fetch(r.url, { credentials: "same-origin" });
  const d = decideResponse(r, res, maxBytes);
  if (d.action !== "store") {
    await res.body?.cancel().catch(() => undefined);
    if (d.action === "fail") throw new Error(d.error);
    await send({ type: "skip-file", resource: { ...r, filename: d.filename } });
    return false;
  }
  // No (or a wrong) Content-Length: stop the download as soon as it passes the limit.
  const bytes = await readLimited(res.body, maxBytes);
  if (!bytes) {
    await send({ type: "skip-file", resource: { ...r, filename: d.filename } });
    return false;
  }
  await send({ type: "upload-file", resource: r, filename: d.filename, contentType: d.contentType, base64: toBase64(bytes) });
  return true;
}

function toBase64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
