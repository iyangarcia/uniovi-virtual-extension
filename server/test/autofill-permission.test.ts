// autofill/index.ts autoConnect(): the AI site's host permission is given back after every fill,
// whatever happened, and never touched for dev fixtures. Runs against a stubbed `chrome`.
import assert from "node:assert/strict";
import { test } from "node:test";
import { claude } from "../../extension/src/autofill/claude.ts";
import type { AutofillSpec } from "../../extension/src/autofill/types.ts";

type AutoConnect = (spec: AutofillSpec, url: string, permission: Promise<boolean>, startUrl?: string) => Promise<{ ok: boolean; reason?: string }>;

function stubChrome(fill: () => Promise<unknown>) {
  const removed: string[][] = [];
  (globalThis as Record<string, unknown>).chrome = {
    tabs: {
      create: async () => ({ id: 7 }),
      get: async () => ({ status: "complete" }),
      onUpdated: { addListener: () => undefined, removeListener: () => undefined },
    },
    scripting: { executeScript: async () => [{ result: await fill() }] },
    permissions: {
      remove: async ({ origins }: { origins: string[] }) => {
        removed.push(origins);
        return true;
      },
    },
  };
  return removed;
}

// A non-literal specifier: the server tsconfig has no chrome types, so tsc must not follow it.
const modPath = "../../extension/src/autofill/index.ts";
const { autoConnect } = (await import(modPath)) as { autoConnect: AutoConnect };

test("permission removed after a successful fill", async () => {
  const removed = stubChrome(async () => ({ ok: true, url: true, name: true, trace: [] }));
  const out = await autoConnect(claude, "https://relay/mcp/a/b", Promise.resolve(true));
  assert.equal(out.ok, true);
  assert.deepEqual(removed, [[claude.origin]]);
});

test("permission removed after a failed or throwing fill", async () => {
  let removed = stubChrome(async () => ({ ok: false, url: false, name: false, trace: [] }));
  assert.equal((await autoConnect(claude, "u", Promise.resolve(true))).reason, "fill");
  assert.deepEqual(removed, [[claude.origin]]);
  removed = stubChrome(async () => {
    throw new Error("Cannot access contents of the page");
  });
  assert.equal((await autoConnect(claude, "u", Promise.resolve(true))).reason, "fill");
  assert.deepEqual(removed, [[claude.origin]]);
});

test("nothing to remove when the permission was refused; dev fixture URLs are left alone", async () => {
  let removed = stubChrome(async () => ({ ok: true, url: true, name: true, trace: [] }));
  assert.equal((await autoConnect(claude, "u", Promise.resolve(false))).reason, "permission");
  assert.deepEqual(removed, []);
  removed = stubChrome(async () => ({ ok: true, url: true, name: true, trace: [] }));
  assert.equal((await autoConnect(claude, "u", Promise.resolve(true), "https://campusvirtual.uniovi.es/__fixture/claude.html")).ok, true);
  assert.deepEqual(removed, []);
});
