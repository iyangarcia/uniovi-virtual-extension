import { existsSync } from "node:fs";
import { join } from "node:path";
import { findExecutable, runProcess, type ProviderEvent, type TunnelProvider } from "./provider.ts";

// Cloudflare quick tunnel, last resort and only if installed: `cloudflared tunnel --url http://127.0.0.1:PORT`
// needs no account and prints a random https://<words>.trycloudflare.com URL on stderr.
// Its edge connection uses port 7844 (TCP/QUIC), which campus Wi-Fi blocks.
// api.trycloudflare.com is the endpoint cloudflared asks for a tunnel; it shows up in the
// "failed to request quick Tunnel" error and must never be taken for the tunnel URL.

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(output: string): string | null {
  return URL_RE.exec(output)?.[0] ?? null;
}

// cloudflared prints the quick-tunnel URL as soon as it is assigned, before any edge connection
// exists. On networks that block outbound port 7844 it never connects, and the URL only ever
// answers Cloudflare error 1033. So the URL is ready only once cloudflared logs
// "Registered tunnel connection", and its ERR lines are surfaced so the user can see why.

export type TunnelEvent = { type: "url"; url: string } | { type: "ready"; url: string } | { type: "error"; message: string };

/** Line-based parser for cloudflared's log output. Feed it raw chunks; it returns what happened. */
export function tunnelLogParser() {
  let partial = "";
  let url: string | null = null;
  let ready = false;
  return (chunk: string): TunnelEvent[] => {
    const lines = (partial + chunk).split(/\r?\n/);
    partial = lines.pop() ?? "";
    if (partial.length > 4096) partial = partial.slice(-4096);
    const events: TunnelEvent[] = [];
    for (const line of lines) {
      const found = url ? null : parseTunnelUrl(line);
      if (found) {
        url = found;
        events.push({ type: "url", url });
      }
      if (url && !ready && /Registered tunnel connection/i.test(line)) {
        ready = true;
        events.push({ type: "ready", url });
      }
      const err = /\sERR\s+(.*)$/.exec(line);
      if (err) events.push({ type: "error", message: err[1]!.replace(/\s+(connIndex|event|ip)=\S+/g, "").trim() });
    }
    return events;
  };
}

export const BLOCKED_HINT = `cloudflared has not connected to Cloudflare. This network probably blocks outbound port 7844
  (TCP and UDP/QUIC), common on campus/corporate Wi-Fi.`;

/** cloudflared from CLOUDFLARED, PATH or the default winget/MSI install folder; null if not installed. */
export function cloudflaredPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.CLOUDFLARED) return findExecutable(env.CLOUDFLARED, env);
  const onPath = findExecutable("cloudflared", env);
  if (onPath) return onPath;
  for (const dir of [env["ProgramFiles(x86)"], env.ProgramFiles]) {
    const p = dir && join(dir, "cloudflared", "cloudflared.exe");
    if (p && existsSync(p)) return p;
  }
  return null;
}

export function cloudflaredProvider(env: NodeJS.ProcessEnv = process.env): TunnelProvider {
  return {
    name: "cloudflared",
    timeoutHint: BLOCKED_HINT,
    available: () => cloudflaredPath(env) !== null,
    start(localUrl, emit) {
      const parse = tunnelLogParser();
      const seen = new Set<string>();
      return runProcess(cloudflaredPath(env) ?? "cloudflared", ["tunnel", "--no-autoupdate", "--url", localUrl], emit, (line) => {
        const out: ProviderEvent[] = [];
        for (const ev of parse(`${line}\n`)) {
          if (ev.type !== "error") out.push(ev);
          else {
            // One line per kind of error: the same failure repeats for every edge IP it retries.
            const kind = ev.message.replace(/\d{1,3}(\.\d{1,3}){3}(:\d+)?/g, "<ip>");
            if (seen.has(kind) || seen.size >= 20) continue;
            seen.add(kind);
            out.push(ev);
          }
        }
        return out;
      });
    },
  };
}
