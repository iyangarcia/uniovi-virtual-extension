import assert from "node:assert/strict";
import { test } from "node:test";
import { deriveHelperView, isHostNotFound, type NativeProbe, remoteUrlChange } from "../../extension/src/helperState.ts";
import type { NativeStatus } from "../../shared/helper.ts";
import type { BridgeStatus } from "../../shared/types.ts";

// Popup state derivation and the URL-change notification rule (extension/src/helperState.ts, no chrome APIs).

const native = (running: boolean, tunnel = true): NativeProbe => ({
  kind: "ok",
  status: { installed: true, hostVersion: "0.1.0", running, ...(running ? { pid: 42 } : {}), config: { tunnel }, dataDir: "C:\\Users\\a\\Documents\\Uniovi" } satisfies NativeStatus,
});
const URL = "https://abc.tunnelmole.net/mcp/secret";
const bridge = (extra: Partial<BridgeStatus> = {}): BridgeStatus => ({ ok: true, version: "0.1.0", dataDir: "C:\\d", knownFiles: {}, ...extra });

test("not installed: no controls; a developer bridge is still shown", () => {
  const v = deriveHelperView({ kind: "not-installed" }, undefined);
  assert.equal(v.state, "not-installed");
  assert.equal(v.controllable, false);
  const dev = deriveHelperView({ kind: "not-installed" }, bridge({ remoteUrl: URL }));
  assert.deepEqual([dev.state, dev.url, dev.controllable], ["ready", URL, false]);
  const local = deriveHelperView({ kind: "not-installed" }, bridge());
  assert.deepEqual([local.state, local.tunnelOff], ["ready", true]);
});

test("stopped / starting", () => {
  const stopped = deriveHelperView(native(false), undefined);
  assert.deepEqual([stopped.state, stopped.running, stopped.controllable, stopped.dataDir], ["stopped", false, true, "C:\\Users\\a\\Documents\\Uniovi"]);
  assert.equal(deriveHelperView(native(true), undefined).state, "connecting");
});

test("tunnel states from /api/status", () => {
  const at = (tunnel: BridgeStatus["tunnel"], remoteUrl?: string) => deriveHelperView(native(true), bridge({ tunnel, ...(remoteUrl ? { remoteUrl } : {}) }));
  assert.deepEqual(at({ state: "connecting", provider: "tunnelmole" }), {
    state: "connecting", controllable: true, running: true, provider: "tunnelmole", tunnelOff: false, dataDir: "C:\\Users\\a\\Documents\\Uniovi",
  });
  const ready = at({ state: "ready", provider: "localhost.run", url: "https://x.lhr.life" }, URL);
  assert.deepEqual([ready.state, ready.url, ready.provider], ["ready", URL, "localhost.run"]);
  // Ready tunnel but the connector URL (with its secret path) not published yet.
  assert.equal(at({ state: "ready", url: "https://x.lhr.life" }).state, "connecting");
  const err = at({ state: "error", error: "ssh: connect timed out" });
  assert.deepEqual([err.state, err.detail], ["error", "ssh: connect timed out"]);
  const off = at({ state: "off" });
  assert.deepEqual([off.state, off.tunnelOff, off.url], ["ready", true, undefined]);
});

test("no tunnel field (older helper): falls back to remoteUrl presence", () => {
  assert.equal(deriveHelperView(native(true), bridge({ remoteUrl: URL })).state, "ready");
  assert.equal(deriveHelperView(native(true), bridge()).state, "connecting");
  assert.equal(deriveHelperView(native(true, false), bridge()).state, "ready");
});

test("host error", () => {
  const v = deriveHelperView({ kind: "error", error: "Access to the specified native messaging host is forbidden." }, undefined);
  assert.deepEqual([v.state, v.controllable], ["error", false]);
  assert.equal(isHostNotFound("Specified native messaging host not found."), true);
  assert.equal(isHostNotFound("Access to the specified native messaging host is forbidden."), false);
  assert.equal(isHostNotFound("Native host has exited."), false);
});

test("URL change notification: once per change, never for the first URL or a URL coming back", () => {
  const steps: [string | undefined, boolean][] = [
    [undefined, false], // helper not running
    ["https://a/mcp/t", false], // first URL ever: the student copies it from the popup
    ["https://a/mcp/t", false],
    [undefined, false], // helper stopped
    ["https://a/mcp/t", false], // same URL back
    ["https://b/mcp/t", true], // changed: notify
    ["https://b/mcp/t", false], // once
    ["https://c/mcp/t", true],
  ];
  let known: string | undefined;
  for (const [current, expected] of steps) {
    const r = remoteUrlChange(known, current);
    assert.equal(r.notify, expected, String(current));
    known = r.known;
  }
  assert.equal(known, "https://c/mcp/t");
});

test("helper stopped while another process (Claude's npm run mcp) owns the bridge: stopped, so Iniciar shows", () => {
  const v = deriveHelperView(native(false), bridge());
  assert.deepEqual([v.state, v.running, v.controllable], ["stopped", false, true]);
  assert.ok(v.detail);
  // Even if that bridge reports a URL from an earlier run, the host's word wins.
  assert.equal(deriveHelperView(native(false), bridge({ remoteUrl: URL })).state, "stopped");
});
