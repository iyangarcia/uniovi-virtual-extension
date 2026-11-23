import { spawn, type ChildProcess } from "node:child_process";

// Cloudflare quick tunnel: `cloudflared tunnel --url http://127.0.0.1:PORT` needs no account and
// prints a random https://<words>.trycloudflare.com URL on stderr. The URL changes on every start.

const URL_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;

export function parseTunnelUrl(output: string): string | null {
  return URL_RE.exec(output)?.[0] ?? null;
}

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
    let announced = false;
    let buffer = "";
    const scan = (chunk: Buffer) => {
      if (announced) return;
      buffer = (buffer + chunk.toString("utf8")).slice(-8192);
      const url = parseTunnelUrl(buffer);
      if (url) {
        announced = true;
        onUrl(url);
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
