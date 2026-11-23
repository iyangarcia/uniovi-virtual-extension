import type { NativeStatus, TunnelProviderName } from "../../shared/helper.ts";
import type { BridgeStatus } from "../../shared/types.ts";

// Pure popup/background logic for the helper (no chrome APIs, so server/test can import it).

/** Outcome of chrome.runtime.sendNativeMessage({type: "status"}). */
export type NativeProbe = { kind: "ok"; status: NativeStatus } | { kind: "not-installed" } | { kind: "error"; error: string };

export type HelperStateName = "not-installed" | "stopped" | "connecting" | "ready" | "error";

export interface HelperView {
  state: HelperStateName;
  /** Native host present: Iniciar/Detener and Cambiar carpeta are usable. */
  controllable: boolean;
  /** Helper process running (per the host, or because the bridge answers). */
  running: boolean;
  /** Connector URL to paste into the web AI (BridgeStatus.remoteUrl, includes the secret path). */
  url?: string;
  provider?: TunnelProviderName;
  /** Web connector disabled in config: the helper serves only the local bridge. */
  tunnelOff: boolean;
  /** Human-readable detail for errors. */
  detail?: string;
  dataDir?: string;
}

/** Chrome's lastError when the host isn't registered (wording differs across versions). */
export function isHostNotFound(message: string): boolean {
  return /native messaging host not found|specified native messaging host not found/i.test(message);
}

/**
 * Popup state from the native host probe and /api/status (undefined = bridge not answering).
 * - not-installed: no native host. If a bridge answers anyway (developer `npm run remote`), its state is shown, without controls.
 * - stopped: the host says the helper isn't running and no bridge answers.
 * - connecting / ready / error: BridgeStatus.tunnel, or remoteUrl presence when the helper predates `tunnel`.
 */
export function deriveHelperView(native: NativeProbe, bridge: BridgeStatus | undefined): HelperView {
  const controllable = native.kind === "ok";
  const dataDir = native.kind === "ok" ? native.status.dataDir : bridge?.dataDir;
  const base = { controllable, dataDir, tunnelOff: native.kind === "ok" && !native.status.config.tunnel };

  if (native.kind === "error" && !bridge) return { ...base, state: "error", running: false, detail: native.error };
  if (!bridge) {
    if (native.kind === "not-installed") return { ...base, state: "not-installed", running: false };
    if (native.kind === "ok" && native.status.running) return { ...base, state: "connecting", running: true };
    return { ...base, state: "stopped", running: false };
  }

  const running = true;
  const managed = native.kind === "ok" && native.status.running;
  const tunnel = bridge.tunnel;
  if (tunnel) {
    const provider = tunnel.provider;
    switch (tunnel.state) {
      case "off":
        return { ...base, state: "ready", running, provider, tunnelOff: true };
      case "connecting":
        return { ...base, state: "connecting", running, provider };
      case "error":
        return { ...base, state: "error", running, provider, detail: tunnel.error ?? "No se pudo abrir el túnel" };
      case "ready":
        // The connector URL carries the secret path; until /api/status has it, keep "connecting".
        return bridge.remoteUrl
          ? { ...base, state: "ready", running, provider, url: bridge.remoteUrl }
          : { ...base, state: "connecting", running, provider };
    }
  }
  if (bridge.remoteUrl) return { ...base, state: "ready", running, url: bridge.remoteUrl };
  // A helper we started is still bringing its tunnel up; a bridge we didn't start (npm run mcp/serve) is local-only.
  return managed && !base.tunnelOff ? { ...base, state: "connecting", running } : { ...base, state: "ready", running, tunnelOff: true };
}

/**
 * "pega la nueva URL en tu IA": notify only when a URL the student already had (known) is replaced
 * by a different one. A URL disappearing (helper stopped) keeps the known one, so the same URL
 * coming back is silent, and each new URL is notified once.
 */
export function remoteUrlChange(known: string | undefined, current: string | undefined): { notify: boolean; known: string | undefined } {
  if (!current) return { notify: false, known };
  return { notify: !!known && known !== current, known: current };
}
