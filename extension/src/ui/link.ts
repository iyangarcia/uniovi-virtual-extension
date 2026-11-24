import { connectorUrl as relayConnectorUrl, RELAY_URL } from "../../../shared/relay.ts";
import { connectorUrl } from "../agent/identity.ts";
import { isValidIdentity } from "../agent/protocol.ts";
import { AGENT_KEYS, relayBases } from "../agent/state.ts";

/**
 * The connector URL as stored right now. agent/identity.ts caches the identity per page, so a page
 * that stays open (the welcome page) would keep showing the old link after "Cambiar enlace" in the
 * popup; this reads chrome.storage every time and only falls back to connectorUrl() (which creates
 * the identity) on a first run.
 */
export async function currentLink(): Promise<string> {
  const got = await chrome.storage.local.get([AGENT_KEYS.identity, AGENT_KEYS.devRelayUrl]);
  const identity = got[AGENT_KEYS.identity];
  if (!isValidIdentity(identity)) return connectorUrl();
  return relayConnectorUrl(identity.id, identity.token, relayBases(got[AGENT_KEYS.devRelayUrl], RELAY_URL).http);
}
