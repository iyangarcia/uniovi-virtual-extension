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

/** Returns extracted text, or null when the format is not supported. Cached on disk. */
export async function textOf(f: StoredFile): Promise<string | null> {
  const cached = await readCache(f);
  if (cached !== null) return cached;
  const kind = kindOf(f);
  if (kind === "other") return null;
  const bytes = new Uint8Array(await readFile(absolutePath(f)));
  const text =
    kind === "pdf" ? await pdfText(bytes)
    : kind === "pptx" ? pptxText(bytes)
    : kind === "docx" ? docxText(bytes)
    : new TextDecoder().decode(bytes);
  await writeCache(f, text);
  return text;
}
