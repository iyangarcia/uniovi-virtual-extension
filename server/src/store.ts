import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rename, rmdir, writeFile } from "node:fs/promises";
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
    .trim();
  // Windows rejects names ending in a dot or space, also after truncation.
  return cleaned.slice(0, max).replace(/[. ]+$/, "") || "_";
}

/** Where a file belongs: files/<course label>/<section>/<filename>. */
export function pathFor(resource: Resource, filename: string, courseFolder: string): string {
  return ["files", safeSegment(courseFolder), safeSegment(resource.section || "General"), safeSegment(filename, 150)].join("/");
}

/** Prefixes a short, stable hash of the key when another resource already uses `rel`. */
function avoidClash(index: Record<string, StoredFile>, rel: string, key: string): string {
  // e.g. two "Tema1.pdf" in different subfolders of one folder activity.
  const clash = Object.values(index).some((f) => f.path.toLowerCase() === rel.toLowerCase() && f.key !== key);
  if (!clash) return rel;
  const tag = createHash("sha1").update(key).digest("hex").slice(0, 6);
  return rel.replace(/([^/]+)$/, `${tag}-$1`);
}

function inDataDir(rel: string): string {
  const abs = join(dataDir, ...rel.split("/"));
  if (!abs.startsWith(dataDir + sep)) throw new Error("Refusing to touch a path outside the data dir");
  return abs;
}

// Serialise index writes: files arrive one by one but the extension may retry concurrently.
let indexLock: Promise<unknown> = Promise.resolve();

export async function storeFile(
  resource: Resource & { filename: string },
  courseFolder: string,
  contentType: string,
  bytes: Uint8Array,
): Promise<StoredFile> {
  const run = async () => {
    const index = await loadIndex();
    const existing = index[resource.key];
    const rel = existing?.path ?? avoidClash(index, pathFor(resource, resource.filename, courseFolder), resource.key);
    await writeAtomic(inDataDir(rel), bytes);

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
  return withIndexLock(run);
}

function withIndexLock<T>(run: () => Promise<T>): Promise<T> {
  const p = indexLock.then(run, run);
  indexLock = p.catch(() => undefined);
  return p;
}

/**
 * Moves stored files to where they belong now: course folders named by label instead of code,
 * section names cleaned up by a newer extension. Only renames; never deletes a file. The text
 * cache is keyed by key/timemodified/size, so it stays valid. Returns how many files moved.
 */
export function relocateFiles(snapshot: Snapshot, courseFolder: (courseId: number) => string): Promise<number> {
  return withIndexLock(async () => {
    const index = await loadIndex();
    const current = new Map(snapshot.resources.map((r) => [r.key, r]));
    let moved = 0;
    for (const f of Object.values(index)) {
      const resource = { ...f.resource, ...current.get(f.key) };
      const filename = f.resource.filename ?? f.path.split("/").pop()!;
      const target = avoidClash(index, pathFor(resource, filename, courseFolder(resource.courseId)), f.key);
      if (target === f.path) continue;
      const from = inDataDir(f.path);
      if (!existsSync(from)) continue;
      const to = inDataDir(target);
      if (existsSync(to) && from.toLowerCase() !== to.toLowerCase()) continue; // something unexpected is there: leave both alone
      try {
        await mkdir(dirname(to), { recursive: true });
        await rename(from, to);
      } catch (err) {
        console.error(`[store] could not move ${f.path}:`, (err as Error).message);
        continue;
      }
      await removeEmptyDirs(dirname(from));
      f.path = target;
      f.resource = { ...resource, filename };
      moved++;
    }
    if (moved) await writeAtomic(indexPath, JSON.stringify(index, null, 1));
    return moved;
  });
}

/** Removes `dir` and its parents while they are empty, stopping at files/. */
async function removeEmptyDirs(dir: string) {
  const stop = join(dataDir, "files");
  while (dir.startsWith(stop + sep)) {
    try {
      if ((await readdir(dir)).length) return;
      await rmdir(dir);
    } catch {
      return;
    }
    dir = dirname(dir);
  }
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
