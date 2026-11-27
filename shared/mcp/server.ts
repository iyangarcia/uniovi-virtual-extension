import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { isUpload, type Resource, type Snapshot, UPLOAD_SECTION } from "../types.ts";
import { findDates } from "../dates.ts";
import { RELAY_URL } from "../relay.ts";
import { DOWNLOAD_PAGE } from "../release.ts";
import { fmt, fold, isUploadsFilter, matchCourses, nowUnix, requireSnapshot as loadRequired, UserError, when } from "./common.ts";
import { textOf } from "./extract.ts";
import { hitFile, searchAll, searchMaterials } from "./search.ts";
import type { DataStore, StoredFile } from "./store.ts";

// The MCP server shared by the Node stdio server (files on disk) and the extension (IndexedDB):
// every tool, prompt and the instructions. Storage comes from a DataStore.

type ToolResult = { content: Array<{ type: "text"; text: string }>; isError?: boolean };
// Compact JSON: every character of tool output counts against the AI's limits (free tiers run out fast).
const ok = (data: unknown): ToolResult => ({
  content: [{ type: "text", text: typeof data === "string" ? data : JSON.stringify(data) }],
});
const fail = (text: string): ToolResult => ({ content: [{ type: "text", text }], isError: true });

/** Every tool only reads the student's own synced data. Clients such as Gemini use these hints to
 *  decide whether to ask before each call. */
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

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

/** read_material's default page: about 4k tokens, so one call doesn't eat a free tier's quota. */
const READ_CHARS = 15_000;
/** list_materials cap without a course/query filter. */
const MAX_MATERIALS = 150;

/** Office MIME types are ~70 characters each; list_materials prints the short name. */
const SHORT_TYPES: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.ms-powerpoint": "ppt",
  "application/msword": "doc",
  "application/vnd.ms-excel": "xls",
};
const shortType = (mime?: string) => (mime ? SHORT_TYPES[mime] ?? mime : undefined);

/** Activities stored as their page's text (extension/src/activity.ts): named by what they are. */
const ACTIVITY_TYPES: Record<string, string> = { url: "link", page: "page", quiz: "quiz", assign: "assignment", book: "book", lesson: "lesson", coursepage: "course page" };
const FILE_MODS = new Set(["resource", "folder", "section-file", "activity-file"]);
const materialType = (modname: string, mime?: string) => (FILE_MODS.has(modname) ? shortType(mime) : ACTIVITY_TYPES[modname] ?? modname);
/** Files the student added on «Mis apuntes» (index entries only, never in the snapshot). */
const uploadsOf = (index: Record<string, StoredFile>) => Object.values(index).filter((f) => isUpload(f.resource));
/** Course label of a resource in tool output: the short name, or «Mis archivos» for an upload. */
const courseLabel = (s: Snapshot, r?: Resource) => (r && isUpload(r) ? UPLOAD_SECTION : s.courses.find((c) => c.id === r?.courseId)?.shortname);

/** First `max` characters of a message with whitespace runs collapsed, "…" when cut. */
const excerpt = (s: string, max: number) => {
  const flat = s.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}…` : flat;
};

const courseArg = z
  .string()
  .optional()
  .describe("Course id, short name, or part of the course name (accent-insensitive). Omit for all courses.");

export interface McpOptions {
  /** Served to a web client (ChatGPT, claude.ai) through the relay: hide local paths, which are useless there and reveal the user's folders. */
  remote?: boolean;
  /** Server version reported to clients (default "0.0.0"). */
  version?: string;
}

export function createMcpServer(store: DataStore, { remote = false, version = "0.0.0" }: McpOptions = {}): McpServer {
  const server = new McpServer(
    {
      name: "uniovi-virtual",
      title: "Uniovi Virtual",
      version,
      // Shown by AI sites next to the connector, so it doesn't look like a nameless black box.
      icons: [{ src: `${RELAY_URL}/icon.png`, mimeType: "image/png", sizes: ["128x128"] }],
      websiteUrl: DOWNLOAD_PAGE,
    },
    { instructions: INSTRUCTIONS },
  );
  const local = <T>(v: T): T | undefined => (remote ? undefined : v);
  /** Absolute local path of a file: only in local mode, and only for a store that has one (the Node server). */
  const pathOf = (f: StoredFile): string | undefined => (remote ? undefined : store.localPath?.(f));
  const requireSnapshot = () => loadRequired(store);

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      annotations: READ_ONLY,
      description:
        "When Uniovi Virtual was last synced, how much data is available, and any collection warnings. Call this first if results look incomplete or stale.",
      inputSchema: {},
    },
    wrap(async () => {
      const s = await requireSnapshot();
      const index = await store.index();
      const ageHours = Math.round((nowUnix() - s.syncedAt) / 360) / 10;
      return ok({
        lastSync: when(s.syncedAt),
        ageHours,
        stale: ageHours > 24 ? "Data is over a day old; ask the user to sync from the browser extension." : undefined,
        site: s.siteUrl,
        dataDir: local(store.dataDir),
        counts: {
          courses: s.courses.length,
          materials: s.resources.length,
          downloadedFiles: Object.keys(index).length,
          uploads: uploadsOf(index).length || undefined,
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
    { title: "List courses", annotations: READ_ONLY, description: "Courses the student is enrolled in, with material/post counts and the student's own groups.", inputSchema: {} },
    wrap(async () => {
      const s = await requireSnapshot();
      const uploads = uploadsOf(await store.index()).length;
      const courses = s.courses.map((c) => ({
        id: c.id,
        shortname: c.shortname,
        name: c.fullname,
        url: c.url,
        materials: s.resources.filter((r) => r.courseId === c.id).length,
        forumPosts: s.posts.filter((p) => p.courseId === c.id).length,
        myGroups: s.myGroups?.[c.id]?.length ? s.myGroups[c.id] : undefined,
      }));
      // Files the student uploaded: not a course, so a count and how to list them.
      return ok(uploads ? { courses, uploads, uploadsCourse: UPLOAD_SECTION } : courses);
    }),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Get my grades",
      annotations: READ_ONLY,
      description:
        "The student's own grades per course, as in the campus grade report: each graded item with its category, grade, range, percentage, feedback, and the category and course totals. \"-\" means not graded yet.",
      inputSchema: { course: courseArg, gradedOnly: z.boolean().optional().describe("Only items that already have a grade, plus totals (default false).") },
    },
    wrap(async ({ course, gradedOnly = false }: { course?: string; gradedOnly?: boolean }) => {
      const s = await requireSnapshot();
      if (!s.grades) return ok({ note: "Grades are not synced: the student turned them off in the extension (side panel, Ajustes), or the last sync predates them." });
      return ok(
        matchCourses(s, course).map((c) => ({
          course: c.shortname,
          items: s.grades!
            .filter((g) => g.courseId === c.id && (!gradedOnly || g.total || g.grade !== "-"))
            .map((g) => ({
              category: g.category.length ? g.category.join(" > ") : undefined,
              name: g.name,
              kind: g.kind,
              total: g.total || undefined,
              grade: g.grade,
              range: g.range,
              percentage: g.percentage && g.percentage !== "-" ? g.percentage : undefined,
              feedback: g.feedback || undefined,
              contribution: g.contribution && g.contribution !== "-" ? g.contribution : undefined,
            })),
        })),
      );
    }),
  );

  server.registerTool(
    "get_teachers",
    {
      title: "Get teachers and my groups",
      annotations: READ_ONLY,
      description:
        "Teachers of each course (name, role, the groups each one is in) and the student's own groups, so you can tell which teacher has the student's practice/seminar group. Emails are not available; the course page material may list them.",
      inputSchema: { course: courseArg },
    },
    wrap(async ({ course }: { course?: string }) => {
      const s = await requireSnapshot();
      return ok(
        matchCourses(s, course).map((c) => {
          const mine = s.myGroups?.[c.id] ?? [];
          return {
            course: c.shortname,
            myGroups: mine,
            teachers: (s.teachers ?? [])
              .filter((t) => t.courseId === c.id)
              .map((t) => ({ name: t.name, role: t.role, sharesMyGroups: t.groups.filter((g) => mine.includes(g)), groups: t.groups })),
          };
        }),
      );
    }),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List course materials",
      annotations: READ_ONLY,
      description:
        "Files, slides, lecture notes, links, pages, quizzes, assignments and each course's main page published in courses, plus files the student uploaded (course \"Mis archivos\"). Returns each item's `key` (use with read_material) and, if downloaded, its absolute local path.",
      inputSchema: {
        course: courseArg,
        query: z.string().optional().describe("Filter by words in the material name, filename or section."),
      },
    },
    wrap(async ({ course, query }: { course?: string; query?: string }) => {
      const s = await requireSnapshot();
      const index = await store.index();
      const uploadsOnly = isUploadsFilter(course);
      const ids = new Set(uploadsOnly ? [] : matchCourses(s, course).map((c) => c.id));
      const q = query ? fold(query) : "";
      // The student's own files first: few, and often the very thing asked about (e.g. the exam calendar).
      const uploads = (!course || uploadsOnly ? uploadsOf(index) : [])
        .filter((f) => !q || fold(`${f.resource.name} ${f.resource.filename ?? ""} ${f.resource.section}`).includes(q))
        .sort((a, b) => b.timemodified - a.timemodified)
        .map((f) => ({
          key: f.key,
          course: UPLOAD_SECTION,
          name: f.resource.name,
          filename: f.resource.filename,
          type: "subido por ti",
          modified: f.timemodified ? when(f.timemodified) : undefined,
          localPath: pathOf(f),
        }));
      const campus = s.resources
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
            type: materialType(r.modname, r.mimetype ?? stored?.contentType),
            modified: r.timemodified ? when(r.timemodified) : undefined,
            localPath: stored ? pathOf(stored) : undefined,
            url: r.url,
          };
        });
      const items = [...uploads, ...campus];
      if (items.length > MAX_MATERIALS) {
        return ok({ note: `${items.length} matches; showing ${MAX_MATERIALS}. Narrow with course/query.`, items: items.slice(0, MAX_MATERIALS) });
      }
      return ok(items);
    }),
  );

  server.registerTool(
    "read_material",
    {
      title: "Read course material",
      annotations: READ_ONLY,
      description:
        "Extracts the text of a material: a downloaded or uploaded file (PDF, PPTX, DOCX, XLSX, plain text) or the full text of a page, link, quiz, assignment or course page. Pages/slides/sheets are marked with '--- page N ---' / '--- sheet <name> ---'. Long documents are paginated by characters: pass the returned nextOffset to continue.",
      inputSchema: {
        key: z.string().describe("Material key from list_materials."),
        offset: z.number().int().min(0).optional().describe("Character offset to start from (default 0)."),
        maxChars: z.number().int().min(1000).max(200_000).optional().describe("Max characters to return (default 15000)."),
      },
    },
    wrap(async ({ key, offset = 0, maxChars = READ_CHARS }: { key: string; offset?: number; maxChars?: number }) =>
      ok(await materialText(store, key, offset, maxChars, pathOf)),
    ),
  );

  server.registerTool(
    "search_materials",
    {
      title: "Search inside course materials",
      annotations: READ_ONLY,
      description:
        "Full-text search inside downloaded PDFs, slides, documents and spreadsheets, including files the student uploaded. Returns matching snippets with the page/slide they are on. First search over many files can take a while (text is cached afterwards).",
      inputSchema: {
        query: z.string().min(2).describe("Words to search for (all must appear on the same line or nearby)."),
        course: courseArg,
        limit: z.number().int().min(1).max(100).optional().describe("Max snippets (default 10)."),
      },
    },
    wrap(async ({ query, course, limit = 10 }: { query: string; course?: string; limit?: number }) => {
      const s = await requireSnapshot();
      const found = await searchMaterials(store, { snapshot: s, query, course, limit });
      const { scanned, pending } = found;
      const results = found.results.map((h) => ({ key: h.key, file: hitFile(h), location: h.location, snippet: h.snippet }));
      const note = pending ? ` ${pending} of ${scanned} files are still being indexed (first search after a sync); search again in a minute for complete results.` : "";
      if (!results.length) return ok(`No matches for "${query}" in ${scanned - pending} downloaded files.${note}`);
      return ok(note ? { note: note.trim(), results } : results);
    }),
  );

  server.registerTool(
    "get_deadlines",
    {
      title: "Upcoming deadlines",
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
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
      annotations: READ_ONLY,
      description:
        "Forum posts (announcements/news and discussion forums). Without a query, returns the latest posts. Returns excerpts; use get_forum_post for the full text.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the subject or message (accent-insensitive)."),
        course: courseArg,
        sinceDays: z.number().int().min(1).optional().describe("Only posts from the last N days."),
        limit: z.number().int().min(1).max(200).optional().describe("Max posts (default 15)."),
      },
    },
    wrap(async ({ query, course, sinceDays, limit = 15 }: { query?: string; course?: string; sinceDays?: number; limit?: number }) => {
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
          excerpt: excerpt(p.message, 300),
          url: p.url,
        }));
      return ok(posts.length ? posts : "No matching posts.");
    }),
  );

  server.registerTool(
    "get_forum_post",
    {
      title: "Read forum post",
      annotations: READ_ONLY,
      description: "Full text of a forum post plus the rest of its discussion thread.",
      inputSchema: { id: z.number().int().describe("Post id from search_forums.") },
    },
    wrap(async ({ id }: { id: number }) => ok(threadText(await requireSnapshot(), id))),
  );

  registerSearchFetch(server, store);
  registerStudyPrompts(server);
  return server;
}

// ---------------------------------------------------------------- shared tool logic

async function materialText(
  store: DataStore,
  key: string,
  offset: number,
  maxChars: number,
  pathOf: (f: StoredFile) => string | undefined,
): Promise<string | object> {
  const index = await store.index();
  const f = index[key];
  if (!f) {
    throw new UserError(
      `Material ${key} is not downloaded (it may be a link, too large, or not synced yet). Check list_materials for its url.`,
    );
  }
  const text = await textOf(store, f);
  const localPath = pathOf(f);
  if (text === null) {
    return localPath === undefined
      ? { note: `Text extraction not supported for this file type (${f.contentType}).`, url: f.resource.url }
      : { note: `Text extraction not supported for this file type (${f.contentType}). Open it directly from localPath.`, localPath };
  }
  if (offset > 0 && offset >= text.length) {
    throw new UserError(`offset ${offset} is past the end (${text.length} chars). Use an offset below ${text.length}, or 0 to start over.`);
  }
  const slice = text.slice(offset, offset + maxChars);
  const next = offset + slice.length < text.length ? offset + slice.length : undefined;
  const where =
    localPath !== undefined ? `localPath: ${localPath}` : isUpload(f.resource) ? `${UPLOAD_SECTION}: uploaded by the student` : `url: ${f.resource.url}`;
  // The trailer is what the AI reads last: without it, a cut-off page looks like the whole document.
  const more = next !== undefined ? `\n\n[${text.length - next} more chars: call read_material with offset ${next} to continue.]` : "";
  return `# ${f.resource.name} — ${f.resource.filename}\n${where}\nchars ${offset}-${offset + slice.length} of ${text.length}${next !== undefined ? ` (nextOffset: ${next})` : ""}\n\n${slice}${more}`;
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

const FETCH_CHARS = READ_CHARS;

export async function fetchById(store: DataStore, s: Snapshot, id: string) {
  const [kind, ...rest] = id.split(":");
  const ref = rest.join(":");
  if (kind === "post") {
    const post = s.posts.find((p) => String(p.id) === ref);
    if (!post) throw new UserError(`No post with id ${ref}.`);
    return { id, title: post.subject, text: threadText(s, post.id), url: post.url, metadata: { course: s.courses.find((c) => c.id === post.courseId)?.shortname, forum: post.forumName } };
  }
  if (kind === "material") {
    // Uploads live in the store index only, never in the snapshot.
    const r = s.resources.find((x) => x.key === ref) ?? (await store.index())[ref]?.resource;
    const body = await materialText(store, ref, 0, FETCH_CHARS, () => undefined);
    const text = typeof body === "string" ? body : JSON.stringify(body);
    return { id, title: r?.name ?? ref, text, url: r?.url ?? "", metadata: { course: courseLabel(s, r), section: r?.section, note: `Use read_material (key ${JSON.stringify(ref)}) with nextOffset for the rest of long files.` } };
  }
  throw new UserError(`Unknown id "${id}". Use ids returned by search.`);
}

function registerSearchFetch(server: McpServer, store: DataStore) {
  const requireSnapshot = () => loadRequired(store);
  server.registerTool(
    "search",
    {
      title: "Search everything",
      annotations: READ_ONLY,
      description:
        "Searches the student's Uniovi course materials (text of PDFs/slides/documents) and forum posts. Returns {results:[{id,title,url}]}; pass an id to fetch for the full text.",
      inputSchema: { query: z.string().min(2).describe("Words to search for (accent-insensitive).") },
    },
    wrap(async ({ query }: { query: string }) => {
      const results = await searchAll(store, await requireSnapshot(), query);
      return ok({ results: results.map(({ id, title, url }) => ({ id, title, url })) });
    }),
  );

  server.registerTool(
    "fetch",
    {
      title: "Fetch a search result",
      annotations: READ_ONLY,
      description: "Full text of a material or forum thread returned by search, as {id,title,text,url,metadata}.",
      inputSchema: { id: z.string().describe("An id from search, e.g. 'material:...' or 'post:123'.") },
    },
    wrap(async ({ id }: { id: string }) => ok(await fetchById(store, await requireSnapshot(), id))),
  );
}

// Web clients (ChatGPT, Gemini) don't show MCP prompts, so the same guidance goes in the server instructions.
const INSTRUCTIONS = `Read-only access to one University of Oviedo student's Uniovi Virtual (Moodle) data, synced from their browser: courses, the student's own grades, teachers and groups, course materials (slides, PDFs, notes, with extracted text; also the full text of each course page, pages, links, quizzes and assignments), forum announcements, assignment deadlines, calendar events, and exam dates detected in announcements.

Be economical: every tool result counts against the student's AI limits. Use the fewest calls that answer the question, pass a course filter when you know it, and don't call a tool again for data already in this conversation.
- Questions about content: search_materials first (short snippets with file and page/slide); often the snippets answer it. Then read_material only for the file you need: it returns about 15,000 characters per call, so follow nextOffset only if the part you need isn't there yet.
- Summaries, notes, flashcards or quizzes on a topic: snippets are not enough. Find the file (list_materials with the topic as query, or search_materials), then read_material it whole, following nextOffset.
- "What do I have this week?": get_deadlines (daysAhead 7) for assignments and calendar events, plus get_exam_dates (includeDeadlines true) for dates announced in the forums. Add search_forums (sinceDays 7) only if the student asks for news.
- Exams: get_exam_dates for the course; for format or topics, search_forums (query "examen") and get_forum_post only on the relevant post.
- search/fetch (materials and posts together) are for clients that need them; fetch returns long text, so prefer search_materials and read_material.
- Grades: get_grades (gradedOnly true), with the evaluation rules from the course page. Teachers and the student's groups: get_teachers.
- Syllabus, evaluation rules: the course's "course page" material (list_materials query "Página de la asignatura").
- Files the student uploaded (not from the campus): course "Mis archivos", type "subido por ti"; the official exam calendar may be there.
- If results look empty or stale, call sync_status; data is as fresh as the student's last sync.

Rules: read-only. Work only from the student's real material and announcements; never invent exam dates, rooms, content or rules. Cite material as (file name, page/slide/sheet) using the "--- page N ---" (slide, sheet) markers. Forum-detected dates are heuristic: quote the snippet and link. Reply in the student's language (usually Spanish).`;

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
