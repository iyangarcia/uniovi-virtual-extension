// Which language a course or material is in, and how much it should weigh for this student.
// Uniovi often runs Spanish and English groups side by side: either as two courses
// ("Computabilidad (Grupos en Castellano)" + "Computabilidad (… - Grupo Inglés)") or as one
// course with paired files ("Tema 1 (Castellano)" / "Tema 1 (English)").
//
// This only RANKS and LABELS. Nothing is ever filtered out: the other group's material is a
// backup that can still hold something unique (a past exam, an announcement).
// Detection is deliberately conservative: without an explicit marker the language is
// "unknown" and the item keeps normal priority.
import type { Course, Resource } from "./types.ts";

export type Lang = "en" | "es";
export type CourseLang = Lang | "mixed";
export type ResourceLang = Lang | "both" | "unknown";
/** normal: preferred language or unknown; backup: the other language; low: a course the user deprioritised. */
export type Priority = "normal" | "backup" | "low";

/** User preferences that both halves use (the server reads them from config.json). */
export interface Preferences {
  materialLanguage?: Lang;
  /** Course ids, or text matched against course names (accent-insensitive). */
  lowPriorityCourses?: string[];
}

export const fold = (s: string) => s.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/** "Computabilidad (Grupos en Castellano) (Grado en …)" -> "Computabilidad" */
export const baseName = (c: Course) => c.fullname.split(" (")[0]!.trim() || c.shortname;

/** Group codes from Uniovi shortnames: "T_S,A_(…),G_((01,02,Ing-01))" -> ["01", "02", "Ing-01"]. */
function groupsOf(c: Course): string[] {
  const m = /G_\(\(([^)]*)\)\)/.exec(c.shortname);
  return m ? m[1]!.split(",").map((g) => g.trim()).filter(Boolean) : [];
}
const isEnglishGroup = (g: string) => /^ing/i.test(g);

const EN = /\b(english|ingles|inglesa)\b|\((en|eng)\)|\[(en|eng)\]|[_-]en\b/;
const ES = /\b(castellano|espanol|spanish)\b|\((es|esp)\)|\[(es|esp)\]|[_-]es\b/;

function markers(text: string): ResourceLang {
  const f = fold(text);
  const en = EN.test(f);
  const es = ES.test(f);
  return en && es ? "both" : en ? "en" : es ? "es" : "unknown";
}

/** Other enrolled courses with the same base name (the other language group of the same subject). */
export function siblings(c: Course, all: Course[]): Course[] {
  const base = fold(baseName(c));
  return all.filter((o) => o.id !== c.id && fold(baseName(o)) === base);
}

export function courseLanguage(c: Course, all: Course[] = []): CourseLang {
  const groups = groupsOf(c);
  if (groups.length && groups.every(isEnglishGroup)) return "en";
  const text = markers(c.fullname);
  const spanishGroups = groups.length > 0 && !groups.some(isEnglishGroup);
  if (text === "en" && (groups.length === 0 || !groups.some((g) => !isEnglishGroup(g)))) return "en";
  if (text === "es" && !groups.some(isEnglishGroup)) return "es";
  // Only Spanish group codes, and the same subject has an English-group course: this is the Spanish one.
  if (spanishGroups && text === "unknown" && siblings(c, all).some((s) => courseLanguage(s) === "en")) return "es";
  return "mixed";
}

/** Explicit markers in the item name/filename win, then its section, then the course. */
export function resourceLanguage(r: Resource, course: Course | undefined, all: Course[] = []): ResourceLang {
  const own = markers(`${r.name} ${r.filename ?? ""}`);
  if (own !== "unknown") return own;
  const section = markers(r.section);
  if (section !== "unknown") return section;
  const cl = course ? courseLanguage(course, all) : "mixed";
  return cl === "mixed" ? "unknown" : cl;
}

export function isLowPriority(c: Course | undefined, prefs: Preferences): boolean {
  if (!c) return false;
  return (prefs.lowPriorityCourses ?? []).some((p) => {
    const f = fold(p.trim());
    return !!f && (String(c.id) === f || fold(c.fullname).includes(f) || fold(c.shortname).includes(f));
  });
}

export function priorityOf(lang: ResourceLang | CourseLang, course: Course | undefined, prefs: Preferences): Priority {
  if (isLowPriority(course, prefs)) return "low";
  const want = prefs.materialLanguage;
  if (want && (lang === "en" || lang === "es") && lang !== want) return "backup";
  return "normal";
}

export const PRIORITY_ORDER: Record<Priority, number> = { normal: 0, backup: 1, low: 2 };

/**
 * Readable course name. Sibling language groups get "(English group)" / "(Spanish group)",
 * anything still ambiguous gets its id, so labels are unique (they are also folder names).
 */
export function courseLabel(c: Course, all: Course[]): string {
  const base = baseName(c);
  const sibs = siblings(c, all);
  if (!sibs.length) return base;
  const lang = courseLanguage(c, all);
  const tagged = lang === "en" ? `${base} (English group)` : lang === "es" ? `${base} (Spanish group)` : base;
  const clash = sibs.some((s) => courseLanguage(s, all) === lang);
  return clash ? `${tagged} [${c.id}]` : tagged;
}
