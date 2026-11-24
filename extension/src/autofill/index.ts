import { chatgpt } from "./chatgpt.ts";
import { claude } from "./claude.ts";
import { fillConnector } from "./engine.ts";
import { gemini } from "./gemini.ts";
import { CONNECTOR_NAME, type AiId, type AutofillSpec, type FillResult } from "./types.ts";

// Chrome glue for "Conectar automáticamente" (runs in the welcome page).
//
// chrome.storage.local `devAutofillUrls` (dev/test only): { claude?: url, chatgpt?: url, gemini?: url }
// replaces that AI's start page (a local fixture) and skips the permission request, since the
// fixture is served from an origin the extension can already script.

export const AI_SPECS: Record<AiId, AutofillSpec> = { claude, chatgpt, gemini };
export const DEV_AUTOFILL_KEY = "devAutofillUrls";

export type AutoConnectOutcome = { ok: true; result: FillResult } | { ok: false; reason: "permission" | "tab" | "fill"; result?: FillResult; error?: string };

function waitForComplete(tabId: number, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      reject(new Error("la página no terminó de cargar"));
    }, timeoutMs);
    const finish = () => {
      clearTimeout(timer);
      chrome.tabs.onUpdated.removeListener(onUpdated);
      resolve();
    };
    const onUpdated = (id: number, info: { status?: string }) => {
      if (id === tabId && info.status === "complete") finish();
    };
    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.get(tabId).then((t) => t.status === "complete" && finish(), () => undefined);
  });
}

/**
 * Opens the AI's connector page and fills name + URL. `permission` must be the promise from
 * chrome.permissions.request(), started synchronously inside the click handler (it needs the gesture).
 */
export async function autoConnect(spec: AutofillSpec, connectorUrl: string, permission: Promise<boolean>, startUrl = spec.startUrl): Promise<AutoConnectOutcome> {
  if (!(await permission.catch(() => false))) return { ok: false, reason: "permission" };
  let tabId: number | undefined;
  try {
    const tab = await chrome.tabs.create({ url: startUrl, active: true });
    tabId = tab.id;
    if (tabId === undefined) return { ok: false, reason: "tab" };
    await waitForComplete(tabId, 30_000);
  } catch (err) {
    return { ok: false, reason: "tab", error: err instanceof Error ? err.message : String(err) };
  }
  try {
    const [injection] = await chrome.scripting.executeScript({
      target: { tabId },
      func: fillConnector,
      args: [{ spec, name: CONNECTOR_NAME, url: connectorUrl, timeoutMs: 25_000 }],
    });
    const result = injection?.result as FillResult | undefined;
    return result?.ok ? { ok: true, result } : { ok: false, reason: "fill", ...(result ? { result } : {}) };
  } catch (err) {
    // E.g. the AI redirected to a login page on another origin we have no permission for.
    return { ok: false, reason: "fill", error: err instanceof Error ? err.message : String(err) };
  }
}
