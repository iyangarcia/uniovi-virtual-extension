// Pure logic of the "Mis apuntes" page (extension/src/files.ts): which files to list, how to group,
// sort and filter them, how each type is labelled and opened. No browser APIs; server/test imports it.
import { fold, TZ } from "../../../shared/mcp/common.ts";
import type { StoredFile } from "../../../shared/mcp/store.ts";
import type { Course, Resource, Snapshot } from "../../../shared/types.ts";
import { fileExt, isCampusFile, isReadableFile } from "../readable.ts";

export { fold };

// ------------------------------------------------------------------ file types

export type FileType = "pdf" | "word" | "powerpoint" | "excel" | "image" | "text" | "other";

const TYPE_LABEL: Record<FileType, string> = {
  pdf: "PDF",
  word: "Word",
  powerpoint: "PowerPoint",
  excel: "Excel",
  image: "Imagen",
  text: "Texto",
  other: "Archivo",
};

const WORD = new Set(["doc", "docx", "odt", "rtf"]);
const POWERPOINT = new Set(["ppt", "pptx", "pps", "ppsx", "odp"]);
const EXCEL = new Set(["xls", "xlsx", "ods"]);
const IMAGE: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", bmp: "image/bmp" };
// Text and code shown as plain text. html/htm/xml/svg are here on purpose: rendered from an
// extension page they would run with the extension's origin, so they open as their source.
const TEXT = new Set([
  "txt", "md", "csv", "tsv", "json", "xml", "html", "htm", "tex", "bib", "log", "yaml", "yml", "svg",
  "c", "h", "cc", "cpp", "hpp", "cs", "java", "kt", "py", "ipynb", "js", "mjs", "ts", "sql", "r", "m",
  "sh", "bat", "ps1", "php", "rb", "go", "rs", "swift", "css", "scss", "asm", "s", "pl", "hs", "scala",
]);

/** Kind of a file from its name first, then its MIME type. */
export function fileType(filename: string | undefined, mime?: string): FileType {
  const ext = fileExt(filename);
  if (ext === "pdf") return "pdf";
  if (WORD.has(ext)) return "word";
  if (POWERPOINT.has(ext)) return "powerpoint";
  if (EXCEL.has(ext)) return "excel";
  if (ext in IMAGE) return "image";
  if (TEXT.has(ext)) return "text";
  const m = (mime ?? "").toLowerCase();
  if (m.includes("pdf")) return "pdf";
  if (/wordprocessing|msword|opendocument\.text|rtf/.test(m)) return "word";
  if (/presentation|powerpoint/.test(m)) return "powerpoint";
  if (/spreadsheet|excel/.test(m)) return "excel";
  if (/^image\/(png|jpe?g|gif|webp|bmp)\b/.test(m)) return "image";
  if (/^text\/|^application\/(json|xml)\b/.test(m)) return "text";
  return "other";
}

export const typeLabel = (t: FileType) => TYPE_LABEL[t];

/** "open": Chrome shows it in a tab (PDF, images, text). "download": saved as a file (Office…). */
export const openMode = (t: FileType): "open" | "download" => (t === "pdf" || t === "image" || t === "text" ? "open" : "download");

/**
 * MIME type for the blob URL. Viewable files get a type Chrome displays itself; anything that
 * could run (HTML, SVG) is forced to plain text; the rest keeps its stored type for downloads.
 */
export function blobMime(filename: string | undefined, storedType: string): string {
  const t = fileType(filename, storedType);
  if (t === "pdf") return "application/pdf";
  if (t === "image") return IMAGE[fileExt(filename)] ?? (storedType.split(";")[0]!.trim() || "application/octet-stream");
  if (t === "text") return "text/plain; charset=utf-8";
  return storedType || "application/octet-stream";
}

// ------------------------------------------------------------------ entries

export interface FileEntry {
  key: string;
  courseId: number;
  section: string;
  /** What the row shows: the file name inside folders, the activity name otherwise. */
  title: string;
  filename?: string;
  type: FileType;
  /** Unix seconds (Moodle timemodified), 0 when unknown. */
  date: number;
  size?: number;
  /** Stored in the extension (openable) or only a campus link (zip, exe…). */
  stored: boolean;
  storedAt?: number;
  contentType?: string;
  /** Campus URL of the resource. */
  url: string;
  /** Position in the snapshot (campus order); large for files the snapshot no longer lists. */
  order: number;
}

export function displayTitle(r: Pick<Resource, "modname" | "name" | "filename">): string {
  if (r.modname === "folder" && r.filename) return r.filename;
  return r.name?.trim() || r.filename || "Sin nombre";
}

/**
 * Every file to list: the stored ones (from the IndexedDB index) and the ones that stay campus links
 * (known to the snapshot, deliberately not downloaded: archives, binaries, media, too large). Ordered by the snapshot, which follows the campus pages.
 */
export function buildEntries(snapshot: Snapshot | null, index: Record<string, StoredFile>, skipped: Record<string, number>): FileEntry[] {
  const order = new Map<string, number>();
  snapshot?.resources.forEach((r, i) => order.set(r.key, i));
  const out: FileEntry[] = [];
  const base = snapshot?.resources.length ?? 0;
  let extra = 0;
  for (const f of Object.values(index)) {
    const r = f.resource;
    out.push({
      key: f.key,
      courseId: r.courseId,
      section: r.section || "General",
      title: displayTitle(r),
      filename: r.filename,
      type: fileType(r.filename ?? f.path, f.contentType),
      date: f.timemodified || r.timemodified || 0,
      size: f.size,
      stored: true,
      storedAt: f.storedAt,
      contentType: f.contentType,
      url: r.url,
      order: order.get(f.key) ?? base + extra++,
    });
  }
  for (const r of snapshot?.resources ?? []) {
    if (index[r.key]) continue;
    // Skipped after a look at the response (type known only after the redirect, too large), or a
    // file the campus page already names as an archive/binary/video (never fetched, so never in `skipped`).
    if (!(r.key in skipped) && !(isCampusFile(r) && isReadableFile(r) === false)) continue;
    out.push({
      key: r.key,
      courseId: r.courseId,
      section: r.section || "General",
      title: displayTitle(r),
      filename: r.filename,
      type: fileType(r.filename, r.mimetype),
      date: r.timemodified || skipped[r.key] || 0,
      size: r.filesize,
      stored: false,
      url: r.url,
      order: order.get(r.key)!,
    });
  }
  return out.sort((a, b) => a.order - b.order);
}

// ------------------------------------------------------------------ filter, sort, group

/** Every word of the query appears in the title, file name or section (accent- and case-insensitive). */
export function filterEntries(entries: FileEntry[], query: string): FileEntry[] {
  const terms = fold(query).split(/\s+/).filter(Boolean);
  if (!terms.length) return entries;
  return entries.filter((e) => {
    const hay = fold(`${e.title} ${e.filename ?? ""} ${e.section}`);
    return terms.every((t) => hay.includes(t));
  });
}

export type SortMode = "course" | "name" | "date";

export const SORT_MODES: { value: SortMode; label: string }[] = [
  { value: "course", label: "Por asignatura y tema" },
  { value: "name", label: "Por nombre" },
  { value: "date", label: "Por fecha (más nuevos primero)" },
];

export const isSortMode = (s: unknown): s is SortMode => s === "course" || s === "name" || s === "date";

const collator = new Intl.Collator("es", { sensitivity: "base", numeric: true });

export function sortEntries(entries: FileEntry[], mode: SortMode): FileEntry[] {
  const list = [...entries];
  if (mode === "name") return list.sort((a, b) => collator.compare(a.title, b.title) || a.order - b.order);
  if (mode === "date") return list.sort((a, b) => b.date - a.date || collator.compare(a.title, b.title));
  return list.sort((a, b) => a.order - b.order);
}

export interface SectionGroup {
  name: string;
  files: FileEntry[];
}

export interface CourseGroup {
  id: number;
  name: string;
  shortname?: string;
  /** Sorting by course: files split by section in campus order. Otherwise one unnamed section. */
  sections: SectionGroup[];
  count: number;
}

/**
 * Courses in snapshot order (unknown ones last, by id). With mode "course" each course is split
 * into its sections in campus order; with "name"/"date" each course is one flat list in that order.
 */
export function groupEntries(entries: FileEntry[], courses: Course[], mode: SortMode): CourseGroup[] {
  const sorted = sortEntries(entries, mode);
  const byCourse = new Map<number, FileEntry[]>();
  for (const e of sorted) {
    const list = byCourse.get(e.courseId) ?? [];
    list.push(e);
    byCourse.set(e.courseId, list);
  }
  const known = courses.filter((c) => byCourse.has(c.id));
  const unknown = [...byCourse.keys()].filter((id) => !courses.some((c) => c.id === id)).sort((a, b) => a - b);
  const groups: CourseGroup[] = [];
  for (const c of [...known, ...unknown.map((id) => ({ id, fullname: `Asignatura ${id}`, shortname: undefined }))]) {
    const files = byCourse.get(c.id)!;
    let sections: SectionGroup[];
    if (mode === "course") {
      const bySection = new Map<string, FileEntry[]>();
      for (const e of files) bySection.set(e.section, [...(bySection.get(e.section) ?? []), e]);
      sections = [...bySection].map(([name, list]) => ({ name, files: list }));
    } else {
      sections = [{ name: "", files }];
    }
    groups.push({ id: c.id, name: c.fullname || c.shortname || `Asignatura ${c.id}`, shortname: c.shortname, sections, count: files.length });
  }
  return groups;
}

// ------------------------------------------------------------------ "Nuevo", dates, sizes

/** Stored after her previous visit. No previous visit (first time on the page): nothing is "new". */
export function isNew(e: Pick<FileEntry, "stored" | "storedAt">, lastVisit: number | undefined): boolean {
  return !!(e.stored && lastVisit && e.storedAt && e.storedAt > lastVisit);
}

export const LAST_VISIT_KEY = "filesLastVisit";

const dateFmt = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, day: "numeric", month: "short", year: "numeric" });

/** "14 nov 2026" in Madrid time; "" when unknown. */
export function formatDate(unix: number): string {
  return unix > 0 ? dateFmt.format(unix * 1000).replace(/\./g, "") : "";
}

/** "820 KB", "1,4 MB" (Spanish decimal comma); "" when unknown. */
export function formatSize(bytes: number | undefined): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB"];
  let n = bytes / 1024;
  let u = 0;
  while (n >= 1024 && u < units.length - 1) {
    n /= 1024;
    u++;
  }
  const s = n >= 10 || u === 0 ? String(Math.round(n)) : n.toFixed(1).replace(".", ",");
  return `${s} ${units[u]}`;
}

// ------------------------------------------------------------------ search hits, deep links

/** "página 2" / "diapositiva 3" for a search hit; "" when the hit has no page marker. */
export function locationLabel(h: { locationKind?: "page" | "slide"; locationNumber?: number }): string {
  if (!h.locationNumber) return "";
  return `${h.locationKind === "slide" ? "diapositiva" : "página"} ${h.locationNumber}`;
}

/** Page to jump to for a search hit: only PDF pages (`#page=N` in Chrome's PDF viewer). */
export function hitPage(type: FileType, h: { locationKind?: "page" | "slide"; locationNumber?: number }): number | undefined {
  return type === "pdf" && h.locationKind === "page" && h.locationNumber ? h.locationNumber : undefined;
}

/** Blob URL shown by the viewer, at a PDF page when given. */
export const pageUrl = (blobUrl: string, page?: number) => (page ? `${blobUrl}#page=${page}` : blobUrl);

/** Search snippets come from text with "--- page N ---" markers: drop them for display. */
export function cleanSnippet(s: string): string {
  return s.replace(/-{3} (?:page|slide) \d+ -{3}/g, " ").replace(/\s+/g, " ").trim();
}

/**
 * `files.html?course=<id>&q=<text>`: open on one course and/or with a search typed in.
 * `files.html?open=<key>&page=<n>`: viewer mode, one file filling the tab (see files.ts).
 */
export function parseDeepLink(search: string): { course?: number; q?: string; open?: string; page?: number } {
  const p = new URLSearchParams(search);
  const out: { course?: number; q?: string; open?: string; page?: number } = {};
  const c = Number(p.get("course"));
  if (Number.isInteger(c) && c > 0) out.course = c;
  const q = p.get("q")?.trim();
  if (q) out.q = q.slice(0, 200);
  const open = p.get("open");
  if (open) out.open = open;
  const page = Number(p.get("page"));
  if (out.open && Number.isInteger(page) && page > 0) out.page = page;
  return out;
}

/** Path of the viewer tab for a file (relative to the extension root), optionally at a PDF page. */
export function viewerPath(key: string, page?: number): string {
  return `files.html?open=${encodeURIComponent(key)}${page ? `&page=${page}` : ""}`;
}

/** Only https links to the campus become anchors; anything else (javascript:, data:, other sites…) is dropped. */
export function safeCampusUrl(url: string | undefined): string | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    const campus = u.hostname === "campusvirtual.uniovi.es" || u.hostname.endsWith(".campusvirtual.uniovi.es");
    return u.protocol === "https:" && campus ? u.href : null;
  } catch {
    return null;
  }
}

/** File name for "Descargar": the campus file name, or the title, without path separators. */
export function downloadName(e: Pick<FileEntry, "filename" | "title">): string {
  return (e.filename || e.title).replace(/[\\/:*?"<>|\u0000-\u001f]/g, "_").slice(0, 150) || "archivo";
}
