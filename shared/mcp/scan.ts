import type { Snapshot } from "../types.ts";
import { fold, matchCourses, UserError, NO_DATA } from "./common.ts";
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
  /** Course short name, when the snapshot knows the course. */
  course?: string;
  section: string;
  /** Activity name (Resource.name). */
  name: string;
  filename?: string;
  /** "page 3" / "slide 2" from the extraction markers, or "" before the first marker. */
  location: string;
  locationKind?: "page" | "slide";
  locationNumber?: number;
  snippet: string;
}

export interface SearchMaterialsOptions {
  query: string;
  /** Course filter as the tools take it: id, short name or part of the name (accent-insensitive). */
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
  if (!s && course) throw new UserError(NO_DATA);
  const ids = s ? new Set(matchCourses(s, course).map((c) => c.id)) : null;
  const files = Object.values(await store.index()).filter(
    (f: StoredFile) =>
      (!ids || ids.has(f.resource.courseId)) && (courseId === undefined || f.resource.courseId === courseId) && kindOf(f) !== "other",
  );
  const courseName = (id: number) => s?.courses.find((c) => c.id === id)?.shortname;
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
          course: courseName(f.resource.courseId),
          section: f.resource.section,
          name: f.resource.name,
          filename: f.resource.filename,
          location,
          locationKind,
          locationNumber,
          snippet: lines.slice(Math.max(0, i - 1), i + 3).join(" ").replace(/\s+/g, " ").slice(0, 400),
        });
      }
    }
    if (results.length >= limit) break;
  }
  return { results, scanned: files.length, pending, files };
}

/** Search over already-extracted text only; files without cached text count as `pending`. */
export async function searchCachedMaterials(store: DataStore, opts: SearchMaterialsOptions): Promise<SearchMaterialsResult> {
  const { results, scanned, pending } = await scanMaterials(store, opts, async (f) => (await store.readText(f).catch(() => null)) ?? undefined);
  return { results, scanned, pending };
}
