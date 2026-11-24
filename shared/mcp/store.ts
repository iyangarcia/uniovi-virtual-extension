import type { Resource, Snapshot } from "../types.ts";

// The storage seam of the shared MCP core (shared/mcp/). The same tools, prompts and text extraction
// run in two places:
//   - the extension service worker, over IndexedDB (extension/src/store/), answering web AIs through
//     the relay — the path every student uses;
//   - the Node server (server/src/store.ts, files on disk), for Claude Code / Desktop over stdio —
//     developer path.
// Implementations must be safe for concurrent readers; writes of the text cache may race and the
// last one wins (the text is a pure function of the bytes).

export interface StoredFile {
  key: string;
  /** Display path `files/<course>/<section>/<filename>` (forward slashes). On disk it is also the
   *  relative location; in IndexedDB it is only a label. */
  path: string;
  size: number;
  contentType: string;
  timemodified: number;
  storedAt: number;
  resource: Resource;
}

export interface DataStore {
  /** Latest snapshot pushed by the collector, or null before the first sync. */
  snapshot(): Promise<Snapshot | null>;
  /** Resource key → stored file. */
  index(): Promise<Record<string, StoredFile>>;
  /** Raw bytes of a stored file. Rejects if missing. */
  bytes(f: StoredFile): Promise<Uint8Array>;
  /** Cached extracted text for this exact version of the file (key|timemodified|size), or null. */
  readText(f: StoredFile): Promise<string | null>;
  writeText(f: StoredFile, text: string): Promise<void>;
  /**
   * Local-only extras for the Node stdio server: absolute path of a file and the data dir. Undefined
   * in the extension. Tools include them in output only when the server is not in remote mode.
   */
  localPath?(f: StoredFile): string;
  dataDir?: string;
}
