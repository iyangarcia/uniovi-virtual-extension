import type { Course, Snapshot } from "../types.ts";
import { isUpload } from "../types.ts";
import type { DataStore } from "./store.ts";

// Helpers shared by the MCP tools (server.ts) and the search logic (search.ts).

export const TZ = "Europe/Madrid";
export const fmt = new Intl.DateTimeFormat("sv-SE", {
  timeZone: TZ,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});
const weekday = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "short" });
/** "2027-01-15 10:00 (vie)" in Madrid time. */
export const when = (unix: number) => `${fmt.format(unix * 1000)} (${weekday.format(unix * 1000)})`;
export const nowUnix = () => Math.floor(Date.now() / 1000);

/** Accent- and case-insensitive form used by every text match. */
export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** An error whose message is meant for the AI/user (returned as a tool error, not logged). */
export class UserError extends Error {}

export const NO_DATA =
  "No Uniovi Virtual data synced yet. Open Uniovi Virtual (campusvirtual.uniovi.es) in Chrome, logged in, with the extension installed: it syncs on its own. Or click «Sincronizar ahora» in the extension popup.";

export async function requireSnapshot(store: DataStore): Promise<Snapshot> {
  const s = await store.snapshot();
  if (s) return s;
  // Not synced yet, but the student already added files on «Mis apuntes»: answer from those.
  if (Object.values(await store.index()).some((f) => isUpload(f.resource))) {
    return { syncedAt: 0, siteUrl: "", courses: [], resources: [], posts: [], assignments: [], events: [], warnings: [NO_DATA] };
  }
  throw new UserError(NO_DATA);
}

/** Resolves a course filter (id, shortname or part of the name, accent-insensitive). */
export function matchCourses(s: Snapshot, filter?: string): Course[] {
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

/**
 * True when a course filter asks for the files the student uploaded («Mis archivos»), not for a
 * campus course. Whole-filter match only, so a course such as «Minería» never counts.
 */
export function isUploadsFilter(filter?: string): boolean {
  if (!filter) return false;
  const f = fold(filter.trim()).replace(/\s+/g, " ");
  return /^(0|mis archivos|mis apuntes subidos|mis subidas|archivos subidos|subidos?( por mi)?|mine|my (files|uploads)|uploads?|uploaded)$/.test(f);
}
