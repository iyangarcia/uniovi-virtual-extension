// What the agent (the extension's link to the relay, so web AIs can read the student's data) publishes
// in chrome.storage.local for the popup and welcome page. Pure types; no chrome APIs.
//
//   agent          AgentIdentity { id, secret, token }: created once on first run. Never shown, except
//                  id + token inside the connector URL (connectorUrl() in agent/identity.ts).
//                  «Cambiar enlace» (changeLink()) replaces id and token; the secret stays.
//   aiConnection   boolean, default true (absent = true). false: the agent disconnects and stays off.
//   agentState     AgentState: the connection state, written on every change.
//   agentStats     AgentStats: counters and timestamps for diagnostics (written on connect, close and request;
//                  lastPong is kept in memory and only written along with those).
//   devRelayUrl    string, dev/test only: replaces RELAY_URL (http(s):// or ws(s)://, no trailing slash).

export type AgentStateName =
  /** aiConnection is off (or the agent was never started). */
  | "off"
  /** Opening the socket, or waiting for the relay's welcome. */
  | "connecting"
  /** Welcome received: AIs can reach the student's data. */
  | "connected"
  /** The relay refused this extension's secret for its id. Not retried until aiConnection is toggled. */
  | "rejected"
  /** Socket lost or relay unreachable; reconnecting with backoff (1 s → 60 s). `error` says why. */
  | "offline";

export interface AgentState {
  state: AgentStateName;
  /** Date.now() when this state began. */
  since: number;
  /** Reason for offline / rejected (rejected: RelayRejected.reason). */
  error?: string;
}

export interface AgentStats {
  /** Number of accepted connections (welcomes) since the extension was installed. */
  connects: number;
  lastConnect?: number;
  lastPong?: number;
  lastClose?: number;
  /** Requests received from the relay. */
  requests: number;
  lastRequest?: number;
}

export const AGENT_KEYS = {
  identity: "agent",
  enabled: "aiConnection",
  state: "agentState",
  stats: "agentStats",
  devRelayUrl: "devRelayUrl",
} as const;

/** `aiConnection` defaults to on: absent or anything but `false` means enabled. */
export const aiConnectionEnabled = (v: unknown) => v !== false;

/**
 * Relay base URLs from RELAY_URL or the dev override. Accepts http(s):// or ws(s)://; returns the
 * HTTP base (for the connector URL) and the WebSocket base (for the agent socket).
 */
export function relayBases(override: unknown, fallbackHttp: string): { http: string; ws: string } {
  const raw = typeof override === "string" && /^(https?|wss?):\/\/[^\s]+$/i.test(override) ? override.replace(/\/+$/, "") : fallbackHttp;
  const http = raw.replace(/^ws(s?):/i, "http$1:");
  return { http, ws: http.replace(/^http/i, "ws") };
}
