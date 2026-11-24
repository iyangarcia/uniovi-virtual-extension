// Which campus files the content script downloads, and what it does with each response (pure;
// server/test imports it). content.ts does the fetching and messaging.
import type { Resource } from "../../shared/types.ts";
import { isCampusFile, isReadableFile } from "./readable.ts";

/** What the extension already has for a resource key: a stored file (with its campus URL) or a deliberate skip. */
export interface KnownFile {
  timemodified: number;
  /** Campus URL the stored copy came from; absent for skipped files. */
  url?: string;
}

/** Should this snapshot resource be fetched now? */
export function needsDownload(r: Resource, known: Record<string, KnownFile>, maxBytes: number): boolean {
  if (!isCampusFile(r)) return false;
  if (r.filesize !== undefined && r.filesize > maxBytes) return false;
  // Archives, binaries and media named as such on the campus page: listed as campus links, never fetched.
  if (isReadableFile(r) === false) return false;
  const k = known[r.key];
  if (!k) return true;
  if (r.timemodified !== undefined && r.timemodified > k.timemodified) return true;
  // Files scraped from HTML have no timemodified. Folder file URLs carry the folder revision
  // (/mod_folder/content/<rev>/), so a different URL for the same key is a new version.
  // `/mod/resource/view.php` links and section files keep their URL: a change there goes unnoticed.
  return k.url !== undefined && k.url !== r.url;
}

/** The parts of a fetch Response the decision needs (a real Response fits). */
export interface ResponseInfo {
  ok: boolean;
  status: number;
  /** Final URL, after redirects. */
  url: string;
  headers: { get(name: string): string | null };
}

export type ResponseDecision =
  /** Not a file (error status, or an HTML page such as the login form): try again next time. */
  | { action: "fail"; error: string }
  /** Recorded as a campus link and not fetched again until its key or timemodified changes. */
  | { action: "skip"; filename: string; reason: "type" | "size" }
  /** Read the body (with readLimited) and store it. */
  | { action: "store"; filename: string; contentType: string };

/** Decides from the status and headers alone, before any of the body is read. */
export function decideResponse(r: Resource, res: ResponseInfo, maxBytes: number): ResponseDecision {
  if (!res.ok) return { action: "fail", error: `HTTP ${res.status}` };
  const contentType = res.headers.get("content-type") ?? "application/octet-stream";
  // A resource set to "embed"/"open" without redirect, or a login page, comes back as HTML.
  if (contentType.toLowerCase().startsWith("text/html")) return { action: "fail", error: "Got an HTML page instead of a file" };
  const filename = r.filename ?? filenameFrom(res) ?? r.name;
  // `/mod/resource/view.php` links only reveal the file name and type after the redirect.
  if (isReadableFile({ filename, mimetype: contentType.split(";")[0] }) !== true) return { action: "skip", filename, reason: "type" };
  const length = Number(res.headers.get("content-length"));
  if (Number.isFinite(length) && length > maxBytes) return { action: "skip", filename, reason: "size" };
  return { action: "store", filename, contentType };
}

/** File name from Content-Disposition, else the last segment of the final URL. */
export function filenameFrom(res: Pick<ResponseInfo, "url" | "headers">): string | undefined {
  const cd = res.headers.get("content-disposition") ?? "";
  const star = /filename\*=(?:UTF-8'')?([^;]+)/i.exec(cd)?.[1];
  if (star) return decodeURIComponent(star.replace(/"/g, ""));
  const plain = /filename="?([^";]+)"?/i.exec(cd)?.[1];
  if (plain) return plain;
  try {
    const last = new URL(res.url).pathname.split("/").pop();
    return last ? decodeURIComponent(last) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Reads a body up to maxBytes. Past the limit (no or wrong Content-Length) it cancels the download
 * and returns null, so a huge file is never held in memory.
 */
export async function readLimited(body: ReadableStream<Uint8Array> | null, maxBytes: number): Promise<Uint8Array | null> {
  if (!body) return new Uint8Array(0);
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}
