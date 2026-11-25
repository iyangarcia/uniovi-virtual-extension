import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chatgpt } from "../../extension/src/autofill/chatgpt.ts";
import { claude } from "../../extension/src/autofill/claude.ts";
import { gemini } from "../../extension/src/autofill/gemini.ts";
import { formatBytes, lastSyncLabel, statusSentence } from "../../extension/src/ui/status.ts";
import { CHECK_EVERY_MS, isNewer, parseVersion, pendingUpdate, shouldCheck, updateFromRelease } from "../../extension/src/ui/update.ts";
import { DOWNLOAD_PAGE } from "../../shared/release.ts";

// Pure parts of the student-facing UI (extension/src/ui/, extension/src/autofill/*.ts specs).

const at = (state: "off" | "connecting" | "connected" | "rejected" | "offline", error?: string) => ({ state, since: 0, ...(error ? { error } : {}) });

test("status sentence: connected with and without data, connecting, off, errors", () => {
  assert.deepEqual(statusSentence({ enabled: true, agent: at("connected"), synced: true }), { tone: "ok", text: "✓ Tu IA ya puede ver tus apuntes" });
  const noData = statusSentence({ enabled: true, agent: at("connected"), synced: false });
  assert.equal(noData.tone, "ok");
  assert.match(noData.hint!, /Abre el Campus Virtual/);
  assert.equal(statusSentence({ enabled: true, agent: at("connecting"), synced: true }).text, "Conectando…");
  assert.equal(statusSentence({ enabled: true, synced: false }).text, "Conectando…"); // nothing written yet
  assert.equal(statusSentence({ enabled: true, agent: at("off"), synced: true }).text, "Conectando…"); // switched back on, starting
  const off = statusSentence({ enabled: false, agent: at("connected"), synced: true });
  assert.deepEqual([off.tone, off.text], ["off", "Apagado: actívalo en el botón de la extensión"]);
  assert.equal(statusSentence({ enabled: true, agent: at("offline", "socket closed"), synced: true }).tone, "error");
  const rejected = statusSentence({ enabled: true, agent: at("rejected", "bad-secret"), synced: true });
  assert.equal(rejected.tone, "error");
  assert.match(rejected.hint!, /Conectar con mi IA/);
  // «Cambiar enlace» gives a new id, so the relay's fresh Durable Object accepts us (agent/identity.ts).
  assert.match(rejected.hint!, /Cambiar enlace.*enlace nuevo/);
});

test("no technical words in what the student reads", () => {
  const states = ["off", "connecting", "connected", "rejected", "offline"] as const;
  for (const enabled of [true, false])
    for (const s of states)
      for (const synced of [true, false]) {
        const v = statusSentence({ enabled, agent: at(s, "ws error 1006"), synced });
        assert.doesNotMatch(`${v.text} ${v.hint ?? ""}`, /servidor|t[uú]nel|relay|node|helper|socket|1006/i);
      }
  for (const file of ["popup.html", "welcome.html"]) {
    const html = readFileSync(new URL(`../../extension/src/${file}`, import.meta.url), "utf8");
    // Outside "Opciones avanzadas" (popup) and the maintainer-only notice (welcome).
    const visible = html.replace(/<style>[\s\S]*?<\/style>/, "").replace(/<details[\s\S]*?<\/details>/, "").replace(/<div id="maint"[\s\S]*?<\/div>/, "");
    assert.doesNotMatch(visible.replace(/<[^>]+>/g, " "), /servidor|t[uú]nel|relay|\bnode\b|helper/i, file);
  }
});

test("last sync label and sizes", () => {
  const now = Date.parse("2026-11-24T12:00:00Z");
  assert.match(lastSyncLabel(undefined, now), /Abre el Campus Virtual/);
  assert.equal(lastSyncLabel(now - 10_000, now), "Última actualización: ahora mismo");
  assert.equal(lastSyncLabel(now - 5 * 60_000, now), "Última actualización: hace 5 minutos");
  assert.equal(lastSyncLabel(now - 86400_000, now), "Última actualización: ayer");
  assert.equal(formatBytes(512), "512 B");
  assert.equal(formatBytes(250 * 1024 * 1024), "250.0 MB");
});

test("version parsing and compare", () => {
  assert.deepEqual(parseVersion("v1.2.3"), [1, 2, 3, 0]);
  assert.deepEqual(parseVersion("0.3"), [0, 3, 0, 0]);
  assert.deepEqual(parseVersion("1.2.3-beta.1"), [1, 2, 3, 0]);
  assert.equal(parseVersion("latest"), undefined);
  assert.equal(parseVersion(undefined), undefined);
  assert.equal(isNewer("v0.3.0", "0.2.0"), true);
  assert.equal(isNewer("0.2.1", "0.2.0"), true);
  assert.equal(isNewer("0.10.0", "0.9.9"), true); // numeric, not string compare
  assert.equal(isNewer("v0.2.0", "0.2.0"), false);
  assert.equal(isNewer("0.2", "0.2.0"), false);
  assert.equal(isNewer("0.1.9", "0.2.0"), false);
  assert.equal(isNewer("nonsense", "0.2.0"), false);
});

test("update check throttle: once a day", () => {
  const now = 1_800_000_000_000;
  assert.equal(shouldCheck(undefined, now), true);
  assert.equal(shouldCheck(now - 1000, now), false);
  assert.equal(shouldCheck(now - CHECK_EVERY_MS + 1, now), false);
  assert.equal(shouldCheck(now - CHECK_EVERY_MS, now), true);
  assert.equal(shouldCheck(now + 3600_000, now), true); // clock moved backwards
  assert.equal(shouldCheck("yesterday", now), true);
});

test("update from a GitHub release body", () => {
  const asset = { name: "uniovi-virtual-0.3.0.zip", browser_download_url: "https://github.com/iyangarcia/uniovi-virtual-extension/releases/download/v0.3.0/uniovi-virtual-0.3.0.zip" };
  const rel = { tag_name: "v0.3.0", html_url: "https://github.com/iyangarcia/uniovi-virtual-extension/releases/tag/v0.3.0", assets: [asset] };
  assert.deepEqual(updateFromRelease(rel, "0.2.0"), { version: "0.3.0", url: asset.browser_download_url });
  assert.deepEqual(updateFromRelease({ ...rel, assets: [] }, "0.2.0"), { version: "0.3.0", url: rel.html_url });
  assert.deepEqual(updateFromRelease({ tag_name: "0.3.0", html_url: "https://evil.example/x" }, "0.2.0"), { version: "0.3.0", url: DOWNLOAD_PAGE });
  assert.equal(updateFromRelease(rel, "0.3.0"), undefined);
  assert.equal(updateFromRelease({ ...rel, draft: true }, "0.2.0"), undefined);
  assert.equal(updateFromRelease({ ...rel, prerelease: true }, "0.2.0"), undefined);
  assert.equal(updateFromRelease({ message: "Not Found" }, "0.2.0"), undefined);
  assert.equal(updateFromRelease(null, "0.2.0"), undefined);
  // Stored notice disappears once the running version caught up.
  const stored = { version: "0.3.0", url: rel.html_url };
  assert.deepEqual(pendingUpdate(stored, "0.2.0"), stored);
  assert.equal(pendingUpdate(stored, "0.3.0"), undefined);
  assert.equal(pendingUpdate({ version: "9.0.0", url: "javascript:alert(1)" }, "0.2.0"), undefined);
});

// Buttons the auto-fill must never press, whether as a step or as a wizard's advance button.
const CONFIRM = /^=?(add|anadir|añadir|agregar|create|crear|save|guardar|confirm|confirmar|connect|conectar|done|listo|finish|finalizar|submit|enviar|ok|aceptar|allow|permitir|continue|continuar)$/;

test("auto-fill specs: https origins declared as optional host permissions, start page on that origin", () => {
  const manifest = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8")) as {
    permissions: string[];
    host_permissions: string[];
    optional_host_permissions: string[];
  };
  assert.ok(!manifest.permissions.includes("nativeMessaging"));
  for (const spec of [claude, chatgpt, gemini]) {
    assert.ok(manifest.optional_host_permissions.includes(spec.origin), spec.id);
    assert.ok(!manifest.host_permissions.includes(spec.origin), `${spec.id} must not be an install-time permission`);
    assert.equal(new URL(spec.startUrl).origin + "/*", spec.origin);
    assert.ok(spec.steps.length > 0 && spec.urlField.length > 0 && spec.nameField.length > 0);
    // Specs travel to the page as executeScript args: they must survive JSON.
    assert.deepEqual(JSON.parse(JSON.stringify(spec)), spec);
    // Never a pattern that could be the AI's own final confirm button: not as a step, not as an
    // advance ("Next") button, exact or substring.
    for (const p of [...spec.steps.flatMap((s) => s.texts), ...(spec.advance ?? [])]) assert.doesNotMatch(p, CONFIRM, `${spec.id}: ${p}`);
    // Advance buttons are exact matches only, and the name watcher has a sane lifetime.
    for (const p of spec.advance ?? []) assert.ok(p.startsWith("=") && p.length > 1, `${spec.id}: advance "${p}" must be exact`);
    // A step allowed inside a dialog with fields must have exact texts (only those are used there).
    for (const s of spec.steps) if (s.inDialog) assert.ok(s.texts.some((p) => p.startsWith("=")), `${spec.id}: inDialog step needs "=" texts`);
    assert.ok(spec.nameLaterMs === undefined || (spec.nameLaterMs >= 30_000 && spec.nameLaterMs <= 300_000), `${spec.id}: nameLaterMs`);
  }
  // Only Gemini's wizard needs the multi-screen extras; Claude and ChatGPT keep the one-screen flow.
  assert.ok(gemini.advance?.length && gemini.nameLaterMs && gemini.confirmLabel && gemini.steps.some((s) => s.inDialog));
  for (const spec of [claude, chatgpt]) assert.ok(spec.advance === undefined && spec.nameLaterMs === undefined && !spec.steps.some((s) => s.inDialog), spec.id);
});

test("root package.json carries the extension's name and version", () => {
  const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8")) as { name: string; version: string };
  const manifest = JSON.parse(readFileSync(new URL("../../extension/manifest.json", import.meta.url), "utf8")) as { version: string };
  assert.equal(pkg.name, "uniovi-virtual");
  assert.equal(pkg.version, manifest.version);
});
