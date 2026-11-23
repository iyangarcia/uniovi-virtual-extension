import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { dirname, join } from "node:path";
import type { TunnelStatus } from "../../shared/helper.ts";
import { appDir, loadConfig, logDir, pidFile } from "./config.ts";
import { warmTextCache } from "./extract.ts";
import { startHttp } from "./http.ts";
import { openFileLog, redirectConsole } from "./log.ts";
import { REMOTE_PORT, remoteToken, startRemote } from "./remote.ts";
import { dataDir, loadIndex, pidAlive, saveRemoteState } from "./store.ts";
import { startTunnel } from "./tunnel.ts";
import { VERSION } from "./version.ts";

// `--service`: what the installed helper runs (hidden, started at logon or by the native host).
// Ingest bridge + remote MCP + tunnel, logs to a rotating file, one instance per user.
//
// Single instance: helper.pid in the app dir holds the running helper's pid. A second start exits
// 0 when that pid is alive AND the remote port answers (a pid alone isn't enough: after a reboot
// a stale pid file can name an unrelated process that reused the number). If the remote port is
// taken by anything else, the second start exits 0 too.

// ---------------------------------------------------------------- tunnel
// tunnel.ts tries the providers in TUNNEL_PROVIDERS order and reports every change as a TunnelStatus.
// ssh known_hosts and askpass live in the app dir instead of %TEMP%.

export interface ServiceTunnel {
  stop(): void;
  status(): TunnelStatus;
}

export function startServiceTunnel(localUrl: string, onStatus: (s: TunnelStatus) => void): ServiceTunnel {
  return startTunnel(localUrl, { onStatus, stateDir: join(appDir(), "tunnel") });
}

// ---------------------------------------------------------------- single instance

/** pid recorded in helper.pid, if any. */
export function readPid(file = pidFile()): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** True when something accepts TCP connections on 127.0.0.1:port. */
export function portAnswers(port: number, timeoutMs = 1500): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** pid of another helper that is really running (pid alive and its remote port answering). */
export async function runningHelperPid(file = pidFile(), port = REMOTE_PORT): Promise<number | undefined> {
  const pid = readPid(file);
  if (!pid || pid === process.pid || !pidAlive(pid)) return undefined;
  return (await portAnswers(port)) ? pid : undefined;
}

export function writePidFile(file = pidFile()): void {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, String(process.pid));
}

/** Removes helper.pid only if it still names this process. */
export function removePidFile(file = pidFile()): void {
  if (readPid(file) === process.pid) rmSync(file, { force: true });
}

// ---------------------------------------------------------------- service

const nowUnix = () => Math.floor(Date.now() / 1000);

export async function runService(): Promise<void> {
  const log = openFileLog(logDir());
  // Hidden under the installer's node.exe there is no console; mirror only for dev runs in a terminal.
  redirectConsole(log, Boolean(process.stderr.isTTY));
  const config = loadConfig();
  console.error(`[service] Uniovi Virtual helper ${VERSION} starting (pid ${process.pid}), data in ${dataDir}, tunnel ${config.tunnel ? "on" : "off"}`);

  const other = await runningHelperPid();
  if (other) {
    console.error(`[service] another helper is already running (pid ${other}); exiting`);
    log.close();
    process.exit(0);
  }
  writePidFile();
  process.on("exit", () => removePidFile());

  const http = await startHttp();
  if (!http) console.error("[service] bridge port taken by another process; it serves ingest (same data files)");

  const token = await remoteToken();
  if (!(await startRemote(token))) {
    console.error(`[service] remote port ${REMOTE_PORT} in use (another helper or --remote run); exiting`);
    http?.close();
    removePidFile();
    process.exit(0);
  }
  console.error(`[service] MCP endpoint on http://127.0.0.1:${REMOTE_PORT}/mcp/<token>`);
  // Web clients give up on a tool call after ~60 s; extracting a cold corpus takes longer, so index now.
  void loadIndex().then((index) => warmTextCache(Object.values(index)));

  const publish = (tunnel: TunnelStatus) => {
    const publicUrl = tunnel.state === "ready" && tunnel.url ? `${tunnel.url}/mcp/${token}` : undefined;
    return saveRemoteState({ token, publicUrl, pid: process.pid, tunnel }).catch((err: Error) =>
      console.error("[service] could not write remote.json:", err.message),
    );
  };

  let tunnel: ServiceTunnel | undefined;
  if (config.tunnel) {
    let last = "";
    tunnel = startServiceTunnel(`http://127.0.0.1:${REMOTE_PORT}`, (s) => {
      // Log the base URL only: the full connector URL carries the secret token.
      const line = `[service] tunnel ${s.state}${s.provider ? ` via ${s.provider}` : ""}${s.url ? ` at ${s.url}` : ""}${s.error ? `: ${s.error}` : ""}`;
      if (line !== last) console.error((last = line));
      void publish(s);
    });
  } else {
    await publish({ state: "off", since: nowUnix() });
  }

  let stopping = false;
  const shutdown = (signal: string) => {
    if (stopping) return;
    stopping = true;
    console.error(`[service] ${signal}: stopping`);
    tunnel?.stop();
    void saveRemoteState({ token })
      .catch(() => undefined)
      .finally(() => {
        removePidFile();
        log.close();
        process.exit(0);
      });
  };
  process.on("SIGINT", () => shutdown("SIGINT"));
  process.on("SIGTERM", () => shutdown("SIGTERM"));
  process.on("SIGHUP", () => shutdown("SIGHUP"));
  process.on("SIGBREAK", () => shutdown("SIGBREAK"));
}
