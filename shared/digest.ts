// Turns a Snapshot into the things a student actually looks at: what's coming up and
// what's new. Used by the extension (campus panel, notifications); pure, no DOM/Node APIs.
import { classify, findDates } from "./dates.ts";
import type { ForumPost, GradeItem, Resource, Snapshot } from "./types.ts";

export const TZ = "Europe/Madrid";

export type ItemKind = "exam" | "deadline" | "event";

export interface UpcomingItem {
  /** YYYY-MM-DD in Madrid time */
  date: string;
  /** HH:MM when known */
  clock?: string;
  kind: ItemKind;
  source: "calendar" | "assignment" | "forum";
  title: string;
  courseId?: number;
  url?: string;
  /** For forum-detected dates: the sentence the date came from, so the user can judge it. */
  snippet?: string;
}

const dayFmt = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" });
const clockFmt = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, hour: "2-digit", minute: "2-digit", hour12: false });

export const madridDate = (unix: number) => dayFmt.format(unix * 1000);
const madridClock = (unix: number) => clockFmt.format(unix * 1000);

export function upcoming(s: Snapshot, days: number, nowMs = Date.now()): UpcomingItem[] {
  const today = dayFmt.format(nowMs);
  const until = dayFmt.format(nowMs + days * 86400_000);
  const items: UpcomingItem[] = [];

  for (const a of s.assignments) {
    if (!a.dueDate) continue;
    items.push({
      date: madridDate(a.dueDate),
      clock: madridClock(a.dueDate),
      kind: "deadline",
      source: "assignment",
      title: a.name,
      courseId: a.courseId,
      url: a.url,
    });
  }
  for (const e of s.events) {
    // The calendar repeats assignment due dates; keep a single entry.
    if (items.some((i) => i.source === "assignment" && i.date === madridDate(e.time) && e.name.includes(i.title))) continue;
    const kind: ItemKind =
      e.module === "quiz" || classify(e.name) === "exam"
        ? "exam"
        : e.module === "assign" || e.type === "due" || e.type === "close"
          ? "deadline"
          : (classify(e.name) ?? "event") === "deadline"
            ? "deadline"
            : "event";
    items.push({
      date: madridDate(e.time),
      clock: madridClock(e.time),
      kind,
      source: "calendar",
      title: e.name,
      courseId: e.courseId,
      url: e.url,
    });
  }

  // Newest posts first, so the latest announcement of a date wins when several repeat it.
  const posts = [...s.posts].sort((a, b) => b.created - a.created);
  for (const p of posts) {
    for (const m of findDates(`${p.subject}\n${p.message}`, new Date(p.created * 1000))) {
      if (m.kind === "other") continue;
      const dup = items.some((i) => i.courseId === p.courseId && i.date === m.date && i.kind === m.kind);
      if (dup) continue;
      items.push({
        date: m.date,
        clock: m.time,
        kind: m.kind,
        source: "forum",
        title: p.subject,
        courseId: p.courseId,
        url: p.url,
        snippet: m.snippet,
      });
    }
  }

  return items
    .filter((i) => i.date >= today && i.date <= until)
    .sort((a, b) => `${a.date} ${a.clock ?? "99"}`.localeCompare(`${b.date} ${b.clock ?? "99"}`));
}

export interface Seen {
  posts: number[];
  resources: string[];
  /** `${key}=${grade}`, so a changed grade shows up as new again. Missing in older stored state. */
  grades?: string[];
}

const gradeId = (g: GradeItem) => `${g.key}=${g.grade}`;

export const seenAll = (s: Snapshot): Seen => ({
  posts: s.posts.map((p) => p.id),
  resources: s.resources.map((r) => r.key),
  grades: (s.grades ?? []).map(gradeId),
});

export function unseen(s: Snapshot, seen: Seen): { posts: ForumPost[]; resources: Resource[]; grades: GradeItem[] } {
  const posts = new Set(seen.posts);
  const res = new Set(seen.resources);
  // State saved before grades existed: treat current grades as seen rather than flooding the panel.
  const grades = seen.grades ? new Set(seen.grades) : null;
  return {
    posts: s.posts.filter((p) => !posts.has(p.id)).sort((a, b) => b.created - a.created),
    resources: s.resources.filter((r) => !res.has(r.key)),
    grades: grades ? (s.grades ?? []).filter((g) => !grades.has(gradeId(g))).sort((a, b) => (b.firstSeen ?? 0) - (a.firstSeen ?? 0)) : [],
  };
}

/**
 * Carries firstSeen over from the previous snapshot when the grade is unchanged. Grades that
 * are new or changed keep the firstSeen they arrived with (the extension stamps at sync time,
 * the server at ingest, which can be later), or get `now`.
 */
export function stampGrades(prev: Snapshot | null | undefined, next: Snapshot, now: number): void {
  const old = new Map((prev?.grades ?? []).map((g) => [g.key, g]));
  for (const g of next.grades ?? []) {
    const o = old.get(g.key);
    // An incoming firstSeen (stamped by the extension when it synced) beats `now` at ingest time.
    g.firstSeen = o && o.grade === g.grade && o.firstSeen ? o.firstSeen : (g.firstSeen ?? now);
  }
}

/** Grades that are new, or whose value changed, compared with the previous snapshot. */
export function changedGrades(prev: Snapshot | null | undefined, next: Snapshot): GradeItem[] {
  // A previous snapshot without grades came from an older extension: nothing to compare with.
  if (!prev?.grades) return [];
  const old = new Map(prev.grades.map((g) => [g.key, g.grade]));
  return (next.grades ?? []).filter((g) => old.get(g.key) !== g.grade);
}

/** A post worth interrupting the user for: mentions an exam/deadline, or carries such a date. */
export function isImportant(p: ForumPost): boolean {
  const text = `${p.subject}\n${p.message}`;
  if (classify(p.subject)) return true;
  return findDates(text, new Date(p.created * 1000)).some((m) => m.kind !== "other");
}
