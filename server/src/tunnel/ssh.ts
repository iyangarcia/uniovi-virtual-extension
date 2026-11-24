import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findExecutable, runProcess, type ProviderEvent, type TunnelProvider } from "./provider.ts";

// Tunnels over plain SSH remote forwarding, using Windows' built-in OpenSSH client (no install,
// no account). Both services hand out a random https URL and print it on the session's stdout.
//   localhost.run  ssh -p 22 (it refuses 80/443)   URL: <id>.lhr.life, rotates now and then
//   pinggy         ssh -p 443 (passes campus Wi-Fi) URL: <id>-<public ip>.<free domain>, session ends after 60 min
// Host keys are trusted on first use into our own known_hosts (never the user's ~/.ssh), the
// user's ssh config is ignored, and no key or agent is ever offered or forwarded (see baseArgs).

export interface SshOptions {
  /** Folder for known_hosts and the empty-password askpass helper. */
  stateDir?: string;
  env?: NodeJS.ProcessEnv;
}

/** UNIOVI_SSH, else Windows' built-in OpenSSH, else ssh on PATH; null if there is none. */
export function sshPath(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.UNIOVI_SSH) return findExecutable(env.UNIOVI_SSH, env);
  if (process.platform === "win32") {
    const builtIn = join(env.SystemRoot ?? env.windir ?? "C:\\Windows", "System32", "OpenSSH", "ssh.exe");
    if (existsSync(builtIn)) return builtIn;
  }
  return findExecutable("ssh", env);
}

const quote = (v: string) => (/\s/.test(v) ? `"${v}"` : v);

/**
 * Options shared by every tunnel session. `-F none` ignores the user's ~/.ssh/config and the system
 * ssh_config: a `ForwardAgent yes`, ProxyCommand, LocalCommand or ControlMaster there must never
 * apply to a session with a third-party tunnel server. No agent, no X11, no identities either.
 */
export function baseArgs(stateDir: string, port: number): string[] {
  mkdirSync(stateDir, { recursive: true });
  return [
    "-F", "none",
    "-T",
    "-a",
    "-x",
    "-p", String(port),
    "-o", "StrictHostKeyChecking=accept-new",
    "-o", `UserKnownHostsFile=${quote(join(stateDir, "known_hosts"))}`,
    "-o", "PubkeyAuthentication=no",
    "-o", "IdentityAgent=none",
    "-o", "IdentitiesOnly=yes",
    "-o", "ControlMaster=no",
    "-o", "PermitLocalCommand=no",
    "-o", "ConnectTimeout=15",
    "-o", "ServerAliveInterval=20",
    "-o", "ServerAliveCountMax=3",
    "-o", "ExitOnForwardFailure=yes",
  ];
}

function forwardTarget(localUrl: string): string {
  const u = new URL(localUrl);
  return `${u.hostname}:${u.port || (u.protocol === "https:" ? 443 : 80)}`;
}

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i;

// ---- localhost.run --------------------------------------------------------------------------

/**
 * Parses localhost.run output. With `-- --output json` every event is one JSON line;
 * `run.localhost.tunnel.registered` carries the hostname in data.address (again after a rotation).
 * The plain-text form "<host> tunneled with tls termination, https://<host>" is accepted too.
 */
export function localhostRunParser() {
  let current: string | null = null;
  return (line: string): ProviderEvent[] => {
    let host: string | null = null;
    const trimmed = line.trim();
    if (trimmed.startsWith("{")) {
      try {
        const ev = JSON.parse(trimmed) as { type?: string; data?: { address?: unknown } };
        if (ev.type === "run.localhost.tunnel.registered" && typeof ev.data?.address === "string") host = ev.data.address;
      } catch {
        // not JSON after all
      }
    } else {
      host = /tunneled with tls termination, https:\/\/([^\s/]+)/.exec(trimmed)?.[1] ?? null;
    }
    if (!host || !HOST_RE.test(host)) return [];
    const url = `https://${host.toLowerCase()}`;
    if (url === current) return [];
    current = url;
    return [{ type: "ready", url }];
  };
}

export function localhostRunProvider(opts: SshOptions = {}): TunnelProvider {
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? join(tmpdir(), "uniovi-virtual-tunnel");
  return {
    name: "localhost.run",
    timeoutHint: "localhost.run uses SSH on port 22, which some networks block.",
    available: () => sshPath(env) !== null,
    start(localUrl, emit) {
      const args = [...baseArgs(stateDir, 22), "-o", "BatchMode=yes", "-R", `80:${forwardTarget(localUrl)}`, "nokey@localhost.run", "--", "--output", "json"];
      return runProcess(sshPath(env) ?? "ssh", args, emit, localhostRunParser(), env);
    },
  };
}

// ---- pinggy ---------------------------------------------------------------------------------

const PINGGY_URL_RE = /^https:\/\/([a-z0-9-]+\.)+(pinggy-free\.link|pinggy\.net|pinggy\.link|pinggy\.online)\/?$/i;

/** Pinggy prints its public URLs one per line (plus https://dashboard.pinggy.io); the first one wins. */
export function pinggyParser() {
  let url: string | null = null;
  return (line: string): ProviderEvent[] => {
    const trimmed = line.trim();
    if (url || !PINGGY_URL_RE.test(trimmed) || /^https:\/\/dashboard\./i.test(trimmed)) return [];
    url = trimmed.replace(/\/$/, "").toLowerCase();
    return [{ type: "ready", url }];
  };
}

/** Pinggy's anonymous tunnels log in with an empty password; ssh reads it from this helper. */
function askpassFile(stateDir: string): string {
  mkdirSync(stateDir, { recursive: true });
  const win = process.platform === "win32";
  const file = join(stateDir, win ? "askpass-empty.cmd" : "askpass-empty.sh");
  writeFileSync(file, win ? "@echo.\r\n" : "#!/bin/sh\necho\n", { mode: 0o755 });
  return file;
}

export function pinggyProvider(opts: SshOptions = {}): TunnelProvider {
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? join(tmpdir(), "uniovi-virtual-tunnel");
  return {
    name: "pinggy",
    timeoutHint: "pinggy uses SSH on port 443.",
    available: () => sshPath(env) !== null,
    start(localUrl, emit) {
      const args = [
        ...baseArgs(stateDir, 443),
        "-o", "PreferredAuthentications=keyboard-interactive,password",
        "-o", "NumberOfPasswordPrompts=1",
        "-R", `0:${forwardTarget(localUrl)}`,
        "nokey@a.pinggy.io",
      ];
      const childEnv = { ...env, SSH_ASKPASS: askpassFile(stateDir), SSH_ASKPASS_REQUIRE: "force", DISPLAY: env.DISPLAY ?? "uniovi:0" };
      return runProcess(sshPath(env) ?? "ssh", args, emit, pinggyParser(), childEnv);
    },
  };
}
