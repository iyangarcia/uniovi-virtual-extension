// End-to-end check of the relay, run by hand (not part of npm test). In relay/:
//   npx wrangler dev --port 8787 --inspector-port 9239 --var TEST_REQUEST_TIMEOUT_MS:3000
//   node test/e2e.mjs                       # RELAY=http://127.0.0.1:8787 by default
// TEST_REQUEST_TIMEOUT_MS only lowers the 60 s timeout so the 504 check is quick; without it that check
// waits the full minute. Prints PASS/FAIL per check and exits 1 on any failure.

import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { mcpHandler, startNodeAgent } from "./node-agent.mjs";

const RELAY = (process.env.RELAY ?? "http://127.0.0.1:8787").replace(/\/$/, "");
const WS = RELAY.replace(/^http/, "ws");
const b64url = (n) => randomBytes(n).toString("base64url");
const id = b64url(16); // 22 chars
const token = b64url(16); // 22 chars
const secret = b64url(32); // 43 chars

let failures = 0;
function check(name, ok, detail = "") {
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` (${detail})` : ""}`);
}

function createServer() {
  const s = new McpServer({ name: "e2e-dummy", version: "1.0.0" });
  s.registerTool("echo", { description: "Echo text", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: `echo:${text}` }],
  }));
  s.registerTool("add", { description: "Add numbers", inputSchema: { a: z.number(), b: z.number() } }, async ({ a, b }) => ({
    content: [{ type: "text", text: String(a + b) }],
  }));
  s.registerTool("upper", { description: "Upper-case", inputSchema: { text: z.string() } }, async ({ text }) => ({
    content: [{ type: "text", text: text.toUpperCase() }],
  }));
  s.registerTool("big", { description: "N KiB of text", inputSchema: { kib: z.number() } }, async ({ kib }) => ({
    content: [{ type: "text", text: "x".repeat(kib * 1024) }],
  }));
  s.registerTool("hang", { description: "Never answers" }, () => new Promise(() => {}));
  return s;
}

const handle = mcpHandler({ token, createServer });
const mcpUrl = `${RELAY}/mcp/${id}/${token}`;
const post = (url, body, extra = {}) =>
  fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...extra.headers },
    body,
    ...extra.init,
  });
const rpc = (method, params = {}) => JSON.stringify({ jsonrpc: "2.0", id: 1, method, params });

async function main() {
  // Health and plain 404s.
  {
    const r = await fetch(`${RELAY}/`);
    check("GET / health", r.status === 200 && (await r.text()) === "Uniovi Virtual relay", `status ${r.status}`);
    const foo = await fetch(`${RELAY}/foo`);
    check("/foo → 404", foo.status === 404, `status ${foo.status}`);
    const bad = await post(`${RELAY}/mcp/not-a-valid-id/x`, "{}");
    check("/mcp/<bad id>/x → 404", bad.status === 404, `status ${bad.status}`);
    const badAgent = await fetch(`${RELAY}/agent/short`);
    check("/agent/<bad id> → 404", badAgent.status === 404, `status ${badAgent.status}`);
  }

  // No agent yet → 503 with the Spanish JSON-RPC body.
  {
    const r = await post(mcpUrl, rpc("tools/list"));
    const body = await r.text();
    check(
      "no agent ever connected → 503 Spanish JSON-RPC",
      r.status === 503 && r.headers.get("content-type") === "application/json" && JSON.parse(body).error?.message.includes("no está conectado"),
      `status ${r.status}`,
    );
  }

  // A second agent that never pings, started now and checked at the end: its socket goes stale (like after sleep).
  const silentId = b64url(16), silentToken = b64url(16);
  const silent = startNodeAgent({ wsBase: WS, id: silentId, secret: b64url(32), agent: "silent", pingMs: 3_600_000,
    handle: async () => new Response("ok", { headers: { "content-type": "text/plain" } }) });
  const silentAt = Date.now();
  check("silent agent hello → welcome", (await silent.ready).type === "welcome");
  {
    const r = await post(`${RELAY}/mcp/${silentId}/${silentToken}`, "hi");
    check("fresh silent agent still served", r.status === 200, `status ${r.status}`);
  }

  // Agent connects.
  let agent = startNodeAgent({ wsBase: WS, id, secret, handle, agent: "e2e" });
  const hello = await agent.ready;
  check("agent hello → welcome", hello.type === "welcome", JSON.stringify(hello));

  // Ping → pong (auto-response).
  {
    const pong = new Promise((res) => {
      const t = setTimeout(() => res(false), 3000);
      agent.ws.addEventListener("message", (e) => e.data === "pong" && (clearTimeout(t), res(true)));
    });
    agent.ws.send("ping");
    check("ping → pong", await pong);
  }

  // MCP SDK client: initialize, listTools, 10 calls.
  {
    const client = new Client({ name: "e2e-client", version: "1.0.0" });
    await client.connect(new StreamableHTTPClientTransport(new URL(mcpUrl)));
    const tools = await client.listTools();
    const names = tools.tools.map((t) => t.name).sort().join(",");
    check("MCP listTools through the relay", names === "add,big,echo,hang,upper", names);
    let ok = 0;
    for (let i = 0; i < 10; i++) {
      const kind = i % 3;
      try {
        if (kind === 0) {
          const r = await client.callTool({ name: "echo", arguments: { text: `hola ${i} ñ€` } });
          if (r.content[0].text === `echo:hola ${i} ñ€`) ok++;
        } else if (kind === 1) {
          const r = await client.callTool({ name: "add", arguments: { a: i, b: 100 } });
          if (r.content[0].text === String(i + 100)) ok++;
        } else {
          const r = await client.callTool({ name: "upper", arguments: { text: `apuntes ${i}` } });
          if (r.content[0].text === `APUNTES ${i}`) ok++;
        }
      } catch (e) {
        console.error(`  call ${i}: ${e.message}`);
      }
    }
    check("MCP SDK client tool calls", ok === 10, `${ok}/10`);

    try {
      const r = await client.callTool({ name: "big", arguments: { kib: 4096 } });
      check("4 MiB tool response through the relay", r.content[0].text.length === 4096 * 1024);
    } catch (e) {
      check("4 MiB tool response through the relay", false, e.message);
    }
    await client.close();
  }

  // Wrong token → 404 from the agent, through the relay.
  {
    const r = await post(`${RELAY}/mcp/${id}/${b64url(16)}`, rpc("tools/list"));
    check("wrong token → 404 (agent)", r.status === 404, `status ${r.status}`);
  }

  // Header allow-list: a cookie and set-cookie never cross.
  {
    let seen;
    const spy = startNodeAgent({
      wsBase: WS,
      id,
      secret,
      handle: async (req) => {
        seen = Object.fromEntries(req.headers);
        return new Response("ok", { headers: { "content-type": "text/plain", "set-cookie": "a=1", "x-other": "1" } });
      },
    });
    check("second agent with the right secret → welcome", (await spy.ready).type === "welcome");
    const old = await Promise.race([agent.closed, new Promise((r) => setTimeout(() => r(null), 3000))]);
    check("older agent closed 1000 replaced", old?.code === 1000 && old?.reason === "replaced", JSON.stringify(old));
    const r = await post(`${RELAY}/mcp/${id}/${token}/x?q=1`, "hi", { headers: { cookie: "c=1", authorization: "Bearer z", "mcp-session-id": "s1" } });
    const fwd = seen ?? {};
    check(
      "request headers filtered (no cookie/authorization; mcp-session-id kept)",
      !fwd.cookie && !fwd.authorization && fwd["mcp-session-id"] === "s1" && fwd["content-type"] === "application/json",
      Object.keys(fwd).sort().join(","),
    );
    check(
      "response headers filtered (no set-cookie/x-other)",
      r.status === 200 && !r.headers.get("set-cookie") && !r.headers.get("x-other") && (await r.text()) === "ok",
    );
    spy.close();
    await spy.closed;
    agent = startNodeAgent({ wsBase: WS, id, secret, handle, agent: "e2e" });
    check("agent reconnects → welcome", (await agent.ready).type === "welcome");
  }

  // Wrong secret → rejected.
  {
    const intruder = startNodeAgent({ wsBase: WS, id, secret: b64url(32), handle });
    const res = await intruder.ready;
    const closed = await intruder.closed;
    check("wrong secret → rejected bad-secret, close 1008", res.type === "rejected" && res.reason === "bad-secret" && closed.code === 1008, `${JSON.stringify(res)} ${closed.code}`);
    const still = await post(mcpUrl, rpc("tools/list"));
    check("legit agent still serving after the intruder", still.status === 200, `status ${still.status}`);
  }

  // Bad hello → rejected.
  {
    const ws = new WebSocket(`${WS}/agent/${b64url(16)}`);
    const msg = await new Promise((res) => {
      ws.addEventListener("open", () => ws.send(JSON.stringify({ type: "hello", v: 99, secret })));
      ws.addEventListener("message", (e) => res(e.data));
      setTimeout(() => res(null), 3000);
    });
    check("wrong protocol version → rejected protocol", msg && JSON.parse(msg).reason === "protocol", String(msg));
    ws.close();
  }

  // Body limits → 413.
  {
    const nine = new Uint8Array(9 * 1024 * 1024).fill(32);
    const r = await post(mcpUrl, nine);
    check("9 MB body (content-length) → 413", r.status === 413, `status ${r.status}`);
    const stream = new ReadableStream({
      start(c) {
        for (let i = 0; i < 9; i++) c.enqueue(new Uint8Array(1024 * 1024).fill(32));
        c.close();
      },
    });
    const r2 = await post(mcpUrl, stream, { init: { duplex: "half" } });
    check("9 MB body (chunked, no content-length) → 413", r2.status === 413, `status ${r2.status}`);
  }

  // An agent whose response header can't make an HTTP response (newline in the value) → 502 at once,
  // not a request left hanging (settle() has already dropped it from `pending` by then).
  {
    const badId = b64url(16);
    const ws = new WebSocket(`${WS}/agent/${badId}`);
    await new Promise((res, rej) => {
      ws.onerror = rej;
      ws.onopen = () => ws.send(JSON.stringify({ type: "hello", v: 1, secret: b64url(32), agent: "e2e-bad" }));
      ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.type === "welcome") return res();
        if (m.type === "request")
          ws.send(JSON.stringify({ type: "response", rid: m.rid, status: 200, headers: { "content-type": `text/plain${String.fromCharCode(13, 10)}x-evil: 1` }, body: Buffer.from("hi").toString("base64") }));
      };
    });
    const t0 = Date.now();
    // Before the fix this request hung forever; the abort turns that into a clear failure.
    const r = await post(`${RELAY}/mcp/${badId}/${token}`, rpc("tools/list"), { init: { signal: AbortSignal.timeout(8000) } }).catch((e) => ({ status: e.name, headers: new Headers() }));
    const ms = Date.now() - t0;
    check("malformed agent response header → 502 at once", r.status === 502 && !r.headers.get("x-evil") && ms < 2500, `status ${r.status} after ${ms} ms`);
    ws.close();
  }

  // Timeout → 504 (hang tool).
  {
    const t0 = Date.now();
    const r = await post(mcpUrl, rpc("tools/call", { name: "hang", arguments: {} }));
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    check("agent never answers → 504", r.status === 504, `status ${r.status} after ${s} s`);
  }

  // Agent closes while a request is pending → 503 at once, not after the timeout.
  {
    const t0 = Date.now();
    const pending = post(mcpUrl, rpc("tools/call", { name: "hang", arguments: {} }));
    await new Promise((r) => setTimeout(r, 300));
    agent.close();
    const r = await pending;
    const ms = Date.now() - t0;
    const body = await r.text();
    check("agent closes mid-request → 503 Spanish body at once", r.status === 503 && body.includes("no está conectado") && ms < 2500, `status ${r.status} after ${ms} ms`);
  }

  // Agent disconnected → 503.
  {
    await agent.closed;
    const r = await post(mcpUrl, rpc("tools/list"));
    const body = await r.text();
    let msg = "";
    try {
      msg = JSON.parse(body).error.message;
    } catch {}
    check(
      "agent disconnected → 503 Spanish JSON-RPC",
      r.status === 503 && r.headers.get("content-type") === "application/json" && msg.startsWith("Uniovi Virtual no está conectado"),
      `status ${r.status}`,
    );
  }

  // Rate limit (fresh id so it doesn't affect the rest).
  {
    const url = `${RELAY}/mcp/${b64url(16)}/${token}`;
    const statuses = [];
    for (let i = 0; i < 121; i++) statuses.push((await post(url, "{}")).status);
    check("121st request in a minute → 429", statuses.slice(0, 120).every((s) => s === 503) && statuses[120] === 429, `last ${statuses[120]}`);
  }

  // Hello timeout: a socket that never says hello gets `rejected` after ~10 s. (In wrangler dev the close
  // handshake for this timer-driven close only completes ~10 s later; the rejection is what the agent acts on.)
  {
    const t0 = Date.now();
    const ws = new WebSocket(`${WS}/agent/${b64url(16)}`);
    const msg = await new Promise((res) => {
      ws.addEventListener("message", (e) => res(e.data));
      setTimeout(() => res(null), 15_000);
    });
    const s = ((Date.now() - t0) / 1000).toFixed(1);
    check("no hello → rejected bad-hello after ~10 s", msg && JSON.parse(msg).reason === "bad-hello" && Date.now() - t0 >= 9_500, `${msg} after ${s} s`);
    ws.close();
  }

  // Stale socket (no ping for 2 × 20 s + 5 s) → 503 at once, and the relay closes it, instead of a 60 s wait.
  {
    const wait = silentAt + 46_000 - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    const t0 = Date.now();
    const r = await post(`${RELAY}/mcp/${silentId}/${silentToken}`, "hi");
    const ms = Date.now() - t0;
    const closed = await Promise.race([silent.closed, new Promise((res) => setTimeout(() => res(null), 3000))]);
    check("stale agent → 503 at once, socket closed", r.status === 503 && ms < 2500 && closed?.reason === "stale", `status ${r.status} after ${ms} ms, ${JSON.stringify(closed)}`);
  }
}

try {
  await main();
} catch (e) {
  failures++;
  console.log(`FAIL unexpected error: ${e.stack ?? e}`);
}
console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
process.exit(failures ? 1 : 0);
