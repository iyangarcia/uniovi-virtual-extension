import { spawn, type ChildProcess } from "node:child_process";

// Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:PORT` needs no account and
// prints a random https://<words>.trycloudflare.com URL on stderr. The URL changes on every start.
// api.trycloudflare.com is the endpoint cloudflared asks for a tunnel; it shows up in the
// "failed to request quick Tunnel" error and must never be taken for the tunnel URL.

const URL_RE = /https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(output: string): string | null {
  return URL_RE.exec(output)?.[0] ?? null;
}

// cloudflared prints the quick-tunnel URL as soon as it is assigned, before any edge connection
// exists. On networks that block outbound port 7844 (TCP and/or QUIC) it never connects, and the
// URL only ever answers Cloudflare error 1033. So the URL is announced only once cloudflared logs
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

export const BLOCKED_HINT = `[tunnel] cloudflared has not connected to Cloudflare yet. If this persists, this network probably
  blocks outbound port 7844 (TCP and UDP/QUIC), common on campus/corporate Wi-Fi. Try another network
  (e.g. a phone hotspot). The connector URL is published only once the tunnel is reachable.`;

export const INSTALL_HINT = `cloudflared is not installed (it lets ChatGPT / Gemini / claude.ai reach this PC).
  Windows:  winget install --id Cloudflare.cloudflared   (then open a new terminal)
  macOS:    brew install cloudflared
  Linux:    https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/
Or set CLOUDFLARED to the full path of the cloudflared executable.`;

export interface Tunnel {
  stop(): void;
}

/**
 * Starts cloudflared and keeps it running (restarts with backoff when it exits).
 * `onUrl` fires with each new public URL, `onDown` when the tunnel process dies.
 */
export function startTunnel(localUrl: string, onUrl: (url: string) => void, onDown: () => void = () => {}): Tunnel {
  const bin = process.env.CLOUDFLARED || "cloudflared";
  let child: ChildProcess | null = null;
  let stopped = false;
  let delay = 2000;

  const run = () => {
    if (stopped) return;
    const started = Date.now();
    let missing = false;
    child = spawn(bin, ["tunnel", "--no-autoupdate", "--url", localUrl], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const parse = tunnelLogParser();
    const seenErrors = new Set<string>();
    let connected = false;
    const slow = setTimeout(() => {
      if (!connected && !stopped) console.error(BLOCKED_HINT);
    }, 45_000);
    const scan = (chunk: Buffer) => {
      for (const ev of parse(chunk.toString("utf8"))) {
        if (ev.type === "url") console.error(`[tunnel] got ${ev.url}, waiting for cloudflared to connect...`);
        else if (ev.type === "ready") {
          connected = true;
          clearTimeout(slow);
          onUrl(ev.url);
        } else {
          // One line per kind of error: the same failure repeats for every edge IP it retries.
          const kind = ev.message.replace(/\d{1,3}(\.\d{1,3}){3}(:\d+)?/g, "<ip>");
          if (seenErrors.has(kind) || seenErrors.size >= 20) continue;
          seenErrors.add(kind);
          console.error(`[tunnel] cloudflared: ${ev.message}`);
        }
      }
    };
    child.stdout?.on("data", scan);
    child.stderr?.on("data", scan);
    child.on("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "ENOENT") {
        missing = true;
        console.error(INSTALL_HINT);
      } else {
        console.error("[tunnel]", err.message);
      }
    });
    child.on("exit", (code) => {
      clearTimeout(slow);
      child = null;
      if (stopped || missing) return;
      onDown();
      if (Date.now() - started > 60_000) delay = 2000;
      console.error(`[tunnel] cloudflared exited (${code}); restarting in ${delay / 1000}s`);
      setTimeout(run, delay);
      delay = Math.min(delay * 2, 60_000);
    });
  };
  run();

  return {
    stop() {
      stopped = true;
      child?.kill();
    },
  };
}
