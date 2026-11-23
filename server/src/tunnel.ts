import { tmpdir } from "node:os";
import { join } from "node:path";
import { TUNNEL_PROVIDERS, type TunnelProviderName, type TunnelStatus } from "../../shared/helper.ts";
import { cloudflaredProvider } from "./tunnel/cloudflared.ts";
import type { ProviderEvent, ProviderSession, TunnelProvider } from "./tunnel/provider.ts";
import { localhostRunProvider, pinggyProvider } from "./tunnel/ssh.ts";
import { tunnelmoleProvider } from "./tunnel/tunnelmole.ts";

// Public tunnel to the remote MCP endpoint, so web AIs can reach this PC. No account anywhere.
// Providers are tried in TUNNEL_PROVIDERS order; one that is not ready within readyTimeoutMs
// falls through to the next. When every provider failed the state is "error" and the round is
// retried with backoff. When a ready tunnel drops, a new round starts from the first provider
// (the network may have changed). The public URL can change on every (re)connect.

export { BLOCKED_HINT, parseTunnelUrl, tunnelLogParser, type TunnelEvent } from "./tunnel/cloudflared.ts";
export type { ProviderEvent, ProviderSession, TunnelProvider } from "./tunnel/provider.ts";

export interface TunnelOptions {
  /** Fires on every status change: connecting (incl. after a drop), ready (incl. a new URL), error. */
  onStatus?: (status: TunnelStatus) => void;
  /** Defaults to defaultProviders(): one per TUNNEL_PROVIDERS entry. Tests inject fakes. */
  providers?: TunnelProvider[];
  /** A provider that isn't ready this long after starting is abandoned for the next one. */
  readyTimeoutMs?: number;
  /** Wait after a round where every provider failed; doubles up to maxRetryDelayMs. */
  retryDelayMs?: number;
  maxRetryDelayMs?: number;
  /** Wait before reconnecting after a ready tunnel dropped. */
  dropDelayMs?: number;
  /** Folder for ssh's known_hosts and helper files. */
  stateDir?: string;
  log?: (line: string) => void;
}

export interface Tunnel {
  stop(): void;
  status(): TunnelStatus;
}

/**
 * One provider per TUNNEL_PROVIDERS entry. Dev/test overrides: UNIOVI_TUNNEL_PROVIDERS (comma list,
 * e.g. "pinggy" or "tunnelmole,localhost.run") picks and orders them; UNIOVI_TUNNELMOLE_ENDPOINT
 * points tunnelmole elsewhere (an unreachable one demonstrates the fallback).
 */
export function defaultProviders(opts: { stateDir?: string; env?: NodeJS.ProcessEnv } = {}): TunnelProvider[] {
  const env = opts.env ?? process.env;
  const stateDir = opts.stateDir ?? join(tmpdir(), "uniovi-virtual-tunnel");
  const make: Record<TunnelProviderName, () => TunnelProvider> = {
    "localhost.run": () => localhostRunProvider({ stateDir, env }),
    tunnelmole: () => tunnelmoleProvider(env.UNIOVI_TUNNELMOLE_ENDPOINT || undefined),
    pinggy: () => pinggyProvider({ stateDir, env }),
    cloudflared: () => cloudflaredProvider(env),
  };
  const wanted = env.UNIOVI_TUNNEL_PROVIDERS?.split(",").map((s) => s.trim()) ?? [];
  const names = wanted.length ? wanted.filter((n): n is TunnelProviderName => (TUNNEL_PROVIDERS as readonly string[]).includes(n)) : TUNNEL_PROVIDERS;
  return names.map((name) => make[name]());
}

export function startTunnel(localUrl: string, opts: TunnelOptions = {}): Tunnel {
  const providers = opts.providers ?? defaultProviders(opts);
  const readyTimeoutMs = opts.readyTimeoutMs ?? 25_000;
  const baseRetry = opts.retryDelayMs ?? 10_000;
  const maxRetry = opts.maxRetryDelayMs ?? 120_000;
  const dropDelayMs = opts.dropDelayMs ?? 2_000;
  const log = opts.log ?? ((line: string) => console.error(line));

  let status: TunnelStatus = { state: "off", since: nowSeconds() };
  let stopped = false;
  let generation = 0; // bumps whenever the current session is abandoned; stale events are ignored
  let session: ProviderSession | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let retryDelay = baseRetry;
  let roundErrors: string[] = [];

  const setStatus = (next: Omit<TunnelStatus, "since">) => {
    const same = next.state === status.state && next.provider === status.provider && next.url === status.url && next.error === status.error;
    if (same) return;
    status = { ...next, since: nowSeconds() };
    opts.onStatus?.(status);
  };

  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  const schedule = (ms: number, fn: () => void) => {
    clearTimer();
    timer = setTimeout(() => {
      timer = null;
      fn();
    }, ms);
  };

  const endSession = () => {
    generation++;
    clearTimer();
    const s = session;
    session = null;
    s?.stop();
  };

  const attempt = (i: number) => {
    if (stopped) return;
    if (i === 0) roundErrors = [];
    if (i >= providers.length) {
      const error = roundErrors.length ? roundErrors.join(" | ") : "no tunnel provider available";
      log(`[tunnel] no provider connected (${error}); retrying in ${Math.round(retryDelay / 1000)}s`);
      setStatus({ state: "error", error });
      schedule(retryDelay, () => attempt(0));
      retryDelay = Math.min(retryDelay * 2, maxRetry);
      return;
    }
    const p = providers[i]!;
    let available = true;
    try {
      available = p.available?.() ?? true;
    } catch {
      available = false;
    }
    if (!available) return attempt(i + 1);

    const gen = ++generation;
    let ready = false;
    let lastError: string | undefined;
    const seen = new Set<string>();
    setStatus({ state: "connecting", provider: p.name, error: status.error });
    log(`[tunnel] trying ${p.name}...`);

    const fail = (reason: string) => {
      endSession();
      const why = lastError && !reason.includes(lastError) ? `${reason}; ${lastError}` : reason;
      log(`[tunnel] ${p.name} failed: ${why}`);
      roundErrors.push(`${p.name}: ${why}`);
      attempt(i + 1);
    };

    const onEvent = (ev: ProviderEvent) => {
      if (stopped || gen !== generation) return;
      if (ev.type === "url") {
        log(`[tunnel] ${p.name} got ${ev.url}, waiting for it to connect...`);
      } else if (ev.type === "ready") {
        clearTimer();
        ready = true;
        retryDelay = baseRetry;
        if (ev.url !== status.url) log(`[tunnel] ${p.name} ready: ${ev.url}`);
        setStatus({ state: "ready", provider: p.name, url: ev.url });
      } else if (ev.type === "error") {
        lastError = ev.message;
        if (seen.has(ev.message) || seen.size >= 20) return;
        seen.add(ev.message);
        log(`[tunnel] ${p.name}: ${ev.message}`);
      } else if (!ready) {
        fail(ev.reason);
      } else {
        endSession();
        log(`[tunnel] ${p.name} dropped (${ev.reason}); reconnecting`);
        setStatus({ state: "connecting", provider: p.name, error: `${p.name} dropped: ${ev.reason}` });
        schedule(dropDelayMs, () => attempt(0));
      }
    };

    schedule(readyTimeoutMs, () => {
      if (p.timeoutHint) log(`[tunnel] ${p.timeoutHint}`);
      fail(`not ready after ${readyTimeoutMs / 1000}s`);
    });
    let started: ProviderSession;
    try {
      started = p.start(localUrl, onEvent);
    } catch (err) {
      if (gen === generation) fail(err instanceof Error ? err.message : String(err));
      return;
    }
    // The provider may have failed synchronously inside start(); then this session is already stale.
    if (gen === generation && !stopped) session = started;
    else started.stop();
  };

  attempt(0);

  return {
    stop() {
      if (stopped) return;
      stopped = true;
      endSession();
      setStatus({ state: "off" });
    },
    status: () => status,
  };
}

function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}
