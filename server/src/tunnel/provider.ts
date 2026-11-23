import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";
import type { TunnelProviderName } from "../../../shared/helper.ts";

// What every tunnel provider reports to the orchestrator in tunnel.ts:
//   url    a public URL is known but not reachable yet (cloudflared before its edge connection)
//   ready  the URL answers; may fire again with a NEW url (localhost.run rotates free domains)
//   error  a log-worthy problem, not fatal by itself
//   down   the tunnel is gone (process exited, socket closed); the orchestrator decides what next
export type ProviderEvent =
  | { type: "url"; url: string }
  | { type: "ready"; url: string }
  | { type: "error"; message: string }
  | { type: "down"; reason: string };

export interface ProviderSession {
  stop(): void;
}

export interface TunnelProvider {
  name: TunnelProviderName;
  /** False = skip this provider (e.g. its executable is not installed). Absent = always available. */
  available?(): boolean;
  start(localUrl: string, emit: (ev: ProviderEvent) => void): ProviderSession;
  /** Extra hint logged when the provider does not become ready in time. */
  timeoutHint?: string;
}

/** Splits a byte stream into lines (CRLF or LF), keeping a partial line between chunks. */
export function lineSplitter(onLine: (line: string) => void) {
  let partial = "";
  return (chunk: Buffer | string) => {
    const lines = (partial + chunk.toString()).split(/\r?\n/);
    partial = lines.pop() ?? "";
    if (partial.length > 65536) partial = partial.slice(-65536);
    for (const line of lines) onLine(line);
  };
}

/** Finds an executable on PATH (Windows: also tries PATHEXT), or checks an absolute path. */
export function findExecutable(name: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const exts = process.platform === "win32" ? ["", ...(env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").map((e) => e.toLowerCase())] : [""];
  const candidates = isAbsolute(name) ? [name] : (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean).map((dir) => join(dir, name));
  for (const base of candidates) for (const ext of exts) if (existsSync(base + ext)) return base + ext;
  return null;
}

/**
 * Runs a tunnel client process and turns its output into provider events via `parse`.
 * Exit (or a spawn failure) becomes `down`, with the last stderr line as the reason.
 */
export function runProcess(
  bin: string,
  args: string[],
  emit: (ev: ProviderEvent) => void,
  parse: (line: string) => ProviderEvent[],
  env: NodeJS.ProcessEnv = process.env,
): ProviderSession {
  let child: ChildProcess | null = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, env });
  // The last stderr line explains an exit ("Connection timed out", "Permission denied"). It ends up
  // in the status the popup shows, so IP addresses are masked and it is kept short.
  let lastLine = "";
  const onLine = (line: string) => {
    for (const ev of parse(line)) emit(ev);
  };
  const onErrLine = (line: string) => {
    const text = line.replace(/\b\d{1,3}(\.\d{1,3}){3}(:\d+)?\b/g, "<ip>").replace(/[*=]{3,}/g, "").trim();
    if (text) lastLine = text.slice(0, 200);
    onLine(line);
  };
  child.stdout?.on("data", lineSplitter(onLine));
  child.stderr?.on("data", lineSplitter(onErrLine));
  let failed = false;
  child.on("error", (err: NodeJS.ErrnoException) => {
    failed = true;
    child = null;
    emit({ type: "down", reason: err.code === "ENOENT" ? `${bin} not found` : err.message });
  });
  child.on("exit", (code) => {
    child = null;
    // Windows reports a killed process as 4294967295 (-1 as unsigned).
    const shown = code === null ? "signal" : code > 0x7fffffff ? code - 0x100000000 : code;
    if (!failed) emit({ type: "down", reason: `exited (${shown})${lastLine ? `: ${lastLine}` : ""}` });
  });
  return {
    stop() {
      child?.kill();
      child = null;
    },
  };
}
