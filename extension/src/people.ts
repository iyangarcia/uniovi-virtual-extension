// The student's own grades, the teachers of each course and the student's own groups, parsed from
// campus pages (DOM only; collector.ts fetches). Verified on Uniovi Virtual 2026-11-25:
// - /grade/report/user/index.php?id=<course>: table.user-grade, one row per category / item / total;
//   labels follow the course language (Spanish or English), so rows are read by class, not by text.
// - /user/index.php?id=<course>&roleid=3&perpage=5000: participants filtered to "Profesor". When the
//   role filter matches nobody, the page ignores it and lists everyone: rows are filtered by role here.
// - /user/view.php?course=<course> (no id: the student's own course profile): "Grupo" lists their groups.
// Privacy: other students are never returned. Only rows whose role is a teacher role leave this module.
import type { GradeItem, Teacher } from "../../shared/types.ts";

/** Text of a cell without screen-reader-only duplicates, whitespace collapsed. */
function cellText(el: Element | null | undefined): string {
  if (!el) return "";
  const c = el.cloneNode(true) as Element;
  c.querySelectorAll(".accesshide, .sr-only, .visually-hidden, .action-menu, .dropdown-menu, script, style").forEach((n) => n.remove());
  return (c.textContent ?? "").replace(/\s+/g, " ").trim();
}

const levelOf = (el: Element) => Number(/\blevel(\d+)\b/.exec(el.className)?.[1] ?? 0);

/** Rows of the user grade report. The level-1 category (the course itself) is left out of `category`. */
export function parseGradeReport(doc: Document, courseId: number): GradeItem[] {
  const table = doc.querySelector("table.user-grade");
  if (!table) return [];
  const categories: string[] = [];
  const items: GradeItem[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    const th = tr.querySelector("th.column-itemname");
    if (!th) continue;
    const level = levelOf(th);
    if (th.classList.contains("category")) {
      categories.length = Math.max(0, level - 1);
      categories[level - 1] = cellText(th);
      continue;
    }
    const grade = tr.querySelector("td.column-grade");
    if (!grade) continue;
    const name = cellText(th.querySelector(".rowtitle")) || cellText(th);
    const kind = cellText(th.querySelector(".dimmed_text")) || undefined;
    const optional = (cls: string) => cellText(tr.querySelector(`td.column-${cls}`)) || undefined;
    items.push({
      courseId,
      // Categories strictly above this row, minus the course (level 1).
      category: categories.slice(1, Math.max(1, level - 1)).filter(Boolean),
      name,
      kind,
      total: /\bbagg[tb]\b/.test(th.className),
      grade: cellText(grade) || "-",
      range: optional("range"),
      percentage: optional("percentage"),
      feedback: optional("feedback"),
      contribution: optional("contributiontocoursetotal"),
    });
  }
  return items;
}

const TEACHER_ROLE = /profesor|teacher|docente/i;

/** Index of the header cell whose text matches, in the participants table. */
function column(table: Element, re: RegExp): number {
  return [...table.querySelectorAll("thead th")].findIndex((th) => re.test(cellText(th)));
}

/** Teachers on a participants page. Every other row (students) is dropped here. */
export function parseTeachers(doc: Document, courseId: number): Teacher[] {
  const table = doc.querySelector("table#participants");
  if (!table) return [];
  const roleCol = column(table, /^roles?$/i);
  const groupCol = column(table, /^(grupos?|groups?)$/i);
  if (roleCol < 0) return [];
  const out: Teacher[] = [];
  for (const tr of table.querySelectorAll("tbody tr")) {
    if (tr.classList.contains("emptyrow")) continue;
    const cells = tr.querySelectorAll(":scope > td, :scope > th");
    const role = cellText(cells[roleCol]);
    if (!TEACHER_ROLE.test(role)) continue;
    const name = cellText(tr.querySelector('a[href*="/user/view.php"]'));
    if (!name) continue;
    const groups = groupCol < 0 ? [] : splitGroups(cellText(cells[groupCol]));
    out.push({ courseId, name, role, groups });
  }
  return out;
}

const splitGroups = (s: string) =>
  s
    .split(",")
    .map((g) => g.trim())
    .filter((g) => g && !/^(no hay grupos|no groups|-)$/i.test(g));

/** The student's own groups, from their own course profile (`/user/view.php?course=`). */
export function parseMyGroups(doc: Document): string[] {
  for (const dl of doc.querySelectorAll("#region-main dl, [role=main] dl")) {
    if (/^(grupos?|groups?)$/i.test(cellText(dl.querySelector("dt")))) return splitGroups(cellText(dl.querySelector("dd")));
  }
  return [];
}
