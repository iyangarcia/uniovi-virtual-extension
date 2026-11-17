import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { Lang, Preferences } from "../../shared/lang.ts";
import { dataDir } from "./store.ts";

// Private user preferences: <dataDir>/config.json (outside the repo; see config.example.json).
// Never put passwords here. The file is read on every call, so edits apply without a restart.
// Nothing returns this object as a whole: MCP tools only use it, and the bridge hands the
// extension the Preferences subset (no email).

export interface Config extends Preferences {
  /** Uniovi address. Stored for a future mail integration; not used yet. */
  email?: string;
  /** Language Claude answers in for the study prompts. */
  replyLanguage?: Lang;
}

export const configPath = join(dataDir, "config.json");

const lang = (v: unknown): Lang | undefined => (v === "en" || v === "es" ? v : undefined);

export async function loadConfig(): Promise<Config> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(configPath, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") console.error(`[config] ignoring ${configPath}:`, (err as Error).message);
    return {};
  }
  if (!raw || typeof raw !== "object") return {};
  const o = raw as Record<string, unknown>;
  return {
    email: typeof o.email === "string" ? o.email : undefined,
    materialLanguage: lang(o.materialLanguage),
    replyLanguage: lang(o.replyLanguage),
    lowPriorityCourses: Array.isArray(o.lowPriorityCourses) ? o.lowPriorityCourses.filter((x): x is string => typeof x === "string") : undefined,
  };
}

export const preferencesOf = (c: Config): Preferences => ({
  materialLanguage: c.materialLanguage,
  lowPriorityCourses: c.lowPriorityCourses,
});
