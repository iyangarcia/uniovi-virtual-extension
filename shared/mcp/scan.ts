import { isUpload, type Snapshot, UPLOAD_SECTION } from "../types.ts";
import { fold, isUploadsFilter, matchCourses, UserError, NO_DATA } from "./common.ts";
import { kindOf } from "./kind.ts";
import type { DataStore, StoredFile } from "./store.ts";

// The line scanner behind full-text search, independent of how a file's text is obtained.
// search.ts gives it a getter that may extract (unpdf, for the MCP tools in the service worker and
// the Node server); the "Mis apuntes" page uses searchCachedMaterials, which reads the text cache
// only, so the page doesn't bundle the PDF parser or compete with the worker's background warmer.

export interface MaterialHit {
  /** Resource key of the file (StoredFile.key). */
  key: string;
  courseId: number;
  /** Course short name, when the snapshot knows the course; «Mis archivos» for the student's uploads. */
  course?: string;
  section: string;
  /** Activity name (Resource.name). */
  name: string;
  filename?: string;
  /** "page 3" / "slide 2" / "sheet Notas" from the extraction markers, or "" before the first marker. */
  location: string;
  locationKind?: "page" | "slide";
  locationNumber?: number;
  snippet: string;
}

export interface SearchMaterialsOptions {
  query: string;
  /** Course filter as the tools take it: id, short name or part of the name (accent-insensitive), or «Mis archivos» for uploads only. */
  course?: string;
  /** Exact course id filter (combined with `course` if both are given). */
  courseId?: number;
  /** Max hits (default 30). */
  limit?: number;
  /** Snapshot to use; read from the store when omitted. */
  snapshot?: Snapshot | null;
}

export interface SearchMaterialsResult {
  results: MaterialHit[];
  /** Searchable files considered. */
  scanned: number;
  /** Files skipped because their text isn't extracted yet (background indexing was started). */
  pending: number;
}

/** Text of a file: a string, null when it has none, undefined when it isn't extracted yet (pending). */
export type TextGetter = (f: StoredFile) => Promise<string | null | undefined>;

export async function scanMaterials(
  store: DataStore,
  opts: SearchMaterialsOptions,
  getText: TextGetter,
): Promise<SearchMaterialsResult & { files: StoredFile[] }> {
  const { query, course, courseId, limit = 30 } = opts;
  const s = opts.snapshot !== undefined ? opts.snapshot : await store.snapshot();
  // The student's own uploads (courseId 0) belong to no course: in with no course filter or with «Mis archivos».
  const uploadsOnly = isUploadsFilter(course);
  if (!s && course && !uploadsOnly) throw new UserError(NO_DATA);
  const ids = s && !uploadsOnly ? new Set(matchCourses(s, course).map((c) => c.id)) : null;
  const wanted = (f: StoredFile) =>
    isUpload(f.resource)
      ? (!course || uploadsOnly) && (courseId === undefined || courseId === f.resource.courseId)
      : !uploadsOnly && (!ids || ids.has(f.resource.courseId)) && (courseId === undefined || f.resource.courseId === courseId);
  const files = Object.values(await store.index()).filter((f: StoredFile) => wanted(f) && kindOf(f) !== "other");
  const courseName = (f: StoredFile) => (isUpload(f.resource) ? UPLOAD_SECTION : s?.courses.find((c) => c.id === f.resource.courseId)?.shortname);
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const results: MaterialHit[] = [];
  let pending = 0;
  for (const f of files) {
    const text = await getText(f);
    if (text === undefined) pending++;
    if (!text) continue;
    let location = "";
    let locationKind: "page" | "slide" | undefined;
    let locationNumber: number | undefined;
    const lines = text.split("\n");
    // Fold once per file (not once per line window): warm searches over ~300 files went from ~2 s to well under 1 s.
    const folded = fold(text).split("\n");
    const same = folded.length === lines.length;
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      const sheet = lines[i]!.startsWith("--- sheet ") ? /^--- sheet (.+) ---$/.exec(lines[i]!) : null;
      if (sheet) {
        location = `sheet ${sheet[1]}`;
        locationKind = undefined;
        locationNumber = undefined;
        continue;
      }
      const marker = /^--- (page|slide) (\d+) ---$/.exec(lines[i]!);
      if (marker) {
        location = `${marker[1]} ${marker[2]}`;
        locationKind = marker[1] as "page" | "slide";
        locationNumber = Number(marker[2]);
        continue;
      }
      const line = same ? folded[i]! : fold(lines[i]!);
      if (!terms.some((t) => line.includes(t))) continue;
      const windowText = same ? folded.slice(i, i + 3).join(" ") : fold(lines.slice(i, i + 3).join(" "));
      if (terms.every((t) => windowText.includes(t))) {
        results.push({
          key: f.key,
          courseId: f.resource.courseId,
          course: courseName(f),
          section: f.resource.section,
          name: f.resource.name,
          filename: f.resource.filename,
          location,
          locationKind,
          locationNumber,
          snippet: snippetAt(lines, i, terms),
        });
      }
    }
    if (results.length >= limit) break;
  }
  return { results, scanned: files.length, pending, files };
}

/** Max snippet length: every search result counts against the AI's limits, so keep it short. */
export const SNIPPET_CHARS = 240;

const squash = (s: string) => s.replace(/\s+/g, " ").trim();

/**
 * The text around hit line i (one line before, two after), at most SNIPPET_CHARS long and
 * cut so the first matched term stays in it, with some context before it.
 */
function snippetAt(lines: string[], i: number, terms: string[]): string {
  const prev = i > 0 ? squash(lines[i - 1]!) : "";
  const hit = squash(lines[i]!);
  const after = squash(lines.slice(i + 1, i + 3).join(" "));
  const text = [prev, hit, after].filter(Boolean).join(" ");
  if (text.length <= SNIPPET_CHARS) return text;
  // Column of the first matched term in the squashed hit line (fold can change lengths, so map back char by char).
  const folded = fold(hit);
  const cols = terms.map((t) => folded.indexOf(t)).filter((c) => c >= 0);
  const foldedCol = cols.length ? Math.min(...cols) : 0;
  let col = 0;
  for (let f = 0; col < hit.length && f < foldedCol; col++) f += fold(hit[col]!).length;
  const pos = (prev ? prev.length + 1 : 0) + col;
  const start = Math.max(0, Math.min(pos - 60, text.length - SNIPPET_CHARS));
  return text.slice(start, start + SNIPPET_CHARS).trim();
}

/** Search over already-extracted text only; files without cached text count as `pending`. */
export async function searchCachedMaterials(store: DataStore, opts: SearchMaterialsOptions): Promise<SearchMaterialsResult> {
  const { results, scanned, pending } = await scanMaterials(store, opts, async (f) => (await store.readText(f).catch(() => null)) ?? undefined);
  return { results, scanned, pending };
}
