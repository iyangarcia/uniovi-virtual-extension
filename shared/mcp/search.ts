import type { Snapshot } from "../types.ts";
import { fold, matchCourses, UserError, NO_DATA, when } from "./common.ts";
import { cachedTextOf, isWarming, kindOf, textOf, warmTextCache } from "./extract.ts";
import type { DataStore, StoredFile } from "./store.ts";

// Full-text search over the extracted text of stored files. Used by the search_materials and
// search tools, and reusable by an in-extension file browser ("Mis apuntes").

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

/** "Material 3 (tema3.pdf)", the file label the tools print. */
export const hitFile = (h: Pick<MaterialHit, "name" | "filename">) => `${h.name} (${h.filename})`;

/** How long one search may spend extracting not-yet-cached files before answering with what it has. */
export const searchBudget = { ms: 20_000 };

export async function searchMaterials(store: DataStore, opts: SearchMaterialsOptions): Promise<SearchMaterialsResult> {
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
  const deadline = Date.now() + searchBudget.ms;
  let pending = 0;
  for (const f of files) {
    // A cold cache takes over a minute to build, longer than remote clients wait: past the budget,
    // or while the background indexer runs, only already-extracted files are searched.
    const extract = Date.now() < deadline && !isWarming(store);
    const text = await (extract ? textOf(store, f) : cachedTextOf(store, f)).catch(() => null);
    if (text === null && !extract) pending++;
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
  if (pending) void warmTextCache(store, files);
  return { results, scanned: files.length, pending };
}

// ChatGPT's connector convention (also used by deep research): `search` returns
// {results: [{id, title, url}]}, `fetch` takes one of those ids and returns {id, title, text, url, metadata}.
// Ids are "material:<key>" (one per file, best hit first) and "post:<id>".

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  text?: string;
}

export async function searchAll(store: DataStore, s: Snapshot, query: string, limit = 20): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  const { results } = await searchMaterials(store, { snapshot: s, query, limit: limit * 3 });
  const seen = new Set<string>();
  for (const h of results) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    const r = s.resources.find((x) => x.key === h.key);
    out.push({ id: `material:${h.key}`, title: `${hitFile(h)}${h.location ? `, ${h.location}` : ""}`, url: r?.url ?? "", text: h.snippet });
  }
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const posts = s.posts
    .filter((p) => terms.every((t) => fold(`${p.subject} ${p.message}`).includes(t)))
    .sort((a, b) => b.created - a.created);
  for (const p of posts) {
    out.push({ id: `post:${p.id}`, title: `${p.subject} (${p.forumName}, ${when(p.created)})`, url: p.url, text: p.message.slice(0, 300) });
  }
  return out.slice(0, limit);
}
