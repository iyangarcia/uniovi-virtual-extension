import type { Resource, Snapshot } from "../../shared/types.ts";
import { collect } from "./collector.ts";
import { getSettings, send, type Message, type Reply } from "./messages.ts";
import { MoodleClient, readPageConfig } from "./moodle.ts";
import { isDashboard, mountPanel } from "./panel.ts";
import { isReadableFile } from "./readable.ts";

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
    const snapshot = await collect(new MoodleClient(cfg), {
      courseScope: settings.courseScope,
      replyWindowDays: settings.replyWindowDays,
      onProgress: (t) => progress(t),
    });
    // Stored in the extension (chrome.storage for the panel, IndexedDB for the AI).
    await send({ type: "snapshot-collected", snapshot });
    const files = await uploadPendingFiles(true);
    const summary =
      `${snapshot.courses.length} asignaturas, ${snapshot.resources.length} materiales, ${snapshot.posts.length} mensajes` +
      (files.uploaded ? ` · ${files.uploaded} archivos nuevos` : "") +
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
 * the campus tab (same-origin fetch with the session cookie). Archives, binaries and media are not
 * downloaded: they stay campus links in the snapshot.
 */
async function uploadPendingFiles(reportProgress: boolean): Promise<{ uploaded: number; failed: number }> {
  const settings = await getSettings();
  if (!settings.downloadFiles) return { uploaded: 0, failed: 0 };
  const known = await send<Record<string, number>>({ type: "known-files" });
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

function needsDownload(r: Resource, known: Record<string, number>, maxBytes: number): boolean {
  if (r.modname !== "resource" && r.modname !== "folder" && r.modname !== "section-file") return false;
  if (r.filesize !== undefined && r.filesize > maxBytes) return false;
  if (isReadableFile(r) === false) return false;
  const stored = known[r.key];
  if (stored === undefined) return true;
  return r.timemodified !== undefined && r.timemodified > stored;
}

/** Returns false when the file turned out not to be a readable type (recorded, not downloaded). */
async function uploadFile(r: Resource, maxBytes: number): Promise<boolean> {
  const res = await fetch(r.url, { credentials: "same-origin" });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  // A resource set to "embed"/"open" without redirect, or a login page, comes back as HTML.
  if (contentType.startsWith("text/html")) throw new Error("Got an HTML page instead of a file");
  const filename = r.filename ?? filenameFrom(res) ?? `${r.name}`;
  // `/mod/resource/view.php` links only reveal the file name and type after the redirect.
  if (isReadableFile({ filename, mimetype: contentType.split(";")[0] }) !== true) {
    await res.body?.cancel().catch(() => undefined);
    await send({ type: "skip-file", resource: { ...r, filename } });
    return false;
  }
  const buf = await res.arrayBuffer();
  if (buf.byteLength > maxBytes) throw new Error("File too large");
  await send({ type: "upload-file", resource: r, filename, contentType, base64: toBase64(buf) });
  return true;
}

function filenameFrom(res: Response): string | undefined {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  if (star) return decodeURIComponent(star.replace(/"/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  if (plain) return plain;
  const last = new URL(res.url).pathname.split("/").pop();
  return last ? decodeURIComponent(last) : undefined;
}

function toBase64(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}
