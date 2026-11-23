import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Course, Snapshot } from "../../shared/types.ts";
import { findDates } from "../../shared/dates.ts";
import { cachedTextOf, isWarming, kindOf, textOf, warmTextCache } from "./extract.ts";
import { absolutePath, dataDir, loadIndex, loadSnapshot, type StoredFile } from "./store.ts";
import { VERSION } from "./version.ts";

const TZ = "Europe/Madrid";
const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const weekday = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "short" });
/** "2027-01-15 10:00 (vie)" in Madrid time. */
const when = (unix: number) => `${fmt.format(unix * 1000)} (${weekday.format(unix * 1000)})`;
const nowUnix = () => Math.floor(Date.now() / 1000);

const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data, null, 1) }],
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

const NO_DATA =
  "No Uniovi Virtual data synced yet. Open Uniovi Virtual in Chrome (logged in) with the extension installed and click 'Sync now' in the extension popup.";

async function requireSnapshot(): Promise<Snapshot> {
  const s = await loadSnapshot();
  if (!s) throw new UserError(NO_DATA);
  return s;
}

class UserError extends Error {}

/** Resolves a course filter (id, shortname or part of the name, accent-insensitive). */
function matchCourses(s: Snapshot, filter?: string): Course[] {
  if (!filter) return s.courses;
  const f = fold(filter.trim());
  const byId = s.courses.filter((c) => String(c.id) === f);
  if (byId.length) return byId;
  const hits = s.courses.filter((c) => fold(c.shortname).includes(f) || fold(c.fullname).includes(f));
  if (!hits.length) {
    throw new UserError(`No course matches "${filter}". Courses: ${s.courses.map((c) => c.fullname).join("; ")}`);
  }
  return hits;
}

function wrap<A>(fn: (args: A) => Promise<ToolResult>) {
  return async (args: A): Promise<ToolResult> => {
    try {
      return await fn(args);
    } catch (err) {
      if (err instanceof UserError) return fail(err.message);
      console.error("[mcp]", err);
      return fail(`Internal error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };
}

const courseArg = z
  .string()
  .optional()
  .describe("Course id, short name, or part of the course name (accent-insensitive). Omit for all courses.");

export interface McpOptions {
  /** Served to a web client (ChatGPT, Gemini, claude.ai) over a tunnel: hide local paths, which are useless there and reveal the user's folders. */
  remote?: boolean;
}

export function createMcpServer({ remote = false }: McpOptions = {}): McpServer {
  const server = new McpServer({ name: "uniovi-virtual", version: VERSION }, { instructions: INSTRUCTIONS });
  const local = <T>(v: T): T | undefined => (remote ? undefined : v);

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description:
        "When Uniovi Virtual was last synced, how much data is available, and any collection warnings. Call this first if results look incomplete or stale.",
      inputSchema: {},
    },
    wrap(async () => {
      const s = await requireSnapshot();
      const index = await loadIndex();
      const ageHours = Math.round((nowUnix() - s.syncedAt) / 360) / 10;
      return ok({
        lastSync: when(s.syncedAt),
        ageHours,
        stale: ageHours > 24 ? "Data is over a day old; ask the user to sync from the browser extension." : undefined,
        site: s.siteUrl,
        dataDir: local(dataDir),
        counts: {
          courses: s.courses.length,
          materials: s.resources.length,
          downloadedFiles: Object.keys(index).length,
          forumPosts: s.posts.length,
          assignments: s.assignments.length,
          calendarEvents: s.events.length,
        },
        warnings: s.warnings,
      });
    }),
  );

  server.registerTool(
    "list_courses",
    { title: "List courses", description: "Courses the student is enrolled in, with material/post counts.", inputSchema: {} },
    wrap(async () => {
      const s = await requireSnapshot();
      return ok(
        s.courses.map((c) => ({
          id: c.id,
          shortname: c.shortname,
          name: c.fullname,
          url: c.url,
          materials: s.resources.filter((r) => r.courseId === c.id).length,
          forumPosts: s.posts.filter((p) => p.courseId === c.id).length,
        })),
      );
    }),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List course materials",
      description:
        "Files, slides, lecture notes and links published in courses. Returns each item's `key` (use with read_material) and, if downloaded, its absolute local path.",
      inputSchema: {
        course: courseArg,
        query: z.string().optional().describe("Filter by words in the material name, filename or section."),
      },
    },
    wrap(async ({ course, query }: { course?: string; query?: string }) => {
      const s = await requireSnapshot();
      const index = await loadIndex();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const q = query ? fold(query) : "";
      const items = s.resources
        .filter((r) => ids.has(r.courseId))
        .filter((r) => !q || fold(`${r.name} ${r.filename ?? ""} ${r.section}`).includes(q))
        .map((r) => {
          const stored = index[r.key];
          return {
            key: r.key,
            course: s.courses.find((c) => c.id === r.courseId)?.shortname,
            section: r.section,
            name: r.name,
            filename: r.filename ?? stored?.resource.filename,
            type: r.modname === "url" ? "link" : r.mimetype ?? stored?.contentType,
            modified: r.timemodified ? when(r.timemodified) : undefined,
            localPath: stored ? local(absolutePath(stored)) : undefined,
            url: r.url,
          };
        });
      if (items.length > 300) {
        return ok({ note: `${items.length} matches; showing 300. Narrow with course/query.`, items: items.slice(0, 300) });
      }
      return ok(items);
    }),
  );

  server.registerTool(
    "read_material",
    {
      title: "Read course material",
      description:
        "Extracts the text of a downloaded file (PDF, PPTX, DOCX, plain text). Pages/slides are marked with '--- page N ---'. Long documents are paginated by characters: pass the returned nextOffset to continue.",
      inputSchema: {
        key: z.string().describe("Material key from list_materials."),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)."),
        maxChars: z.number().int().min(1000).max(200_000).optional().describe("Max characters to return (default 40000)."),
      },
    },
    wrap(async ({ key, offset = 0, maxChars = 40_000 }: { key: string; offset?: number; maxChars?: number }) =>
      ok(await materialText(key, offset, maxChars, remote)),
    ),
  );

  server.registerTool(
    "search_materials",
    {
      title: "Search inside course materials",
      description:
        "Full-text search inside downloaded PDFs, slides and documents. Returns matching snippets with the page/slide they are on. First search over many files can take a while (text is cached afterwards).",
      inputSchema: {
        query: z.string().min(2).describe("Words to search for (all must appear on the same line or nearby)."),
        course: courseArg,
        limit: z.number().int().min(1).max(100).optional().describe("Max snippets (default 30)."),
      },
    },
    wrap(async ({ query, course, limit = 30 }: { query: string; course?: string; limit?: number }) => {
      const s = await requireSnapshot();
      const { results, scanned, pending } = await searchMaterials(s, query, course, limit);
      const note = pending ? ` ${pending} of ${scanned} files are still being indexed (first search after a sync); search again in a minute for complete results.` : "";
      if (!results.length) return ok(`No matches for "${query}" in ${scanned - pending} downloaded files.${note}`);
      return ok(note ? { note: note.trim(), results } : results);
    }),
  );

  server.registerTool(
    "get_deadlines",
    {
      title: "Upcoming deadlines",
      description:
        "Assignment due dates and calendar events (submissions, quizzes, course events), sorted by date, in Europe/Madrid time.",
      inputSchema: {
        course: courseArg,
        daysAhead: z.number().int().min(1).max(400).optional().describe("Look-ahead window in days (default 90)."),
        includePastDays: z.number().int().min(0).max(365).optional().describe("Also include items from the last N days (default 3)."),
      },
    },
    wrap(async ({ course, daysAhead = 90, includePastDays = 3 }: { course?: string; daysAhead?: number; includePastDays?: number }) => {
      const s = await requireSnapshot();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const from = nowUnix() - includePastDays * 86400;
      const to = nowUnix() + daysAhead * 86400;
      const courseName = (id?: number) => s.courses.find((c) => c.id === id)?.shortname;
      const items: Array<{ time: number; when: string; course?: string; title: string; kind: string; url?: string; details?: string }> = [];
      for (const a of s.assignments) {
        if (!a.dueDate || !ids.has(a.courseId) || a.dueDate < from || a.dueDate > to) continue;
        items.push({
          time: a.dueDate,
          when: when(a.dueDate),
          course: courseName(a.courseId),
          title: a.name,
          kind: "assignment due",
          url: a.url,
          details: a.cutoffDate ? `Cut-off: ${when(a.cutoffDate)}` : undefined,
        });
      }
      for (const e of s.events) {
        if (e.time < from || e.time > to) continue;
        if (course && (e.courseId === undefined || !ids.has(e.courseId))) continue;
        // The calendar repeats assignment due dates ("X is due"); skip those already listed.
        if (items.some((a) => a.time === e.time && e.name.includes(a.title))) continue;
        items.push({
          time: e.time,
          when: when(e.time),
          course: courseName(e.courseId),
          title: e.name,
          kind: [e.module, e.type].filter(Boolean).join(" "),
          url: e.url,
          details: e.description ? e.description.slice(0, 300) : undefined,
        });
      }
      const list = items.sort((a, b) => a.time - b.time).map(({ time: _t, ...rest }) => rest);
      return ok(list.length ? list : "No deadlines in that window.");
    }),
  );

  server.registerTool(
    "get_exam_dates",
    {
      title: "Exam dates",
      description:
        "Exam dates found in calendar events and in forum announcements (detected heuristically from Spanish text, e.g. 'el examen final será el 15 de enero a las 10:00'). Each forum-derived date includes the snippet and post link: confirm by reading the snippet, as detection can over-report.",
      inputSchema: {
        course: courseArg,
        includePast: z.boolean().optional().describe("Include dates already past (default false)."),
        includeDeadlines: z.boolean().optional().describe("Also return non-exam dates found in posts, e.g. submission deadlines (default false)."),
      },
    },
    wrap(async ({ course, includePast = false, includeDeadlines = false }: { course?: string; includePast?: boolean; includeDeadlines?: boolean }) => {
      const s = await requireSnapshot();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const courseName = (id?: number) => s.courses.find((c) => c.id === id)?.shortname;
      const today = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const out: Array<{ date: string; time?: string; course?: string; kind: string; source: string; title: string; snippet?: string; url?: string }> = [];

      const examWord = /ex[aá]men|parcial|prueba|convocatoria|final|recuperaci/i;
      for (const e of s.events) {
        if (course && (e.courseId === undefined || !ids.has(e.courseId))) continue;
        if (!examWord.test(`${e.name} ${e.description}`) && e.module !== "quiz") continue;
        const [date, time] = fmt.format(e.time * 1000).split(" ");
        out.push({ date: date!, time, course: courseName(e.courseId), kind: "exam", source: "calendar", title: e.name, url: e.url });
      }
      for (const p of s.posts) {
        if (!ids.has(p.courseId)) continue;
        for (const m of findDates(`${p.subject}\n${p.message}`, new Date(p.created * 1000))) {
          if (m.kind !== "exam" && !(includeDeadlines && m.kind === "deadline")) continue;
          out.push({
            date: m.date,
            time: m.time,
            course: courseName(p.courseId),
            kind: m.kind,
            source: `forum "${p.forumName}" post by ${p.author} on ${when(p.created)}`,
            title: p.subject,
            snippet: m.snippet,
            url: p.url,
          });
        }
      }
      const list = out.filter((x) => includePast || x.date >= today).sort((a, b) => a.date.localeCompare(b.date));
      return ok(list.length ? list : "No exam dates found. Try includePast or search_forums for 'examen'.");
    }),
  );

  server.registerTool(
    "search_forums",
    {
      title: "Search forum posts",
      description:
        "Forum posts (announcements/news and discussion forums). Without a query, returns the latest posts. Returns excerpts; use get_forum_post for the full text.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the subject or message (accent-insensitive)."),
        course: courseArg,
        sinceDays: z.number().int().min(1).optional().describe("Only posts from the last N days."),
        limit: z.number().int().min(1).max(200).optional().describe("Max posts (default 30)."),
      },
    },
    wrap(async ({ query, course, sinceDays, limit = 30 }: { query?: string; course?: string; sinceDays?: number; limit?: number }) => {
      const s = await requireSnapshot();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const terms = query ? fold(query).split(/\s+/).filter(Boolean) : [];
      const since = sinceDays ? nowUnix() - sinceDays * 86400 : 0;
      const posts = s.posts
        .filter((p) => ids.has(p.courseId) && p.created >= since)
        .filter((p) => {
          const hay = fold(`${p.subject} ${p.message}`);
          return terms.every((t) => hay.includes(t));
        })
        .sort((a, b) => b.created - a.created)
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          course: s.courses.find((c) => c.id === p.courseId)?.shortname,
          forum: p.forumName,
          subject: p.subject,
          author: p.author,
          posted: when(p.created),
          excerpt: p.message.slice(0, 400) + (p.message.length > 400 ? "…" : ""),
          url: p.url,
        }));
      return ok(posts.length ? posts : "No matching posts.");
    }),
  );

  server.registerTool(
    "get_forum_post",
    {
      title: "Read forum post",
      description: "Full text of a forum post plus the rest of its discussion thread.",
      inputSchema: { id: z.number().int().describe("Post id from search_forums.") },
    },
    wrap(async ({ id }: { id: number }) => ok(threadText(await requireSnapshot(), id))),
  );

  registerSearchFetch(server);
  registerStudyPrompts(server);
  return server;
}

// ---------------------------------------------------------------- shared tool logic

async function materialText(key: string, offset: number, maxChars: number, remote: boolean): Promise<string | object> {
  const index = await loadIndex();
  const f = index[key];
  if (!f) {
    throw new UserError(
      `Material ${key} is not downloaded (it may be a link, too large, or not synced yet). Check list_materials for its url.`,
    );
  }
  const text = await textOf(f);
  if (text === null) {
    return remote
      ? { note: `Text extraction not supported for this file type (${f.contentType}).`, url: f.resource.url }
      : { note: `Text extraction not supported for this file type (${f.contentType}). Open it directly from localPath.`, localPath: absolutePath(f) };
  }
  if (offset > 0 && offset >= text.length) {
    throw new UserError(`offset ${offset} is past the end (${text.length} chars). Use an offset below ${text.length}, or 0 to start over.`);
  }
  const slice = text.slice(offset, offset + maxChars);
  const next = offset + slice.length < text.length ? offset + slice.length : undefined;
  const where = remote ? `url: ${f.resource.url}` : `localPath: ${absolutePath(f)}`;
  return `# ${f.resource.name} — ${f.resource.filename}\n${where}\nchars ${offset}-${offset + slice.length} of ${text.length}${next !== undefined ? ` (nextOffset: ${next})` : ""}\n\n${slice}`;
}

export interface MaterialHit {
  key: string;
  file: string;
  location: string;
  snippet: string;
}

/** How long one search may spend extracting not-yet-cached files before answering with what it has. */
export const searchBudget = { ms: 20_000 };

export async function searchMaterials(s: Snapshot, query: string, course: string | undefined, limit: number) {
  const ids = new Set(matchCourses(s, course).map((c) => c.id));
  const files = Object.values(await loadIndex()).filter(
    (f: StoredFile) => ids.has(f.resource.courseId) && kindOf(f) !== "other",
  );
  const terms = fold(query).split(/\s+/).filter(Boolean);
  const results: MaterialHit[] = [];
  const deadline = Date.now() + searchBudget.ms;
  let pending = 0;
  for (const f of files) {
    // A cold cache takes over a minute to build, longer than remote clients wait: past the budget,
    // or while the background indexer runs, only already-extracted files are searched.
    const extract = Date.now() < deadline && !isWarming();
    const text = await (extract ? textOf(f) : cachedTextOf(f)).catch(() => null);
    if (text === null && !extract) pending++;
    if (!text) continue;
    let location = "";
    const lines = text.split("\n");
    // Fold once per file (not once per line window): warm searches over ~300 files went from ~2 s to well under 1 s.
    const folded = fold(text).split("\n");
    const same = folded.length === lines.length;
    for (let i = 0; i < lines.length && results.length < limit; i++) {
      const marker = /^--- (page|slide) (\d+) ---$/.exec(lines[i]!);
      if (marker) {
        location = `${marker[1]} ${marker[2]}`;
        continue;
      }
      const line = same ? folded[i]! : fold(lines[i]!);
      if (!terms.some((t) => line.includes(t))) continue;
      const windowText = same ? folded.slice(i, i + 3).join(" ") : fold(lines.slice(i, i + 3).join(" "));
      if (terms.every((t) => windowText.includes(t))) {
        results.push({
          key: f.key,
          file: `${f.resource.name} (${f.resource.filename})`,
          location,
          snippet: lines.slice(Math.max(0, i - 1), i + 3).join(" ").replace(/\s+/g, " ").slice(0, 400),
        });
      }
    }
    if (results.length >= limit) break;
  }
  if (pending) void warmTextCache(files);
  return { results, scanned: files.length, pending };
}

function threadText(s: Snapshot, id: number): string {
  const post = s.posts.find((p) => p.id === id);
  if (!post) throw new UserError(`No post with id ${id}.`);
  const thread = s.posts
    .filter((p) => p.discussionId === post.discussionId)
    .sort((a, b) => a.created - b.created)
    .map((p) => `## ${p.subject}\n${p.author} · ${when(p.created)}${p.id === id ? "  ← requested" : ""}\n\n${p.message}`);
  return `Course: ${s.courses.find((c) => c.id === post.courseId)?.fullname}\nForum: ${post.forumName}\n${post.url}\n\n${thread.join("\n\n---\n\n")}`;
}

// ---------------------------------------------------------------- search / fetch
// ChatGPT's connector convention (also used by deep research): `search` returns
// {results: [{id, title, url}]}, `fetch` takes one of those ids and returns {id, title, text, url, metadata}.
// Ids are "material:<key>" (one per file, best hit first) and "post:<id>".

export interface SearchResult {
  id: string;
  title: string;
  url: string;
  text?: string;
}

const FETCH_CHARS = 60_000;

export async function searchAll(s: Snapshot, query: string, limit = 20): Promise<SearchResult[]> {
  const out: SearchResult[] = [];
  const { results } = await searchMaterials(s, query, undefined, limit * 3);
  const seen = new Set<string>();
  for (const h of results) {
    if (seen.has(h.key)) continue;
    seen.add(h.key);
    const r = s.resources.find((x) => x.key === h.key);
    out.push({ id: `material:${h.key}`, title: `${h.file}${h.location ? `, ${h.location}` : ""}`, url: r?.url ?? "", text: h.snippet });
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

export async function fetchById(s: Snapshot, id: string) {
  const [kind, ...rest] = id.split(":");
  const ref = rest.join(":");
  if (kind === "post") {
    const post = s.posts.find((p) => String(p.id) === ref);
    if (!post) throw new UserError(`No post with id ${ref}.`);
    return { id, title: post.subject, text: threadText(s, post.id), url: post.url, metadata: { course: s.courses.find((c) => c.id === post.courseId)?.shortname, forum: post.forumName } };
  }
  if (kind === "material") {
    const r = s.resources.find((x) => x.key === ref);
    const body = await materialText(ref, 0, FETCH_CHARS, true);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { id, title: r?.name ?? ref, text, url: r?.url ?? "", metadata: { course: s.courses.find((c) => c.id === r?.courseId)?.shortname, section: r?.section, note: "Use read_material with nextOffset for the rest of long files." } };
  }
  throw new UserError(`Unknown id "${id}". Use ids returned by search.`);
}

function registerSearchFetch(server: McpServer) {
  server.registerTool(
    "search",
    {
      title: "Search everything",
      description:
        "Searches the student's Uniovi course materials (text of PDFs/slides/documents) and forum posts. Returns {results:[{id,title,url}]}; pass an id to fetch for the full text.",
      inputSchema: { query: z.string().min(2).describe("Words to search for (accent-insensitive).") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ query }: { query: string }) => {
      const results = await searchAll(await requireSnapshot(), query);
      return ok({ results: results.map(({ id, title, url }) => ({ id, title, url })) });
    }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a search result",
      description: "Full text of a material or forum thread returned by search, as {id,title,text,url,metadata}.",
      inputSchema: { id: z.string().describe("An id from search, e.g. 'material:...' or 'post:123'.") },
      annotations: { readOnlyHint: true },
    },
    wrap(async ({ id }: { id: string }) => ok(await fetchById(await requireSnapshot(), id))),
  );
}

// Web clients (ChatGPT, Gemini) don't show MCP prompts, so the same guidance goes in the server instructions.
const INSTRUCTIONS = `Read-only access to one University of Oviedo student's Uniovi Virtual (Moodle) data, synced from their browser: courses, course materials (slides, PDFs, notes, with extracted text), forum announcements, assignment deadlines, calendar events, and exam dates detected in announcements.

How to use it well:
- Start with sync_status if results look empty or stale; data is as fresh as the student's last sync.
- "What do I have this week?": get_deadlines (daysAhead 14) + get_exam_dates (includeDeadlines true) merged chronologically, then search_forums (sinceDays 7) for new announcements, then a prioritised 7-day plan.
- Preparing an exam: get_exam_dates for the course, search_forums with query "examen" and get_forum_post to learn format and covered topics, then list_materials and read_material (follow nextOffset) for those topics; produce a study plan, condensed notes and practice questions.
- Studying a topic: list_materials with the topic as query (or search_materials to find where it is covered), read_material, then summary, key concepts, flashcards and a short quiz.
- search/fetch search materials and forum posts together.

Rules: work only from the student's real material and announcements; never invent exam dates, rooms, content or rules. Cite material as (file name, page/slide N) using the "--- page N ---" / "--- slide N ---" markers. Forum-detected dates are heuristic: quote the snippet and link. Reply in the student's language (usually Spanish).`;

// ---------------------------------------------------------------- study prompts
// Ready-made workflows, shown by Claude Code / Claude Desktop as slash commands, so the
// student doesn't have to know which tools exist or what to ask.

const prompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

const GROUNDING = `
Rules:
- Work only from the student's real course material and announcements (the uniovi-virtual tools). Never invent exam content, dates, rooms or rules.
- Cite every claim from the material as (file name, page/slide N), using the "--- page N ---" / "--- slide N ---" markers.
- If something is unclear (e.g. which topics an exam covers), say so and quote the announcement instead of guessing.
- Reply in Spanish.`;

function registerStudyPrompts(server: McpServer) {
  server.registerPrompt(
    "semana",
    {
      title: "Mi semana",
      description: "What's due, exams coming up and new announcements, with suggested priorities.",
    },
    () =>
      prompt(`Give me my week at Uniovi.
1. sync_status: if the data is over a day old, say so first.
2. get_deadlines (daysAhead 14) and get_exam_dates (includeDeadlines true): merge into one chronological list. Mark forum-detected dates as "(según el foro)".
3. search_forums (sinceDays 7): summarise anything new in one line each; flag room/date changes and anything that requires action.
4. End with a short, prioritised plan for the next 7 days, based on how close and how heavy each item is.
Keep it scannable: tables or short bullets, no filler.${GROUNDING}`),
  );

  server.registerPrompt(
    "preparar_examen",
    {
      title: "Preparar examen",
      description: "Plan, notes and practice questions for the next exam of a course, from its slides and announcements.",
      argsSchema: { asignatura: z.string().describe("Course name or part of it, e.g. 'física'") },
    },
    ({ asignatura }) =>
      prompt(`Help me prepare the next exam of "${asignatura}".
1. get_exam_dates (course "${asignatura}", includePast false) → the next exam: date, time, place. Then search_forums (course "${asignatura}", query "examen") and get_forum_post on the relevant ones → format, allowed material, and which temas/topics it covers.
2. list_materials (course "${asignatura}") → choose the materials for those topics (if coverage is unknown, use everything taught so far). read_material each one fully (follow nextOffset).
3. Produce:
   - **Ficha del examen**: date, time, place, format, what's included — each with its source.
   - **Plan de estudio** day by day from today until the exam, weighted by topic size and difficulty.
   - **Apuntes condensados** per topic: key definitions, formulas, procedures, typical pitfalls, with citations.
   - **10 preguntas de práctica** in the style the announcements describe (test/problemas/desarrollo), answers in a separate section at the end.${GROUNDING}`),
  );

  server.registerPrompt(
    "estudiar_tema",
    {
      title: "Estudiar un tema",
      description: "Summary, key concepts, flashcards and a short quiz for one topic of a course.",
      argsSchema: {
        asignatura: z.string().describe("Course name or part of it"),
        tema: z.string().describe("Topic, e.g. 'Tema 3' or 'termodinámica'"),
      },
    },
    ({ asignatura, tema }) =>
      prompt(`Teach me "${tema}" from "${asignatura}".
1. list_materials (course "${asignatura}", query "${tema}"). If nothing matches, use search_materials (query "${tema}", course "${asignatura}") to find where it is covered. read_material the relevant files fully.
2. Produce:
   - **Resumen** (one page max) in the order the slides teach it.
   - **Conceptos clave**: term → one-line explanation.
   - **Tarjetas**: 10–15 question/answer flashcards.
   - **Mini test**: 5 questions; wait for my answers before correcting them.${GROUNDING}`),
  );
}
