import { strFromU8, unzipSync } from "fflate";
import { extractText } from "unpdf";
import type { DataStore, StoredFile } from "./store.ts";

// Plain-text extraction so an AI can read lecture material through MCP. Storage-independent: the
// bytes and the text cache come from a DataStore (files on disk in the server, IndexedDB in the
// extension). No node: imports here; this module is bundled into the extension too.
// PDF pages / PPTX slides are separated by "--- page N ---" / "--- slide N ---" markers.

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Extension of the last path segment, with the dot ("" if none), like node:path's extname. */
export function extname(path: string): string {
  const base = path.slice(path.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot) : "";
}

async function pdfText(bytes: Uint8Array): Promise<string> {
  const { text } = await extractText(bytes, { mergePages: false });
  return text.map((t, i) => `--- page ${i + 1} ---\n${t.trim()}`).join("\n\n");
}

function officeXmlText(xml: string, paragraphTag: string, textTag: string): string {
  return xml
    .split(new RegExp(`</${paragraphTag}>`))
    .map((para) =>
      [...para.matchAll(new RegExp(`<${textTag}(?:\\s[^>]*)?>([^<]*)</${textTag}>`, "g"))].map((m) => decodeXml(m[1]!)).join(""),
    )
    .filter((l) => l.trim())
    .join("\n");
}

function pptxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/(slides|notesSlides)\/\w+\d+\.xml$/.test(f.name) });
  const num = (name: string) => Number(/(\d+)\.xml$/.exec(name)?.[1] ?? 0);
  const slides = Object.keys(files)
    .filter((n) => n.startsWith("ppt/slides/"))
    .sort((a, b) => num(a) - num(b));
  return slides
    .map((name) => {
      const body = officeXmlText(strFromU8(files[name]!), "a:p", "a:t");
      const notesName = `ppt/notesSlides/notesSlide${num(name)}.xml`;
      const notes = files[notesName] ? officeXmlText(strFromU8(files[notesName]), "a:p", "a:t") : "";
      return `--- slide ${num(name)} ---\n${body}${notes ? `\n[notes] ${notes}` : ""}`;
    })
    .join("\n\n");
}

function docxText(bytes: Uint8Array): string {
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" });
  const xml = files["word/document.xml"];
  return xml ? officeXmlText(strFromU8(xml), "w:p", "w:t") : "";
}

export type FileKind = "pdf" | "pptx" | "docx" | "text" | "other";

export function kindOf(f: Pick<StoredFile, "path" | "contentType">): FileKind {
  const ext = extname(f.path).toLowerCase();
  if (ext === ".pdf" || f.contentType.includes("pdf")) return "pdf";
  if (ext === ".pptx") return "pptx";
  if (ext === ".docx") return "docx";
  if ([".txt", ".md", ".csv", ".json", ".c", ".java", ".py", ".js", ".ts", ".sql", ".xml", ".html"].includes(ext)) return "text";
  if (f.contentType.startsWith("text/")) return "text";
  return "other";
}

/** Extracts text from raw bytes of the given kind (no caching). */
export async function extractBytes(kind: Exclude<FileKind, "other">, bytes: Uint8Array): Promise<string> {
  return kind === "pdf" ? await pdfText(bytes)
    : kind === "pptx" ? pptxText(bytes)
    : kind === "docx" ? docxText(bytes)
    : new TextDecoder().decode(bytes);
}

// Per-store state (the extension and the server are two runtimes, and tests use several stores).
// One extraction per file at a time, shared by tool calls and the background warmer.
const inFlightByStore = new WeakMap<DataStore, Map<string, Promise<string | null>>>();
const warmingByStore = new WeakMap<DataStore, Promise<void>>();

function inFlightOf(store: DataStore): Map<string, Promise<string | null>> {
  let m = inFlightByStore.get(store);
  if (!m) inFlightByStore.set(store, (m = new Map()));
  return m;
}

/** Returns extracted text, or null when the format is not supported. Cached in the store. */
export async function textOf(store: DataStore, f: StoredFile): Promise<string | null> {
  const cached = await store.readText(f);
  if (cached !== null) return cached;
  const kind = kindOf(f);
  if (kind === "other") return null;
  const inFlight = inFlightOf(store);
  const id = `${f.key}|${f.timemodified}|${f.size}`;
  let p = inFlight.get(id);
  if (!p) {
    p = (async () => {
      const text = await extractBytes(kind, await store.bytes(f));
      await store.writeText(f, text);
      return text;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

/** Cached text only (null if not extracted yet); never does the slow extraction. */
export function cachedTextOf(store: DataStore, f: StoredFile): Promise<string | null> {
  return store.readText(f);
}

/** True while warmTextCache runs on this store; searches then read the cache only instead of competing for the CPU. */
export function isWarming(store: DataStore): boolean {
  return warmingByStore.has(store);
}

/**
 * Extracts every stored file that isn't cached yet, one at a time, in the background.
 * A cold corpus (~300 files) takes over a minute, longer than remote clients wait for one
 * search call, so the server starts this at launch and searches use whatever is ready.
 */
export function warmTextCache(store: DataStore, files: StoredFile[]): Promise<void> {
  const running = warmingByStore.get(store);
  if (running) return running;
  const warming = (async () => {
    const started = Date.now();
    let done = 0;
    for (const f of files) {
      if (kindOf(f) === "other" || (await store.readText(f)) !== null) continue;
      await textOf(store, f).catch((err: Error) => console.error(`[extract] ${f.path}: ${err.message}`));
      done++;
    }
    if (done) console.error(`[extract] indexed ${done} files in ${Math.round((Date.now() - started) / 1000)}s`);
  })().finally(() => {
    warmingByStore.delete(store);
  });
  warmingByStore.set(store, warming);
  return warming;
}
