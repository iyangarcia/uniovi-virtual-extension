// Which campus files the content script downloads and what it does with each response
// (extension/src/download.ts), and that the dev bridge stays silent unless switched on (bridge.ts).
import assert from "node:assert/strict";
import { test } from "node:test";
import type { Resource } from "../../shared/types.ts";
import { DEV_BRIDGE_KEY, devBridgeOn, sendToBridge } from "../../extension/src/bridge.ts";
import { decideResponse, filenameFrom, type KnownFile, needsDownload, readLimited } from "../../extension/src/download.ts";

const MB = 1024 * 1024;
const MAX = 40 * MB;
const CAMPUS = "https://www.campusvirtual.uniovi.es";

const folderFile = (rev: number, filename = "tema1.pdf"): Resource => ({
  key: `12:/${filename}`,
  cmid: 12,
  courseId: 1,
  section: "Tema 1",
  name: "Material",
  modname: "folder",
  url: `${CAMPUS}/pluginfile.php/345/mod_folder/content/${rev}/${filename}?forcedownload=1`,
  filename,
});
const viewResource: Resource = {
  key: "7:/",
  cmid: 7,
  courseId: 1,
  section: "Tema 2",
  name: "Apuntes tema 2",
  modname: "resource",
  url: `${CAMPUS}/mod/resource/view.php?id=7&redirect=1`,
};

const response = (headers: Record<string, string>, url = viewResource.url, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  headers: new Headers(headers),
});

test("needsDownload: readable campus files only, never links or archives", () => {
  assert.equal(needsDownload(folderFile(1), {}, MAX), true);
  assert.equal(needsDownload(viewResource, {}, MAX), true, "type unknown until the redirect: fetch to find out");
  assert.equal(needsDownload({ ...folderFile(1, "x.zip") }, {}, MAX), false);
  assert.equal(needsDownload({ ...folderFile(1, "clase.mp4"), modname: "section-file" }, {}, MAX), false);
  assert.equal(needsDownload({ ...viewResource, modname: "url", key: "9:link" }, {}, MAX), false);
  assert.equal(needsDownload({ ...folderFile(1), filesize: MAX + 1 }, {}, MAX), false, "known oversize");
});

test("needsDownload: already stored or skipped files are not fetched again", () => {
  const r = folderFile(3);
  const stored: Record<string, KnownFile> = { [r.key]: { timemodified: 100, url: r.url } };
  assert.equal(needsDownload(r, stored, MAX), false);
  const skipped: Record<string, KnownFile> = { [viewResource.key]: { timemodified: 0 } };
  assert.equal(needsDownload(viewResource, skipped, MAX), false);
  // A newer timemodified (web-service data) is a new version.
  assert.equal(needsDownload({ ...r, timemodified: 101 }, stored, MAX), true);
  assert.equal(needsDownload({ ...r, timemodified: 100 }, stored, MAX), false);
});

test("needsDownload: a folder file whose URL revision changed is downloaded again", () => {
  const old = folderFile(3);
  const known: Record<string, KnownFile> = { [old.key]: { timemodified: 100, url: old.url } };
  const changed = folderFile(4);
  assert.equal(changed.key, old.key, "the key ignores the revision");
  assert.equal(needsDownload(changed, known, MAX), true);
  // view.php resources keep their URL: unchanged URL, not fetched again.
  const view: Record<string, KnownFile> = { [viewResource.key]: { timemodified: 100, url: viewResource.url } };
  assert.equal(needsDownload(viewResource, view, MAX), false);
  // A skip records no URL: a skipped file is not re-fetched for a URL change.
  assert.equal(needsDownload(changed, { [old.key]: { timemodified: 0 } }, MAX), false);
});

test("decideResponse: readable file is stored, with the name from the headers", () => {
  const d = decideResponse(folderFile(1), response({ "content-type": "application/pdf", "content-length": "2048" }, folderFile(1).url), MAX);
  assert.deepEqual(d, { action: "store", filename: "tema1.pdf", contentType: "application/pdf" });
});

test("decideResponse: unreadable type after the redirect is skipped", () => {
  const d = decideResponse(viewResource, response({ "content-type": "application/zip" }, `${CAMPUS}/pluginfile.php/9/mod_resource/content/1/codigo.zip`), MAX);
  assert.deepEqual(d, { action: "skip", filename: "codigo.zip", reason: "type" });
});

test("decideResponse: after a redirect the file name comes from the final URL or Content-Disposition", () => {
  const byUrl = decideResponse(viewResource, response({ "content-type": "application/pdf" }, `${CAMPUS}/pluginfile.php/9/mod_resource/content/1/Tema%202.pdf`), MAX);
  assert.deepEqual(byUrl, { action: "store", filename: "Tema 2.pdf", contentType: "application/pdf" });
  const byHeader = decideResponse(
    viewResource,
    response({ "content-type": "application/octet-stream", "content-disposition": "attachment; filename*=UTF-8''pr%C3%A1ctica.docx" }, `${CAMPUS}/x`),
    MAX,
  );
  assert.equal(byHeader.action, "store");
  assert.equal((byHeader as { filename: string }).filename, "práctica.docx");
  assert.equal(filenameFrom(response({ "content-disposition": 'inline; filename="guion.pdf"' })), "guion.pdf");
});

test("decideResponse: oversize by Content-Length is skipped before reading the body", () => {
  const d = decideResponse(folderFile(1), response({ "content-type": "application/pdf", "content-length": String(MAX + 1) }), MAX);
  assert.deepEqual(d, { action: "skip", filename: "tema1.pdf", reason: "size" });
  assert.equal(decideResponse(folderFile(1), response({ "content-type": "application/pdf", "content-length": String(MAX) }), MAX).action, "store");
});

test("decideResponse: an HTML page or an error status is a failure (retried later), not a skip", () => {
  assert.deepEqual(decideResponse(viewResource, response({ "content-type": "text/html; charset=utf-8" }), MAX), {
    action: "fail",
    error: "Got an HTML page instead of a file",
  });
  assert.deepEqual(decideResponse(viewResource, response({}, viewResource.url, 404), MAX), { action: "fail", error: "HTTP 404" });
});

function stream(chunks: number[], onCancel?: () => void): ReadableStream<Uint8Array> {
  let i = 0;
  return new ReadableStream<Uint8Array>({
    pull(c) {
      if (i < chunks.length) c.enqueue(new Uint8Array(chunks[i++]!).fill(7));
      else c.close();
    },
    cancel: () => onCancel?.(),
  });
}

test("readLimited: whole body under the limit, cancelled as soon as it passes the limit", async () => {
  const ok = await readLimited(stream([3, 4]), 10);
  assert.deepEqual(ok, new Uint8Array(7).fill(7));
  let cancelled = false;
  const big = await readLimited(stream([6, 6, 6], () => (cancelled = true)), 10);
  assert.equal(big, null);
  assert.equal(cancelled, true, "the download is aborted");
  assert.deepEqual(await readLimited(null, 10), new Uint8Array(0));
});

test("dev bridge: no request at all unless devBridge is exactly true", async () => {
  const calls: string[] = [];
  const fakeFetch = (async (url: string) => {
    calls.push(String(url));
    return new Response("{}", { status: 200 });
  }) as unknown as typeof fetch;
  const init = { method: "POST", body: "{}" };
  for (const stored of [{}, { [DEV_BRIDGE_KEY]: false }, { [DEV_BRIDGE_KEY]: "true" }, { [DEV_BRIDGE_KEY]: 1 }]) {
    assert.equal(devBridgeOn(stored), false);
    assert.equal(await sendToBridge({ isOn: async () => devBridgeOn(stored), fetch: fakeFetch }, "/api/snapshot", init), false);
  }
  assert.deepEqual(calls, [], "students' data never reaches 127.0.0.1");

  const on = { isOn: async () => devBridgeOn({ [DEV_BRIDGE_KEY]: true }), fetch: fakeFetch };
  assert.equal(await sendToBridge(on, "/api/snapshot", init), true);
  assert.deepEqual(calls, ["http://127.0.0.1:47823/api/snapshot"]);
  // On but the dev server isn't running / answers an error: the caller gets an error to swallow.
  await assert.rejects(sendToBridge({ ...on, fetch: (async () => Promise.reject(new TypeError("refused"))) as unknown as typeof fetch }, "/x", init), /not running/);
  await assert.rejects(sendToBridge({ ...on, fetch: (async () => new Response("no", { status: 403 })) as unknown as typeof fetch }, "/x", init), /HTTP 403/);
});
