import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import { TUNNEL_PROVIDERS, type TunnelProviderName, type TunnelStatus } from "../../shared/helper.ts";
import { defaultProviders, startTunnel, type ProviderEvent, type TunnelProvider } from "../src/tunnel.ts";
import { tunnelLogParser } from "../src/tunnel/cloudflared.ts";
import { lineSplitter, runProcess } from "../src/tunnel/provider.ts";
import { localhostRunParser, pinggyParser } from "../src/tunnel/ssh.ts";
import { assignedUrl, forwardedResponse, type ForwardedRequest } from "../src/tunnel/tunnelmole.ts";

// Real output captured on 2026-11-24 from this PC (public IP replaced by 203.0.113.7).
const fixture = (name: string) => readFileSync(new URL(`./fixtures/tunnel/${name}`, import.meta.url), "utf8");

function feed(parse: (line: string) => ProviderEvent[], text: string): ProviderEvent[] {
  const out: ProviderEvent[] = [];
  const split = lineSplitter((line) => out.push(...parse(line)));
  split(text);
  split("\n");
  return out;
}

// ---- URL parsing per provider ----------------------------------------------------------------

test("cloudflared: URL first, ready only after the edge connection registers", () => {
  const events = tunnelLogParser()(fixture("cloudflared-ready.txt"));
  const url = "https://graduated-craft-reid-realistic.trycloudflare.com";
  assert.deepEqual(events.filter((e) => e.type !== "error"), [{ type: "url", url }, { type: "ready", url }]);
});

test("localhost.run: JSON output gives the address; a rotation gives a new ready URL", () => {
  const parse = localhostRunParser();
  const json = fixture("localhost-run-json.txt");
  assert.deepEqual(feed(parse, json), [{ type: "ready", url: "https://c29ff57edec7ea.app.lhr.life" }]);
  assert.deepEqual(feed(parse, json), [], "same address again is not a change");
  const rotated = json.replaceAll("c29ff57edec7ea", "0a1b2c3d4e5f60");
  assert.deepEqual(feed(parse, rotated), [{ type: "ready", url: "https://0a1b2c3d4e5f60.app.lhr.life" }]);
});

test("localhost.run: plain-text output (banner, QR code) gives the https URL", () => {
  assert.deepEqual(feed(localhostRunParser(), fixture("localhost-run-text.txt")), [{ type: "ready", url: "https://9cd96aa124fac3.app.lhr.life" }]);
});

test("localhost.run: other JSON events, bad JSON and bad hostnames are ignored", () => {
  const parse = localhostRunParser();
  assert.deepEqual(parse('{"type":"run.localhost.tunnel.unregistered","data":{"address":"x.lhr.life"}}'), []);
  assert.deepEqual(parse('{"type":"run.localhost.tunnel.registered","data":{"address":"evil host/../"}}'), []);
  assert.deepEqual(parse("{not json"), []);
  assert.deepEqual(parse("see https://localhost.run/docs/forever-free/ for more information."), []);
});

test("pinggy: the first tunnel URL wins; the dashboard link and the second alias are ignored", () => {
  const events = feed(pinggyParser(), fixture("pinggy-stdout.txt") + fixture("pinggy-stderr.txt"));
  assert.deepEqual(events, [{ type: "ready", url: "https://ktnlg-203-0-113-7.run.pinggy-free.link" }]);
  assert.deepEqual(feed(pinggyParser(), "https://dashboard.pinggy.io\n"), []);
});

test("tunnelmole: hostnameAssigned gives the https URL", () => {
  const [assigned, request] = fixture("tunnelmole-messages.jsonl").trim().split(/\r?\n/).map((l) => JSON.parse(l));
  assert.equal(assignedUrl(assigned), "https://1nbkfv-ip-203-0-113-7.tunnelmole.net");
  assert.equal(assignedUrl(request), null);
  assert.equal(assignedUrl({ type: "hostnameAssigned", hostname: "a b" }), null);
});

test("tunnelmole: a chunked local response is forwarded without hop-by-hop headers (the npm client's 502)", async () => {
  const [, request] = fixture("tunnelmole-messages.jsonl").trim().split(/\r?\n/).map((l) => JSON.parse(l) as ForwardedRequest);
  let seen = { method: "", url: "", body: "" };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      seen = { method: req.method!, url: req.url!, body: Buffer.concat(chunks).toString() };
      res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" }); // no length: Node sends it chunked
      res.write("Not ");
      res.end("found");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const local = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  try {
    const reply = await forwardedResponse(local, request!);
    assert.deepEqual(seen, { method: "POST", url: "/mcp/TOKEN", body: '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' });
    assert.equal(reply.type, "forwardedResponse");
    assert.equal(reply.requestId, request!.requestId);
    assert.equal(reply.statusCode, 404);
    assert.equal(Buffer.from(reply.body, "base64").toString(), "Not found");
    assert.equal(reply.headers["content-length"], "9");
    for (const h of ["transfer-encoding", "connection", "keep-alive"]) assert.equal(reply.headers[h], undefined, h);
  } finally {
    server.close();
  }
  const down = await forwardedResponse(local, request!);
  assert.equal(down.statusCode, 502);
});

test("runProcess: output lines become events; the exit is down with the last stderr line, IPs masked", async () => {
  const events: ProviderEvent[] = [];
  const script = `process.stdout.write(${JSON.stringify(fixture("localhost-run-json.txt"))} + "\\n"); console.error("Connection closed by 54.161.197.247 port 443"); process.exit(3)`;
  await new Promise<void>((resolve) => {
    runProcess(process.execPath, ["-e", script], (ev) => {
      events.push(ev);
      if (ev.type === "down") resolve();
    }, localhostRunParser());
  });
  assert.deepEqual(events, [{ type: "ready", url: "https://c29ff57edec7ea.app.lhr.life" }, { type: "down", reason: "exited (3): Connection closed by <ip> port 443" }]);
});

test("runProcess: a missing executable is down right away", async () => {
  const ev = await new Promise<ProviderEvent>((resolve) => runProcess("uniovi-no-such-exe-xyz", [], resolve, () => []));
  assert.deepEqual(ev, { type: "down", reason: "uniovi-no-such-exe-xyz not found" });
});

// ---- Orchestrator with fake providers --------------------------------------------------------

interface Fake extends TunnelProvider {
  starts: number;
  stops: number;
  emit: (ev: ProviderEvent) => void;
}

/** A provider driven by the test; `onStart` runs right after start(), e.g. to fail synchronously. */
function fake(name: TunnelProviderName, onStart?: (emit: (ev: ProviderEvent) => void, n: number) => void, available = true): Fake {
  const f: Fake = {
    name,
    starts: 0,
    stops: 0,
    emit: () => assert.fail(`${name} not started`),
    available: () => available,
    start(_url, emit) {
      f.starts++;
      f.emit = emit;
      onStart?.(emit, f.starts);
      return { stop: () => void f.stops++ };
    },
  };
  return f;
}

const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const brief = (s: TunnelStatus) => [s.state, s.provider ?? "-", s.url ?? "-"].join(" ");
const quiet = () => {};

test("fallback in order: timeout, then failure, then ready", async () => {
  const slow = fake("localhost.run"); // never ready
  const broken = fake("tunnelmole", (emit) => setTimeout(() => emit({ type: "down", reason: "connection closed (1006)" }), 5));
  const good = fake("pinggy", (emit) => setTimeout(() => emit({ type: "ready", url: "https://a.example" }), 5));
  const statuses: TunnelStatus[] = [];
  const t = startTunnel("http://127.0.0.1:1", { providers: [slow, broken, good], readyTimeoutMs: 40, onStatus: (s) => statuses.push(s), log: quiet });
  await tick(150);
  assert.deepEqual(statuses.map(brief), ["connecting localhost.run -", "connecting tunnelmole -", "connecting pinggy -", "ready pinggy https://a.example"]);
  assert.equal(slow.stops, 1, "the provider that timed out is stopped");
  assert.equal(broken.stops, 1);
  assert.equal(good.stops, 0);
  assert.deepEqual(brief(t.status()), "ready pinggy https://a.example");
  assert.equal(typeof t.status().since, "number");
  t.stop();
  assert.equal(t.status().state, "off");
  assert.equal(good.stops, 1);
});

test("unavailable providers are skipped without being started", async () => {
  const missing = fake("cloudflared", undefined, false);
  const good = fake("localhost.run", (emit) => emit({ type: "ready", url: "https://b.example" })); // synchronous ready
  const t = startTunnel("http://x", { providers: [missing, good], readyTimeoutMs: 1000, log: quiet });
  await tick();
  assert.equal(missing.starts, 0);
  assert.equal(brief(t.status()), "ready localhost.run https://b.example");
  t.stop();
});

test("a provider that fails synchronously inside start() falls through and is stopped", async () => {
  const bad = fake("localhost.run", (emit) => emit({ type: "down", reason: "ssh not found" }));
  const good = fake("tunnelmole", (emit) => setTimeout(() => emit({ type: "ready", url: "https://c.example" }), 1));
  const t = startTunnel("http://x", { providers: [bad, good], readyTimeoutMs: 1000, log: quiet });
  await tick(20);
  assert.equal(bad.stops, 1);
  assert.equal(brief(t.status()), "ready tunnelmole https://c.example");
  t.stop();
});

test("after a drop the status goes back to connecting and the new URL is republished", async () => {
  const first = fake("localhost.run", (emit, n) => setTimeout(() => emit({ type: "ready", url: `https://drop${n}.example` }), 1));
  const statuses: TunnelStatus[] = [];
  const t = startTunnel("http://x", { providers: [first], readyTimeoutMs: 1000, dropDelayMs: 10, onStatus: (s) => statuses.push(s), log: quiet });
  await tick(20);
  first.emit({ type: "down", reason: "exited (255)" });
  assert.equal(t.status().state, "connecting");
  assert.match(t.status().error ?? "", /dropped: exited \(255\)/);
  await tick(50);
  assert.deepEqual(statuses.map(brief), ["connecting localhost.run -", "ready localhost.run https://drop1.example", "connecting localhost.run -", "ready localhost.run https://drop2.example"]);
  assert.equal(first.starts, 2);
  t.stop();
});

test("a drop restarts from the first provider (the network may have changed)", async () => {
  const preferred = fake("localhost.run", (emit, n) => {
    if (n === 1) emit({ type: "down", reason: "Connection timed out" });
    else setTimeout(() => emit({ type: "ready", url: "https://pref.example" }), 1);
  });
  const backup = fake("pinggy", (emit) => setTimeout(() => emit({ type: "ready", url: "https://backup.example" }), 1));
  const t = startTunnel("http://x", { providers: [preferred, backup], readyTimeoutMs: 1000, dropDelayMs: 5, log: quiet });
  await tick(20);
  assert.equal(brief(t.status()), "ready pinggy https://backup.example");
  backup.emit({ type: "down", reason: "session expired" });
  await tick(30);
  assert.equal(brief(t.status()), "ready localhost.run https://pref.example");
  assert.equal(backup.starts, 1);
  t.stop();
});

test("a URL rotation within one session is published as a new ready URL", async () => {
  const p = fake("localhost.run", (emit) => emit({ type: "ready", url: "https://one.example" }));
  const urls: string[] = [];
  const t = startTunnel("http://x", { providers: [p], onStatus: (s) => s.url && urls.push(s.url), log: quiet });
  p.emit({ type: "ready", url: "https://one.example" });
  p.emit({ type: "ready", url: "https://two.example" });
  assert.deepEqual(urls, ["https://one.example", "https://two.example"]);
  t.stop();
});

test("when every provider fails the state is error (with each reason) and the round is retried", async () => {
  let fail = true;
  const a = fake("localhost.run", (emit) => setTimeout(() => emit(fail ? { type: "down", reason: "port 22 blocked" } : { type: "ready", url: "https://late.example" }), 1));
  const b = fake("tunnelmole", (emit) => emit({ type: "error", message: "websocket error" })); // then times out
  const t = startTunnel("http://x", { providers: [a, b], readyTimeoutMs: 20, retryDelayMs: 40, log: quiet });
  await tick(35);
  assert.equal(t.status().state, "error");
  assert.equal(t.status().error, "localhost.run: port 22 blocked | tunnelmole: not ready after 0.02s; websocket error");
  fail = false;
  await tick(60);
  assert.equal(brief(t.status()), "ready localhost.run https://late.example");
  assert.equal(a.starts, 2);
  t.stop();
});

test("no available provider at all is an error, not a crash", async () => {
  const t = startTunnel("http://x", { providers: [fake("cloudflared", undefined, false)], retryDelayMs: 1000, log: quiet });
  assert.deepEqual([t.status().state, t.status().error], ["error", "no tunnel provider available"]);
  t.stop();
});

test("events from a stopped or abandoned session are ignored", async () => {
  const p = fake("localhost.run");
  const statuses: TunnelStatus[] = [];
  const t = startTunnel("http://x", { providers: [p], readyTimeoutMs: 1000, onStatus: (s) => statuses.push(s), log: quiet });
  const stale = p.emit;
  t.stop();
  stale({ type: "ready", url: "https://ghost.example" });
  stale({ type: "down", reason: "x" });
  assert.deepEqual(statuses.map(brief), ["connecting localhost.run -", "off - -"]);
});

test("default providers follow TUNNEL_PROVIDERS; UNIOVI_TUNNEL_PROVIDERS picks and orders them", () => {
  assert.deepEqual(defaultProviders({ env: {} }).map((p) => p.name), [...TUNNEL_PROVIDERS]);
  assert.deepEqual(defaultProviders({ env: { UNIOVI_TUNNEL_PROVIDERS: "pinggy, tunnelmole,nope" } }).map((p) => p.name), ["pinggy", "tunnelmole"]);
});
