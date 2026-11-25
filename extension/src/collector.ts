import type { Assignment, CalendarEvent, Course, ForumPost, Resource, Snapshot } from "../../shared/types.ts";
import { activityTextPath, elementText, linkedFiles, linkTarget, mainRegion, textFilename, wantsText } from "./activity.ts";
import { htmlToText, MoodleClient, MoodleError } from "./moodle.ts";

export interface CollectOptions {
  /** "inprogress" (default) or "all" (includes past/future courses). */
  courseScope: "inprogress" | "all";
  /** Fetch replies for discussions active within this many days. */
  replyWindowDays: number;
  onProgress: (msg: string) => void;
  /** Full text of an activity or course page (stored as a text file once the snapshot is saved). */
  onText?: (r: Resource & { filename: string }, text: string) => void;
}

type OnText = NonNullable<CollectOptions["onText"]>;

interface ForumRef {
  courseId: number;
  /** Forum instance id (the `f=` in view.php?f=), which the forum web services take. */
  instance: number;
  name: string;
}

const now = () => Math.floor(Date.now() / 1000);

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  });
  await Promise.all(workers);
  return out;
}

export async function collect(client: MoodleClient, opts: CollectOptions): Promise<Snapshot> {
  const warnings = new Set<string>();
  const warn = (scope: string, err: unknown) => {
    // A disabled web service is reported once per function, not once per course/forum.
    const msg =
      err instanceof MoodleError && err.errorcode === "servicenotavailable"
        ? err.message
        : `${scope}: ${err instanceof Error ? err.message : String(err)}`;
    if (!warnings.has(msg)) console.warn("[uniovi]", msg);
    warnings.add(msg);
  };

  opts.onProgress("Listing courses…");
  const courses = await getCourses(client, opts.courseScope, warn);

  const resources: Resource[] = [];
  const forums: ForumRef[] = [];
  let done = 0;
  await mapLimit(courses, 3, async (course) => {
    const r = await getCourseContents(client, course, warn, opts.onText ?? (() => undefined));
    resources.push(...r.resources);
    forums.push(...r.forums);
    opts.onProgress(`Course contents ${++done}/${courses.length}`);
  });

  opts.onProgress("Reading forums…");
  const posts: ForumPost[] = [];
  done = 0;
  await mapLimit(forums, 3, async (forum) => {
    posts.push(...(await getForumPosts(client, forum, opts.replyWindowDays, warn)));
    opts.onProgress(`Forums ${++done}/${forums.length}`);
  });

  opts.onProgress("Reading assignments and calendar…");
  const assignments = await getAssignments(client, courses, warn);
  const events = await getEvents(client, warn);

  return {
    syncedAt: now(),
    siteUrl: client.wwwroot,
    courses,
    resources,
    posts,
    assignments,
    events,
    warnings: [...warnings],
  };
}

type Warn = (scope: string, err: unknown) => void;

// ---------------------------------------------------------------- courses

async function getCourses(client: MoodleClient, scope: "inprogress" | "all", warn: Warn): Promise<Course[]> {
  try {
    const data = await client.call<{ courses: Array<{ id: number; shortname: string; fullname: string; viewurl: string }> }>(
      "core_course_get_enrolled_courses_by_timeline_classification",
      { classification: scope, limit: 0, offset: 0, sort: "fullname" },
    );
    return data.courses.map((c) => ({
      id: c.id,
      shortname: c.shortname,
      fullname: htmlToText(c.fullname),
      url: c.viewurl,
    }));
  } catch (err) {
    if (err instanceof MoodleError && err.errorcode === "servicerequireslogin") throw err;
    warn("courses (WS)", err);
  }
  // Fallback: course links in the navigation / dashboard.
  const doc = await client.page("/my/courses.php");
  const seen = new Map<number, Course>();
  doc.querySelectorAll<HTMLAnchorElement>('a[href*="/course/view.php?id="]').forEach((a) => {
    const id = Number(new URL(a.href, client.wwwroot).searchParams.get("id"));
    const name = a.textContent?.trim() ?? "";
    if (id > 1 && name && !seen.has(id)) {
      seen.set(id, { id, shortname: name, fullname: name, url: client.absolute(`/course/view.php?id=${id}`) });
    }
  });
  return [...seen.values()];
}

// ---------------------------------------------------------------- course contents

interface WsModule {
  id: number;
  name: string;
  instance: number;
  modname: string;
  url?: string;
  contents?: Array<{
    type: string;
    filename: string;
    filepath: string;
    fileurl: string;
    filesize: number;
    timemodified: number;
    mimetype?: string;
  }>;
}

async function getCourseContents(
  client: MoodleClient,
  course: Course,
  warn: Warn,
  onText: OnText,
): Promise<{ resources: Resource[]; forums: ForumRef[] }> {
  const resources: Resource[] = [];
  const activities: Resource[] = [];
  const forums: ForumRef[] = [];
  try {
    const sections = await client.call<Array<{ name: string; modules: WsModule[] }>>("core_course_get_contents", {
      courseid: course.id,
      options: [],
    });
    for (const section of sections) {
      for (const mod of section.modules) {
        if (mod.modname === "forum") {
          forums.push({ courseId: course.id, instance: mod.instance, name: mod.name });
          continue;
        }
        if (wantsText(mod.modname)) {
          activities.push(activityResource(client, course, mod.id, mod.modname, mod.name, htmlToText(section.name)));
          continue;
        }
        for (const f of mod.contents ?? []) {
          const isLink = f.type === "url";
          if (f.type !== "file" && !isLink) continue;
          resources.push({
            key: `${mod.id}:${f.filepath}${f.filename}`,
            cmid: mod.id,
            courseId: course.id,
            section: htmlToText(section.name),
            name: mod.name,
            modname: mod.modname,
            url: isLink ? f.fileurl : client.sessionFileUrl(f.fileurl),
            filename: isLink ? undefined : f.filename,
            mimetype: f.mimetype,
            filesize: f.filesize || undefined,
            timemodified: f.timemodified || undefined,
          });
        }
      }
    }
    resources.push(...(await readActivities(client, course, activities, warn, onText)));
    return { resources, forums };
  } catch (err) {
    warn(`contents ${course.shortname} (WS)`, err);
  }

  // Fallback (the real path on Uniovi, where core_course_get_contents is disabled).
  // Don't parse /course/view.php: formats like Onetopic (used at Uniovi) render only the
  // current tab. The per-course index pages list every activity regardless of format.
  try {
    const doc = await client.page(`/course/resources.php?id=${course.id}`);
    let section = "";
    for (const tr of doc.querySelectorAll<HTMLTableRowElement>("table.generaltable tbody tr")) {
      // The section name is only printed on the first row of each section group.
      const sectionText = tr.querySelector("td")?.textContent?.trim();
      if (sectionText) section = sectionText;
      const a = tr.querySelector<HTMLAnchorElement>('a[href*="/mod/"][href*="view.php?id="]');
      const m = a && /\/mod\/(\w+)\/view\.php\?id=(\d+)/.exec(a.href);
      if (!a || !m) continue;
      const modname = m[1]!;
      const cmid = Number(m[2]);
      const name = a.textContent?.trim() ?? "";
      if (modname === "folder") {
        resources.push(...(await scrapeFolder(client, course, cmid, name, section, warn)));
        continue;
      }
      if (wantsText(modname)) {
        activities.push(activityResource(client, course, cmid, modname, name, section));
        continue;
      }
      resources.push({
        key: modname === "resource" ? `${cmid}:/` : `${cmid}:link`,
        cmid,
        courseId: course.id,
        section,
        name,
        modname,
        // redirect=1 makes view.php answer with a redirect to the pluginfile.php file.
        url: modname === "resource" ? client.absolute(`/mod/resource/view.php?id=${cmid}&redirect=1`) : a.href,
      });
    }
  } catch (err) {
    warn(`resources ${course.shortname} (HTML)`, err);
  }
  const pages = await scrapeCoursePages(client, course, warn, onText);
  resources.push(...pages.files);
  // resources.php lists only resource-type modules (files, folders, pages, links, books): quizzes,
  // assignments, lessons... are found on the section pages.
  const known = new Set(activities.map((a) => a.cmid));
  for (const a of pages.activities) {
    if (known.has(a.cmid) || !wantsText(a.modname)) continue;
    known.add(a.cmid);
    activities.push(a);
  }
  resources.push(...(await readActivities(client, course, activities, warn, onText)));
  try {
    const doc = await client.page(`/mod/forum/index.php?id=${course.id}`);
    const seen = new Set<number>();
    // Hrefs here are relative ("view.php?f=12"): match loosely, then check the resolved URL.
    doc.querySelectorAll<HTMLAnchorElement>('table.generaltable a[href*="view.php?f="]').forEach((a) => {
      const url = new URL(a.href);
      if (!url.pathname.endsWith("/mod/forum/view.php")) return;
      const instance = Number(url.searchParams.get("f"));
      if (instance && !seen.has(instance)) {
        seen.add(instance);
        forums.push({ courseId: course.id, instance, name: a.textContent?.trim() ?? "" });
      }
    });
  } catch (err) {
    warn(`forums ${course.shortname} (HTML)`, err);
  }
  return { resources, forums };
}

/** An activity (not a file, not a forum) as a snapshot resource; its text is read by readActivities. */
function activityResource(client: MoodleClient, course: Course, cmid: number, modname: string, name: string, section: string): Resource {
  return { key: `${cmid}:link`, cmid, courseId: course.id, section, name, modname, url: client.absolute(`/mod/${modname}/view.php?id=${cmid}`) };
}

/**
 * Reads each activity's page: its full text goes to onText, files linked from it become resources.
 * A link activity's `url` becomes its target. Returns the activities plus those files.
 */
async function readActivities(client: MoodleClient, course: Course, activities: Resource[], warn: Warn, onText: OnText): Promise<Resource[]> {
  const out: Resource[] = [];
  const host = new URL(client.wwwroot).host;
  for (const a of activities) {
    const r: Resource & { filename: string } = { ...a, filename: textFilename(a.name) };
    out.push(r);
    try {
      const doc = await client.page(activityTextPath(a.modname, a.cmid));
      if (a.modname === "url") r.url = linkTarget(doc) ?? r.url;
      const region = mainRegion(doc);
      out.push(...linkedFiles(region, { cmid: a.cmid, courseId: course.id, section: a.section, name: a.name }));
      const text = elementText(region, host);
      if (text) onText(r, text);
    } catch (err) {
      warn(`${a.modname} ${course.shortname}`, err);
    }
  }
  return out;
}

/**
 * The course page and every section tab of it (Onetopic renders one section per page):
 * - its text (section summaries and labels: syllabus, teachers, rules), stored as one text file;
 * - files linked from section descriptions (pluginfile.php/<ctx>/course/section/<id>/<file>). Some
 *   courses (e.g. CPM at Uniovi) publish everything this way, so resources.php is empty;
 * - every activity linked there, since resources.php leaves out quizzes, assignments and the like.
 */
async function scrapeCoursePages(client: MoodleClient, course: Course, warn: Warn, onText: OnText): Promise<{ files: Resource[]; activities: Resource[] }> {
  const byKey = new Map<string, Resource>();
  const activities = new Map<number, Resource>();
  const texts: string[] = [];
  const host = new URL(client.wwwroot).host;
  const collectFrom = (doc: Document) => {
    const region = mainRegion(doc);
    const text = elementText(region, host);
    if (text && !texts.includes(text)) texts.push(text);
    for (const a of region.querySelectorAll<HTMLAnchorElement>('a[href*="/mod/"][href*="view.php?id="]')) {
      const m = /\/mod\/(\w+)\/view\.php\?id=(\d+)/.exec(a.href);
      if (!m || activities.has(Number(m[2]))) continue;
      const sectionEl = a.closest('li.section, [data-for="section"]');
      const section = sectionEl?.querySelector(".sectionname, [data-for='section_title']")?.textContent?.trim() ?? "";
      // The activity name without the type label ("Tarea", "Cuestionario") Moodle adds for screen readers.
      const nameEl = a.querySelector(".instancename") ?? a;
      const name = [...nameEl.childNodes]
        .filter((n) => !(n instanceof Element && n.matches(".accesshide, .sr-only, .visually-hidden")))
        .map((n) => n.textContent)
        .join("")
        .replace(/\s+/g, " ")
        .trim();
      if (name) activities.set(Number(m[2]), activityResource(client, course, Number(m[2]), m[1]!, name, section));
    }
    for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/pluginfile.php/"][href*="/course/section/"]')) {
      const url = new URL(a.href);
      url.searchParams.delete("forcedownload");
      const m = /\/course\/section\/(\d+)\/(.+)$/.exec(url.pathname);
      if (!m) continue;
      const key = `section${m[1]}:/${decodeURIComponent(m[2]!)}`;
      if (byKey.has(key)) continue;
      const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "file");
      // Links are often bare "Castellano" / "English" inside a line like "Presentación: Castellano / English".
      const line = (a.closest("li, p, td, div")?.textContent ?? "").replace(/\s+/g, " ").trim();
      const label = line.split(/[:.]/)[0]!.trim().slice(0, 80);
      const linkText = a.textContent?.trim() ?? "";
      const sectionEl = a.closest('li.section, [data-for="section"]');
      byKey.set(key, {
        key,
        cmid: Number(m[1]),
        courseId: course.id,
        section: sectionEl?.querySelector(".sectionname, [data-for='section_title']")?.textContent?.trim() ?? "",
        name: label && label !== linkText ? `${label} (${linkText})` : linkText || filename,
        modname: "section-file",
        url: url.toString(),
        filename,
      });
    }
  };
  try {
    const doc = await client.page(`/course/view.php?id=${course.id}`);
    collectFrom(doc);
    const tabs = new Set<string>();
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="course/view.php?id="][href*="section="]').forEach((a) => {
      const u = new URL(a.href);
      if (Number(u.searchParams.get("id")) === course.id && u.searchParams.get("section")) tabs.add(u.searchParams.get("section")!);
    });
    for (const s of [...tabs].slice(0, 40)) collectFrom(await client.page(`/course/view.php?id=${course.id}&section=${s}`));
  } catch (err) {
    warn(`section files ${course.shortname}`, err);
  }
  if (texts.length) {
    const name = `Página de la asignatura ${course.shortname}`;
    const page = { key: `course${course.id}:page`, cmid: 0, courseId: course.id, section: "", name, modname: "coursepage", url: course.url, filename: textFilename(name) };
    byKey.set(page.key, page);
    onText(page, texts.join("\n\n"));
  }
  return { files: [...byKey.values()], activities: [...activities.values()] };
}

async function scrapeFolder(
  client: MoodleClient,
  course: Course,
  cmid: number,
  name: string,
  section: string,
  warn: Warn,
): Promise<Resource[]> {
  try {
    const doc = await client.page(`/mod/folder/view.php?id=${cmid}`);
    const byKey = new Map<string, Resource>();
    for (const a of doc.querySelectorAll<HTMLAnchorElement>('a[href*="/pluginfile.php/"]')) {
      const url = new URL(a.href);
      url.searchParams.delete("forcedownload");
      const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "file");
      // .../pluginfile.php/<ctx>/mod_folder/content/<rev>/<sub/dirs>/<file>: key on the path
      // inside the folder, so same-named files in different subfolders stay distinct.
      const inner = /\/mod_folder\/content\/\d+(\/.*)$/.exec(url.pathname)?.[1];
      const key = `${cmid}:${inner ? decodeURIComponent(inner) : `/${filename}`}`;
      if (byKey.has(key)) continue; // the same file can be linked twice (icon + name)
      byKey.set(key, {
        key,
        cmid,
        courseId: course.id,
        section,
        name,
        modname: "folder",
        url: url.toString(),
        filename,
      });
    }
    return [...byKey.values()];
  } catch (err) {
    warn(`folder ${cmid}`, err);
    return [];
  }
}

// ---------------------------------------------------------------- forums

interface WsDiscussion {
  id: number;
  discussion?: number;
  name: string;
  subject: string;
  message: string;
  userfullname: string;
  created: number;
  timemodified: number;
  numreplies?: number;
}

async function getForumPosts(client: MoodleClient, forum: ForumRef, replyWindowDays: number, warn: Warn): Promise<ForumPost[]> {
  const posts: ForumPost[] = [];
  const discussUrl = (d: number, p?: number) =>
    client.absolute(`/mod/forum/discuss.php?d=${d}${p ? `#p${p}` : ""}`);

  // 1. Discussion list via WS: includes each first post, so replies are only fetched for
  //    recently active discussions. (Disabled at Uniovi.)
  try {
    const data = await client.call<{ discussions: WsDiscussion[] }>("mod_forum_get_forum_discussions", {
      forumid: forum.instance,
      sortorder: 0,
      page: 0,
      perpage: 50,
    });
    const cutoff = now() - replyWindowDays * 86400;
    for (const d of data.discussions) {
      const discussionId = d.discussion ?? d.id;
      posts.push({
        id: d.id,
        discussionId,
        courseId: forum.courseId,
        forumName: forum.name,
        subject: htmlToText(d.subject || d.name),
        author: d.userfullname,
        created: d.created,
        message: htmlToText(d.message),
        url: discussUrl(discussionId),
      });
      if ((d.numreplies ?? 0) > 0 && d.timemodified >= cutoff) {
        posts.push(...(await getDiscussionPosts(client, forum, discussionId, warn, d.id)));
      }
    }
    return posts;
  } catch (err) {
    warn(`forum ${forum.name} (WS)`, err);
  }

  // 2. Discussion list from the forum page, then every post of each discussion.
  try {
    const doc = await client.page(`/mod/forum/view.php?f=${forum.instance}`);
    const ids = new Set<number>();
    doc.querySelectorAll<HTMLAnchorElement>('a[href*="discuss.php?d="]').forEach((a) => {
      const d = Number(new URL(a.href).searchParams.get("d"));
      if (d) ids.add(d);
    });
    for (const d of [...ids].slice(0, 50)) {
      posts.push(...(await getDiscussionPosts(client, forum, d, warn)));
    }
  } catch (err) {
    warn(`forum ${forum.name} (HTML)`, err);
  }
  return posts;
}

/** All posts of a discussion (optionally minus one already collected): WS first, then the discuss.php page. */
async function getDiscussionPosts(
  client: MoodleClient,
  forum: ForumRef,
  discussionId: number,
  warn: Warn,
  excludeId?: number,
): Promise<ForumPost[]> {
  const url = (p: number) => client.absolute(`/mod/forum/discuss.php?d=${discussionId}#p${p}`);
  const base = { discussionId, courseId: forum.courseId, forumName: forum.name };
  try {
    const data = await client.call<{
      posts: Array<{ id: number; subject: string; message: string; timecreated: number; author: { fullname: string } }>;
    }>("mod_forum_get_discussion_posts", { discussionid: discussionId, sortby: "created", sortdirection: "ASC" });
    return data.posts
      .filter((p) => p.id !== excludeId)
      .map((p) => ({
        ...base,
        id: p.id,
        subject: htmlToText(p.subject),
        author: p.author.fullname,
        created: p.timecreated,
        message: htmlToText(p.message),
        url: url(p.id),
      }));
  } catch (err) {
    warn(`discussion d=${discussionId} (WS)`, err);
  }

  try {
    const page = await client.page(`/mod/forum/discuss.php?d=${discussionId}`);
    // In Moodle 4.x a post matches both [data-region="post"] and an inner .forumpost, and
    // threaded replies are nested inside their parent: dedupe by id, first match wins.
    const byId = new Map<number, ForumPost>();
    page.querySelectorAll<HTMLElement>("[data-post-id]").forEach((el) => {
      const id = Number(el.getAttribute("data-post-id"));
      if (!id || id === excludeId || byId.has(id)) return;
      const subject = el.querySelector('[data-region-content="forum-post-core-subject"], .subject')?.textContent?.trim() ?? "";
      const author =
        [...el.querySelectorAll('a[href*="/user/view.php"]')].map((a) => a.textContent?.trim()).find(Boolean) ?? "";
      const time = el.querySelector("time")?.getAttribute("datetime");
      const content = el.querySelector(".post-content-container, .posting");
      byId.set(id, {
        ...base,
        id,
        subject,
        author,
        created: time ? Math.floor(Date.parse(time) / 1000) : 0,
        message: content ? htmlToText(content.innerHTML) : "",
        url: url(id),
      });
    });
    return [...byId.values()];
  } catch (err) {
    warn(`discussion d=${discussionId} (HTML)`, err);
    return [];
  }
}

// ---------------------------------------------------------------- assignments & calendar

async function getAssignments(client: MoodleClient, courses: Course[], warn: Warn): Promise<Assignment[]> {
  if (courses.length === 0) return [];
  try {
    const data = await client.call<{
      courses: Array<{
        id: number;
        assignments: Array<{
          id: number;
          cmid: number;
          name: string;
          duedate: number;
          cutoffdate: number;
          allowsubmissionsfromdate: number;
          intro: string;
        }>;
      }>;
    }>("mod_assign_get_assignments", { courseids: courses.map((c) => c.id) });
    return data.courses.flatMap((c) =>
      c.assignments.map((a) => ({
        id: a.id,
        cmid: a.cmid,
        courseId: c.id,
        name: htmlToText(a.name),
        dueDate: a.duedate || undefined,
        cutoffDate: a.cutoffdate || undefined,
        allowSubmissionsFrom: a.allowsubmissionsfromdate || undefined,
        intro: htmlToText(a.intro ?? ""),
        url: client.absolute(`/mod/assign/view.php?id=${a.cmid}`),
      })),
    );
  } catch (err) {
    // Commonly not AJAX-enabled; assignment due dates still arrive via the calendar.
    warn("assignments (WS, due dates still come from calendar)", err);
    return [];
  }
}

interface WsEvent {
  id: number;
  name: string;
  description?: string;
  eventtype: string;
  modulename?: string;
  timestart: number;
  timesort?: number;
  course?: { id: number };
  courseid?: number;
  url?: string;
}

async function getEvents(client: MoodleClient, warn: Warn): Promise<CalendarEvent[]> {
  const byId = new Map<number, CalendarEvent>();
  const add = (e: WsEvent) =>
    byId.set(e.id, {
      id: e.id,
      courseId: e.course?.id ?? e.courseid,
      name: htmlToText(e.name),
      type: e.eventtype,
      module: e.modulename || undefined,
      time: e.timesort ?? e.timestart,
      description: htmlToText(e.description ?? ""),
      url: e.url,
    });

  try {
    const data = await client.call<{ events: WsEvent[] }>("core_calendar_get_action_events_by_timesort", {
      timesortfrom: now() - 14 * 86400,
      timesortto: now() + 365 * 86400,
      limitnum: 50,
    });
    data.events.forEach(add);
  } catch (err) {
    warn("calendar action events", err);
  }
  try {
    const data = await client.call<{ events: WsEvent[] }>("core_calendar_get_calendar_upcoming_view", {
      courseid: 1,
      categoryid: 0,
    });
    data.events.forEach(add);
  } catch (err) {
    warn("calendar upcoming", err);
  }
  return [...byId.values()].sort((a, b) => a.time - b.time);
}
