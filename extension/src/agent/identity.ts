import { connectorUrl as relayConnectorUrl, RELAY_URL } from "../../../shared/relay.ts";
import { isValidIdentity, newIdentity, rotatedIdentity, type AgentIdentity } from "./protocol.ts";
import { AGENT_KEYS, relayBases } from "./state.ts";

// The extension's relay identity and connector URL, for any extension context (side panel, welcome page,
// background). Kept apart from agent/index.ts so the pages don't bundle the connection, the MCP
// server and its SDK: this file imports only shared/relay.ts, protocol.ts and state.ts.

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

/** Replaces this context's cached identity (the background does it when storage changes). */
export function setCachedIdentity(identity: AgentIdentity): void {
  identityPromise = Promise.resolve(identity);
}

export async function relayBasesNow() {
  const { [AGENT_KEYS.devRelayUrl]: dev } = await chrome.storage.local.get(AGENT_KEYS.devRelayUrl);
  return relayBases(dev, RELAY_URL);
}

/** The URL the student pastes into their AI: `${RELAY_URL}/mcp/<id>/<token>`. Grants read access. */
export async function connectorUrl(): Promise<string> {
  const [{ id, token }, { http }] = await Promise.all([getIdentity(), relayBasesNow()]);
  return relayConnectorUrl(id, token, http);
}

/**
 * "Cambiar enlace": a new id and a new token, so the old URL reaches a Durable Object nobody answers
 * any more (503) and its holder can't even tell when Chrome is open. The secret stays; the new
 * Durable Object binds it on the first hello. The background worker sees the change in storage and
 * reconnects to the new id (agent/index.ts initAgent), which also retries a "rejected" state.
 */
export async function changeLink(): Promise<string> {
  const next = rotatedIdentity(await getIdentity());
  await chrome.storage.local.set({ [AGENT_KEYS.identity]: next });
  identityPromise = Promise.resolve(next);
  return connectorUrl();
}
