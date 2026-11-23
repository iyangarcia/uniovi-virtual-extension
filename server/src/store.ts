import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve, sep } from "node:path";
import type { Resource, Snapshot } from "../../shared/types.ts";

// On-disk layout (dataDir defaults to ~/uniovi-data, override with UNIOVI_DATA_DIR):
//   snapshot.json        latest Snapshot pushed by the extension
//   files-index.json     resource key -> StoredFile
//   files/<course>/<section>/<filename>
//   .cache/<hash>.txt    extracted text of stored files

export interface StoredFile {
  key: string;
  path: string; // relative to dataDir, forward slashes
  size: number;
  contentType: string;
  timemodified: number;
  storedAt: number;
  resource: Resource;
}

export const dataDir = resolve(process.env.UNIOVI_DATA_DIR ?? join(homedir(), "uniovi-data"));

const snapshotPath = join(dataDir, "snapshot.json");
const indexPath = join(dataDir, "files-index.json");

async function writeAtomic(path: string, data: string | Uint8Array) {
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
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

/** Windows-safe path segment. */
export function safeSegment(s: string, max = 80): string {
  const cleaned = s
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/, "");
  return (cleaned || "_").slice(0, max);
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

// ---------------------------------------------------------------- remote connector state
// remote.json holds the secret token of the public MCP URL and, while `--remote` runs, the
// current tunnel URL, so /api/status can show it in the popup even from another process.

export interface RemoteState {
  token: string;
  /** Full connector URL (https://….trycloudflare.com/mcp/<token>) while a tunnel is up. */
  publicUrl?: string;
  /** pid of the `--remote` process that owns publicUrl. */
  pid?: number;
}

const remotePath = join(dataDir, "remote.json");

export function loadRemoteState(): Promise<RemoteState | null> {
  return readJson<RemoteState | null>(remotePath, null);
}

export async function saveRemoteState(s: RemoteState) {
  await writeAtomic(remotePath, JSON.stringify(s, null, 1));
}

/** The connector URL, if the process that published it is still alive. */
export async function liveRemoteUrl(): Promise<string | undefined> {
  const s = await loadRemoteState();
  if (!s?.publicUrl || !s.pid) return undefined;
  try {
    process.kill(s.pid, 0);
    return s.publicUrl;
  } catch {
    return undefined;
  }
}
