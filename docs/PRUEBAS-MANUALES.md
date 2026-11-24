# Manual test checklist (maintainer)

Things automated tests can't cover: the real relay, real Chrome, the real campus, real AI chats, a real
non-technical student, and whether the answers are actually *useful*. Tick as you go. For each failure, note
**what you did, what you expected, what happened**, and the `sync_status` warnings.

Never test against a public relay with fixture data that looks real, and never point a test helper or
test profile at your real campus data except in the checks below that are about the real campus.

## 0. Release (once per version)

**First time only:**
- [ ] Deploy the relay: follow [relay/DESPLIEGUE.md](../relay/DESPLIEGUE.md) (Cloudflare account, `npx wrangler login`, `npx wrangler deploy`). `curl https://<relay>/` answers `Uniovi Virtual relay`.
- [ ] Put that URL in `RELAY_URL` in `shared/relay.ts` (no trailing slash). Never change it afterwards: every student's pasted link depends on it.
- [ ] Make the GitHub repository **public** (Settings → General → Danger Zone → Change visibility). Pages and the unauthenticated releases API (the update check) need it.
- [ ] Enable GitHub Pages: Settings → Pages → Source "Deploy from a branch", branch `master`, folder `/docs`. After a minute, <https://iyangarcia.github.io/uniovi-virtual-extension/> shows the download page with its pictures.
- [ ] Push the installer backup tag: `git push origin v0.1.0-instalador`. Optionally create a release on that tag and attach the old `UnioviVirtual-Setup-0.1.0.exe` (rebuild it with `git checkout v0.1.0-instalador && npm ci && npm run package` if you no longer have it; mark it as not latest).

**Each version:**
- [ ] Bump `version` in `extension/manifest.json`. Do **not** touch the manifest `key` (the ID, and with it the students' stored files and links, depends on it).
- [ ] `npm run typecheck && npm test && npm run build && npm run package`. This writes `release/uniovi-virtual-<version>.zip` and `release/uniovi-virtual.zip` (same bytes).
- [ ] Create a GitHub Release with tag `v<version>` and attach **both** zips. It must be marked *latest*: the download button points at `releases/latest/download/uniovi-virtual.zip`, and the extension's daily update check reads `releases/latest`.
- [ ] Click **Descargar** on the Pages site: the new zip downloads.

## 1. A fresh student (the real test)

On a Windows PC that has never had the extension, on **campus Wi-Fi** (eduroam / Uniovi). Ideally a non-technical friend does it while you **watch without helping**; write down every place they hesitate.

- [ ] Starting from the Pages URL only, they download, extract to Documentos, enable Modo Desarrollador, Cargar descomprimida, pick the folder. Note the time taken and any step where they got stuck (the native folder picker and nested `uniovi-virtual\uniovi-virtual` are the likely spots).
- [ ] The welcome page opens by itself. Its first check is ✓.
- [ ] They log in to the campus; the "Entra en el Campus Virtual" step turns ✓ after the first sync. Note the time.
- [ ] They connect an AI using only the welcome page.
- [ ] They ask "¿qué exámenes tengo esta semana?" and get a correct answer.
- [ ] No "Errores" button on the extension card in `chrome://extensions` after the first sync (a red Errores button scares students).

## 2. Each AI answers

For **claude.ai** (free plan), **ChatGPT** (Plus) and **Gemini** (if the option exists for a Spanish account; otherwise note plan/country and that it was missing):

- [ ] The connector is added with the student's link, no authentication, and lists about 11 tools.
- [ ] "¿Qué exámenes tengo esta semana?" Matches the campus calendar and announcements. Forum dates are quoted with a link. Record client, plan, the tool calls and the result.
- [ ] "Busca en mis apuntes dónde se explica <a concept you know>." Right file and page/slide.
- [ ] "Explícame el tema N de <asignatura> y hazme un mini test." Uses that course's material and cites (file, page).
- [ ] A long PDF (100+ pages) is read in chunks (nextOffset) without the client cutting it off.
- [ ] Something not in the data: it says it doesn't know instead of inventing.
- [ ] No answer shows a local path or the data folder.

## 3. Auto-fill

On the real sites, logged in:

- [ ] claude.ai: **Conectar automáticamente** asks for the claude.ai permission only at click time, opens the connector page and fills name + URL. Only the AI's own confirm button is left. Confirm → it works in a chat.
- [ ] chatgpt.com: the same, on a Plus account.
- [ ] Gemini: the card says it is probably not available; if a form exists, try it.
- [ ] Deny the permission, or break a selector on purpose (edit the selector file, rebuild): it falls back to Copiar with a note.
- [ ] Installing the extension showed no extra permission warning for the AI sites.

## 4. Chrome closed

- [ ] Close every Chrome window (and check Task Manager: no `chrome.exe` left). Ask the AI something: it shows the Spanish "Uniovi Virtual no está conectado: abre Chrome…" message, not a generic error.
- [ ] Open Chrome (without opening the campus). Within about a minute the same question works.
- [ ] Turn off **Conectar con mi IA** in the popup: the AI gets the same message. Turn it on: it works again.
- [ ] Laptop suspended for an hour, then resumed: it reconnects by itself.

## 5. Update v1 → v2

With a real install that has synced and has a connected AI:

- [ ] Note the link (Copiar enlace) and the file count in Mis apuntes.
- [ ] Publish v2 (section 0). Within a day (or after reloading the extension), the popup and welcome page show "Hay una versión nueva".
- [ ] Follow the 2 pictured steps: extract over the same `Documentos\uniovi-virtual` (Reemplazar), press ⟳ in `chrome://extensions`.
- [ ] The version is v2; the extension ID is still `amagekgnbkaeigjhbenkilkhoklkdieo`; the link is unchanged; Mis apuntes shows the same files; the AI still answers without re-pasting.

## 6. Mis apuntes

- [ ] Opens from the popup and from the campus panel. Courses → sections → files match the campus.
- [ ] Sort by name, date and course; the filter box narrows the list; text search finds a phrase inside a PDF.
- [ ] "Nuevo" marks appear for files since the last visit and clear after it.
- [ ] Open two PDFs (e.g. exercises and solutions) with **Abrir en ventana nueva** and snap them side by side (Win + ←/→). Both render in Chrome's viewer.
- [ ] A .docx / .pptx offers **Descargar** and saves one copy. A zip shows as a campus link.

## 7. Sync on the real campus

- [ ] After reloading the extension and the campus tab, the dashboard panel appears on `/my/` and nowhere else.
- [ ] `sync_status` shows the right course count and a recent `lastSync`. Read every warning; only disabled WS functions are expected.
- [ ] Every course you're enrolled in this term appears.
- [ ] Materials: compare 2–3 courses on the campus with Mis apuntes / `list_materials` (folders, PDFs, slides, links).
- [ ] Downloaded files open and are not HTML login pages (the real redirect path is not covered by tests).
- [ ] A second sync is incremental: noticeably faster, no re-download of unchanged files.
- [ ] Notifications: a new important announcement triggers one notification when "Notify me" is on.

## 8. Efficiency (time it)

| Check | Target | Measured |
|---|---|---|
| Install, from Pages to extension card (non-technical person) | < 5 min | |
| Full first sync, all in-progress courses | < 5 min | |
| Incremental sync | < 1 min | |
| `get_deadlines` / `search_forums` reply in chat | a few seconds | |
| First `search_materials` over all files (cold text cache) | < 30 s | |
| Same search again | < 3 s | |
| `read_material` of a 100-page PDF, first call | < 15 s | |
| Tool calls the AI needs for "mi semana" | ≤ 5 | |

Also watch: Chrome's CPU while idle with the AI connection on (Task Manager → Chrome's own task manager, Shift+Esc), and how much the extension stores after several syncs.

## 9. Privacy and safety

- [ ] Nothing in the chats shows the campus password or session cookie.
- [ ] Cambiar enlace: the old link gives 404 in the AI; the new one works.
- [ ] The extension never posts or submits anything on the campus.
- [ ] Cloudflare dashboard → the Worker: logs/observability are off; the Durable Object stores only the secret hash.

## 10. Claude Code (developers)

- [ ] `npm run build`, then `claude` in the repo: `.mcp.json` starts `server/dist/index.js`; the tools work against `~/uniovi-data`, filled by the extension's optional bridge POST while the server runs.
- [ ] `npm run serve` keeps the bridge up while Claude is closed.

## Reporting

Open an issue or note with: client (claude.ai / ChatGPT / Gemini + plan), the prompt, the tool calls the chat shows, the expected vs. actual result, and `sync_status` output.
