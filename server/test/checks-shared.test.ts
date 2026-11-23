// Tests added by the mutation audit (goals/03-verify-checks.md) for shared/dates.ts and
// shared/digest.ts: each one kills a mutation the original suite let through.
import assert from "node:assert/strict";
import { test } from "node:test";
import { findDates } from "../../shared/dates.ts";
import { isImportant, seenAll, unseen, upcoming } from "../../shared/digest.ts";
import type { ForumPost, Snapshot } from "../../shared/types.ts";

const posted = new Date("2026-11-10T09:00:00Z");

test("dates: 'a las 10' without minutes is 10:00", () => {
  const [d] = findDates("El examen será el 20 de enero a las 10 en el aula A-1.", posted);
  assert.equal(d?.time, "10:00");
});

test("dates: dotted times are not dates, even when they form a valid day.month", () => {
  assert.deepEqual(findDates("Tutoría a las 9.12 en el despacho", posted), []);
});

test("dates: two-digit years mean 20xx", () => {
  const [d] = findDates("Entrega: 01/12/26", posted);
  assert.equal(d?.date, "2026-12-01");
});

test("dates: the same date written twice is reported once", () => {
  const found = findDates("Examen el 15 de enero. Repito: examen el 15/01.", posted);
  assert.deepEqual(found.map((d) => d.date), ["2027-01-15"]);
});

test("dates: an exam word wins over a deadline word in the same sentence", () => {
  const [d] = findDates("Plazo de revisión del examen: 20 de enero.", posted);
  assert.equal(d?.kind, "exam");
});

test("dates: 'parcial' alone marks an exam", () => {
  const [d] = findDates("Segundo parcial el 20 de enero.", posted);
  assert.equal(d?.kind, "exam");
});

test("dates: a date shortly before the post keeps the post's year (45-day look-back)", () => {
  // Posted 10 Nov 2026 about 1 Nov: last week, not November 2027.
  const [d] = findDates("Las notas del examen del 1 de noviembre ya están publicadas.", posted);
  assert.equal(d?.date, "2026-11-01");
});

// ---------------------------------------------------------------- digest

const now = Date.parse("2026-11-17T10:00:00Z");
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);
const post = (p: Partial<ForumPost> & Pick<ForumPost, "id" | "subject" | "message" | "created">): ForumPost => ({
  discussionId: p.id,
  courseId: 1,
  forumName: "Avisos",
  author: "P",
  url: `u${p.id}`,
  ...p,
});
const base: Snapshot = {
  syncedAt: unix("2026-11-17T10:00:00Z"),
  siteUrl: "https://x",
  warnings: [],
  courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "" }],
  resources: [],
  assignments: [],
  events: [],
  posts: [],
};

test("digest: past items are left out", () => {
  const s: Snapshot = {
    ...base,
    events: [{ id: 1, courseId: 1, name: "Examen parcial", type: "course", time: unix("2026-11-10T08:00:00Z"), description: "" }],
  };
  assert.deepEqual(upcoming(s, 90, now), []);
});

test("digest: quiz events are exams", () => {
  const s: Snapshot = {
    ...base,
    events: [{ id: 1, courseId: 1, name: "Cuestionario tema 3", type: "open", module: "quiz", time: unix("2026-11-20T08:00:00Z"), description: "" }],
  };
  assert.equal(upcoming(s, 90, now)[0]?.kind, "exam");
});

test("digest: forum dates with no exam/deadline meaning are not listed", () => {
  const s: Snapshot = { ...base, posts: [post({ id: 1, subject: "Tutorías", message: "Las tutorías del 25 de noviembre se mueven.", created: unix("2026-11-16T09:00:00Z") })] };
  assert.deepEqual(upcoming(s, 90, now), []);
});

test("digest: when several posts announce the same date, the newest post wins", () => {
  const s: Snapshot = {
    ...base,
    posts: [
      post({ id: 1, subject: "Primer aviso", message: "Examen parcial el 3 de diciembre.", created: unix("2026-11-01T09:00:00Z") }),
      post({ id: 2, subject: "Aviso corregido", message: "Examen parcial el 3 de diciembre en el aula B.", created: unix("2026-11-16T09:00:00Z") }),
    ],
  };
  const items = upcoming(s, 90, now);
  assert.deepEqual(items.map((i) => i.title), ["Aviso corregido"]);
});

test("digest: unseen covers resources too, and lists new posts newest first", () => {
  const s: Snapshot = {
    ...base,
    resources: [
      { key: "a", cmid: 1, courseId: 1, section: "T1", name: "A", modname: "resource", url: "" },
      { key: "b", cmid: 2, courseId: 1, section: "T1", name: "B", modname: "resource", url: "" },
    ],
    posts: [
      post({ id: 1, subject: "Viejo", message: "", created: unix("2026-11-01T09:00:00Z") }),
      post({ id: 2, subject: "Nuevo", message: "", created: unix("2026-11-16T09:00:00Z") }),
    ],
  };
  const seen = seenAll({ ...s, resources: s.resources.slice(0, 1), posts: [] });
  const u = unseen(s, seen);
  assert.deepEqual(u.resources.map((r) => r.key), ["b"]);
  assert.deepEqual(u.posts.map((p) => p.id), [2, 1]);
});

test("digest: a subject announcing an exam is important even without a date", () => {
  assert.equal(isImportant(post({ id: 1, subject: "Examen final", message: "Ya están las normas en el aula virtual.", created: unix("2026-11-16T09:00:00Z") })), true);
});
