import type { AgentState } from "../agent/state.ts";

// The one plain sentence the popup and the welcome page show about the AI connection.
// Pure: no chrome APIs, so it is unit-tested in server/test/ux.test.ts.

export type Tone = "ok" | "busy" | "off" | "error";

export interface StatusInput {
  /** chrome.storage.local `aiConnection` (absent = on). */
  enabled: boolean;
  agent?: AgentState;
  /** A campus sync has happened at least once (snapshot or syncState.lastSync). */
  synced: boolean;
}

export interface StatusView {
  tone: Tone;
  text: string;
  /** Optional second line with what to do. */
  hint?: string;
}

export function statusSentence({ enabled, agent, synced }: StatusInput): StatusView {
  if (!enabled) return { tone: "off", text: "Apagado: actívalo en el botón de la extensión", hint: "Mientras esté apagado, tu IA no puede ver tus apuntes." };
  switch (agent?.state) {
    case "connected":
      return synced
        ? { tone: "ok", text: "✓ Tu IA ya puede ver tus apuntes" }
        : { tone: "ok", text: "✓ Conectado", hint: "Abre el Campus Virtual para traer tus apuntes." };
    case "offline":
      return { tone: "error", text: "Sin conexión ahora mismo", hint: "Comprueba tu Internet. Se vuelve a intentar solo." };
    case "rejected":
      return { tone: "error", text: "No se pudo conectar", hint: "Apaga y vuelve a encender «Conectar con mi IA». Si sigue igual, pulsa «Cambiar enlace» en Opciones avanzadas." };
    default:
      // "connecting", "off" while starting up, or nothing written yet.
      return { tone: "busy", text: "Conectando…" };
  }
}

/** "hace 5 minutos" style label for the last sync. */
export function lastSyncLabel(lastSync: number | undefined, now = Date.now()): string {
  if (!lastSync) return "Aún no se han traído tus apuntes. Abre el Campus Virtual.";
  const rel = new Intl.RelativeTimeFormat("es", { numeric: "auto" });
  const s = Math.round((lastSync - now) / 1000);
  const abs = Math.abs(s);
  const when =
    abs < 60 ? "ahora mismo" : abs < 3600 ? rel.format(Math.round(s / 60), "minute") : abs < 86400 ? rel.format(Math.round(s / 3600), "hour") : rel.format(Math.round(s / 86400), "day");
  return `Última actualización: ${when}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}
