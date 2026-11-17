// "Próximamente y novedades" panel injected at the top of the Uniovi Virtual dashboard.
// Reads the last snapshot straight from chrome.storage.local, so it works without the
// local bridge or Claude. Rendered in a shadow root (Moodle CSS can't leak in) and built
// with textContent only: post subjects and names come from the site and are untrusted.
import { seenAll, TZ, unseen, upcoming, type Seen, type UpcomingItem } from "../../shared/digest.ts";
import type { Snapshot } from "../../shared/types.ts";
import type { SyncState } from "./messages.ts";

const UPCOMING_DAYS = 21;
const SHOW = 8;

export function isDashboard(): boolean {
  return /^\/my\/(index\.php|courses\.php)?$/.test(location.pathname);
}

type Child = Node | string | null | undefined | false;
function h(tag: string, attrs: Record<string, string> = {}, ...children: Child[]): HTMLElement {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  for (const c of children) if (c) el.append(c);
  return el;
}

const dayLabel = new Intl.DateTimeFormat("es-ES", { timeZone: TZ, weekday: "short", day: "numeric", month: "short" });
const rel = new Intl.RelativeTimeFormat("es", { numeric: "auto" });

function untilLabel(date: string): string {
  const today = new Intl.DateTimeFormat("sv-SE", { timeZone: TZ }).format(Date.now());
  const days = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86400_000);
  return rel.format(days, "day");
}

function ago(unix: number): string {
  const s = Math.round(unix - Date.now() / 1000);
  const abs = Math.abs(s);
  if (abs < 3600) return rel.format(Math.round(s / 60), "minute");
  if (abs < 86400) return rel.format(Math.round(s / 3600), "hour");
  return rel.format(Math.round(s / 86400), "day");
}

const KIND: Record<UpcomingItem["kind"], string> = { exam: "Examen", deadline: "Entrega", event: "Evento" };

const STYLE = `
:host { all: initial; display: block; margin: 0 0 1.25rem; font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif; color: #1d2125; }
.card { border: 1px solid #dee2e6; border-radius: 10px; background: #fff; overflow: hidden; }
header { display: flex; align-items: center; gap: .75rem; padding: .7rem 1rem; border-bottom: 1px solid #dee2e6; background: #f5f8fc; }
header h2 { font-size: 15px; margin: 0; flex: 1; }
.meta { font-size: 12px; color: #6a737b; }
.meta.err { color: #b3261e; }
button { font: inherit; font-size: 13px; padding: .3rem .8rem; border-radius: 6px; border: 1px solid #1565c0; background: #1565c0; color: #fff; cursor: pointer; }
button.ghost { background: transparent; color: #1565c0; }
button:disabled { opacity: .55; cursor: default; }
.cols { display: grid; grid-template-columns: 1.2fr 1fr; }
@media (max-width: 900px) { .cols { grid-template-columns: 1fr; } }
section { padding: .75rem 1rem 1rem; min-width: 0; }
section + section { border-left: 1px solid #dee2e6; }
@media (max-width: 900px) { section + section { border-left: 0; border-top: 1px solid #dee2e6; } }
h3 { font-size: 12px; text-transform: uppercase; letter-spacing: .04em; color: #6a737b; margin: 0 0 .5rem; display: flex; justify-content: space-between; align-items: center; }
ul { list-style: none; margin: 0; padding: 0; }
li { display: flex; gap: .7rem; padding: .45rem 0; border-top: 1px solid #f0f2f4; align-items: baseline; }
li:first-child { border-top: 0; }
.when { flex: 0 0 6.5rem; font-variant-numeric: tabular-nums; }
.when b { display: block; font-weight: 600; }
.when span { font-size: 12px; color: #6a737b; }
.body { min-width: 0; flex: 1; }
.title { color: #0f47ad; text-decoration: none; font-weight: 500; }
.title:hover { text-decoration: underline; }
.sub { font-size: 12px; color: #6a737b; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip { display: inline-block; font-size: 11px; font-weight: 600; padding: 0 .45rem; border-radius: 999px; margin-right: .35rem; vertical-align: 1px; }
.exam { background: #fde7e7; color: #a4161a; }
.deadline { background: #fff1d6; color: #8a5300; }
.event { background: #eceff3; color: #4a525a; }
.forum { font-size: 11px; color: #6a737b; border-bottom: 1px dotted; cursor: help; margin-left: .35rem; }
.empty { color: #6a737b; padding: .4rem 0; }
.more { margin-top: .4rem; }
`;

export function mountPanel(onSync: () => void): void {
  const anchor = document.querySelector("#region-main, [role='main'], #page-content");
  if (!anchor || document.getElementById("uniovi-claude-panel")) return;
  const host = document.createElement("div");
  host.id = "uniovi-claude-panel";
  anchor.prepend(host);
  const root = host.attachShadow({ mode: "open" });
  let expanded = false;

  const render = async () => {
    const { snapshot, seen, syncState } = (await chrome.storage.local.get(["snapshot", "seen", "syncState"])) as {
      snapshot?: Snapshot;
      seen?: Seen;
      syncState?: SyncState;
    };
    // "Computabilidad (Grupos en Castellano) (Grado en …)" -> "Computabilidad"
    const courseName = (id?: number) => (snapshot?.courses.find((c) => c.id === id)?.fullname ?? "").split(" (")[0]!;

    const syncBtn = h("button", syncState?.running ? { disabled: "" } : {}, syncState?.running ? "Actualizando…" : "Actualizar");
    syncBtn.addEventListener("click", onSync);
    const metaText = syncState?.running
      ? syncState.text
      : syncState?.error
        ? syncState.text
        : snapshot
          ? `Actualizado ${ago(snapshot.syncedAt)}`
          : "";
    const header = h("header", {}, h("h2", {}, "Próximamente y novedades"), h("span", { class: `meta${syncState?.error ? " err" : ""}` }, metaText), syncBtn);

    if (!snapshot) {
      root.replaceChildren(
        h("style", {}, STYLE),
        h("div", { class: "card" }, header, h("section", {}, h("div", { class: "empty" }, "Aún no hay datos. Pulsa «Actualizar» para leer tus asignaturas (tarda unos 20 segundos)."))),
      );
      return;
    }

    // ---- upcoming
    const items = upcoming(snapshot, UPCOMING_DAYS);
    const shown = expanded ? items : items.slice(0, SHOW);
    const upList = h(
      "ul",
      {},
      ...shown.map((i) =>
        h(
          "li",
          {},
          h("div", { class: "when" }, h("b", {}, dayLabel.format(Date.parse(`${i.date}T12:00:00Z`))), h("span", {}, [untilLabel(i.date), i.clock].filter(Boolean).join(" · "))),
          h(
            "div",
            { class: "body" },
            h("span", { class: `chip ${i.kind}` }, KIND[i.kind]),
            i.url ? h("a", { class: "title", href: i.url }, i.title) : h("span", {}, i.title),
            i.source === "forum" && h("span", { class: "forum", title: i.snippet ?? "" }, "del foro"),
            h("div", { class: "sub" }, courseName(i.courseId)),
          ),
        ),
      ),
    );
    const upSection = h("section", {}, h("h3", {}, `Próximos ${UPCOMING_DAYS} días`), items.length ? upList : h("div", { class: "empty" }, "Nada en las próximas tres semanas."));
    if (items.length > SHOW) {
      const more = h("button", { class: "ghost more" }, expanded ? "Ver menos" : `Ver todo (${items.length})`);
      more.addEventListener("click", () => {
        expanded = !expanded;
        void render();
      });
      upSection.append(more);
    }

    // ---- news since last "mark as seen"
    const news = unseen(snapshot, seen ?? seenAll(snapshot));
    const newsItems: HTMLElement[] = [
      ...news.posts.slice(0, 6).map((p) =>
        h("li", {}, h("div", { class: "body" }, h("a", { class: "title", href: p.url }, p.subject || "(sin asunto)"), h("div", { class: "sub" }, `${courseName(p.courseId)} · ${p.forumName} · ${ago(p.created)}`))),
      ),
      ...news.resources.slice(0, 6).map((r) =>
        h("li", {}, h("div", { class: "body" }, h("span", { class: "chip event" }, "Material"), h("a", { class: "title", href: r.url.replace("&redirect=1", "") }, r.filename ?? r.name), h("div", { class: "sub" }, `${courseName(r.courseId)} · ${r.section}`))),
      ),
    ];
    const hidden = news.posts.length + news.resources.length - newsItems.length;
    const markBtn = h("button", { class: "ghost" }, "Marcar como visto");
    markBtn.addEventListener("click", () => void chrome.storage.local.set({ seen: seenAll(snapshot) }));
    const newsSection = h(
      "section",
      {},
      h("h3", {}, h("span", {}, "Nuevo desde tu última visita"), newsItems.length ? markBtn : null),
      newsItems.length ? h("ul", {}, ...newsItems) : h("div", { class: "empty" }, "Nada nuevo. Estás al día."),
      hidden > 0 && h("div", { class: "sub more" }, `y ${hidden} más`),
    );

    root.replaceChildren(h("style", {}, STYLE), h("div", { class: "card" }, header, h("div", { class: "cols" }, upSection, newsSection)));
  };

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && (changes.snapshot || changes.seen || changes.syncState)) void render();
  });
  void render();
}
