import { connectorUrl as relayConnectorUrl, RELAY_URL } from "../../../shared/relay.ts";
import { idbStore } from "../store/idb.ts";
import { AgentConnection } from "./connection.ts";
import { mcpHandler } from "./mcp.ts";
import { isValidIdentity, newIdentity, newToken, type AgentIdentity } from "./protocol.ts";
import { AGENT_KEYS, aiConnectionEnabled, relayBases, type AgentState, type AgentStateName, type AgentStats } from "./state.ts";

// Chrome glue for the agent. connectorUrl() / rotateToken() work from any extension context (popup,
// welcome page); startAgent() and the listeners run in the background service worker only.

const KEEPALIVE_ALARM = "agent-keepalive";

let identityPromise: Promise<AgentIdentity> | null = null;

/** The extension's relay identity, created on first use and kept in chrome.storage.local `agent`. */
export function getIdentity(): Promise<AgentIdentity> {
  identityPromise ??= (async () => {
    const { [AGENT_KEYS.identity]: stored } = await chrome.storage.local.get(AGENT_KEYS.identity);
    if (isValidIdentity(stored)) return stored;
    const fresh = newIdentity();
    await chrome.storage.local.set({ [AGENT_KEYS.identity]: fresh });
    return fresh;
  })().catch((err: unknown) => {
    identityPromise = null;
    throw err;
  });
  return identityPromise;
}

async function bases() {
  const { [AGENT_KEYS.devRelayUrl]: dev } = await chrome.storage.local.get(AGENT_KEYS.devRelayUrl);
  return relayBases(dev, RELAY_URL);
}

/** The URL the student pastes into their AI: `${RELAY_URL}/mcp/<id>/<token>`. Grants read access. */
export async function connectorUrl(): Promise<string> {
  const [{ id, token }, { http }] = await Promise.all([getIdentity(), bases()]);
  return relayConnectorUrl(id, token, http);
}

/** "Cambiar enlace": a new token (the old URL stops working at once); id and secret stay. */
export async function rotateToken(): Promise<string> {
  const current = await getIdentity();
  const next = { ...current, token: newToken() };
  await chrome.storage.local.set({ [AGENT_KEYS.identity]: next });
  identityPromise = Promise.resolve(next);
  return connectorUrl();
}

// ---------------------------------------------------------------- background only

let conn: AgentConnection | null = null;
let connKey = "";
let token = "";
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

function bumpStats(ev: "connect" | "pong" | "close" | "request") {
  statsChain = statsChain.then(async () => {
    const { [AGENT_KEYS.stats]: prev } = (await chrome.storage.local.get(AGENT_KEYS.stats)) as { agentStats?: AgentStats };
    const s: AgentStats = { connects: 0, requests: 0, ...prev };
    const now = Date.now();
    if (ev === "connect") {
      s.connects++;
      s.lastConnect = s.lastPong = now;
    } else if (ev === "pong") s.lastPong = now;
    else if (ev === "close") s.lastClose = now;
    else {
      s.requests++;
      s.lastRequest = now;
    }
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

  const [identity, { ws }] = await Promise.all([getIdentity(), bases()]);
  token = identity.token;
  const url = `${ws}/agent/${identity.id}`;
  const key = `${url}|${identity.secret}`;
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
    onEvent: bumpStats,
  });
  conn.start();
}

export async function stopAgent(): Promise<void> {
  conn?.stop();
  conn = null;
  connKey = "";
  await writeState("off");
}

/** Registers listeners and the keepalive alarm, and connects. Call once from background.ts. */
export function initAgent(): void {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (AGENT_KEYS.identity in changes) {
      const next = changes[AGENT_KEYS.identity]!.newValue;
      if (isValidIdentity(next)) {
        identityPromise = Promise.resolve(next);
        token = next.token; // a rotated token applies to the next request
      }
    }
    if (AGENT_KEYS.enabled in changes) {
      if (aiConnectionEnabled(changes[AGENT_KEYS.enabled]!.newValue)) {
        // Switching it back on is also how a "rejected" state is retried.
        void writeState("connecting").then(startAgent);
      } else void stopAgent();
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
