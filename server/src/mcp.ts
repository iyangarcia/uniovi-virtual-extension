import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { Course, Resource, Snapshot } from "../../shared/types.ts";
import { findDates } from "../../shared/dates.ts";
import {
  courseLabel,
  courseLanguage,
  PRIORITY_ORDER,
  priorityOf,
  resourceLanguage,
  type Priority,
  type ResourceLang,
} from "../../shared/lang.ts";
import { type Config, loadConfig } from "./config.ts";
import { kindOf, textOf } from "./extract.ts";
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

/**
 * Snapshot + private preferences, with the per-course helpers every tool needs. Language and
 * priority only label and order results: nothing is ever dropped because of them.
 */
interface Ctx {
  s: Snapshot;
  cfg: Config;
  label: (courseId?: number) => string | undefined;
  /** Material language and priority. */
  rank: (r: Resource) => { language: ResourceLang; priority: Priority };
  /** Course-level priority, for posts, events and grades. */
  coursePriority: (courseId?: number) => Priority;
}

async function context(): Promise<Ctx> {
  const [s, cfg] = await Promise.all([requireSnapshot(), loadConfig()]);
  const byId = new Map(s.courses.map((c) => [c.id, c]));
  const labels = new Map(s.courses.map((c) => [c.id, courseLabel(c, s.courses)]));
  return {
    s,
    cfg,
    label: (id) => (id === undefined ? undefined : (labels.get(id) ?? String(id))),
    rank: (r) => {
      const c = byId.get(r.courseId);
      const language = resourceLanguage(r, c, s.courses);
      return { language, priority: priorityOf(language, c, cfg) };
    },
    coursePriority: (id) => {
      const c = id === undefined ? undefined : byId.get(id);
      return c ? priorityOf(courseLanguage(c, s.courses), c, cfg) : "normal";
    },
  };
}

/** Only non-default priorities are worth printing. */
const tag = (p: Priority) => (p === "normal" ? undefined : p);

/** Resolves a course filter (id, label, shortname or part of the name, accent-insensitive). */
function matchCourses(s: Snapshot, filter?: string): Course[] {
  if (!filter) return s.courses;
  const f = fold(filter.trim());
  const byId = s.courses.filter((c) => String(c.id) === f);
  if (byId.length) return byId;
  const hits = s.courses.filter(
    (c) => fold(c.shortname).includes(f) || fold(c.fullname).includes(f) || fold(courseLabel(c, s.courses)).includes(f),
  );
  if (!hits.length) {
    throw new UserError(`No course matches "${filter}". Courses: ${s.courses.map((c) => courseLabel(c, s.courses)).join("; ")}`);
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

export function createMcpServer(): McpServer {
  const server = new McpServer({ name: "uniovi-virtual", version: VERSION });

  server.registerTool(
    "sync_status",
    {
      title: "Sync status",
      description:
        "When Uniovi Virtual was last synced, how much data is available, and any collection warnings. Call this first if results look incomplete or stale.",
      inputSchema: {},
    },
    wrap(async () => {
      const { s, cfg } = await context();
      const index = await loadIndex();
      const ageHours = Math.round((nowUnix() - s.syncedAt) / 360) / 10;
      return ok({
        lastSync: when(s.syncedAt),
        ageHours,
        stale: ageHours > 24 ? "Data is over a day old; ask the user to sync from the browser extension." : undefined,
        site: s.siteUrl,
        dataDir,
        counts: {
          courses: s.courses.length,
          materials: s.resources.length,
          downloadedFiles: Object.keys(index).length,
          forumPosts: s.posts.length,
          assignments: s.assignments.length,
          calendarEvents: s.events.length,
          grades: s.grades?.length ?? "not synced (older extension version)",
        },
        // The student's preferences (from config.json; the email is deliberately not exposed).
        preferences: {
          materialLanguage: cfg.materialLanguage ?? "any",
          replyLanguage: cfg.replyLanguage ?? "es",
          lowPriorityCourses: cfg.lowPriorityCourses ?? [],
        },
        warnings: s.warnings,
      });
    }),
  );

  server.registerTool(
    "list_courses",
    {
      title: "List courses",
      description:
        "Courses the student is enrolled in, with material/post counts. Some subjects appear twice (English and Spanish group); the student's other-language group is marked priority 'backup': still use it when it has something the main one lacks (past exams, announcements). 'low' = a course the student deprioritised.",
      inputSchema: {},
    },
    wrap(async () => {
      const { s, label, coursePriority } = await context();
      return ok(
        s.courses.map((c) => ({
          id: c.id,
          name: label(c.id),
          fullName: c.fullname,
          language: courseLanguage(c, s.courses),
          priority: tag(coursePriority(c.id)),
          url: c.url,
          materials: s.resources.filter((r) => r.courseId === c.id).length,
          forumPosts: s.posts.filter((p) => p.courseId === c.id).length,
          grades: s.grades?.filter((g) => g.courseId === c.id).length,
        })),
      );
    }),
  );

  server.registerTool(
    "list_materials",
    {
      title: "List course materials",
      description:
        "Files, slides, lecture notes and links published in courses. Returns each item's `key` (use with read_material) and, if downloaded, its absolute local path. Items in the student's preferred language come first; other-language copies are marked priority 'backup' and listed last but never omitted.",
      inputSchema: {
        course: courseArg,
        query: z.string().optional().describe("Filter by words in the material name, filename or section."),
      },
    },
    wrap(async ({ course, query }: { course?: string; query?: string }) => {
      const { s, label, rank } = await context();
      const index = await loadIndex();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const q = query ? fold(query) : "";
      const items = s.resources
        .filter((r) => ids.has(r.courseId))
        .filter((r) => !q || fold(`${r.name} ${r.filename ?? ""} ${r.section}`).includes(q))
        .map((r) => {
          const stored = index[r.key];
          const { language, priority } = rank(r);
          return {
            key: r.key,
            course: label(r.courseId),
            section: r.section,
            name: r.name,
            filename: r.filename ?? stored?.resource.filename,
            language: language === "unknown" ? undefined : language,
            priority: tag(priority),
            type: r.modname === "url" ? "link" : r.mimetype ?? stored?.contentType,
            modified: r.timemodified ? when(r.timemodified) : undefined,
            localPath: stored ? absolutePath(stored) : undefined,
            url: r.url,
            order: PRIORITY_ORDER[priority],
          };
        })
        .sort((a, b) => a.order - b.order) // stable: keeps course/section order within a priority
        .map(({ order: _o, ...rest }) => rest);
      const backup = items.filter((i) => i.priority).length;
      const note = backup
        ? `${backup} item(s) marked backup/low are listed last. Use them when the main material lacks something (e.g. a past exam only the other group has), and say so.`
        : undefined;
      if (items.length > 300) {
        return ok({ note: [`${items.length} matches; showing 300. Narrow with course/query.`, note].filter(Boolean).join(" "), items: items.slice(0, 300) });
      }
      return ok(note ? { note, items } : items);
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
    wrap(async ({ key, offset = 0, maxChars = 40_000 }: { key: string; offset?: number; maxChars?: number }) => {
      const index = await loadIndex();
      const f = index[key];
      if (!f) {
        throw new UserError(
          `Material ${key} is not downloaded (it may be a link, too large, or not synced yet). Check list_materials for its url.`,
        );
      }
      const text = await textOf(f);
      if (text === null) {
        return ok({
          note: `Text extraction not supported for this file type (${f.contentType}). Open it directly from localPath.`,
          localPath: absolutePath(f),
        });
      }
      const slice = text.slice(offset, offset + maxChars);
      const next = offset + slice.length < text.length ? offset + slice.length : undefined;
      const header = `# ${f.resource.name} — ${f.resource.filename}\nlocalPath: ${absolutePath(f)}\nchars ${offset}-${offset + slice.length} of ${text.length}${next !== undefined ? ` (nextOffset: ${next})` : ""}\n\n`;
      return ok(header + slice);
    }),
  );

  server.registerTool(
    "search_materials",
    {
      title: "Search inside course materials",
      description:
        "Full-text search inside downloaded PDFs, slides and documents. Returns matching snippets with the page/slide they are on. Files in the student's preferred language are searched first; other-language hits follow, marked priority 'backup'. Search with words in the material's language (try both English and Spanish terms if needed). First search over many files can take a while (text is cached afterwards).",
      inputSchema: {
        query: z.string().min(2).describe("Words to search for (all must appear on the same line or nearby)."),
        course: courseArg,
        limit: z.number().int().min(1).max(100).optional().describe("Max snippets (default 30)."),
      },
    },
    wrap(async ({ query, course, limit = 30 }: { query: string; course?: string; limit?: number }) => {
      const { s, label, rank } = await context();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const current = new Map(s.resources.map((r) => [r.key, r]));
      // Preferred-language files first, so other-language copies don't use up the limit.
      const files = Object.values(await loadIndex())
        .filter((f: StoredFile) => ids.has(f.resource.courseId) && kindOf(f) !== "other")
        .map((f) => ({ f, priority: rank(current.get(f.key) ?? f.resource).priority }))
        .sort((a, b) => PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority]);
      const terms = fold(query).split(/\s+/).filter(Boolean);
      const results: Array<{ key: string; course?: string; file: string; priority?: Priority; location: string; snippet: string }> = [];
      // Main-priority hits fill `limit`; backup/low files still get a few slots of their own, so
      // something only the other group has can't be crowded out.
      const reserve = Math.max(3, Math.ceil(limit / 3));
      let main = 0;
      let extra = 0;
      for (const { f, priority } of files) {
        const isMain = priority === "normal";
        const room = () => (isMain ? main < limit : extra < reserve);
        if (!room()) {
          if (isMain) continue;
          break;
        }
        const text = await textOf(f).catch(() => null);
        if (!text) continue;
        let location = "";
        const lines = text.split("\n");
        for (let i = 0; i < lines.length && room(); i++) {
          const marker = /^--- (page|slide) (\d+) ---$/.exec(lines[i]!);
          if (marker) {
            location = `${marker[1]} ${marker[2]}`;
            continue;
          }
          const windowText = fold(lines.slice(i, i + 3).join(" "));
          if (terms.every((t) => windowText.includes(t)) && terms.some((t) => fold(lines[i]!).includes(t))) {
            results.push({
              key: f.key,
              course: label(f.resource.courseId),
              file: `${f.resource.name} (${f.resource.filename})`,
              priority: tag(priority),
              location,
              snippet: lines.slice(Math.max(0, i - 1), i + 3).join(" ").replace(/\s+/g, " ").slice(0, 400),
            });
            if (isMain) main++;
            else extra++;
          }
        }
      }
      return ok(results.length ? results : `No matches for "${query}" in ${files.length} downloaded files.`);
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
      const { s, label: courseName, coursePriority } = await context();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const from = nowUnix() - includePastDays * 86400;
      const to = nowUnix() + daysAhead * 86400;
      const items: Array<{ time: number; when: string; course?: string; priority?: Priority; title: string; kind: string; url?: string; details?: string }> = [];
      for (const a of s.assignments) {
        if (!a.dueDate || !ids.has(a.courseId) || a.dueDate < from || a.dueDate > to) continue;
        items.push({
          time: a.dueDate,
          when: when(a.dueDate),
          course: courseName(a.courseId),
          priority: tag(coursePriority(a.courseId)),
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
          priority: tag(coursePriority(e.courseId)),
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
      const { s, label: courseName, coursePriority } = await context();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const today = new Date(Date.now() - 86400_000).toISOString().slice(0, 10);
      const out: Array<{ date: string; time?: string; course?: string; priority?: Priority; kind: string; source: string; title: string; snippet?: string; url?: string }> = [];

      const examWord = /ex[aá]men|parcial|prueba|convocatoria|final|recuperaci/i;
      for (const e of s.events) {
        if (course && (e.courseId === undefined || !ids.has(e.courseId))) continue;
        if (!examWord.test(`${e.name} ${e.description}`) && e.module !== "quiz") continue;
        const [date, time] = fmt.format(e.time * 1000).split(" ");
        out.push({ date: date!, time, course: courseName(e.courseId), priority: tag(coursePriority(e.courseId)), kind: "exam", source: "calendar", title: e.name, url: e.url });
      }
      for (const p of s.posts) {
        if (!ids.has(p.courseId)) continue;
        for (const m of findDates(`${p.subject}\n${p.message}`, new Date(p.created * 1000))) {
          if (m.kind !== "exam" && !(includeDeadlines && m.kind === "deadline")) continue;
          out.push({
            date: m.date,
            time: m.time,
            course: courseName(p.courseId),
            priority: tag(coursePriority(p.courseId)),
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
        "Forum posts (announcements/news and discussion forums). Without a query, returns the latest posts. Posts from courses the student deprioritised (priority 'low') come after the rest. Returns excerpts; use get_forum_post for the full text.",
      inputSchema: {
        query: z.string().optional().describe("Words that must all appear in the subject or message (accent-insensitive)."),
        course: courseArg,
        sinceDays: z.number().int().min(1).optional().describe("Only posts from the last N days."),
        limit: z.number().int().min(1).max(200).optional().describe("Max posts (default 30)."),
      },
    },
    wrap(async ({ query, course, sinceDays, limit = 30 }: { query?: string; course?: string; sinceDays?: number; limit?: number }) => {
      const { s, label, coursePriority } = await context();
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const terms = query ? fold(query).split(/\s+/).filter(Boolean) : [];
      const since = sinceDays ? nowUnix() - sinceDays * 86400 : 0;
      const posts = s.posts
        .filter((p) => ids.has(p.courseId) && p.created >= since)
        .filter((p) => {
          const hay = fold(`${p.subject} ${p.message}`);
          return terms.every((t) => hay.includes(t));
        })
        // Newest first, but posts from deprioritised courses after the rest (still returned when there's room).
        .sort((a, b) => (coursePriority(a.courseId) === "low" ? 1 : 0) - (coursePriority(b.courseId) === "low" ? 1 : 0) || b.created - a.created)
        .slice(0, limit)
        .map((p) => ({
          id: p.id,
          course: label(p.courseId),
          priority: tag(coursePriority(p.courseId)),
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
    wrap(async ({ id }: { id: number }) => {
      const { s, label } = await context();
      const post = s.posts.find((p) => p.id === id);
      if (!post) throw new UserError(`No post with id ${id}.`);
      const thread = s.posts
        .filter((p) => p.discussionId === post.discussionId)
        .sort((a, b) => a.created - b.created)
        .map((p) => `## ${p.subject}\n${p.author} · ${when(p.created)}${p.id === id ? "  ← requested" : ""}\n\n${p.message}`);
      return ok(`Course: ${label(post.courseId)}\nForum: ${post.forumName}\n${post.url}\n\n${thread.join("\n\n---\n\n")}`);
    }),
  );

  server.registerTool(
    "get_grades",
    {
      title: "Grades",
      description:
        "The student's graded items from the Uniovi Virtual gradebook (grade, range, percentage, teacher feedback), newest first. `firstSeen` is when a sync first saw that grade, i.e. roughly when it was published. Grades only cover what teachers enter in the gradebook; some publish marks as forum posts or PDFs instead (search_forums 'notas' / 'calificaciones').",
      inputSchema: {
        course: courseArg,
        sinceDays: z.number().int().min(1).optional().describe("Only grades first seen in the last N days."),
      },
    },
    wrap(async ({ course, sinceDays }: { course?: string; sinceDays?: number }) => {
      const { s, label, coursePriority } = await context();
      if (!s.grades) {
        throw new UserError("No grades synced yet: update the extension (npm run build, reload it) and sync again.");
      }
      const ids = new Set(matchCourses(s, course).map((c) => c.id));
      const since = sinceDays ? nowUnix() - sinceDays * 86400 : 0;
      const list = s.grades
        .filter((g) => ids.has(g.courseId) && (g.firstSeen ?? 0) >= since)
        .sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0))
        .map((g) => ({
          course: label(g.courseId),
          priority: tag(coursePriority(g.courseId)),
          item: g.name,
          grade: g.grade,
          range: g.range,
          percentage: g.percentage,
          feedback: g.feedback,
          firstSeen: g.firstSeen ? when(g.firstSeen) : undefined,
          url: g.url,
        }));
      return ok(list.length ? list : sinceDays ? `No new grades in the last ${sinceDays} days.` : "No graded items yet.");
    }),
  );

  registerStudyPrompts(server);
  return server;
}

// ---------------------------------------------------------------- study prompts
// Ready-made workflows, shown by Claude Code / Claude Desktop as slash commands, so the
// student doesn't have to know which tools exist or what to ask.

const prompt = (text: string) => ({ messages: [{ role: "user" as const, content: { type: "text" as const, text } }] });

/** Rules appended to every study prompt; reads config.json so language changes apply immediately. */
async function grounding(): Promise<string> {
  const cfg = await loadConfig();
  const reply = cfg.replyLanguage === "en" ? "English" : "Spanish";
  const studies = cfg.materialLanguage === "en" ? "English" : cfg.materialLanguage === "es" ? "Spanish" : undefined;
  const rules = [
    "Work only from the student's real course material and announcements (the uniovi-virtual tools). Never invent exam content, dates, rooms or rules.",
    'Cite every claim from the material as (file name, page/slide N), using the "--- page N ---" / "--- slide N ---" markers.',
    "If something is unclear (e.g. which topics an exam covers), say so and quote the announcement instead of guessing.",
    "A subject can be two courses (English and Spanish group). A course filter that matches both covers both: announcements and exam dates can be posted in either.",
    studies &&
      `The student studies in ${studies}. Prefer ${studies} material. Items marked priority "backup" are the other language's copy: use them when they add something (a past exam, an announcement, a topic the main material lacks) and say so; never skip them just because they are backup.`,
    'Items marked priority "low" come from courses the student deprioritised: mention them only in one short line at the end, and only if they need action.',
    `Reply in ${reply}, including headings.`,
  ];
  return `\nRules:\n${rules.filter(Boolean).map((r) => `- ${r}`).join("\n")}`;
}

function registerStudyPrompts(server: McpServer) {
  server.registerPrompt(
    "semana",
    {
      title: "Mi semana",
      description: "What's due, exams coming up and new announcements, with suggested priorities.",
    },
    async () =>
      prompt(`Give me my week at Uniovi.
1. sync_status: if the data is over a day old, say so first.
2. get_deadlines (daysAhead 14) and get_exam_dates (includeDeadlines true): merge into one chronological list. Mark forum-detected dates as "(from the forum)".
3. search_forums (sinceDays 7): summarise anything new in one line each; flag room/date changes and anything that requires action.
4. get_grades (sinceDays 7): any new grades, one line each with the item and mark.
5. End with a short, prioritised plan for the next 7 days, based on how close and how heavy each item is.
Keep it scannable: tables or short bullets, no filler.${await grounding()}`),
  );

  server.registerPrompt(
    "preparar_examen",
    {
      title: "Preparar examen",
      description: "Plan, notes and practice questions for the next exam of a course, from its slides and announcements.",
      argsSchema: { asignatura: z.string().describe("Course name or part of it, e.g. 'física'") },
    },
    async ({ asignatura }) =>
      prompt(`Help me prepare the next exam of "${asignatura}".
1. get_exam_dates (course "${asignatura}", includePast false) → the next exam: date, time, place. Then search_forums (course "${asignatura}", query "examen") and get_forum_post on the relevant ones → format, allowed material, and which temas/topics it covers.
2. list_materials (course "${asignatura}") → choose the materials for those topics (if coverage is unknown, use everything taught so far). read_material each one fully (follow nextOffset).
3. Produce:
   - **Exam sheet**: date, time, place, format, what's included — each with its source.
   - **Study plan** day by day from today until the exam, weighted by topic size and difficulty.
   - **Condensed notes** per topic: key definitions, formulas, procedures, typical pitfalls, with citations.
   - **10 practice questions** in the style the announcements describe (test/problemas/desarrollo), answers in a separate section at the end.${await grounding()}`),
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
    async ({ asignatura, tema }) =>
      prompt(`Teach me "${tema}" from "${asignatura}".
1. list_materials (course "${asignatura}", query "${tema}"). If nothing matches, use search_materials (query "${tema}", course "${asignatura}") to find where it is covered. read_material the relevant files fully.
2. Produce:
   - **Summary** (one page max) in the order the slides teach it.
   - **Key concepts**: term → one-line explanation.
   - **Flashcards**: 10–15 question/answer flashcards.
   - **Mini quiz**: 5 questions; wait for my answers before correcting them.${await grounding()}`),
  );
}
