import { NATIVE_HOST_NAME, type NativeReply, type NativeRequest, type NativeStatus } from "../../shared/helper.ts";
import { isHostNotFound, type NativeProbe } from "./helperState.ts";

// Native Messaging: control of the helper only (status/start/stop/config). Data goes over the HTTP bridge.

export class HostNotInstalled extends Error {}

/** One request to the `es.uniovi.virtual` host. Throws HostNotInstalled when it isn't registered. */
export function sendNative(request: NativeRequest): Promise<NativeStatus> {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendNativeMessage(NATIVE_HOST_NAME, request, (reply: NativeReply | undefined) => {
      const lastError = chrome.runtime.lastError?.message;
      if (lastError) return reject(isHostNotFound(lastError) ? new HostNotInstalled(lastError) : new Error(lastError));
      if (!reply) return reject(new Error("El asistente no respondió"));
      if (!reply.ok) return reject(new Error(reply.error));
      resolve(reply.status);
    });
  });
}

export async function probeNative(): Promise<NativeProbe> {
  try {
    return { kind: "ok", status: await sendNative({ type: "status" }) };
  } catch (err) {
    if (err instanceof HostNotInstalled) return { kind: "not-installed" };
    return { kind: "error", error: err instanceof Error ? err.message : String(err) };
  }
}
