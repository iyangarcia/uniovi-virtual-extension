// Full text of course activities that are not files: pages, links, quizzes, assignments, books,
// lessons... and of the course page itself (section summaries and labels, where teachers often put
// the syllabus, their names and the exam rules). Each one is stored as a plain-text "file" in the
// extension, so read_material / search_materials / "Mis apuntes" read it like any document.
// DOM helpers only (no fetching): collector.ts fetches the pages.
import type { Resource } from "../../shared/types.ts";

/** Longest text kept per activity (a whole book printed is the big case). */
export const TEXT_MAX_CHARS = 400_000;

/** Files are downloaded as files and forums are read post by post: every other module has its page read. */
const NOT_TEXT = new Set(["resource", "folder", "forum"]);
export const wantsText = (modname: string) => !NOT_TEXT.has(modname);

/** Page to read for an activity's full text, relative to the campus root. */
export function activityTextPath(modname: string, cmid: number): string {
  // A book's view.php shows one chapter; its print tool shows them all.
  if (modname === "book") return `/mod/book/tool/print/index.php?id=${cmid}`;
  // forceview: a link set to open directly would otherwise redirect off the campus.
  return `/mod/${modname}/view.php?id=${cmid}&forceview=1`;
}

/** File name the text is stored under. */
export const textFilename = (name: string) => `${name.replace(/[\\/:*?"<>|]+/g, " ").trim().slice(0, 120) || "actividad"}.txt`;

/** The page's main content region (Boost / Classic themes), else the body. */
export function mainRegion(doc: Document): Element {
  return doc.querySelector("#region-main, [role=main]") ?? doc.body;
}

/**
 * Readable text of an element: block structure as line breaks, table cells separated by " | ",
 * links to other sites spelled out (a link activity's text is then its target), controls and
 * screen-reader-only duplicates dropped.
 */
export function elementText(el: Element, campusHost: string): string {
  const root = el.cloneNode(true) as Element;
  root.querySelectorAll("script, style, noscript, template, button, input, select, textarea, .sr-only, .visually-hidden, .accesshide, .nav-tabs").forEach((n) => n.remove());
  for (const a of root.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let href: URL;
    try {
      href = new URL(a.getAttribute("href")!, el.ownerDocument.baseURI);
    } catch {
      continue;
    }
    if (!/^https?:$/.test(href.protocol) || href.host === campusHost) continue;
    const text = (a.textContent ?? "").trim();
    if (text !== href.href) a.append(` <${href.href}>`);
  }
  const doc = root.ownerDocument;
  root.querySelectorAll("br").forEach((br) => br.replaceWith(doc.createTextNode("\n")));
  root.querySelectorAll("td, th").forEach((c) => c.append(doc.createTextNode(" | ")));
  root.querySelectorAll("p, div, li, tr, dt, dd, h1, h2, h3, h4, h5, h6, section, article, header, footer, blockquote, pre, table").forEach((b) => {
    b.prepend(doc.createTextNode("\n"));
    b.append(doc.createTextNode("\n"));
  });
  const text = (root.textContent ?? "")
    .split("\n")
    .map((l) => l.replace(/[ \t ]+/g, " ").replace(/( \| )+$/, "").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.length > TEXT_MAX_CHARS ? text.slice(0, TEXT_MAX_CHARS) : text;
}

/**
 * Files linked from an activity's text (an assignment's instructions PDF, a page's attachments), as
 * downloadable resources. Keyed on the path inside pluginfile.php, under the activity's cmid.
 */
export function linkedFiles(region: Element, base: Omit<Resource, "key" | "url" | "filename" | "modname">): Resource[] {
  const byKey = new Map<string, Resource>();
  for (const a of region.querySelectorAll<HTMLAnchorElement>('a[href*="/pluginfile.php/"]')) {
    let url: URL;
    try {
      url = new URL(a.href);
    } catch {
      continue;
    }
    url.searchParams.delete("forcedownload");
    // /pluginfile.php/<context>/<component>/<area>/<item...>/<file>
    const inner = /\/pluginfile\.php\/\d+(\/.+)$/.exec(url.pathname)?.[1];
    if (!inner) continue;
    const key = `${base.cmid}:file:${decodeURIComponent(inner)}`;
    if (byKey.has(key)) continue;
    const filename = decodeURIComponent(url.pathname.split("/").pop() ?? "file");
    const text = (a.textContent ?? "").trim();
    byKey.set(key, { ...base, key, modname: "activity-file", url: url.toString(), filename, name: `${base.name}: ${text && text !== filename ? text : filename}` });
  }
  return [...byKey.values()];
}

/** Target of a link activity, from its "click here" page (forceview). */
export function linkTarget(doc: Document): string | undefined {
  const a = doc.querySelector<HTMLAnchorElement>(".urlworkaround a[href], #region-main .urlembed a[href]");
  return a?.href || undefined;
}
