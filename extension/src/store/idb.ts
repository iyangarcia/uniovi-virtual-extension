import type { DataStore, StoredFile } from "../../../shared/mcp/store.ts";
import type { Resource, Snapshot } from "../../../shared/types.ts";
import type { KnownFile } from "../download.ts";
import { fileLabel, textKey, withClashTag } from "./paths.ts";

// The student's data, kept by the extension itself in IndexedDB (database "uniovi"). Works from the
// service worker and from extension pages (same origin, same database). Object stores:
//   meta    out-of-line keys: "snapshot" → Snapshot, "skipped" → Record<resource key, timemodified>
//   files   StoredFile, keyPath "key"
//   blobs   out-of-line keys: resource key → Blob (typed with the file's content type)
//   texts   out-of-line keys: `${key}|${timemodified}|${size}` → extracted text
// IndexedDB transactions serialise writers, so several pages + the worker may use it at once.

export const DB_NAME = "uniovi";
const DB_VERSION = 1;
const STORES = ["meta", "files", "blobs", "texts"] as const;
type StoreName = (typeof STORES)[number];

let dbPromise: Promise<IDBDatabase> | null = null;

function openDb(): Promise<IDBDatabase> {
  dbPromise ??= new Promise<IDBDatabase>((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("meta")) db.createObjectStore("meta");
      if (!db.objectStoreNames.contains("files")) db.createObjectStore("files", { keyPath: "key" });
      if (!db.objectStoreNames.contains("blobs")) db.createObjectStore("blobs");
      if (!db.objectStoreNames.contains("texts")) db.createObjectStore("texts");
    };
    req.onsuccess = () => {
      const db = req.result;
      // A newer version opened elsewhere (extension update): let it upgrade, reopen lazily.
      db.onversionchange = () => {
        db.close();
        dbPromise = null;
      };
      db.onclose = () => {
        dbPromise = null;
      };
      resolve(db);
    };
    req.onerror = () => {
      dbPromise = null;
      reject(req.error ?? new Error("IndexedDB open failed"));
    };
    req.onblocked = () => console.warn("[uniovi] IndexedDB upgrade blocked by another open page");
  });
  return dbPromise;
}

function done<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB request failed"));
  });
}

function finished(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("IndexedDB transaction failed"));
    tx.onabort = () => reject(tx.error ?? new Error("IndexedDB transaction aborted"));
  });
}

async function get<T>(store: StoreName, key: IDBValidKey): Promise<T | undefined> {
  const db = await openDb();
  return (await done(db.transaction(store, "readonly").objectStore(store).get(key))) as T | undefined;
}

async function put(store: StoreName, value: unknown, key?: IDBValidKey): Promise<void> {
  const db = await openDb();
  const tx = db.transaction(store, "readwrite");
  tx.objectStore(store).put(value, key);
  await finished(tx);
}

async function allFiles(): Promise<StoredFile[]> {
  const db = await openDb();
  return (await done(db.transaction("files", "readonly").objectStore("files").getAll())) as StoredFile[];
}

export class IdbStore implements DataStore {
  async snapshot(): Promise<Snapshot | null> {
    return (await get<Snapshot>("meta", "snapshot")) ?? null;
  }

  async saveSnapshot(s: Snapshot): Promise<void> {
    await put("meta", s, "snapshot");
  }

  async index(): Promise<Record<string, StoredFile>> {
    return Object.fromEntries((await allFiles()).map((f) => [f.key, f]));
  }

  async bytes(f: StoredFile): Promise<Uint8Array> {
    const blob = await this.fileBlob(f.key);
    if (!blob) throw new Error(`File not stored: ${f.path}`);
    return new Uint8Array(await blob.arrayBuffer());
  }

  async readText(f: StoredFile): Promise<string | null> {
    return (await get<string>("texts", textKey(f))) ?? null;
  }

  async writeText(f: StoredFile, text: string): Promise<void> {
    await put("texts", text, textKey(f));
  }

  // ------------------------------------------------------------ helpers for ingest and the UI

  /**
   * Stores (or replaces) a downloaded file: bytes, StoredFile record, and drops cached text of
   * older versions, all in one transaction. The `path` label stays stable for a key once given.
   */
  async putFile(resource: Resource & { filename: string }, courseShortname: string, contentType: string, bytes: Uint8Array): Promise<StoredFile> {
    const db = await openDb();
    const tx = db.transaction(["files", "blobs", "texts", "meta"], "readwrite");
    const files = tx.objectStore("files");
    const existing = (await done(files.get(resource.key))) as StoredFile | undefined;
    let path = existing?.path ?? fileLabel(courseShortname, resource.section, resource.filename);
    if (!existing) {
      // Another resource with the same label (two "Tema1.pdf" in one section): tag the new one.
      const clash = (await done(files.getAll())) as StoredFile[];
      if (clash.some((f) => f.path === path && f.key !== resource.key)) path = withClashTag(path, resource.key);
    }
    const now = Math.floor(Date.now() / 1000);
    const stored: StoredFile = {
      key: resource.key,
      path,
      size: bytes.byteLength,
      contentType,
      timemodified: resource.timemodified ?? now,
      storedAt: now,
      resource,
    };
    files.put(stored);
    tx.objectStore("blobs").put(new Blob([bytes as Uint8Array<ArrayBuffer>], { type: contentType }), resource.key);
    // Text of earlier versions of this key is stale: keys are `${key}|…`, so drop that range.
    tx.objectStore("texts").delete(IDBKeyRange.bound(`${resource.key}|`, `${resource.key}|￿`));
    await finished(tx);
    return stored;
  }

  /** Bytes of a stored file as a Blob typed with its content type (for blob: URLs in the viewer). */
  async fileBlob(key: string): Promise<Blob | null> {
    return (await get<Blob>("blobs", key)) ?? null;
  }

  /** Resource key → timemodified and campus URL of every stored file, for incremental sync. */
  async knownFiles(): Promise<Record<string, KnownFile>> {
    return Object.fromEntries((await allFiles()).map((f) => [f.key, { timemodified: f.timemodified, url: f.resource.url }]));
  }

  /** Files deliberately not downloaded (archives, binaries…): key → timemodified (0 if unknown). */
  async skippedFiles(): Promise<Record<string, number>> {
    return (await get<Record<string, number>>("meta", "skipped")) ?? {};
  }

  async markSkipped(resource: Resource): Promise<void> {
    const db = await openDb();
    const tx = db.transaction("meta", "readwrite");
    const meta = tx.objectStore("meta");
    const skipped = ((await done(meta.get("skipped"))) as Record<string, number> | undefined) ?? {};
    skipped[resource.key] = resource.timemodified ?? 0;
    meta.put(skipped, "skipped");
    await finished(tx);
  }

  /** Total bytes stored (sum of file sizes). */
  async usage(): Promise<{ files: number; bytes: number }> {
    const files = await allFiles();
    return { files: files.length, bytes: files.reduce((n, f) => n + f.size, 0) };
  }
}

/** One shared instance per JS context (worker or page). */
export const idbStore = new IdbStore();
