// The Uniovi Virtual side panel (the extension icon opens it: manifest `side_panel`), top to bottom:
// - a «Conecta tu IA» card until an AI has made its first request, then the status line + Copiar enlace;
// - "Mis apuntes": the student's synced course files, read straight from the extension's IndexedDB.
//   Courses → sections → files, filter, sort, search inside the text. The title opens the file in the
//   viewer tab; the rest (Ventana nueva, Descargar, Borrar) is in each row's «⋯» menu;
// - «Ajustes»: Conectar con mi IA, Sincronizar ahora, sync settings, Tu enlace / Cambiar enlace.
// «Añadir archivo» (button or drag and drop) stores the student's own files under «Mis archivos»
// (key `upload:<uuid>`, never in the snapshot); only those have «Borrar».
// The same page opened as a tab with `?open=<key>` is the viewer (see viewer() below).
// Campus strings are untrusted: everything is built with createElement + textContent.
import { searchCachedMaterials, type MaterialHit } from "../../shared/mcp/scan.ts";
import { type Resource, type Snapshot, UPLOAD_SECTION } from "../../shared/types.ts";
import { changeLink } from "./agent/identity.ts";
import { AGENT_KEYS, aiConnectionEnabled, type AgentState, type AgentStats } from "./agent/state.ts";
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
  uploadRefusal,
} from "./files/model.ts";
import { getSettings, send, type Settings, type SyncState } from "./messages.ts";
import { idbStore } from "./store/idb.ts";
import { copyText, flash, updateNotice } from "./ui/dom.ts";
import { currentLink } from "./ui/link.ts";
import { openSidePanel } from "./ui/sidepanel.ts";
import { formatBytes, lastSyncLabel, statusSentence } from "./ui/status.ts";
import { pendingUpdate, UPDATE_KEYS } from "./ui/update.ts";

const CAMPUS_URL = "https://www.campusvirtual.uniovi.es/";
const SORT_KEY = "filesSort";
const VERSION = chrome.runtime.getManifest().version;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const summary = $("summary");
const toolbar = $("toolbar");
const filterInput = $<HTMLInputElement>("filter");
const searchBtn = $<HTMLButtonElement>("searchInside");
const sortSelect = $<HTMLSelectElement>("sort");
const results = $("results");
const noMatch = $("noMatch");
const list = $("list");
const addBtn = $<HTMLButtonElement>("addFile");
const fileInput = $<HTMLInputElement>("fileInput");
const uploadNotes = $<HTMLUListElement>("uploadNotes");
const dropHint = $("dropHint");

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
// that created it: after closing the panel, reloading that tab says "No se ha podido acceder al
// archivo". So files open in a viewer tab of their own, `home.html?open=<key>`, which makes its own
// blob URL and shows it full-size in an iframe: it survives the panel, reloads fine, and the tab
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

/** Viewer mode (`home.html?open=<key>&page=<n>`): one stored file filling the tab. */
async function viewer(key: string, page?: number): Promise<void> {
  document.querySelector("main")?.remove();
  const f = (await idbStore.index())[key];
  const url = f ? await blobUrl({ key, filename: f.resource.filename ?? f.path, contentType: f.contentType }) : null;
  if (!f || !url) {
    const gone = key.startsWith("upload:") ? "Este archivo ya no está guardado: lo borraste de Mis apuntes." : "Este archivo ya no está guardado. Entra en el Campus Virtual para que se vuelva a descargar.";
    const box = el("main", {}, el("div", { className: "card empty" }, el("p", { text: gone })));
    box.firstElementChild!.append(button("Abrir el panel de Uniovi Virtual", "btn primary", openSidePanel));
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

// ------------------------------------------------------------------ per-row «⋯» menu

let openMenu: { box: HTMLElement; more: HTMLButtonElement; items: HTMLElement } | null = null;

function closeMenu(): void {
  if (!openMenu) return;
  openMenu.items.hidden = true;
  openMenu.more.setAttribute("aria-expanded", "false");
  openMenu = null;
}

function menuItem(text: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = button(
    text,
    "",
    () => {
      closeMenu();
      onClick();
    },
    title,
  );
  b.setAttribute("role", "menuitem");
  return b;
}

/** A file's secondary actions (the title already does the main one); null when it has none. */
function rowMenu(e: FileEntry, hit?: MaterialHit): HTMLElement | null {
  const items: HTMLElement[] = [];
  if (e.stored) {
    if (openMode(e.type) === "open") items.push(menuItem("Ventana nueva", () => void openEntry(e, "window", hit), "Abrir en ventana nueva, para ponerla al lado de otra"));
    items.push(menuItem("Descargar", () => void downloadEntry(e), "Guardar una copia en tu carpeta de descargas"));
  }
  // Only her own files: a campus file would come back with the next sync.
  if (e.upload) items.push(deleteButton(e));
  if (!items.length) return null;
  const menu = el("div", { className: "menu-items" }, ...items);
  menu.setAttribute("role", "menu");
  menu.hidden = true;
  const box = el("div", { className: "menu" });
  const more = button("⋯", "more", () => {
    const wasOpen = openMenu?.more === more;
    closeMenu();
    if (wasOpen) return;
    menu.hidden = false;
    more.setAttribute("aria-expanded", "true");
    openMenu = { box, more, items: menu };
  });
  more.setAttribute("aria-haspopup", "menu");
  more.setAttribute("aria-expanded", "false");
  more.setAttribute("aria-label", `Más opciones: ${e.title}`);
  more.title = "Más opciones";
  box.append(more, menu);
  return box;
}

/** The file name: opens it in the viewer tab, downloads it (types Chrome can't show) or links to the campus. */
function titleFor(e: FileEntry, hit?: MaterialHit): HTMLElement {
  if (e.stored) {
    const open = openMode(e.type) === "open";
    return open
      ? button(e.title, "title", () => void openEntry(e, "tab", hit), "Abrir en una pestaña nueva")
      : button(e.title, "title", () => void downloadEntry(e), "Chrome no puede mostrar este tipo de archivo: se guarda en tu carpeta de descargas");
  }
  const href = safeCampusUrl(e.url);
  if (!href) return el("span", { className: "title", text: e.title });
  const a = el("a", { className: "title", text: e.title });
  a.href = href;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.title = "Abrir en el Campus Virtual";
  return a;
}

/** «Borrar», then «¿Seguro?» for a few seconds: the second click deletes. The menu stays open between them. */
function deleteButton(e: FileEntry): HTMLButtonElement {
  let armed: ReturnType<typeof setTimeout> | undefined;
  const b = button(
    "Borrar",
    "danger",
    () => {
      if (!armed) {
        b.textContent = "¿Seguro?";
        b.classList.add("armed");
        armed = setTimeout(() => {
          armed = undefined;
          b.textContent = "Borrar";
          b.classList.remove("armed");
        }, 4000);
        return;
      }
      clearTimeout(armed);
      b.disabled = true;
      closeMenu();
      void deleteUpload(e);
    },
    "Borrar este archivo de Mis apuntes",
  );
  b.dataset.action = "delete";
  b.setAttribute("role", "menuitem");
  return b;
}

async function deleteUpload(e: FileEntry): Promise<void> {
  uploadNotes.replaceChildren();
  try {
    await send({ type: "delete-upload", key: e.key });
    note(`${e.title} borrado`, "ok");
  } catch (err) {
    console.error("[uniovi] delete", err);
    note(`${e.title}: no se pudo borrar. Inténtalo de nuevo.`, "error");
  }
  await load();
}

// ------------------------------------------------------------------ rendering

function fileRow(e: FileEntry, showSection: boolean): HTMLLIElement {
  const li = el("li", { className: e.stored ? "file" : "file skipped" });
  li.dataset.key = e.key;
  li.dataset.type = e.type;
  li.append(el("span", { className: `type ${e.type}`, text: typeLabel(e.type) }));
  const meta: string[] = [];
  if (e.filename && e.filename !== e.title) meta.push(e.filename);
  if (showSection && !e.upload) meta.push(e.section);
  if (e.date) meta.push(formatDate(e.date));
  const size = formatSize(e.size);
  if (size) meta.push(size);
  if (!e.stored) meta.push("solo en el campus");
  li.append(el("div", { className: "info" }, titleFor(e), el("div", { className: "meta", text: meta.join(" · ") })));
  if (isNew(e, lastVisit)) li.append(el("span", { className: "badge-new", text: "Nuevo" }));
  li.append(rowMenu(e) ?? "");
  return li;
}

function renderList(): void {
  closeMenu();
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
  box.append(el("p", { text: "Todavía no hay apuntes. Entra en el Campus Virtual y espera a que termine la sincronización. También puedes añadir tus propios archivos con «Añadir archivo» o arrastrándolos aquí." }));
  box.append(button("Abrir el Campus Virtual", "btn primary", () => void chrome.tabs.create({ url: safeCampusUrl(snapshot?.siteUrl) ?? CAMPUS_URL })));
  list.replaceChildren(box);
}

async function renderSummary(): Promise<void> {
  const { files, bytes } = await idbStore.usage();
  const parts = [`${files} ${files === 1 ? "archivo guardado" : "archivos guardados"}`, formatSize(bytes) || "0 B"];
  if (snapshot?.syncedAt) parts.push(`actualizado: ${formatDate(snapshot.syncedAt)}`);
  summary.textContent = parts.join(" · ");
}

// ------------------------------------------------------------------ «Añadir archivo»

/** One line per file under the toolbar: «Tema 1.pdf añadido» or why it was refused. */
function note(text: string, kind: "ok" | "error"): void {
  uploadNotes.append(el("li", { className: kind, text }));
  uploadNotes.hidden = false;
}

function base64(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

let adding = Promise.resolve();

/** Same rules as campus files (readable types, «Tamaño máximo»); one at a time, then the list reloads. */
function addFiles(files: File[]): void {
  if (!files.length) return;
  adding = adding.then(async () => {
    uploadNotes.replaceChildren();
    const { maxFileMB } = await getSettings();
    // A file with the name of one she already added replaces it (a newer exam calendar...).
    const mine = new Map(entries.filter((e) => e.upload && e.filename).map((e) => [e.filename!, e.key]));
    for (const f of files) {
      const refusal = uploadRefusal(f, maxFileMB);
      if (refusal) {
        note(`${f.name}: ${refusal}`, "error");
        continue;
      }
      try {
        const bytes = new Uint8Array(await f.arrayBuffer());
        const known = mine.get(f.name);
        const key = known ?? `upload:${crypto.randomUUID()}`;
        const resource: Resource = {
          key,
          cmid: 0,
          courseId: 0,
          section: UPLOAD_SECTION,
          name: f.name,
          modname: "upload",
          url: "",
          filename: f.name,
          ...(f.type ? { mimetype: f.type } : {}),
          filesize: f.size,
          timemodified: Math.floor(Date.now() / 1000),
        };
        await send({ type: "upload-file", resource, filename: f.name, contentType: f.type || "application/octet-stream", base64: base64(bytes) });
        mine.set(f.name, key);
        note(`${f.name} ${known ? "actualizado" : "añadido"}`, "ok");
      } catch (err) {
        console.error("[uniovi] upload", err);
        note(`${f.name}: no se pudo añadir. Inténtalo de nuevo.`, "error");
      }
    }
    await load();
  });
}

function initUploads(): void {
  addBtn.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    addFiles([...(fileInput.files ?? [])]);
    fileInput.value = ""; // the same file can be chosen again
  });
  // Drag and drop anywhere on the panel. Without preventDefault, Chrome would open the file instead.
  const hasFiles = (ev: DragEvent) => !!ev.dataTransfer?.types.includes("Files");
  let depth = 0;
  addEventListener("dragenter", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth++;
    dropHint.hidden = false;
  });
  addEventListener("dragover", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  });
  addEventListener("dragleave", (ev) => {
    if (!hasFiles(ev)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) dropHint.hidden = true;
  });
  addEventListener("drop", (ev) => {
    if (!hasFiles(ev)) return;
    ev.preventDefault();
    depth = 0;
    dropHint.hidden = true;
    addFiles([...(ev.dataTransfer?.files ?? [])]);
  });
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
  closeMenu();
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
    const course = snapshot?.courses.find((c) => c.id === e.courseId)?.fullname;
    const line = el("div", { className: "meta" });
    if (where) line.append(el("span", { className: "where", text: where }), document.createTextNode(" · "));
    line.append(document.createTextNode([course, e.section].filter(Boolean).join(" · ")));
    div.append(el("div", { className: "info" }, titleFor(e, h), line, el("div", { className: "snippet", text: cleanSnippet(h.snippet) })));
    div.append(rowMenu(e, h) ?? "");
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

// ------------------------------------------------------------------ top: «Conecta tu IA» / status, and «Ajustes»

// Not "snapshot": it is large, and syncState.lastSync already says whether a sync happened.
const STATUS_KEYS = [AGENT_KEYS.enabled, AGENT_KEYS.state, AGENT_KEYS.stats, "syncState", UPDATE_KEYS.update] as const;

async function renderStatus(): Promise<void> {
  const got = await chrome.storage.local.get([...STATUS_KEYS]);
  const enabled = aiConnectionEnabled(got[AGENT_KEYS.enabled]);
  const agent = got[AGENT_KEYS.state] as AgentState | undefined;
  const stats = got[AGENT_KEYS.stats] as AgentStats | undefined;
  const sync = got.syncState as SyncState | undefined;

  // Same test as the welcome page's step 3: an AI has actually asked for something.
  const connectedOnce = (stats?.requests ?? 0) > 0;
  const view = statusSentence({ enabled, ...(agent ? { agent } : {}), synced: !!sync?.lastSync });
  $("connect").hidden = connectedOnce;
  const box = $("status");
  // Before the first request the card says what to do; the status line then only shows a problem.
  box.hidden = !connectedOnce && (view.tone === "ok" || view.tone === "busy");
  box.className = `status ${view.tone}`;
  box.querySelector(".text")!.textContent = view.text;
  box.querySelector(".hint")!.textContent = view.hint ?? "";
  $("copy").hidden = !connectedOnce;

  const toggle = $<HTMLInputElement>("aiConnection");
  if (document.activeElement !== toggle) toggle.checked = enabled;

  const busy = !!sync?.running || !!sync?.error;
  const syncLine = $("syncLine");
  syncLine.hidden = !busy;
  syncLine.textContent = busy ? sync!.text : "";
  syncLine.classList.toggle("error", !!sync?.error);
  const syncText = $("syncText");
  syncText.textContent = busy ? sync!.text : lastSyncLabel(sync?.lastSync);
  syncText.classList.toggle("error", !!sync?.error);
  $<HTMLButtonElement>("sync").disabled = !!sync?.running;

  const update = pendingUpdate(got[UPDATE_KEYS.update], VERSION);
  $("update").replaceChildren(...(update ? [updateNotice(update)] : []));

  // Technical detail, «Ajustes» only.
  $("diag").textContent = `Versión ${VERSION} · conexión: ${agent?.state ?? "—"}${agent?.error ? ` (${agent.error})` : ""}`;
}

async function showLink(): Promise<void> {
  $<HTMLInputElement>("linkBox").value = await currentLink();
}

async function showUsage(): Promise<void> {
  try {
    const { files, bytes } = await idbStore.usage();
    $("usage").textContent = `Espacio usado: ${formatBytes(bytes)} en ${files} ${files === 1 ? "archivo" : "archivos"}`;
  } catch {
    $("usage").textContent = "Espacio usado: no disponible";
  }
}

const SETTING_IDS = ["courseScope", "autoSync", "autoSyncHours", "downloadFiles", "maxFileMB", "replyWindowDays", "notify", "syncGrades"] as const;

async function initSettings(): Promise<void> {
  const s = await getSettings();
  const save = async () => {
    const next: Settings = {
      courseScope: $<HTMLSelectElement>("courseScope").value as Settings["courseScope"],
      autoSync: $<HTMLInputElement>("autoSync").checked,
      autoSyncHours: Number($<HTMLInputElement>("autoSyncHours").value) || 6,
      downloadFiles: $<HTMLInputElement>("downloadFiles").checked,
      maxFileMB: Number($<HTMLInputElement>("maxFileMB").value) || 40,
      replyWindowDays: Number($<HTMLInputElement>("replyWindowDays").value) || 0,
      notify: $<HTMLInputElement>("notify").checked,
      syncGrades: $<HTMLInputElement>("syncGrades").checked,
    };
    await chrome.storage.local.set({ settings: next });
  };
  $<HTMLSelectElement>("courseScope").value = s.courseScope;
  $<HTMLInputElement>("autoSync").checked = s.autoSync;
  $<HTMLInputElement>("autoSyncHours").value = String(s.autoSyncHours);
  $<HTMLInputElement>("downloadFiles").checked = s.downloadFiles;
  $<HTMLInputElement>("maxFileMB").value = String(s.maxFileMB);
  $<HTMLInputElement>("replyWindowDays").value = String(s.replyWindowDays);
  $<HTMLInputElement>("notify").checked = s.notify;
  $<HTMLInputElement>("syncGrades").checked = s.syncGrades;
  for (const id of SETTING_IDS) $(id).addEventListener("change", () => void save());
}

function initHome(): void {
  const openWelcome = () => void chrome.tabs.create({ url: chrome.runtime.getURL("welcome.html") });
  $("connectAi").addEventListener("click", openWelcome);
  $("otherAi").addEventListener("click", openWelcome);

  $("aiConnection").addEventListener("change", () => {
    void chrome.storage.local.set({ [AGENT_KEYS.enabled]: $<HTMLInputElement>("aiConnection").checked });
  });
  for (const id of ["copy", "copyLink"]) {
    $(id).addEventListener("click", async () => {
      const ok = await copyText(await currentLink());
      flash($(id), ok ? "¡Copiado!" : "No se pudo copiar: cópialo de Ajustes → Tu enlace");
    });
  }
  $("sync").addEventListener("click", async () => {
    try {
      await send({ type: "start-sync" });
    } catch (err) {
      const t = $("syncText");
      t.textContent = err instanceof Error ? err.message : String(err);
      t.classList.add("error");
    }
  });

  $("rotate").addEventListener("click", () => ($("confirmRotate").hidden = false));
  $("rotateNo").addEventListener("click", () => ($("confirmRotate").hidden = true));
  $("rotateYes").addEventListener("click", async () => {
    const url = await changeLink();
    $<HTMLInputElement>("linkBox").value = url;
    $("confirmRotate").hidden = true;
    const copied = await copyText(url);
    flash($("rotate"), copied ? "Enlace cambiado y copiado ✓" : "Enlace cambiado ✓", 2500);
  });
  $("settings").addEventListener("toggle", () => {
    if (($("settings") as HTMLDetailsElement).open) void showUsage();
  });

  // A click outside the open «⋯» menu, or Escape, closes it.
  addEventListener("click", (ev) => {
    if (openMenu && !openMenu.box.contains(ev.target as Node)) closeMenu();
  });
  addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape" || !openMenu) return;
    const more = openMenu.more;
    closeMenu();
    more.focus();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local") return;
    if (STATUS_KEYS.some((k) => k in changes)) void renderStatus();
    if (AGENT_KEYS.identity in changes) void showLink();
  });
  void renderStatus();
  void initSettings();
  void showLink();
}

let filterTimer: ReturnType<typeof setTimeout> | undefined;

async function main(): Promise<void> {
  initHome();
  for (const m of SORT_MODES) {
    const o = el("option", { text: m.label });
    o.value = m.value;
    sortSelect.append(o);
  }
  const stored = await chrome.storage.local.get([LAST_VISIT_KEY, SORT_KEY]);
  lastVisit = typeof stored[LAST_VISIT_KEY] === "number" ? stored[LAST_VISIT_KEY] : undefined;
  if (isSortMode(stored[SORT_KEY])) sortMode = stored[SORT_KEY];
  sortSelect.value = sortMode;

  // The visit counts from when the panel opened: files stored while it is open are "Nuevo" next time.
  const markVisited = () => void chrome.storage.local.set({ [LAST_VISIT_KEY]: loadedAt });
  setTimeout(markVisited, 4000);
  addEventListener("pagehide", markVisited);

  if (deepLink.q) filterInput.value = deepLink.q;
  initUploads();
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

  // A sync finishing while the panel is open brings new files: reload the list (filter and folds kept).
  let reloadTimer: ReturnType<typeof setTimeout> | undefined;
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== "local" || !changes.syncState) return;
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => void load(), 1500);
  });
}

if (deepLink.open) void viewer(deepLink.open, deepLink.page);
else void main();
