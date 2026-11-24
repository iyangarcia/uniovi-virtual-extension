// "Mis apuntes": the student's synced course files, read straight from the extension's IndexedDB.
// Courses → sections → files, filter, sort, search inside the text, open in a new tab or window.
// Campus strings are untrusted: everything is built with createElement + textContent.
import { searchCachedMaterials, type MaterialHit } from "../../shared/mcp/scan.ts";
import type { Snapshot } from "../../shared/types.ts";
import {
  blobMime,
  buildEntries,
  downloadName,
  type FileEntry,
  filterEntries,
  formatDate,
  formatSize,
  groupEntries,
  cleanSnippet,
  displayTitle,
  hitPage,
  pageUrl,
  viewerPath,
  isNew,
  isSortMode,
  LAST_VISIT_KEY,
  locationLabel,
  openMode,
  parseDeepLink,
  safeCampusUrl,
  SORT_MODES,
  type SortMode,
  typeLabel,
} from "./files/model.ts";
import { idbStore } from "./store/idb.ts";

const CAMPUS_URL = "https://www.campusvirtual.uniovi.es/";
const SORT_KEY = "filesSort";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const summary = $("summary");
const toolbar = $("toolbar");
const filterInput = $<HTMLInputElement>("filter");
const searchBtn = $<HTMLButtonElement>("searchInside");
const sortSelect = $<HTMLSelectElement>("sort");
const results = $("results");
const noMatch = $("noMatch");
const list = $("list");

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: { className?: string; text?: string } = {}, ...children: (Node | null)[]): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (props.className) e.className = props.className;
  if (props.text !== undefined) e.textContent = props.text;
  for (const c of children) if (c) e.append(c);
  return e;
}

function button(text: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = el("button", { className, text });
  b.type = "button";
  if (title) b.title = title;
  b.addEventListener("click", onClick);
  return b;
}

// ------------------------------------------------------------------ state

const loadedAt = Math.floor(Date.now() / 1000);
let lastVisit: number | undefined;
let snapshot: Snapshot | null = null;
let entries: FileEntry[] = [];
let byKey = new Map<string, FileEntry>();
let sortMode: SortMode = "course";
/** Courses she folded (by id); a filter opens everything that matches. */
const collapsed = new Set<number>();
const deepLink = parseDeepLink(location.search);

// ------------------------------------------------------------------ opening files

// A tab opened straight on a blob: URL works (Chrome shows the PDF), but the URL dies with the page
// that created it: after closing "Mis apuntes", reloading that tab says "No se ha podido acceder al
// archivo". So files open in a viewer tab of their own, `files.html?open=<key>`, which makes its own
// blob URL and shows it full-size in an iframe: it survives this page, reloads fine, and the tab
// title is the file name. See viewer() below.

async function blobUrl(e: Pick<FileEntry, "key" | "filename" | "contentType">): Promise<string | null> {
  const blob = await idbStore.fileBlob(e.key);
  if (!blob) return null;
  return URL.createObjectURL(new Blob([blob], { type: blobMime(e.filename, e.contentType ?? blob.type) }));
}

async function openEntry(e: FileEntry, how: "tab" | "window", hit?: MaterialHit): Promise<void> {
  const url = chrome.runtime.getURL(viewerPath(e.key, hit ? hitPage(e.type, hit) : undefined));
  if (how === "window") await chrome.windows.create({ url, type: "normal", focused: true });
  else await chrome.tabs.create({ url, active: true });
}

async function downloadEntry(e: FileEntry): Promise<void> {
  const url = await blobUrl(e);
  if (!url) {
    alert("Este archivo ya no está guardado. Entra en el Campus Virtual para que se vuelva a descargar.");
    return;
  }
  const a = el("a");
  a.href = url;
  a.download = downloadName(e);
  document.body.append(a);
  a.click();
  a.remove();
  // The download has started from the URL by now; free it a little later, not immediately.
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** Viewer mode (`files.html?open=<key>&page=<n>`): one stored file filling the tab. */
async function viewer(key: string, page?: number): Promise<void> {
  document.querySelector("main")?.remove();
  const f = (await idbStore.index())[key];
  const url = f ? await blobUrl({ key, filename: f.resource.filename ?? f.path, contentType: f.contentType }) : null;
  if (!f || !url) {
    const box = el("main", {}, el("div", { className: "card empty" }, el("p", { text: "Este archivo ya no está guardado. Entra en el Campus Virtual para que se vuelva a descargar." })));
    const back = el("a", { className: "btn primary", text: "Ir a Mis apuntes" });
    back.href = chrome.runtime.getURL("files.html");
    box.firstElementChild!.append(back);
    document.body.append(box);
    return;
  }
  document.title = displayTitle(f.resource);
  document.body.classList.add("viewer");
  const frame = el("iframe");
  frame.title = document.title;
  frame.src = pageUrl(url, page);
  document.body.append(frame);
}

function actionsFor(e: FileEntry, hit?: MaterialHit): HTMLElement {
  const box = el("div", { className: "actions" });
  if (!e.stored) {
    const href = safeCampusUrl(e.url);
    if (href) {
      const a = el("a", { className: "btn small", text: "Abrir en el campus" });
      a.href = href;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      box.append(a);
    }
  } else if (openMode(e.type) === "open") {
    box.append(button("Abrir", "btn small", () => void openEntry(e, "tab", hit), "Abrir en una pestaña nueva"));
    box.append(button("Ventana nueva", "btn small", () => void openEntry(e, "window", hit), "Abrir en ventana nueva, para ponerla al lado de otra"));
  } else {
    box.append(button("Descargar", "btn small", () => void downloadEntry(e), "Chrome no puede mostrar este tipo de archivo: se guarda en tu carpeta de descargas"));
  }
  return box;
}

function primaryAction(e: FileEntry): (() => void) | null {
  if (!e.stored) return null;
  return openMode(e.type) === "open" ? () => void openEntry(e, "tab") : () => void downloadEntry(e);
}

// ------------------------------------------------------------------ rendering

function fileRow(e: FileEntry, showSection: boolean): HTMLLIElement {
  const li = el("li", { className: e.stored ? "file" : "file skipped" });
  li.dataset.key = e.key;
  li.dataset.type = e.type;
  li.append(el("span", { className: `type ${e.type}`, text: typeLabel(e.type) }));
  const act = primaryAction(e);
  const title = act ? button(e.title, "title", act) : el("span", { className: "title", text: e.title });
  const meta: string[] = [];
  if (e.filename && e.filename !== e.title) meta.push(e.filename);
  if (showSection) meta.push(e.section);
  if (e.date) meta.push(formatDate(e.date));
  const size = formatSize(e.size);
  if (size) meta.push(size);
  if (!e.stored) meta.push("no se guarda en el ordenador");
  li.append(el("div", { className: "info" }, title, el("div", { className: "meta", text: meta.join(" · ") })));
  if (isNew(e, lastVisit)) li.append(el("span", { className: "badge-new", text: "Nuevo" }));
  li.append(actionsFor(e));
  return li;
}

function renderList(): void {
  const query = filterInput.value;
  const shown = filterEntries(entries, query);
  const groups = groupEntries(shown, snapshot?.courses ?? [], sortMode);
  list.replaceChildren();
  noMatch.hidden = shown.length > 0 || !entries.length || !results.hidden;
  if (!noMatch.hidden) noMatch.textContent = `Ningún archivo se llama así. Pulsa «Buscar dentro de los apuntes» para buscar «${query.trim()}» en su contenido.`;
  const filtering = query.trim() !== "";
  for (const g of groups) {
    const details = el("details", { className: "card course-group" });
    details.dataset.courseId = String(g.id);
    details.open = filtering || !collapsed.has(g.id);
    details.addEventListener("toggle", () => {
      if (filtering) return;
      if (details.open) collapsed.delete(g.id);
      else collapsed.add(g.id);
    });
    const count = `${g.count} ${g.count === 1 ? "archivo" : "archivos"}`;
    details.append(el("summary", {}, el("span", { className: "course", text: g.name }), el("span", { className: "count", text: count })));
    for (const s of g.sections) {
      if (s.name) details.append(el("h3", { text: s.name }));
      const ul = el("ul");
      for (const e of s.files) ul.append(fileRow(e, !s.name));
      details.append(ul);
    }
    list.append(details);
  }
}

function renderEmpty(): void {
  toolbar.hidden = true;
  const box = el("div", { className: "card empty" });
  box.append(el("p", { text: "Todavía no hay apuntes. Entra en el Campus Virtual y espera a que termine la sincronización." }));
  box.append(button("Abrir el Campus Virtual", "btn primary", () => void chrome.tabs.create({ url: safeCampusUrl(snapshot?.siteUrl) ?? CAMPUS_URL })));
  list.replaceChildren(box);
}

async function renderSummary(): Promise<void> {
  const { files, bytes } = await idbStore.usage();
  const parts = [`${files} ${files === 1 ? "archivo guardado" : "archivos guardados"}`, `${formatSize(bytes) || "0 B"} ocupados`];
  if (snapshot?.syncedAt) parts.push(`última sincronización: ${formatDate(snapshot.syncedAt)}`);
  summary.textContent = parts.join(" · ");
}

// ------------------------------------------------------------------ search inside the text

let searchSeq = 0;

async function searchInside(): Promise<void> {
  const query = filterInput.value.trim();
  if (!query) {
    filterInput.focus();
    return;
  }
  const seq = ++searchSeq;
  results.hidden = false;
  noMatch.hidden = true;
  results.replaceChildren(el("div", { className: "results-head" }, el("h2", { text: `Buscando «${query}» dentro de los apuntes…` })));
  searchBtn.disabled = true;
  try {
    // Cached text only: the service worker extracts files in the background (no PDF parser in this page).
    const r = await searchCachedMaterials(idbStore, { query, limit: 60, snapshot });
    if (seq !== searchSeq) return;
    renderResults(query, r.results, r.pending);
  } catch (err) {
    if (seq !== searchSeq) return;
    console.error("[uniovi] search", err);
    results.replaceChildren(el("div", { className: "results-head" }, el("h2", { text: "No se pudo buscar ahora. Inténtalo de nuevo en un momento." })));
  } finally {
    if (seq === searchSeq) searchBtn.disabled = false;
  }
}

function renderResults(query: string, hits: MaterialHit[], pending: number): void {
  const n = hits.length;
  const head = el(
    "div",
    { className: "results-head" },
    el("h2", { text: n ? `«${query}» aparece ${n === 1 ? "1 vez" : `${n} veces`} en tus apuntes` : `«${query}» no aparece dentro de tus apuntes` }),
    button("Cerrar", "btn small", () => {
      searchSeq++;
      results.hidden = true;
      results.replaceChildren();
      renderList();
    }),
  );
  results.replaceChildren(head);
  noMatch.hidden = true;
  if (pending > 0) results.append(el("p", { className: "notice hit", text: "Algunos archivos aún se están preparando para la búsqueda. Vuelve a buscar en un rato." }));
  for (const h of hits) {
    const e = byKey.get(h.key);
    if (!e) continue;
    const where = locationLabel(h);
    const div = el("div", { className: "hit" });
    div.dataset.key = h.key;
    const title = button(e.title, "title", openMode(e.type) === "open" ? () => void openEntry(e, "tab", h) : () => void downloadEntry(e));
    const course = snapshot?.courses.find((c) => c.id === e.courseId)?.fullname;
    const line = el("div", { className: "meta" });
    if (where) line.append(el("span", { className: "where", text: where }), document.createTextNode(" · "));
    line.append(document.createTextNode([course, e.section].filter(Boolean).join(" · ")));
    div.append(title, line, el("div", { className: "snippet", text: cleanSnippet(h.snippet) }), actionsFor(e, h));
    results.append(div);
  }
}

// ------------------------------------------------------------------ loading

async function load(): Promise<void> {
  const [snap, index, skipped] = await Promise.all([idbStore.snapshot(), idbStore.index(), idbStore.skippedFiles()]);
  snapshot = snap;
  entries = buildEntries(snapshot, index, skipped);
  byKey = new Map(entries.map((e) => [e.key, e]));
  await renderSummary();
  if (!entries.length) return renderEmpty();
  toolbar.hidden = false;
  renderList();
}

let filterTimer: ReturnType<typeof setTimeout> | undefined;

async function main(): Promise<void> {
  for (const m of SORT_MODES) {
    const o = el("option", { text: m.label });
    o.value = m.value;
    sortSelect.append(o);
  }
  const stored = await chrome.storage.local.get([LAST_VISIT_KEY, SORT_KEY]);
  lastVisit = typeof stored[LAST_VISIT_KEY] === "number" ? stored[LAST_VISIT_KEY] : undefined;
  if (isSortMode(stored[SORT_KEY])) sortMode = stored[SORT_KEY];
  sortSelect.value = sortMode;

  // The visit counts from when the page opened: files stored while she is here are "Nuevo" next time.
  const markVisited = () => void chrome.storage.local.set({ [LAST_VISIT_KEY]: loadedAt });
  setTimeout(markVisited, 4000);
  addEventListener("pagehide", markVisited);

  if (deepLink.q) filterInput.value = deepLink.q;
  await load();
  if (deepLink.course && entries.some((e) => e.courseId === deepLink.course)) {
    for (const e of entries) if (e.courseId !== deepLink.course) collapsed.add(e.courseId);
    renderList();
    document.querySelector(`details[data-course-id="${deepLink.course}"]`)?.scrollIntoView({ block: "start" });
  }
  if (deepLink.q && entries.length) void searchInside();

  filterInput.addEventListener("input", () => {
    clearTimeout(filterTimer);
    filterTimer = setTimeout(renderList, 120);
  });
  filterInput.addEventListener("keydown", (ev) => {
    if (ev.key === "Enter") {
      ev.preventDefault();
      void searchInside();
    }
  });
  searchBtn.addEventListener("click", () => void searchInside());
  sortSelect.addEventListener("change", () => {
    if (!isSortMode(sortSelect.value)) return;
    sortMode = sortSelect.value;
    void chrome.storage.local.set({ [SORT_KEY]: sortMode });
    renderList();
  });

  // A sync finishing while the page is open brings new files: reload the list (filter and folds kept).
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.syncState) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(), 1500);
  });
}

if (deepLink.open) void viewer(deepLink.open, deepLink.page);
else void main();
