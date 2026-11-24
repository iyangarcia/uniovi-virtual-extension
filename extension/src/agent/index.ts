import { idbStore } from "../store/idb.ts";
import { AgentConnection, type AgentEvent } from "./connection.ts";
import { changeLink, connectorUrl, getIdentity, relayBasesNow, setCachedIdentity } from "./identity.ts";
import { mcpHandler } from "./mcp.ts";
import { connectionKey, idChanged, isValidIdentity } from "./protocol.ts";
import { AGENT_KEYS, aiConnectionEnabled, type AgentState, type AgentStateName, type AgentStats } from "./state.ts";

// Chrome glue for the agent, background service worker only: startAgent() and the listeners. The
// identity and connector URL live in identity.ts (pages import that one, not this file, so they don't
// bundle the MCP server); they are re-exported here for convenience.
export { changeLink, connectorUrl, getIdentity };

const KEEPALIVE_ALARM = "agent-keepalive";

// ---------------------------------------------------------------- background only

let conn: AgentConnection | null = null;
let connKey = "";
let token = "";
/** Last pong, in memory only: writing it to storage every ~20 s woke every open page for nothing. */
let lastPong: number | undefined;
let statsChain: Promise<unknown> = Promise.resolve();

let stateChain: Promise<unknown> = Promise.resolve();

/** Serialised, so quick transitions (connecting → connected) land in order. */
function writeState(state: AgentStateName, error?: string): Promise<void> {
  const run = async () => {
    const { [AGENT_KEYS.state]: prev } = (await chrome.storage.local.get(AGENT_KEYS.state)) as { agentState?: AgentState };
    if (prev?.state === state && prev.error === error) return;
    const next: AgentState = { state, since: Date.now(), ...(error ? { error } : {}) };
    await chrome.storage.local.set({ [AGENT_KEYS.state]: next });
  };
  const p = stateChain.then(run, run);
  stateChain = p.catch(() => undefined);
  return p;
}

function onAgentEvent(ev: AgentEvent) {
  if (ev === "pong") {
    lastPong = Date.now();
    return;
  }
  statsChain = statsChain.then(async () => {
    const { [AGENT_KEYS.stats]: prev } = (await chrome.storage.local.get(AGENT_KEYS.stats)) as { agentStats?: AgentStats };
    const s: AgentStats = { connects: 0, requests: 0, ...prev };
    const now = Date.now();
    if (ev === "connect") {
      s.connects++;
      s.lastConnect = lastPong = now;
    } else if (ev === "close") s.lastClose = now;
    else {
      s.requests++;
      s.lastRequest = now;
    }
    if (lastPong) s.lastPong = lastPong;
    await chrome.storage.local.set({ [AGENT_KEYS.stats]: s });
  }).catch(() => undefined);
}

/**
 * Connects to the relay unless the student switched the AI connection off or the relay rejected
 * this extension. Idempotent: called on startup, install, every worker wake and by the alarm.
 */
export async function startAgent(): Promise<void> {
  const got = await chrome.storage.local.get([AGENT_KEYS.enabled, AGENT_KEYS.state]);
  if (!aiConnectionEnabled(got[AGENT_KEYS.enabled])) return stopAgent();
  if ((got[AGENT_KEYS.state] as AgentState | undefined)?.state === "rejected") return;

  const [identity, { ws }] = await Promise.all([getIdentity(), relayBasesNow()]);
  token = identity.token;
  const url = `${ws}/agent/${identity.id}`;
  // The id is in the key, so "Cambiar enlace" (new id) gives a new connection.
  const key = connectionKey(ws, identity);
  if (conn && connKey === key) {
    if (!conn.active) conn.start();
    return;
  }
  conn?.stop();
  connKey = key;
  conn = new AgentConnection({
    url,
    secret: identity.secret,
    token: () => token,
    version: chrome.runtime.getManifest().version,
    handler: mcpHandler(idbStore, chrome.runtime.getManifest().version),
    onState: (state, error) => void writeState(state, error).catch(() => undefined),
    onEvent: onAgentEvent,
  });
  conn.start();
}

export async function stopAgent(): Promise<void> {
  conn?.stop();
  conn = null;
  connKey = "";
  await writeState("off");
}

/** After "Cambiar enlace": drop the old id's socket and connect with the new one (if switched on). */
async function reconnectForNewLink(): Promise<void> {
  const got = await chrome.storage.local.get([AGENT_KEYS.enabled, AGENT_KEYS.state]);
  if (!aiConnectionEnabled(got[AGENT_KEYS.enabled])) return;
  // A fresh Durable Object accepts our secret, so a "rejected" state is worth retrying now.
  if ((got[AGENT_KEYS.state] as AgentState | undefined)?.state === "rejected") await writeState("connecting");
  await startAgent();
}

/** Registers listeners and the keepalive alarm, and connects. Call once from background.ts. */
export function initAgent(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    let newId = false;
    if (AGENT_KEYS.identity in changes) {
      const { oldValue: prev, newValue: next } = changes[AGENT_KEYS.identity]!;
      if (isValidIdentity(next)) {
        setCachedIdentity(next);
        token = next.token; // a new token applies to the next request
        newId = idChanged(prev, next);
      }
    }
    if (AGENT_KEYS.enabled in changes) {
      if (aiConnectionEnabled(changes[AGENT_KEYS.enabled]!.newValue)) {
        // Switching it back on is also how a "rejected" state is retried.
        void writeState("connecting").then(startAgent);
      } else void stopAgent();
    } else if (newId) {
      // "Cambiar enlace": reconnect to the new id (startAgent's key includes it).
      void reconnectForNewLink().catch((err: unknown) => console.warn("[uniovi] agent restart", err));
    } else if (AGENT_KEYS.devRelayUrl in changes) void startAgent();
  });
  chrome.alarms.onAlarm.addListener((alarm) => {
    if (alarm.name === KEEPALIVE_ALARM) void startAgent();
  });
  void (async () => {
    // A worker killed while connected left a stale "connected"; startAgent rewrites it.
    if (!(await chrome.alarms.get(KEEPALIVE_ALARM))) await chrome.alarms.create(KEEPALIVE_ALARM, { periodInMinutes: 1 });
    await startAgent();
  })().catch((err: unknown) => console.warn("[uniovi] agent start", err));
}
