import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { strFromU8, unzipSync } from "fflate";
import { extractText } from "unpdf";
import { absolutePath, readCache, writeCache, type StoredFile } from "./store.ts";

// Plain-text extraction so Claude can read lecture material through MCP.
// PDF pages / PPTX slides are separated by "--- page N ---" / "--- slide N ---" markers.

const decodeXml = (s: string) =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

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

export function kindOf(f: StoredFile): "pdf" | "pptx" | "docx" | "text" | "other" {
  const ext = extname(f.path).toLowerCase();
  if (ext === ".pdf" || f.contentType.includes("pdf")) return "pdf";
  if (ext === ".pptx") return "pptx";
  if (ext === ".docx") return "docx";
  if ([".txt", ".md", ".csv", ".json", ".c", ".java", ".py", ".js", ".ts", ".sql", ".xml", ".html"].includes(ext)) return "text";
  if (f.contentType.startsWith("text/")) return "text";
  return "other";
}

// One extraction per file at a time, shared by tool calls and the background warmer.
const inFlight = new Map<string, Promise<string | null>>();

/** Returns extracted text, or null when the format is not supported. Cached on disk. */
export async function textOf(f: StoredFile): Promise<string | null> {
  const cached = await readCache(f);
  if (cached !== null) return cached;
  const kind = kindOf(f);
  if (kind === "other") return null;
  const id = `${f.key}|${f.timemodified}|${f.size}`;
  let p = inFlight.get(id);
  if (!p) {
    p = (async () => {
      const bytes = new Uint8Array(await readFile(absolutePath(f)));
      const text =
        kind === "pdf" ? await pdfText(bytes)
        : kind === "pptx" ? pptxText(bytes)
        : kind === "docx" ? docxText(bytes)
        : new TextDecoder().decode(bytes);
      await writeCache(f, text);
      return text;
    })().finally(() => inFlight.delete(id));
    inFlight.set(id, p);
  }
  return p;
}

/** Cached text only (null if not extracted yet); never does the slow extraction. */
export function cachedTextOf(f: StoredFile): Promise<string | null> {
  return readCache(f);
}

let warming: Promise<void> | null = null;

/** True while warmTextCache runs; searches then read the cache only instead of competing for the CPU. */
export function isWarming(): boolean {
  return warming !== null;
}

/**
 * Extracts every downloaded file that isn't cached yet, one at a time, in the background.
 * A cold corpus (~300 files) takes over a minute, longer than remote clients wait for one
 * search call, so the server starts this at launch and searches use whatever is ready.
 */
export function warmTextCache(files: StoredFile[]): Promise<void> {
  if (warming) return warming;
  warming = (async () => {
    const started = Date.now();
    let done = 0;
    for (const f of files) {
      if (kindOf(f) === "other" || (await readCache(f)) !== null) continue;
      await textOf(f).catch((err: Error) => console.error(`[extract] ${f.path}: ${err.message}`));
      done++;
    }
    if (done) console.error(`[extract] indexed ${done} files in ${Math.round((Date.now() - started) / 1000)}s`);
  })().finally(() => {
    warming = null;
  });
  return warming;
}
