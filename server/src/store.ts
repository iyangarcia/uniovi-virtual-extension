import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import type { TunnelStatus } from "../../shared/helper.ts";
import type { DataStore, StoredFile } from "../../shared/mcp/store.ts";
import type { Resource, Snapshot } from "../../shared/types.ts";
import { effectiveDataDir } from "./config.ts";

// On-disk layout. dataDir: UNIOVI_DATA_DIR env > config.json dataDir > existing ~/uniovi-data >
// ~/Documents/Uniovi (see config.ts). Read once at startup: changing it means restarting the helper.
//   snapshot.json        latest Snapshot pushed by the extension
//   files-index.json     resource key -> StoredFile
//   files/<course>/<section>/<filename>
//   .cache/<hash>.txt    extracted text of stored files

// StoredFile.path is relative to dataDir, forward slashes.
export type { StoredFile };

export const dataDir = resolve(effectiveDataDir());

const snapshotPath = join(dataDir, "snapshot.json");
const indexPath = join(dataDir, "files-index.json");

let tmpSeq = 0;
const writeChains = new Map<string, Promise<unknown>>();

// Concurrent writes of one file (e.g. the tunnel's onDown and the shutdown handler both clearing
// remote.json) used to share one tmp name, so one of the renames failed with ENOENT. Writes to
// the same path are now serialised in-process, tmp names are unique, and a rename that loses a
// race with another process on Windows (EPERM/EACCES/EBUSY) is retried briefly.
function writeAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const run = async () => {
    await mkdir(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.${++tmpSeq}.tmp`;
    await writeFile(tmp, data);
    for (let attempt = 0; ; attempt++) {
      try {
        return await rename(tmp, path);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? "";
        if (attempt >= 8 || !["EPERM", "EACCES", "EBUSY"].includes(code)) {
          await unlink(tmp).catch(() => undefined);
          throw err;
        }
        await new Promise((r) => setTimeout(r, 15 * (attempt + 1)));
      }
    }
  };
  const p = (writeChains.get(path) ?? Promise.resolve()).then(run, run);
  const tail = p.catch(() => undefined);
  writeChains.set(path, tail);
  void tail.then(() => {
    if (writeChains.get(path) === tail) writeChains.delete(path);
  });
  return p;
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch {
    return fallback;
  }
}

export function loadSnapshot(): Promise<Snapshot | null> {
  return readJson<Snapshot | null>(snapshotPath, null);
}

export async function saveSnapshot(s: Snapshot) {
  await writeAtomic(snapshotPath, JSON.stringify(s, null, 1));
}

export function loadIndex(): Promise<Record<string, StoredFile>> {
  return readJson<Record<string, StoredFile>>(indexPath, {});
}

/**
 * Windows-safe path segment. Truncation happens BEFORE stripping trailing dots/spaces (Win32 drops
 * them, so a folder ending in one can't be opened by Explorer or PowerShell) and by code point (no
 * lone surrogate halves). Reserved device names (CON, NUL, COM1, nul.txt…) get a leading "_".
 * Already-indexed files keep their stored path (storeFile reuses it); only new files use this.
 */
export function safeSegment(s: string, max = 80): string {
  const cleaned = [
    ...s
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
      .replace(/\s+/g, " ")
      .trim(),
  ]
    .slice(0, max)
    .join("")
    .replace(/[. ]+$/, "");
  if (!cleaned) return "_";
  return /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(\.|$)/i.test(cleaned) ? `_${cleaned}`.slice(0, max) : cleaned;
}

// Serialise index writes: files arrive one by one but the extension may retry concurrently.
let indexLock: Promise<unknown> = Promise.resolve();

export async function storeFile(
  resource: Resource & { filename: string },
  courseShortname: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<StoredFile> {
  const run = async () => {
    const index = await loadIndex();
    const existing = index[resource.key];
    let rel =
      existing?.path ??
      ["files", safeSegment(courseShortname), safeSegment(resource.section || "General"), safeSegment(resource.filename, 150)].join("/");
    // Avoid clobbering a different resource that shares the filename (e.g. two "Tema1.pdf" in
    // different subfolders of one folder activity): prefix a short, stable hash of the key.
    const clash = Object.values(index).some((f) => f.path === rel && f.key !== resource.key);
    if (clash) {
      const tag = createHash("sha1").update(resource.key).digest("hex").slice(0, 6);
      rel = rel.replace(/([^/]+)$/, `${tag}-$1`);
    }

    const abs = join(dataDir, ...rel.split("/"));
    if (!abs.startsWith(dataDir + sep)) throw new Error("Refusing to write outside data dir");
    await writeAtomic(abs, bytes);

    const stored: StoredFile = {
      key: resource.key,
      path: rel,
      size: bytes.byteLength,
      contentType,
      timemodified: resource.timemodified ?? Math.floor(Date.now() / 1000),
      storedAt: Math.floor(Date.now() / 1000),
      resource,
    };
    index[resource.key] = stored;
    await writeAtomic(indexPath, JSON.stringify(index, null, 1));
    return stored;
  };
  const p = indexLock.then(run, run);
  indexLock = p.catch(() => undefined);
  return p;
}

export function absolutePath(f: StoredFile): string {
  return join(dataDir, ...f.path.split("/"));
}

export function cachePathFor(f: StoredFile): string {
  const h = createHash("sha1").update(`${f.key}|${f.timemodified}|${f.size}`).digest("hex");
  return join(dataDir, ".cache", `${h}.txt`);
}

export async function readCache(f: StoredFile): Promise<string | null> {
  const p = cachePathFor(f);
  return existsSync(p) ? readFile(p, "utf8") : null;
}

export async function writeCache(f: StoredFile, text: string) {
  await writeAtomic(cachePathFor(f), text);
}

/** The shared MCP core's view of the on-disk layout (one instance: the core keeps per-store state). */
export const nodeStore: DataStore = {
  snapshot: loadSnapshot,
  index: loadIndex,
  bytes: async (f) => new Uint8Array(await readFile(absolutePath(f))),
  readText: readCache,
  writeText: writeCache,
  localPath: absolutePath,
  dataDir,
};

// ---------------------------------------------------------------- remote connector state
// remote.json holds the secret token of the public MCP URL and, while `--remote` / `--service`
// runs, the current tunnel URL and state, so /api/status can show them in the popup even when
// another process serves the bridge.

export interface RemoteState {
  token: string;
  /** Full connector URL (https://…/mcp/<token>) while a tunnel is up. */
  publicUrl?: string;
  /** pid of the `--remote` / `--service` process that owns publicUrl and tunnel. */
  pid?: number;
  /** Tunnel state written by the owning process (`--service` keeps it current). */
  tunnel?: TunnelStatus;
}

const remotePath = join(dataDir, "remote.json");

export function loadRemoteState(): Promise<RemoteState | null> {
  return readJson<RemoteState | null>(remotePath, null);
}

export async function saveRemoteState(s: RemoteState) {
  await writeAtomic(remotePath, JSON.stringify(s, null, 1));
}

export function pidAlive(pid: number | undefined): boolean {
  if (!pid || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** URL and tunnel state published by the remote/service process, if that process is still alive. */
export async function liveRemote(): Promise<{ remoteUrl?: string; tunnel?: TunnelStatus }> {
  const s = await loadRemoteState();
  if (!s?.pid || !pidAlive(s.pid)) return {};
  return { remoteUrl: s.publicUrl, tunnel: s.tunnel };
}

/** The connector URL, if the process that published it is still alive. */
export async function liveRemoteUrl(): Promise<string | undefined> {
  return (await liveRemote()).remoteUrl;
}
