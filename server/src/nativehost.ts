import { execFileSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { basename, dirname, join, posix, resolve } from "node:path";
import { EXTENSION_ID, NATIVE_HOST_NAME, type NativeReply, type NativeRequest, type NativeStatus } from "../../shared/helper.ts";
import { effectiveDataDir, loadConfig, pidFile, saveConfig } from "./config.ts";
import { VERSION } from "./version.ts";

// Native Messaging host `es.uniovi.virtual`: lets the extension popup see and control the helper
// (status / start / stop / setDataDir / setTunnel). Data never goes through here: it still flows
// over the HTTP bridge on 127.0.0.1.
//
// Protocol (Chrome): each message is a 4-byte little-endian length + UTF-8 JSON, on stdin/stdout.
// One reply per request; exit when stdin closes. stdout is the protocol channel: log to stderr.
// Chrome passes the caller origin (and on Windows --parent-window=N) as arguments; they are ignored.
//
// The host runs with the user's rights, so every request is validated strictly before acting.
// Installed layout: <appDir>\host.cmd -> node.exe host.cjs, helper.js next to it (see config.ts).
//
// Keep this file light: Node built-ins + config.ts only (no MCP SDK, no unpdf). It is bundled to
// a single CommonJS release/app/host.cjs by scripts/build-host.mjs.

/** Chrome allows up to 4 GB towards the host; real requests are tiny. */
export const MAX_MESSAGE_BYTES = 64 * 1024;
const MAX_PATH_CHARS = 1024;
const START_TIMEOUT_MS = 15_000;
const STOP_TIMEOUT_MS = 5_000;

// ---------------------------------------------------------------- host manifest

export interface HostManifest {
  name: string;
  description: string;
  path: string;
  type: "stdio";
  allowed_origins: string[];
}

/**
 * The host manifest registered under HKCU\Software\Google\Chrome\NativeMessagingHosts\es.uniovi.virtual.
 * On Windows `path` may be relative to the manifest's folder, so the default "host.cmd" works when the
 * manifest sits next to host.cmd in the install folder.
 */
export function hostManifest(path = "host.cmd"): HostManifest {
  return {
    name: NATIVE_HOST_NAME,
    description: "Uniovi Virtual: controla el asistente local (helper)",
    path,
    type: "stdio",
    allowed_origins: [`chrome-extension://${EXTENSION_ID}/`],
  };
}

// ---------------------------------------------------------------- framing

export function encodeFrame(message: unknown): Buffer {
  const body = Buffer.from(JSON.stringify(message), "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32LE(body.length, 0);
  return Buffer.concat([head, body]);
}

/**
 * Incremental decoder for chunks of stdin. Calls onFrame for each complete message body.
 * Returns false (and stops) once a declared length exceeds `max`: the stream can't be resynced.
 */
export function frameDecoder(onFrame: (body: Buffer) => void, max = MAX_MESSAGE_BYTES): (chunk: Buffer) => boolean {
  let buf: Buffer = Buffer.alloc(0);
  let broken = false;
  return (chunk) => {
    if (broken) return false;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (buf.length >= 4) {
      const len = buf.readUInt32LE(0);
      if (len > max) {
        broken = true;
        buf = Buffer.alloc(0);
        return false;
      }
      if (buf.length < 4 + len) break;
      onFrame(buf.subarray(4, 4 + len));
      buf = buf.subarray(4 + len);
    }
    return true;
  };
}

// ---------------------------------------------------------------- validation

const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;

const hasExactKeys = (o: Record<string, unknown>, keys: string[]) => {
  const own = Object.keys(o);
  return own.length === keys.length && keys.every((k) => Object.hasOwn(o, k));
};

/**
 * Absolute data folder: a drive path on Windows (no UNC / device paths, no relative "C:foo"),
 * an absolute path elsewhere; no control characters and no ".." segments. Returns the normalised
 * path, or an error string.
 */
export function validateDataDir(value: unknown, platform: NodeJS.Platform = process.platform): string | { error: string } {
  if (typeof value !== "string") return { error: "dataDir debe ser texto" };
  const dir = value.trim();
  if (!dir || dir.length > MAX_PATH_CHARS) return { error: "dataDir vacío o demasiado largo" };
  if (/[\u0000-\u001f]/.test(dir)) return { error: "dataDir contiene caracteres no válidos" };
  if (dir.split(/[\\/]/).includes("..")) return { error: "dataDir no puede contener '..'" };
  if (platform === "win32") {
    if (!/^[A-Za-z]:[\\/]/.test(dir)) return { error: "dataDir debe ser una ruta absoluta (por ejemplo C:\\Users\\tú\\Documents\\Uniovi)" };
    if (/[<>"|?*]/.test(dir.slice(2))) return { error: "dataDir contiene caracteres no válidos en Windows" };
    return resolve(dir);
  }
  if (!posix.isAbsolute(dir)) return { error: "dataDir debe ser una ruta absoluta" };
  return posix.normalize(dir);
}

/** Parses and validates one request body. Unknown types, extra keys or wrong value types are rejected. */
export function parseRequest(body: Buffer | string): NativeRequest | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(typeof body === "string" ? body : body.toString("utf8"));
  } catch {
    return { error: "JSON no válido" };
  }
  if (!isPlainObject(raw) || typeof raw.type !== "string") return { error: "petición no válida" };
  switch (raw.type) {
    case "status":
    case "start":
    case "stop":
      return hasExactKeys(raw, ["type"]) ? { type: raw.type } : { error: `campos inesperados en ${raw.type}` };
    case "setDataDir": {
      if (!hasExactKeys(raw, ["type", "dataDir"])) return { error: "setDataDir necesita solo dataDir" };
      const dir = validateDataDir(raw.dataDir);
      return typeof dir === "string" ? { type: "setDataDir", dataDir: dir } : dir;
    }
    case "setTunnel":
      if (!hasExactKeys(raw, ["type", "enabled"]) || typeof raw.enabled !== "boolean") return { error: "setTunnel necesita enabled (true/false)" };
      return { type: "setTunnel", enabled: raw.enabled };
    default:
      return { error: "tipo de petición desconocido" };
  }
}

// ---------------------------------------------------------------- helper process control

/** Folder of the running host script (host.cjs in an install, server/src in dev). helper.js lives next to it. */
const hostDir = () => dirname(resolve(process.argv[1] ?? "."));
const helperScript = () => join(hostDir(), "helper.js");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Windows recycles pids: make sure a pid from the file still belongs to a node.exe before trusting it. */
function isOurImage(pid: number): boolean {
  if (process.platform !== "win32") return true;
  try {
    const out = execFileSync("tasklist", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "ignore"] });
    const image = /^"([^"]+)"/.exec(out.trim())?.[1];
    return !!image && image.toLowerCase() === basename(process.execPath).toLowerCase();
  } catch {
    return true; // tasklist unavailable: fall back to the liveness check alone
  }
}

function readPid(): number | undefined {
  try {
    const text = readFileSync(pidFile(), "utf8").trim();
    if (!/^\d{1,10}$/.test(text)) return undefined;
    const pid = Number(text);
    return pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

/** Pid of the running helper, or undefined. A stale pid file (dead or reused pid) is removed. */
function helperPid(): number | undefined {
  if (!existsSync(pidFile())) return undefined;
  const pid = readPid();
  if (pid !== undefined && pid !== process.pid && isAlive(pid) && isOurImage(pid)) return pid;
  removePidFile(pid);
  return undefined;
}

/** Removes the pid file, but only if it still names `pid` (a new helper may have replaced it). */
function removePidFile(pid: number | undefined) {
  if (readPid() !== pid) return;
  try {
    rmSync(pidFile(), { force: true });
  } catch (err) {
    console.error("[host] could not remove pid file:", err);
  }
}

export function status(): NativeStatus {
  const config = loadConfig();
  const pid = helperPid();
  return {
    installed: true,
    hostVersion: VERSION,
    running: pid !== undefined,
    ...(pid !== undefined ? { pid } : {}),
    config,
    dataDir: effectiveDataDir(config),
  };
}

/** Starts the helper detached and hidden, and waits until it has written its pid file. */
export async function start(): Promise<NativeStatus> {
  if (helperPid() !== undefined) return status();
  const script = helperScript();
  if (!existsSync(script)) throw new Error(`No se encuentra el asistente (helper.js) en ${hostDir()}. Reinstala Uniovi Virtual.`);
  const child = spawn(process.execPath, [script, "--service"], { cwd: hostDir(), detached: true, windowsHide: true, stdio: "ignore" });
  let exited: number | null | undefined;
  child.on("exit", (code) => (exited = code));
  child.on("error", (err) => {
    console.error("[host] spawn failed:", err);
    exited = -1;
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (helperPid() !== undefined) return status();
    // A second instance exits cleanly when another helper already runs (single instance).
    if (exited !== undefined) break;
    await sleep(100);
  }
  const now = status();
  if (now.running) return now;
  throw new Error(exited !== undefined ? `El asistente se cerró al arrancar (código ${exited}); revisa los logs.` : "El asistente no arrancó a tiempo; revisa los logs.");
}

/** Stops the helper and its children (tunnel clients), then removes the pid file. */
export async function stop(): Promise<NativeStatus> {
  const pid = helperPid();
  if (pid === undefined) return status();
  try {
    if (process.platform === "win32") {
      // /T: also the tunnel client (ssh / cloudflared) the helper spawned; /F: it has no window to close.
      execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(pid, "SIGTERM");
    }
  } catch (err) {
    if (isAlive(pid)) console.error("[host] kill failed:", err);
  }
  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (isAlive(pid) && Date.now() < deadline) await sleep(100);
  if (isAlive(pid)) throw new Error("No se pudo detener el asistente.");
  removePidFile(pid);
  return status();
}

async function restartIfRunning(): Promise<NativeStatus> {
  if (helperPid() === undefined) return status();
  await stop();
  return start();
}

export async function handleRequest(req: NativeRequest): Promise<NativeStatus> {
  switch (req.type) {
    case "status":
      return status();
    case "start":
      return start();
    case "stop":
      return stop();
    case "setDataDir":
      // Create it now, so a path the user can't write to fails here instead of in the helper.
      mkdirSync(req.dataDir, { recursive: true });
      saveConfig({ ...loadConfig(), dataDir: req.dataDir });
      return restartIfRunning();
    case "setTunnel":
      saveConfig({ ...loadConfig(), tunnel: req.enabled });
      return restartIfRunning();
  }
}

export async function reply(body: Buffer): Promise<NativeReply> {
  const req = parseRequest(body);
  if ("error" in req) return { ok: false, error: req.error };
  try {
    return { ok: true, status: await handleRequest(req) };
  } catch (err) {
    console.error(`[host] ${req.type} failed:`, err);
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ---------------------------------------------------------------- main

function write(frame: Buffer): Promise<void> {
  return new Promise((done) => process.stdout.write(frame, () => done()));
}

function main() {
  const flag = process.argv.indexOf("--print-manifest");
  if (flag !== -1) {
    // `node host.cjs --print-manifest [C:\path\to\host.cmd]` (installer / docs helper).
    process.stdout.write(`${JSON.stringify(hostManifest(process.argv[flag + 1]), null, 2)}\n`);
    return;
  }
  if (process.argv.includes("--stop")) {
    // `node host.cjs --stop` (installer before an upgrade, uninstaller): same logic as the popup's Detener.
    stop().then(
      () => process.exit(0),
      (err: unknown) => {
        console.error("[host] --stop failed:", err);
        process.exit(1);
      },
    );
    return;
  }

  // Requests are answered strictly in order.
  let queue: Promise<void> = Promise.resolve();
  const decode = frameDecoder((body) => {
    queue = queue.then(async () => write(encodeFrame(await reply(body))));
  });
  process.stdin.on("data", (chunk: Buffer) => {
    if (decode(chunk)) return;
    queue = queue
      .then(() => write(encodeFrame({ ok: false, error: "mensaje demasiado grande" } satisfies NativeReply)))
      .then(() => process.exit(1));
  });
  process.stdin.on("end", () => void queue.then(() => process.exit(0)));
}

// Runs as the bundled host.cjs or as `node server/src/nativehost.ts`; importing it (tests) does nothing.
if (/^(?:host\.cjs|nativehost\.ts)$/.test(basename(process.argv[1] ?? ""))) main();
