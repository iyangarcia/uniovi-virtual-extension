import { strFromU8, unzipSync } from "fflate";
import { extractText } from "unpdf";
import { type FileKind, kindOf } from "./kind.ts";
import type { DataStore, StoredFile } from "./store.ts";

export { extname, type FileKind, kindOf } from "./kind.ts";

// Plain-text extraction so an AI can read lecture material through MCP. Storage-independent: the
// bytes and the text cache come from a DataStore (files on disk in the server, IndexedDB in the
// extension). No node: imports here; this module is bundled into the extension too.
// PDF pages / PPTX slides / XLSX sheets are separated by "--- page N ---" / "--- slide N ---" /
// "--- sheet <name> ---" markers.

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
  const files = unzipSync(bytes, { filter: (f) => /^ppt\/(slides|notesSlides)\/\w+\d+\.xml$/.test(f.name) && f.originalSize <= MAX_ZIP_PART });
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
  const files = unzipSync(bytes, { filter: (f) => f.name === "word/document.xml" && f.originalSize <= MAX_ZIP_PART });
  const xml = files["word/document.xml"];
  return xml ? officeXmlText(strFromU8(xml), "w:p", "w:t") : "";
}

// ---------------------------------------------------------------- xlsx
// A spreadsheet becomes "--- sheet <name> ---" blocks, one line per non-empty row, cells joined with
// " | " in column order. Read with regexes like the other Office formats: tolerant of prefixes and
// odd XML, and a missing part only loses what it would have added (never throws).

/** Upper bound of a spreadsheet's text: a sheet of exported data can be huge, and nobody reads past this. */
export const XLSX_MAX_CHARS = 2_000_000;
/** Office parts larger than this once unzipped are skipped (a ~1 MB zip bomb would otherwise expand past 1 GB in the service worker). */
export const MAX_ZIP_PART = 50 * 1024 * 1024;

const attrsOf = (s: string): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const m of s.matchAll(/([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g)) out[m[1]!] = decodeXml(m[2] ?? m[3] ?? "");
  return out;
};
/** Attribute by local name, whatever its namespace prefix (`r:id`, `id`). */
const attr = (a: Record<string, string>, local: string) => a[local] ?? Object.entries(a).find(([k]) => k.endsWith(`:${local}`))?.[1];
/**
 * Elements `<tag ...>body</tag>` or `<tag .../>`, any namespace prefix. Linear time: the closing tag
 * is found with indexOf, and once one is missing no later element searches for it again (a lazy
 * regex over a file of unclosed `<row>` tags took minutes for a 1 KB zip).
 */
function elements(xml: string, tag: string): Array<{ attrs: Record<string, string>; body: string }> {
  const out: Array<{ attrs: Record<string, string>; body: string }> = [];
  const open = new RegExp(`<((?:\\w+:)?)${tag}\\b([^>]*?)(/?)>`, "g");
  const missing = new Set<string>();
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    const attrs = attrsOf(m[2]!);
    const close = `</${m[1]}${tag}>`;
    if (m[3] === "/" || missing.has(close)) {
      out.push({ attrs, body: "" });
      continue;
    }
    const end = xml.indexOf(close, open.lastIndex);
    if (end < 0) {
      missing.add(close);
      out.push({ attrs, body: "" });
      continue;
    }
    out.push({ attrs, body: xml.slice(open.lastIndex, end) });
    open.lastIndex = end + close.length;
  }
  return out;
}
/** Text of every `<t>` run in a string item (rich text included), skipping phonetic hints (`<rPh>`). Linear, like elements(). */
function runsText(xml: string): string {
  const parts: string[] = [];
  const open = /<((?:\w+:)?)(t|rPh)\b[^>]*?(\/?)>/g;
  for (let m = open.exec(xml); m; m = open.exec(xml)) {
    if (m[3] === "/") continue;
    const close = `</${m[1]}${m[2]}>`;
    const end = xml.indexOf(close, open.lastIndex);
    if (end < 0) break;
    if (m[2] === "t") parts.push(decodeXml(xml.slice(open.lastIndex, end)));
    open.lastIndex = end + close.length;
  }
  return parts.join("");
}

/** Built-in number formats that show a date and/or time. */
const DATE_FMT_IDS = new Set([14, 15, 16, 17, 22]);
const TIME_FMT_IDS = new Set([18, 19, 20, 21, 45, 46, 47]);
type DateStyle = "date" | "time";

/** "date"/"time" for a custom format code that shows one, ignoring quoted text, [colors/locales] and escapes. */
function codeStyle(code: string): DateStyle | undefined {
  // `_x` (space as wide as x) and `*x` (fill with x) are padding, not codes: "_-* #,##0 _P_t_s_-" is a number.
  const bare = code.replace(/"[^"]*"/g, "").replace(/\[[^\]]*\]/g, "").replace(/\\./g, "").replace(/[_*]./g, "").toLowerCase();
  if (/[dy]/.test(bare)) return "date";
  if (/[hs]/.test(bare)) return "time";
  return /m/.test(bare) ? "date" : undefined;
}

/** Style index (a cell's `s`) → whether its numbers are dates or times, from xl/styles.xml. */
function dateStyles(xml: string | undefined): Array<DateStyle | undefined> {
  if (!xml) return [];
  const custom = new Map<number, DateStyle | undefined>();
  for (const { attrs } of elements(xml, "numFmt")) custom.set(Number(attrs.numFmtId), codeStyle(attrs.formatCode ?? ""));
  const xfs = elements(xml, "cellXfs")[0]?.body ?? "";
  return elements(xfs, "xf").map(({ attrs }) => {
    const id = Number(attrs.numFmtId ?? 0);
    if (custom.has(id)) return custom.get(id);
    return DATE_FMT_IDS.has(id) ? "date" : TIME_FMT_IDS.has(id) ? "time" : undefined;
  });
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Excel serial (1900 date system) → "dd/mm/yyyy", plus " hh:mm" when it has a time of day; a time format under one day → "hh:mm". */
export function excelDate(serial: number, style: DateStyle = "date"): string {
  let days = Math.floor(serial);
  let secs = Math.round((serial - days) * 86400);
  if (secs >= 86400) {
    days++;
    secs -= 86400;
  }
  const time = `${pad(Math.floor(secs / 3600))}:${pad(Math.floor((secs % 3600) / 60))}`;
  if (style === "time" && days === 0) return time;
  let date: string;
  if (days === 60) date = "29/02/1900"; // Excel's day that never was
  else {
    // Serial 1 is 1 Jan 1900; past the phantom 29 Feb 1900 (serial 60), day 0 is 30 Dec 1899.
    const d = new Date(Date.UTC(1899, 11, days < 60 ? 31 : 30) + days * 86_400_000);
    date = `${pad(d.getUTCDate())}/${pad(d.getUTCMonth() + 1)}/${d.getUTCFullYear()}`;
  }
  return secs ? `${date} ${time}` : date;
}

/** "AB12" → 27 (0-based column), or undefined without letters. */
const columnOf = (ref: string | undefined) => {
  const letters = /^[A-Za-z]+/.exec(ref ?? "")?.[0];
  if (!letters) return undefined;
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + ch.charCodeAt(0) - 64;
  return n - 1;
};

const oneLine = (s: string) => s.replace(/\s*[\r\n]+\s*/g, " ").trim();

function cellText(c: { attrs: Record<string, string>; body: string }, shared: string[], styles: Array<DateStyle | undefined>): string {
  const t = c.attrs.t ?? "n";
  if (t === "inlineStr") return runsText(elements(c.body, "is")[0]?.body ?? "");
  const v = elements(c.body, "v")[0]?.body;
  if (v === undefined) return "";
  const raw = decodeXml(v).trim();
  if (t === "s") return shared[Number(raw)] ?? "";
  if (t === "b") return raw === "1" ? "TRUE" : raw === "0" ? "FALSE" : raw;
  if (t === "d") {
    const m = /^(\d{4})-(\d\d)-(\d\d)(?:T(\d\d):(\d\d))?/.exec(raw);
    if (!m) return raw;
    return `${m[3]}/${m[2]}/${m[1]}${m[4] && `${m[4]}:${m[5]}` !== "00:00" ? ` ${m[4]}:${m[5]}` : ""}`;
  }
  if (t !== "n") return raw; // str (formula text), e (error such as #DIV/0!)
  const n = Number(raw);
  if (!raw || !Number.isFinite(n)) return raw;
  const style = styles[Number(c.attrs.s ?? 0)];
  if (style && n >= (style === "date" ? 1 : 0) && n < 2_958_466) return excelDate(n, style); // up to 31/12/9999
  return String(Number(n.toPrecision(15)));
}

function sheetRows(xml: string, shared: string[], styles: Array<DateStyle | undefined>, budget = XLSX_MAX_CHARS): string[] {
  const lines: string[] = [];
  const data = elements(xml, "sheetData")[0]?.body ?? "";
  let size = 0;
  for (const row of elements(data, "row")) {
    if (size > budget) break; // XLSX_MAX_CHARS bounds the work too, not only the output
    const cells: string[] = [];
    let next = 0;
    for (const c of elements(row.body, "c")) {
      const col = columnOf(c.attrs.r) ?? next;
      next = col + 1;
      if (col > 16_383) continue; // past Excel's last column (XFD): a broken reference
      const text = oneLine(cellText(c, shared, styles));
      if (!text) continue;
      while (cells.length < col) cells.push("");
      cells[col] = text;
    }
    while (cells.length && !cells[cells.length - 1]) cells.pop();
    if (cells.length) {
      const line = cells.join(" | ");
      lines.push(line);
      size += line.length + 1;
    }
  }
  return lines;
}

/** Zip path of a target in xl/_rels/workbook.xml.rels ("worksheets/sheet1.xml" or "/xl/worksheets/sheet1.xml"). */
function resolveTarget(target: string): string {
  const out: string[] = [];
  for (const p of (target.startsWith("/") ? target.slice(1) : `xl/${target}`).split("/")) {
    if (p === "..") out.pop();
    else if (p && p !== ".") out.push(p);
  }
  return out.join("/");
}

export function xlsxText(bytes: Uint8Array): string {
  try {
    const files = unzipSync(bytes, { filter: (f) => f.name.startsWith("xl/") && /\.(xml|rels)$/.test(f.name) && f.originalSize <= MAX_ZIP_PART });
    const read = (name: string) => (files[name] ? strFromU8(files[name]) : undefined);
    const shared = elements(read("xl/sharedStrings.xml") ?? "", "si").map((si) => runsText(si.body));
    const styles = dateStyles(read("xl/styles.xml"));
    const rels = new Map(elements(read("xl/_rels/workbook.xml.rels") ?? "", "Relationship").map(({ attrs }) => [attrs.Id ?? "", attrs.Target ?? ""]));
    let sheets = elements(read("xl/workbook.xml") ?? "", "sheet").map(({ attrs }, i) => {
      const target = rels.get(attr(attrs, "id") ?? "");
      return { name: attrs.name ?? `Hoja ${i + 1}`, path: target ? resolveTarget(target) : `xl/worksheets/sheet${i + 1}.xml` };
    });
    if (!sheets.length) {
      // No usable workbook part: take the worksheets in file order.
      const num = (n: string) => Number(/(\d+)\.xml$/.exec(n)?.[1] ?? 0);
      sheets = Object.keys(files)
        .filter((n) => /^xl\/worksheets\/[^/]+\.xml$/.test(n))
        .sort((a, b) => num(a) - num(b))
        .map((path, i) => ({ name: `Hoja ${i + 1}`, path }));
    }
    const blocks: string[] = [];
    let size = 0;
    for (const sheet of sheets) {
      const xml = read(sheet.path);
      if (!xml) continue;
      const rows = sheetRows(xml, shared, styles, XLSX_MAX_CHARS - size);
      if (!rows.length) continue;
      const block = `--- sheet ${oneLine(sheet.name)} ---\n${rows.join("\n")}`;
      blocks.push(block);
      size += block.length + 2;
      if (size > XLSX_MAX_CHARS) break;
    }
    const text = blocks.join("\n\n");
    return text.length > XLSX_MAX_CHARS ? `${text.slice(0, XLSX_MAX_CHARS)}\n[spreadsheet cut at ${XLSX_MAX_CHARS} characters]` : text;
  } catch {
    return "";
  }
}

/** Extracts text from raw bytes of the given kind (no caching). */
export async function extractBytes(kind: Exclude<FileKind, "other">, bytes: Uint8Array): Promise<string> {
  return kind === "pdf" ? await pdfText(bytes)
    : kind === "pptx" ? pptxText(bytes)
    : kind === "docx" ? docxText(bytes)
    : kind === "xlsx" ? xlsxText(bytes)
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
      // The file may have been deleted (an upload's «Borrar») while it was being extracted: don't leave its text behind.
      if ((await store.index())[f.key]) await store.writeText(f, text);
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
