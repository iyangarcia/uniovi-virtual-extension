// Heuristic detection of exam / deadline dates in Spanish (and some English) forum text.
// It intentionally over-reports: every candidate carries the surrounding snippet and a
// link so Claude (or the user) can confirm against the original post.

export type DateKind = "exam" | "deadline" | "other";

export interface DateMention {
  /** ISO date YYYY-MM-DD */
  date: string;
  /** HH:MM if a time was found near the date */
  time?: string;
  kind: DateKind;
  snippet: string;
}

const MONTHS: Record<string, number> = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7, agosto: 8,
  septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
  ene: 1, feb: 2, mar: 3, abr: 4, may: 5, jun: 6, jul: 7, ago: 8, sep: 9, sept: 9, oct: 10, nov: 11, dic: 12,
  january: 1, february: 2, march: 3, april: 4, june: 6, july: 7, august: 8, september: 9, october: 10,
  november: 11, december: 12,
};

const EXAM_WORDS =
  /\b(ex[aá]men(es)?|parcial(es)?|prueba(s)?|convocatoria|evaluaci[oó]n|control(es)?|test|quiz|defensa|recuperaci[oó]n|final)\b/i;
// Not "práctica(s)": in Spanish it also means internships, and job offers flooded the
// upcoming list. Lab deadlines still match through "entrega"/"plazo".
const DEADLINE_WORDS = /\b(entrega(s|r)?|plazo|fecha l[ií]mite|deadline|submission|subir|enviar)\b/i;

const MONTH_ALT = Object.keys(MONTHS).sort((a, b) => b.length - a.length).join("|");
// "15 de enero de 2027", "15 enero", "lunes 3 de febrero"
const TEXT_DATE = new RegExp(`\\b(\\d{1,2})\\s*(?:de\\s+)?(${MONTH_ALT})\\.?(?:\\s*(?:de|del)?\\s*(\\d{4}))?\\b`, "gi");
// "15/01/2027", "15-01-27", "15/1"
const NUM_DATE = /\b(\d{1,2})[/\-.](\d{1,2})(?:[/\-.](\d{2,4}))?\b/g;
const ISO_DATE = /\b(20\d{2})-(\d{2})-(\d{2})\b/g;
const TIME =/\b(?:a\s+las\s+)?([01]?\d|2[0-3])[:.h]([0-5]\d)\s*h?\b|\ba\s+las\s+([01]?\d|2[0-3])\b/i;

function pad(n: number) {
  return String(n).padStart(2, "0");
}

/** Picks the year for a day/month with no year: the occurrence closest to (and preferably after) the post date. */
function inferYear(month: number, day: number, ref: Date): number {
  const y = ref.getUTCFullYear();
  const candidates = [y - 1, y, y + 1].map((yy) => ({ yy, t: Date.UTC(yy, month - 1, day) }));
  const refT = ref.getTime() - 45 * 86400_000; // allow mentions of dates shortly before the post
  const after = candidates.filter((c) => c.t >= refT).sort((a, b) => a.t - b.t);
  return (after[0] ?? candidates[1]!).yy;
}

function valid(y: number, m: number, d: number) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCMonth() === m - 1;
}

export function classify(s: string): DateKind | undefined {
  if (EXAM_WORDS.test(s)) return "exam";
  if (DEADLINE_WORDS.test(s)) return "deadline";
  return undefined;
}

/** The sentence (or line) containing the match, so a post announcing both an exam and a deadline classifies each date correctly. */
function sentenceAround(text: string, index: number, length: number): string {
  const boundary = /[.;!?](?=\s)|\n/g;
  let start = 0;
  let end = text.length;
  for (const m of text.matchAll(boundary)) {
    if (m.index! < index) start = m.index! + 1;
    else if (m.index! >= index + length) {
      end = m.index!;
      break;
    }
  }
  return text.slice(start, end);
}

export function findDates(text: string, postedAt: Date): DateMention[] {
  const out: DateMention[] = [];
  const seen = new Set<string>();

  const push = (index: number, length: number, y: number, m: number, d: number) => {
    if (!valid(y, m, d)) return;
    const windowStart = Math.max(0, index - 160);
    const windowEnd = Math.min(text.length, index + length + 160);
    const context = text.slice(windowStart, windowEnd);
    const after = text.slice(index + length, index + length + 40);
    const before = text.slice(Math.max(0, index - 30), index);
    const t = TIME.exec(after) ?? TIME.exec(before);
    const time = t ? `${pad(Number(t[1] ?? t[3]))}:${t[2] ?? "00"}` : undefined;
    const kind = classify(sentenceAround(text, index, length)) ?? classify(context) ?? "other";
    const date = `${y}-${pad(m)}-${pad(d)}`;
    const id = `${date}|${time ?? ""}`;
    if (seen.has(id)) return;
    seen.add(id);
    out.push({ date, time, kind, snippet: context.replace(/\s+/g, " ").trim() });
  };

  for (const m of text.matchAll(TEXT_DATE)) {
    const day = Number(m[1]);
    const month = MONTHS[m[2]!.toLowerCase()];
    if (!month) continue;
    // Skip "mar"/"may" etc. when they are clearly not months ("3 mar" is ok, but avoid "1 test")
    const year = m[3] ? Number(m[3]) : inferYear(month, day, postedAt);
    push(m.index!, m[0].length, year, month, day);
  }
  for (const m of text.matchAll(ISO_DATE)) {
    push(m.index!, m[0].length, Number(m[1]), Number(m[2]), Number(m[3]));
  }
  for (const m of text.matchAll(NUM_DATE)) {
    // Part of a longer number sequence (ISO date, phone number, version string)
    if (/\d[/\-.]$/.test(text.slice(Math.max(0, m.index! - 2), m.index!))) continue;
    if (/^[/\-.]\d/.test(text.slice(m.index! + m[0].length, m.index! + m[0].length + 2))) continue;
    const day = Number(m[1]);
    const month = Number(m[2]);
    // "10.30" is a time, not a date
    if (m[0].includes(".") && !m[3]) continue;
    let year = m[3] ? Number(m[3]) : inferYear(month, day, postedAt);
    if (year < 100) year += 2000;
    push(m.index!, m[0].length, year, month, day);
  }
  return out;
}
