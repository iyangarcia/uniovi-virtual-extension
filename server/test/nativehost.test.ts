import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import * as esbuild from "esbuild";
import { EXTENSION_ID, EXTENSION_PUBLIC_KEY, type NativeReply } from "../../shared/helper.ts";
import { encodeFrame, frameDecoder, hostManifest, listensOnPort, MAX_MESSAGE_BYTES, parseRequest, validateDataDir } from "../src/nativehost.ts";

// ---------------------------------------------------------------- pure parts

test("frames: round trip, split chunks, several frames per chunk", () => {
  const got: unknown[] = [];
  const decode = frameDecoder((b) => got.push(JSON.parse(b.toString("utf8"))));
  const all = Buffer.concat([encodeFrame({ type: "status" }), encodeFrame({ type: "setDataDir", dataDir: "C:\\Año\\ñ" })]);
  for (let i = 0; i < all.length; i += 3) assert.equal(decode(all.subarray(i, i + 3)), true);
  assert.deepEqual(got, [{ type: "status" }, { type: "setDataDir", dataDir: "C:\\Año\\ñ" }]);
  // The length is in bytes, little-endian: "ñ" is 2 bytes.
  assert.equal(encodeFrame("ñ").readUInt32LE(0), 4);
});

test("frames: a declared length over the limit stops the decoder", () => {
  const decode = frameDecoder(() => assert.fail("no frame expected"));
  const head = Buffer.alloc(4);
  head.writeUInt32LE(MAX_MESSAGE_BYTES + 1);
  assert.equal(decode(head), false);
  assert.equal(decode(encodeFrame({ type: "status" })), false);
});

test("requests are validated strictly", () => {
  const ok = (v: unknown) => parseRequest(JSON.stringify(v));
  assert.deepEqual(ok({ type: "status" }), { type: "status" });
  assert.deepEqual(ok({ type: "setTunnel", enabled: false }), { type: "setTunnel", enabled: false });
  for (const bad of [
    "not json",
    "[]",
    "null",
    JSON.stringify({ type: "exec", cmd: "calc" }),
    JSON.stringify({ type: "status", extra: 1 }),
    '{"type":"start","__proto__":{"x":1}}',
    JSON.stringify({ type: "setTunnel", enabled: "yes" }),
    JSON.stringify({ type: "setTunnel" }),
    JSON.stringify({ type: "setDataDir" }),
    JSON.stringify({ type: "setDataDir", dataDir: 42 }),
    JSON.stringify({ type: "setDataDir", dataDir: "C:\\x", more: true }),
  ]) {
    assert.ok("error" in parseRequest(bad), bad);
  }
});

test("dataDir must be an absolute, plain path", () => {
  // win32 output goes through path.resolve, which only normalises separators on Windows.
  if (process.platform === "win32") assert.equal(validateDataDir("C:/Users/Ana/Documents/Uniovi/", "win32"), "C:\\Users\\Ana\\Documents\\Uniovi");
  assert.equal(validateDataDir("/home/ana/uniovi", "linux"), "/home/ana/uniovi");
  for (const bad of ["", "relative\\dir", "C:relative", "\\\\server\\share\\x", "\\\\?\\C:\\x", "\\rooted", "C:\\a\\..\\Windows", "C:\\a\u0000b", "C:\\a?b", "x".repeat(2000), 5, null]) {
    assert.ok(typeof validateDataDir(bad, "win32") === "object", String(bad));
  }
  assert.ok(typeof validateDataDir("relative/dir", "linux") === "object");
});

test("host manifest: name, stdio, allowed_origins = the fixed extension ID", () => {
  assert.deepEqual(hostManifest("C:\\Apps\\UnioviVirtual\\host.cmd"), {
    name: "es.uniovi.virtual",
    description: "Uniovi Virtual: controla el asistente local (helper)",
    path: "C:\\Apps\\UnioviVirtual\\host.cmd",
    type: "stdio",
    allowed_origins: ["chrome-extension://amagekgnbkaeigjhbenkilkhoklkdieo/"],
  });
  assert.equal(hostManifest().path, "host.cmd");
});

test("extension ID is derived from the manifest key (Chrome: sha256 of the DER key, first 32 hex digits mapped to a-p)", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8")) as { key: string; permissions: string[] };
  assert.equal(manifest.key, EXTENSION_PUBLIC_KEY);
  const hex = createHash("sha256").update(Buffer.from(manifest.key, "base64")).digest("hex").slice(0, 32);
  const id = [...hex].map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16))).join("");
  assert.equal(id, EXTENSION_ID);
});

// ---------------------------------------------------------------- the bundled host over stdio

// A fake helper.js (agent B's real bundle isn't on this branch): writes the pid file like --service
// does and answers GET /api/status on UNIOVI_BRIDGE_PORT.
const FAKE_HELPER = `
import http from "node:http"; import fs from "node:fs"; import path from "node:path";
const server = http.createServer((req, res) => {
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, version: "fake", dataDir: process.env.UNIOVI_DATA_DIR, knownFiles: {}, argv: process.argv.slice(2) }));
});
// Like the real helper: bind the remote port (the host checks this pid listens there), then the bridge, then write the pid file.
http.createServer((q, r) => r.end()).listen(Number(process.env.UNIOVI_REMOTE_PORT), "127.0.0.1", () =>
  server.listen(Number(process.env.UNIOVI_BRIDGE_PORT), "127.0.0.1", () => fs.writeFileSync(path.join(process.env.UNIOVI_APP_DIR, "helper.pid"), String(process.pid))));
`;

const root = mkdtempSync(join(tmpdir(), "uniovi-host-test-"));
const appDir = join(root, "app");
const installDir = join(root, "install");
const spawned = new Set<number>();
let port = 0;
let rport = 0;

const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const s = createServer().listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => resolve(p));
    });
    s.on("error", reject);
  });

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

before(async () => {
  mkdirSync(appDir, { recursive: true });
  // Same bundle options as scripts/build-host.mjs (CommonJS, Node built-ins only).
  await esbuild.build({ entryPoints: ["server/src/nativehost.ts"], outfile: join(installDir, "host.cjs"), bundle: true, format: "cjs", platform: "node", target: "node22", logLevel: "silent" });
  writeFileSync(join(installDir, "helper.js"), FAKE_HELPER);
  // Same as release/app: the real helper.js is ESM, so the folder carries {"type":"module"} (host must be .cjs).
  writeFileSync(join(installDir, "package.json"), JSON.stringify({ type: "module" }));
  port = await freePort();
  rport = await freePort();
});

after(() => {
  for (const pid of spawned) if (alive(pid)) process.kill(pid);
  rmSync(root, { recursive: true, force: true });
});

/** A host process plus a framed request/reply helper, like Chrome's connectNative. */
function startHost(): { child: ChildProcess; ask: (msg: unknown) => Promise<NativeReply>; askRaw: (frame: Buffer) => Promise<NativeReply> } {
  const child = spawn(process.execPath, [join(installDir, "host.cjs"), "chrome-extension://amagekgnbkaeigjhbenkilkhoklkdieo/", "--parent-window=0"], {
    env: { ...process.env, UNIOVI_APP_DIR: appDir, UNIOVI_DATA_DIR: join(root, "data"), UNIOVI_BRIDGE_PORT: String(port), UNIOVI_REMOTE_PORT: String(rport) },
    stdio: ["pipe", "pipe", "pipe"],
  });
  child.stderr!.resume();
  const waiting: ((r: NativeReply) => void)[] = [];
  child.stdout!.on("data", frameDecoder((body) => waiting.shift()?.(JSON.parse(body.toString("utf8")) as NativeReply), 1 << 20));
  const askRaw = (frame: Buffer) =>
    new Promise<NativeReply>((resolve) => {
      waiting.push(resolve);
      child.stdin!.write(frame);
    });
  return { child, askRaw, ask: (msg) => askRaw(encodeFrame(msg)) };
}

const okStatus = (r: NativeReply) => {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.status;
};

test("host over stdio: status, start → /api/status answers, setTunnel restarts, stop", { timeout: 60_000 }, async () => {
  const { child, ask } = startHost();
  const exited = new Promise<number | null>((r) => child.on("exit", r));

  const first = okStatus(await ask({ type: "status" }));
  assert.equal(first.installed, true);
  assert.equal(first.running, false);
  assert.equal(first.config.tunnel, true);
  assert.equal(first.dataDir, join(root, "data"));

  const bad = await ask({ type: "exec", cmd: "calc.exe" });
  assert.deepEqual(bad, { ok: false, error: "tipo de petición desconocido" });

  const started = okStatus(await ask({ type: "start" }));
  assert.equal(started.running, true);
  const pid = started.pid!;
  spawned.add(pid);
  assert.equal(readFileSync(join(appDir, "helper.pid"), "utf8"), String(pid));
  const res = await fetch(`http://127.0.0.1:${port}/api/status`);
  const body = (await res.json()) as { ok: boolean; argv: string[] };
  assert.equal(body.ok, true);
  assert.deepEqual(body.argv, ["--service"]);

  // Starting again is a no-op.
  assert.equal(okStatus(await ask({ type: "start" })).pid, pid);

  // Config change while running: written, helper restarted.
  const restarted = okStatus(await ask({ type: "setTunnel", enabled: false }));
  assert.equal(restarted.config.tunnel, false);
  assert.equal(restarted.running, true);
  assert.notEqual(restarted.pid, pid);
  spawned.add(restarted.pid!);
  assert.equal(alive(pid), false);
  assert.deepEqual(JSON.parse(readFileSync(join(appDir, "config.json"), "utf8")), { tunnel: false });

  const stopped = okStatus(await ask({ type: "stop" }));
  assert.equal(stopped.running, false);
  assert.equal(alive(restarted.pid!), false);
  assert.equal(existsSync(join(appDir, "helper.pid")), false);
  await assert.rejects(fetch(`http://127.0.0.1:${port}/api/status`));

  // Exits when Chrome closes stdin.
  child.stdin!.end();
  assert.equal(await exited, 0);
});

test("host --stop (installer / uninstaller): stops a running helper, then is a no-op", { timeout: 30_000 }, async () => {
  const { child, ask } = startHost();
  const pid = okStatus(await ask({ type: "start" })).pid!;
  spawned.add(pid);
  child.stdin!.end();

  const runStop = () =>
    new Promise<number | null>((resolve) => {
      const c = spawn(process.execPath, [join(installDir, "host.cjs"), "--stop"], {
        env: { ...process.env, UNIOVI_APP_DIR: appDir, UNIOVI_DATA_DIR: join(root, "data"), UNIOVI_BRIDGE_PORT: String(port), UNIOVI_REMOTE_PORT: String(rport) },
        stdio: "ignore",
      });
      c.on("exit", resolve);
    });
  assert.equal(await runStop(), 0);
  assert.equal(alive(pid), false);
  assert.equal(existsSync(join(appDir, "helper.pid")), false);
  assert.equal(await runStop(), 0);
});

test("host over stdio: setDataDir while stopped, stale pid file, oversized message", { timeout: 30_000 }, async () => {
  const { child, ask, askRaw } = startHost();
  const exited = new Promise<number | null>((r) => child.on("exit", r));

  const dir = join(root, "elsewhere", "Uniovi");
  const changed = okStatus(await ask({ type: "setDataDir", dataDir: dir }));
  assert.equal(changed.running, false);
  assert.equal(changed.config.dataDir, dir);
  assert.ok(existsSync(dir));
  assert.equal((await ask({ type: "setDataDir", dataDir: "relative\\dir" })).ok, false);

  // A pid file left by a killed helper (dead pid) is ignored and removed.
  writeFileSync(join(appDir, "helper.pid"), "999999");
  assert.equal(okStatus(await ask({ type: "status" })).running, false);
  assert.equal(existsSync(join(appDir, "helper.pid")), false);

  const head = Buffer.alloc(4);
  head.writeUInt32LE(MAX_MESSAGE_BYTES + 1);
  assert.deepEqual(await askRaw(head), { ok: false, error: "mensaje demasiado grande" });
  assert.equal(await exited, 1);
});

test("a pid from helper.pid is trusted only if that process listens on the helper's remote port", () => {
  const netstat = [
    "  Proto  Dirección local          Dirección remota        Estado           PID",
    "  TCP    127.0.0.1:47823          0.0.0.0:0              LISTENING       900",
    "  TCP    127.0.0.1:47824          0.0.0.0:0              ESCUCHANDO      1234",
    "  TCP    127.0.0.1:47824          127.0.0.1:50000        ESTABLISHED     777",
  ].join("\r\n");
  assert.equal(listensOnPort(netstat, 1234, 47824), true); // localized state word is fine
  assert.equal(listensOnPort(netstat, 900, 47824), false); // a reused pid that is some other server
  assert.equal(listensOnPort(netstat, 777, 47824), false); // a client connection is not ownership
  assert.equal(listensOnPort(netstat, 1234, 47825), false);
});
