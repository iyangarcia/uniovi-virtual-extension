// The local dev bridge (`npm run serve` / the Node MCP server on 127.0.0.1:47823), for developers who
// use Claude Code / Desktop. Off for students: nothing is sent unless chrome.storage.local.devBridge
// is exactly true (set it from the service worker console). Any local process could listen on that
// port, so the student's snapshot and files never go there by default. Pure; server/test imports it.
import { BRIDGE_URL } from "../../shared/types.ts";

export const DEV_BRIDGE_KEY = "devBridge";

/** Whether the developer switched the bridge on (chrome.storage.local contents, or part of them). */
export const devBridgeOn = (stored: Record<string, unknown>) => stored[DEV_BRIDGE_KEY] === true;

export interface BridgeDeps {
  /** Reads the devBridge flag (chrome.storage.local in the worker). */
  isOn(): Promise<boolean>;
  fetch: typeof fetch;
}

/**
 * Sends one request to the bridge. Returns false without any network traffic when the bridge is
 * off; throws when it is on but not running or answers with an error.
 */
export async function sendToBridge(deps: BridgeDeps, path: string, init: RequestInit): Promise<boolean> {
  if (!(await deps.isOn())) return false;
  let res: Response;
  try {
    res = await deps.fetch(BRIDGE_URL + path, init);
  } catch {
    throw new Error("Dev bridge not running (`npm run serve`).");
  }
  if (!res.ok) throw new Error(`Bridge ${path}: HTTP ${res.status} ${await res.text()}`);
  return true;
}
