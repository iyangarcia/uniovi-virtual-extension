import assert from "node:assert/strict";
import { test } from "node:test";
import { isImportant, seenAll, unseen, upcoming } from "../../shared/digest.ts";
import type { Snapshot } from "../../shared/types.ts";

const now = Date.parse("2026-11-17T10:00:00Z");
const unix = (iso: string) => Math.floor(Date.parse(iso) / 1000);

const snap: Snapshot = {
  syncedAt: unix("2026-11-17T10:00:00Z"),
  siteUrl: "https://x",
  warnings: [],
  courses: [{ id: 1, shortname: "FIS", fullname: "Física", url: "" }],
  resources: [{ key: "5:/", cmid: 5, courseId: 1, section: "T1", name: "Tema 1", modname: "resource", url: "" }],
  assignments: [{ id: 1, cmid: 9, courseId: 1, name: "Práctica 2", dueDate: unix("2026-12-01T22:59:00Z"), intro: "", url: "a" }],
  events: [
    { id: 1, courseId: 1, name: "Práctica 2 is due", type: "due", module: "assign", time: unix("2026-12-01T22:59:00Z"), description: "" },
    { id: 2, courseId: 1, name: "Examen final", type: "course", time: unix("2027-01-20T08:00:00Z"), description: "" },
  ],
  posts: [
    { id: 10, discussionId: 1, courseId: 1, forumName: "Avisos", subject: "Parcial", author: "P", created: unix("2026-11-16T09:00:00Z"), message: "El examen parcial será el 3 de diciembre a las 9:30.", url: "u" },
    { id: 11, discussionId: 2, courseId: 1, forumName: "Avisos", subject: "Tutorías", author: "P", created: unix("2026-11-15T09:00:00Z"), message: "Hoy no hay tutoría.", url: "u" },
    { id: 12, discussionId: 3, courseId: 1, forumName: "Avisos", subject: "Recordatorio", author: "P", created: unix("2026-11-17T09:00:00Z"), message: "Recordad: examen final el 20 de enero.", url: "u" },
  ],
};

test("merges calendar, assignments and forum dates; dedupes repeats", () => {
  const items = upcoming(snap, 90, now);
  assert.deepEqual(
    items.map((i) => [i.date, i.kind, i.source]),
    [
      ["2026-12-01", "deadline", "assignment"],
      ["2026-12-03", "exam", "forum"],
      ["2027-01-20", "exam", "calendar"], // the forum reminder of the same exam is dropped
    ],
  );
  assert.equal(items[0]!.clock, "23:59"); // Madrid time
});

test("window excludes later items", () => {
  assert.equal(upcoming(snap, 20, now).length, 2);
});

test("unseen and importance", () => {
  const seen = seenAll({ ...snap, posts: snap.posts.slice(1) });
  assert.deepEqual(unseen(snap, seen).posts.map((p) => p.id), [10]);
  assert.equal(isImportant(snap.posts[0]!), true);
  assert.equal(isImportant(snap.posts[1]!), false);
});
