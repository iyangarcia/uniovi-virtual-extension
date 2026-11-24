import * as core from "../../shared/mcp/extract.ts";
import { nodeStore, type StoredFile } from "./store.ts";

// Node wiring of the shared text extraction (shared/mcp/extract.ts) over the on-disk store.

export const kindOf = core.kindOf;
export const textOf = (f: StoredFile) => core.textOf(nodeStore, f);
export const cachedTextOf = (f: StoredFile) => core.cachedTextOf(nodeStore, f);
export const isWarming = () => core.isWarming(nodeStore);
export const warmTextCache = (files: StoredFile[]) => core.warmTextCache(nodeStore, files);
