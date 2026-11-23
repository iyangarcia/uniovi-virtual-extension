import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { APP_DIR_NAME, DEFAULT_HELPER_CONFIG, defaultDataDir, type HelperConfig } from "../../shared/helper.ts";

// Per-user install/config dir for the helper and the native host (Windows: %LOCALAPPDATA%\UnioviVirtual).
// UNIOVI_APP_DIR overrides it (tests, dev runs), so nothing ever touches the real one by accident.
//
// Installed layout (built by `npm run package`):
//   <appDir>\node.exe        portable Node
//   <appDir>\helper.js       bundled server (`--service`)
//   <appDir>\host.js         bundled native-messaging host; host.cmd runs it with node.exe
//   <appDir>\config.json     HelperConfig
//   <appDir>\helper.pid      pid of the running helper (written by --service, removed on clean exit)
//   <appDir>\logs\           helper logs

export function appDir(): string {
  if (process.env.UNIOVI_APP_DIR) return process.env.UNIOVI_APP_DIR;
  const base = process.env.LOCALAPPDATA ?? join(homedir(), "AppData", "Local");
  return join(base, APP_DIR_NAME);
}

export const configFile = (): string => join(appDir(), "config.json");
export const pidFile = (): string => join(appDir(), "helper.pid");
export const logDir = (): string => join(appDir(), "logs");

export function loadConfig(): HelperConfig {
  try {
    const raw = JSON.parse(readFileSync(configFile(), "utf8")) as Partial<HelperConfig>;
    return {
      ...DEFAULT_HELPER_CONFIG,
      ...(typeof raw.dataDir === "string" && raw.dataDir ? { dataDir: raw.dataDir } : {}),
      ...(typeof raw.tunnel === "boolean" ? { tunnel: raw.tunnel } : {}),
    };
  } catch {
    return { ...DEFAULT_HELPER_CONFIG };
  }
}

/** Atomic write (tmp + rename). */
export function saveConfig(config: HelperConfig): void {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(`${file}.tmp`, JSON.stringify(config, null, 2));
  renameSync(`${file}.tmp`, file);
}

/** UNIOVI_DATA_DIR env > config.dataDir > default (existing ~/uniovi-data, else ~/Documents/Uniovi). */
export function effectiveDataDir(config: HelperConfig = loadConfig()): string {
  if (process.env.UNIOVI_DATA_DIR) return process.env.UNIOVI_DATA_DIR;
  if (config.dataDir) return config.dataDir;
  return defaultDataDir(process.env.USERPROFILE ?? homedir(), existsSync).replaceAll("\\", process.platform === "win32" ? "\\" : "/");
}
