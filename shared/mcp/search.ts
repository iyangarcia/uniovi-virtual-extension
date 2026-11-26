import type { Snapshot } from "../types.ts";
import { fold, when } from "./common.ts";
import { cachedTextOf, isWarming, textOf, warmTextCache } from "./extract.ts";
import { type MaterialHit, scanMaterials, type SearchMaterialsOptions, type SearchMaterialsResult } from "./scan.ts";
import type { DataStore } from "./store.ts";

// Full-text search over the extracted text of stored files, for the search_materials and search
// tools. Files not extracted yet are extracted inline within a time budget (scan.ts has the scanner).

export type { MaterialHit, SearchMaterialsOptions, SearchMaterialsResult } from "./scan.ts";

/** "Material 3 (tema3.pdf)", the file label the tools print. */
export const hitFile = (h: Pick<MaterialHit, "name" | "filename">) => `${h.name} (${h.filename})`;

/** How long one search may spend extracting not-yet-cached files before answering with what it has. */
export const searchBudget = { ms: 20_000 };

export async function searchMaterials(store: DataStore, opts: SearchMaterialsOptions): Promise<SearchMaterialsResult> {
  const deadline = Date.now() + searchBudget.ms;
  const { results, scanned, pending, files } = await scanMaterials(store, opts, async (f) => {
    // A cold cache takes over a minute to build, longer than remote clients wait: past the budget,
    // or while the background indexer runs, only already-extracted files are searched.
    const extract = Date.now() < deadline && !isWarming(store);
    const text = await (extract ? textOf(store, f) : cachedTextOf(store, f)).catch(() => null);
    return text === null && !extract ? undefined : text;
  });
  if (pending) void warmTextCache(store, files);
  return { results, scanned, pending };
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

export async function searchAll(store: DataStore, s: Snapshot, query: string, limit = 10): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  const { results } = await searchMaterials(store, { snapshot: s, query, limit: limit * 3 });
  const seen = new Set<string>();
  // The student's uploads are in the store only, never in the snapshot.
  const index = results.length ? await store.index() : {};
  for (const h of results) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    const r = s.resources.find((x) => x.key === h.key) ?? index[h.key]?.resource;
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
