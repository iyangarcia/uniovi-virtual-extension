// Contracts between the extension, the native-messaging host and the local helper (the Node
// server running as a hidden background service, installed per user on Windows).
// Pure: no DOM or Node APIs, so both halves can import it.

/** Native Messaging host name, registered under HKCU\Software\Google\Chrome\NativeMessagingHosts. */
export const NATIVE_HOST_NAME = "es.uniovi.virtual";

/**
 * Fixed extension ID: the manifest carries `key` = EXTENSION_PUBLIC_KEY (derived from the
 * gitignored extension/dist.pem), so an unpacked install has this ID on every machine. The native
 * host manifest's allowed_origins is `chrome-extension://${EXTENSION_ID}/`.
 */
export const EXTENSION_ID = "amagekgnbkaeigjhbenkilkhoklkdieo";
export const EXTENSION_PUBLIC_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAnBmQsxWb6hitDhCnte8YZdb55mGX2cDiIvpFU8shDNNuiumg3FkrvVLGI86a3OKuxy4D/U7v1JqtOY6uYrCMModNuFubClN10cRjaB/5hhD5Ou9zdZYGq+he2P+ytxi5pLXbGBNK0g5UyvtZ72zHK2I/PyeINUwMffXpGqysPGBlZ3Rs07Hbquw+TSfCeLDsCyTkQTjByVZOHvgBQnSh++aGHV383mOtX+GAc+MB0wsx+rfJaQMNekOUsv/gQ6oZn/oYxFeAtbxK3fJfhPohY1hh4Q2krsnuGbpX5vHhAg4p32oKQcUBX3ChFZBfBjAsE+EE1t/u5kCNK6oSRBFNQwIDAQAB";

/** Folder name under %LOCALAPPDATA% for the install, config and logs. */
export const APP_DIR_NAME = "UnioviVirtual";

// ---- Tunnel ---------------------------------------------------------------------------------

/** Tried in this order; a provider that isn't ready in time falls through to the next. */
export type TunnelProviderName = "tunnelmole" | "localhost.run" | "cloudflared";
export const TUNNEL_PROVIDERS: readonly TunnelProviderName[] = ["tunnelmole", "localhost.run", "cloudflared"];

export interface TunnelStatus {
  /** off: tunnel disabled in config or not started. connecting: trying a provider. ready: url reachable. error: every provider failed (retrying). */
  state: "off" | "connecting" | "ready" | "error";
  provider?: TunnelProviderName;
  /** Public base URL (no /mcp/<token> path), only when state is "ready". */
  url?: string;
  /** Last error line, human readable, no secrets. */
  error?: string;
  /** Unix seconds of the last state change. */
  since?: number;
}

// ---- Helper config: %LOCALAPPDATA%\UnioviVirtual\config.json -----------------------------------

export interface HelperConfig {
  /** Absolute data folder. Absent = default (see defaultDataDir). UNIOVI_DATA_DIR env still overrides. */
  dataDir?: string;
  /** Web-AI tunnel enabled. Default true. */
  tunnel: boolean;
}

export const DEFAULT_HELPER_CONFIG: HelperConfig = { tunnel: true };

export interface HelperPaths {
  appDir: string; // %LOCALAPPDATA%\UnioviVirtual
  configFile: string; // <appDir>\config.json
  logDir: string; // <appDir>\logs
}

/** Windows paths only (Windows is the only supported install target for now). */
export function helperPaths(localAppData: string): HelperPaths {
  const appDir = `${localAppData}\\${APP_DIR_NAME}`;
  return { appDir, configFile: `${appDir}\\config.json`, logDir: `${appDir}\\logs` };
}

/**
 * Default data folder: an existing %USERPROFILE%\uniovi-data (earlier versions, no migration),
 * otherwise %USERPROFILE%\Documents\Uniovi.
 */
export function defaultDataDir(userProfile: string, exists: (path: string) => boolean): string {
  const legacy = `${userProfile}\\uniovi-data`;
  return exists(legacy) ? legacy : `${userProfile}\\Documents\\Uniovi`;
}

// ---- Native messaging: extension <-> host (chrome.runtime.sendNativeMessage) ------------------

export type NativeRequest =
  | { type: "status" }
  | { type: "start" } // start the helper detached + hidden if not running
  | { type: "stop" }
  | { type: "setDataDir"; dataDir: string } // writes config, restarts the helper if running
  | { type: "setTunnel"; enabled: boolean }; // writes config, restarts the helper if running

export interface NativeStatus {
  installed: true;
  hostVersion: string;
  running: boolean;
  pid?: number;
  config: HelperConfig;
  /** Effective data folder (config, env override or default). */
  dataDir: string;
}

export type NativeReply = { ok: true; status: NativeStatus } | { ok: false; error: string };
