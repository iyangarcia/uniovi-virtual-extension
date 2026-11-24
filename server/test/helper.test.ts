import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { BridgeStatus } from "../../shared/types.ts";

// The installed helper: config.json, --service (single instance, log file), /api/status fields.
// Everything lives in temp dirs (UNIOVI_APP_DIR / UNIOVI_DATA_DIR) and on ephemeral ports.

const appDir = mkdtempSync(join(tmpdir(), "uniovi-helper-app-"));
const dataDir = mkdtempSync(join(tmpdir(), "uniovi-helper-data-"));
process.env.UNIOVI_APP_DIR = appDir;
process.env.UNIOVI_DATA_DIR = dataDir;
const config = await import("../src/config.ts");
const store = await import("../src/store.ts");
const http = await import("../src/http.ts");
const service = await import("../src/service.ts");
const log = await import("../src/log.ts");

function listen(): Promise<Server> {
  return new Promise((resolve) => {
    const s = createServer((socket) => socket.destroy());
    s.listen(0, "127.0.0.1", () => resolve(s));
  });
}
const portOf = (s: { address(): unknown }) => (s.address() as AddressInfo).port;
async function freePort(): Promise<number> {
  const s = await listen();
  const port = portOf(s);
  await new Promise((r) => s.close(r));
  return port;
}

test("config.json: defaults, round trip, and data dir precedence (env > config > default)", () => {
  assert.equal(config.configFile(), join(appDir, "config.json"));
  assert.deepEqual(config.loadConfig(), { tunnel: true });

  writeFileSync(config.configFile(), "{ not json");
  assert.deepEqual(config.loadConfig(), { tunnel: true });

  config.saveConfig({ dataDir: "D:\\Apuntes", tunnel: false });
  assert.deepEqual(config.loadConfig(), { dataDir: "D:\\Apuntes", tunnel: false });
  writeFileSync(config.configFile(), JSON.stringify({ dataDir: 7, tunnel: "yes", extra: 1 }));
  assert.deepEqual(config.loadConfig(), { tunnel: true });

  const saved = { env: process.env.UNIOVI_DATA_DIR, profile: process.env.USERPROFILE };
  try {
    assert.equal(config.effectiveDataDir({ dataDir: "D:\\Apuntes", tunnel: true }), dataDir);
    delete process.env.UNIOVI_DATA_DIR;
    assert.equal(config.effectiveDataDir({ dataDir: "D:\\Apuntes", tunnel: true }), "D:\\Apuntes");

    const profile = mkdtempSync(join(tmpdir(), "uniovi-helper-profile-"));
    process.env.USERPROFILE = profile;
    assert.equal(config.effectiveDataDir({ tunnel: true }), join(profile, "Documents", "Uniovi"));
    mkdirSync(join(profile, "uniovi-data"));
    assert.equal(config.effectiveDataDir({ tunnel: true }), join(profile, "uniovi-data"));
  } finally {
    process.env.UNIOVI_DATA_DIR = saved.env;
    if (saved.profile === undefined) delete process.env.USERPROFILE;
    else process.env.USERPROFILE = saved.profile;
  }
  assert.equal(store.dataDir, dataDir);
});

test("log file rotates by size and keeps a bounded number of files", () => {
  const dir = mkdtempSync(join(tmpdir(), "uniovi-helper-logs-"));
  const l = log.openFileLog(dir, { maxBytes: 200, keep: 2 });
  for (let i = 0; i < 40; i++) l.write(`line ${i} ${"x".repeat(30)}`);
  l.close();
  assert.deepEqual(readdirSync(dir).sort(), ["helper.1.log", "helper.2.log", "helper.log"]);
  for (const f of readdirSync(dir)) assert.ok(readFileSync(join(dir, f)).length <= 200, f);
  assert.match(readFileSync(join(dir, "helper.log"), "utf8"), /line 39/);
});

test("single instance: a pid counts only if it is alive and the remote port answers", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "uniovi-helper-pid-")), "helper.pid");
  const busy = await listen();
  try {
    const port = portOf(busy);
    assert.equal(await service.runningHelperPid(file, port), undefined, "no pid file");
    writeFileSync(file, "not a pid");
    assert.equal(await service.runningHelperPid(file, port), undefined, "garbage");
    writeFileSync(file, "4000000"); // no such process
    assert.equal(await service.runningHelperPid(file, port), undefined, "dead pid");
    writeFileSync(file, String(process.pid));
    assert.equal(await service.runningHelperPid(file, port), undefined, "our own pid");
    // A live process (our parent) whose pid was reused after a reboot, but nothing on the port.
    writeFileSync(file, String(process.ppid));
    assert.equal(await service.runningHelperPid(file, await freePort()), undefined, "live pid, port closed");
    assert.equal(await service.runningHelperPid(file, port), process.ppid, "live pid, port answering");

    service.writePidFile(file);
    assert.equal(service.readPid(file), process.pid);
    service.removePidFile(file);
    assert.equal(existsSync(file), false);
    writeFileSync(file, String(process.ppid));
    service.removePidFile(file); // someone else's pid file is left alone
    assert.equal(service.readPid(file), process.ppid);
  } finally {
    busy.close();
  }
});

test("/api/status reports helperVersion and the live tunnel state", async () => {
  const server = (await http.startHttp(0))!;
  const base = `http://127.0.0.1:${portOf(server)}`;
  const status = async () => (await (await fetch(`${base}/api/status`)).json()) as BridgeStatus;
  try {
    const tunnel = { state: "ready", provider: "tunnelmole", url: "https://abc.tunnelmole.net", since: 1 } as const;
    await store.saveRemoteState({ token: "t", pid: process.pid, publicUrl: "https://abc.tunnelmole.net/mcp/t", tunnel });
    let s = await status();
    assert.equal(s.helperVersion, s.version);
    assert.deepEqual(s.tunnel, tunnel);
    assert.equal(s.remoteUrl, "https://abc.tunnelmole.net/mcp/t");

    await store.saveRemoteState({ token: "t", pid: process.pid, tunnel: { state: "error", provider: "cloudflared", error: "boom", since: 2 } });
    s = await status();
    assert.equal(s.tunnel?.state, "error");
    assert.equal(s.remoteUrl, undefined);

    await store.saveRemoteState({ token: "t", pid: 4000000, publicUrl: "https://x/mcp/t", tunnel }); // owner is dead
    s = await status();
    assert.equal(s.tunnel, undefined);
    assert.equal(s.remoteUrl, undefined);
  } finally {
    server.close();
  }
});

test("--service: serves /api/status, logs to a file, and a second start exits 0", { timeout: 60_000 }, async () => {
  const app = mkdtempSync(join(tmpdir(), "uniovi-helper-svc-app-"));
  const data = mkdtempSync(join(tmpdir(), "uniovi-helper-svc-data-"));
  writeFileSync(join(app, "config.json"), JSON.stringify({ tunnel: false }));
  const [bridgePort, remotePort] = [await freePort(), await freePort()];
  const env = { ...process.env, UNIOVI_APP_DIR: app, UNIOVI_DATA_DIR: data, UNIOVI_BRIDGE_PORT: String(bridgePort), UNIOVI_REMOTE_PORT: String(remotePort) };
  const entry = join(import.meta.dirname, "..", "src", "index.ts");
  const start = () => spawn(process.execPath, [entry, "--service"], { env, stdio: "ignore", windowsHide: true });
  const exited = (child: ReturnType<typeof start>) =>
    new Promise<number | null>((resolve) => (child.exitCode !== null ? resolve(child.exitCode) : child.once("exit", resolve)));

  const first = start();
  try {
    let status: BridgeStatus | undefined;
    for (let i = 0; i < 100 && !status; i++) {
      await new Promise((r) => setTimeout(r, 200));
      // Wait for the tunnel state too: it is written just after the bridge starts listening.
      const s = (await fetch(`http://127.0.0.1:${bridgePort}/api/status`).then((r) => r.json(), () => undefined)) as BridgeStatus | undefined;
      if (s?.tunnel) status = s;
    }
    assert.ok(status, "helper never answered /api/status");
    assert.equal(status.dataDir, data);
    assert.equal(status.tunnel?.state, "off");
    assert.equal(service.readPid(join(app, "helper.pid")), first.pid);

    const second = start();
    assert.equal(await exited(second), 0);
    assert.equal(first.exitCode, null, "the first helper keeps running");
    const logged = readFileSync(join(app, "logs", "helper.log"), "utf8");
    assert.match(logged, /already running \(pid \d+\)/);
    assert.equal(service.readPid(join(app, "helper.pid")), first.pid, "the second start leaves the pid file alone");
  } finally {
    first.kill();
    await exited(first);
  }
});

test("safeSegment: never ends in a space or dot after truncation, keeps surrogate pairs, avoids device names", async () => {
  const { safeSegment } = await import("../src/store.ts");
  const cut = safeSegment(`${"a".repeat(79)} b`);
  assert.ok(!/[. ]$/.test(cut), JSON.stringify(cut));
  assert.ok(cut.length <= 80);
  const emoji = safeSegment(`${"a".repeat(79)}😀x`);
  assert.ok(!/[\ud800-\udbff]$/.test(emoji) && !/^[\udc00-\udfff]/.test(emoji), "no lone surrogate");
  assert.equal(safeSegment("CON"), "_CON");
  assert.equal(safeSegment("nul.txt"), "_nul.txt");
  assert.equal(safeSegment("Console"), "Console");
  assert.equal(safeSegment("Expandir_ _ "), "Expandir_ _");
  assert.equal(safeSegment(" .. "), "_");
});
