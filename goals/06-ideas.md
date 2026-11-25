# Ideas for the next goals

Collected on 2026-11-25, after goal 05 was tested for real. The extension, the deployed relay
(`https://uniovi-relay.iyangarcias.workers.dev`) and the connector worked in ChatGPT and claude.ai with no
problems, and in Gemini through Developer Mode (`gemini.google.com/devmode`, "Create new"), with more steps.

## 1. Files from outside the campus ("Añadir archivo")

**Problem.** Some important information isn't on the Campus Virtual. Example: the official
exam calendar ("fechas de exámenes") is published on the Uniovi website as an **Excel** file. Today the AI
can't see it, so "¿cuándo es el examen de X?" only works if a teacher also posted it on the campus.

**Idea (keep it simple).** On the "Mis apuntes" page, add an **"Añadir archivo"** button (a file picker, plus
drag and drop) that stores the chosen file in the same IndexedDB store the AI reads.
- The files go into their own "Mis archivos" group (not a course), with the same open/sort/search
  as campus files. They can be deleted (campus files can't, because the next sync would bring them back).
- The AI sees them through the existing tools (`list_materials`, `read_material`, `search_materials`), with
  no new tool if possible. Mark them as "subido por ti", so the AI knows they don't come from the campus.
- Excel (`.xlsx`/`.xls`) needs text extraction: check what `shared/mcp/extract.ts` already does for xlsx,
  and make sure tables come out readable (rows/columns, sheet names). This is what makes the exam-calendar
  case work.
- Same type and size rules as campus files (`readable.ts`, 8 MB limit), with a clear message in Spanish if a
  file is refused.
- No new permissions: a file picker in an extension page needs none.

**Later, maybe:** "Añadir desde enlace": paste a uniovi.es URL and let the extension download it and
refresh it now and then, so the exam calendar stays up to date by itself. This needs host permissions for
`*.uniovi.es`, requested only at click time, as auto-fill does. Only worth doing if the uploaded-file version is
used.

**Check:** upload the real exam-calendar Excel, ask Claude "¿cuándo es el examen de <asignatura>?" and get
the right date and room, citing the file.

## 2. Gemini: make Developer Mode the documented path

What was found:
- Gemini's normal "Add a custom app" is US/English only, but **Developer Mode** works from Spain.
- Steps there:
  1. Settings → Gemini Apps Developer Mode (or `gemini.google.com/devmode`);
  2. "+ Create new";
  3. paste the link into "MCP Server URL", then "Next";
  4. tick the risk notice, then "Connect";
  5. give it a name, then "Connect".
- It worked, but it was "a bit harder" than ChatGPT and Claude.

To do:
- Point the Gemini card and its auto-fill (`extension/src/autofill/gemini.ts`) at `gemini.google.com/devmode`,
  with "Create new" and the "MCP Server URL" field.
- Replace "puede que no esté disponible en España" with the real steps, plus pictures in
  `docs/USO-CON-IA-WEB.md`.
- Checked on 2026-11-25: once added, it **does** appear in ordinary Gemini chats (type `@Uniovi Virtual`).
  Gemini then asks permission per tool. All tools are now marked read-only (`6fc7c50`); still to check whether
  that stops the prompts, or whether students must answer "Permitir siempre" once per tool. Keep recommending
  Claude (free) first.

## 3. Publish on the Chrome Web Store (likely the next goal)

Cost: a **one-time US$5** developer registration (no yearly fee, nothing per user). This removes developer mode,
the zip and the manual update step, which are the hardest parts for law students. Publish as **unlisted**, so
only people with the link can find it.

To do:
- **Store build.** No manifest `key`: the store assigns its own ID. Do this before sharing it widely, because
  zip users would re-sync once and paste a new link.
- **Name and icon.** Unofficial name and its own icon, to avoid being rejected for impersonation. For example
  "Asistente para el Campus Virtual (no oficial)", plus "no afiliado a la Universidad de Oviedo".
- **Privacy policy page** on GitHub Pages (`docs/privacidad.html`): files stay on the student's computer, and
  the relay forwards requests but stores nothing.
- **Store listing in Spanish:** description, screenshots, and a justification for each permission (the campus
  host, storage, the optional claude.ai / chatgpt.com / gemini.google.com permissions for auto-fill, alarms,
  notifications).
- **Docs.** `docs/index.html`, the welcome page and the guides point to the store. The update notice is no
  longer needed: Chrome updates store extensions by itself.

Steps only the maintainer can do: register in the Chrome Web Store Developer Dashboard (2-step verification, pay
the $5), upload, and answer the review (usually a few days).

## 4. Cheaper answers per question (Gemini's free quota ran out after a few questions)

**Done (2026-11-25).** Measured with `node scripts/measure-output.ts` (fixture data): 80,781 → 40,885 characters for a
typical question set (-49%). The main changes:
- compact JSON;
- `read_material` and `fetch` return 15,000 characters per call, plus a "call again with offset" trailer;
- `search_materials` returns 10 results by default, with 240-character snippets;
- `search_forums` returns 15 results by default, with 300-character excerpts;
- `list_materials` returns at most 150;
- shorter instructions that ask for the fewest calls.
Next targets: `get_exam_dates` and `search_forums` repeat whole forum messages (about 6k characters each). `fetch` is now
15k, so search/fetch-only clients (ChatGPT deep research) see less of a long file.

Every tool call's output counts against the AI's limits. Ideas:
- `read_material` default 40,000 → about 15,000 characters (the AI pages with `offset`);
- compact JSON (no indentation);
- fewer search snippets by default;
- server instructions that don't push 3–4 calls per question.

Measure the tool-output sizes on real data before and after. Students should still be told: Claude (free) is
recommended; Gemini is advanced and its free quota is small.

## 5. One shared connector with OAuth (next goal after the pilot, before the Web Store)

**Problem.** Today each student has a personal URL `…/mcp/<id>/<token>`, and the token in it is the
password. Claude's and ChatGPT's "share connector" button therefore shares the student's own campus data.
The guide says "no lo compartas", but the button makes sharing feel normal.

**Idea.** One URL for everyone (e.g. `https://<relay>/mcp`), with nothing secret in it, plus OAuth 2.1 in the
Worker:
- dynamic client registration;
- an authorize page;
- a token endpoint;
- the access token maps to the student's agent id.

Whoever adds the connector logs in through **their own** extension, so they only ever see their own campus.
Then sharing is safe, and it becomes a way to spread the tool: one student shares the connector and a
classmate adds it in one click.

How the login works:
- **Approval.** The authorize page opens in the student's Chrome, and the extension approves with its
  identity.
- **Safety.** No silent approval for any site. Show one «Permitir» button, and approve only when the
  `redirect_uri` belongs to claude.ai, chatgpt.com or gemini.google.com. Without this, a malicious site could
  start a login and receive the student's data.
- **No extension:** if the extension isn't installed, the authorize page says «Instala Uniovi Virtual
  primero» with the guide link, never a bare error.
- **Personal links** (`/mcp/<id>/<token>`) keep working: existing students change nothing, and they remain
  the fallback for Gemini.
- **Cambiar enlace** also revokes the student's OAuth tokens.

Check first, with a prototype:
- Does a shared Claude or ChatGPT connector really carry over to another person's personal account, or only
  within a workspace?
- Does Gemini Developer Mode accept OAuth servers?

About 1–2 days of work.

### Directories (after OAuth; a bonus, don't plan the rollout around it)

Same shared URL; submit once OAuth works. Every tool is already marked read-only (`6fc7c50`).

- **Claude Connectors Directory** (claude.ai/directory/manage).
  - Needs OAuth, privacy policy, docs, a test account.
  - No official review time and no fast track.
- **ChatGPT plugins** (OpenAI developer platform).
  - Needs a verified developer account, a `/.well-known/openai-apps-challenge` file on the relay, privacy and
    terms URLs, test cases.
  - Forum reports: 3 weeks to over 3 months, sometimes rejected with no reason.
- **Gemini.** Google's "Connected Apps" (October 2026) takes remote MCP servers, but it's a US-only waitlist
  preview, so not an option for us yet. Check again in a few months.
- **Reviewer demo mode.** Reviewers can't install the extension and sign in to Uniovi. The relay needs a demo
  account that answers with fake sample courses (about half a day). Never real data.
- **Privacy policy.** Shared with the Web Store (`docs/privacidad.html`).
- **Approval is not guaranteed** for an unofficial app built around one university.

### Gemini: workarounds (many students use it)

Gemini can't share connectors, and its directory isn't open to us. Options, simplest first:
1. **Developer Mode with the personal link** (works today). Auto-fill already opens `gemini.google.com/devmode`.
   Improve the guide with pictures, and check whether the read-only annotations removed the per-tool prompts.
2. **Through Google Drive / NotebookLM** (idea, to check). Gemini and NotebookLM already read the student's
   Google Drive natively, and NotebookLM is popular with students.
   - A «Copiar a Google Drive» button (per course) would put the campus files in a "Uniovi Virtual" Drive
     folder. Gemini (`@Google Drive`) and NotebookLM could then use them with no connector at all.
   - Costs: the Google Drive permission (`identity` + Drive scope), and files are copies, so they need re-sync.
   - Simpler first step: «Descargar asignatura» as a zip, for uploading to NotebookLM or Gemini by hand.
3. **Wait for Google's Connected Apps** to open outside the US, then submit the OAuth URL there as well.

## 6. Search inside files (RAG): send passages, not whole documents

**Problem.** To answer a question, the AI reads whole files with `read_material`, up to 40,000 characters a
call. That is slow, and it uses up the free plans: Gemini's ran out after a few questions. Often the
answer is in one or two paragraphs.

### Step 1: word search over pieces (simple, no new downloads)

**Split.** Cut each file's extracted text into pieces of about one page. Keep the file key, the name, the
course, and the page or slide number (from the existing `--- page N ---` / `--- slide N ---` markers).

**Tool.** New `find_passages` (read-only):
- **Input:** `query`, plus an optional course filter.
- **Output:** the 3–5 best pieces, each with its file, page and a short text.

**Ranking.**
- **Method:** BM25 (word matching, as search engines do).
- **Normalizing:** words are compared without accents or capitals, so "prescripcion" finds "Prescripción".
  Very common Spanish words are ignored.

**Where it runs.**
- Inside the shared MCP core (`shared/mcp/`), over the text the extension already stores, behind the
  `DataStore` interface, so the dev server gets it too.
- No new libraries.
- The index is built when needed and cached per store (like the existing WeakMap state), and rebuilt when
  files change.

**Instructions.** Server instructions say "use `find_passages` first; use `read_material` only when you need
the whole document". Citations stay "(file name, page N)".

**Size.** Maybe a day of work.

### Step 2: search by meaning (later, only if step 1 falls short)

**Idea.** Find passages by meaning, not only exact words, so that "usucapión" also finds "prescripción
adquisitiva".

**How.**
- A small multilingual embedding model (about 25–100 MB) running in the student's browser (WebGPU/WASM), so
  the data still never leaves the computer.
- Vectors stored in IndexedDB next to the texts.
- Results mixed with the BM25 ones.

**Costs.**
- A one-time download.
- A slower first indexing.
- A bigger extension or a download on first use.
- MV3 limits: no dynamic `import()` in the service worker, so this may need an offscreen document.

### How to check it works

Write about 10 real questions with known answers (for example "¿qué dice el tema 3 sobre…?",
"¿cuándo es el examen de…?"). Compare before and after:
- whether the answer is right and cites the right page;
- how many characters were sent to the AI.

Use fixture data or the dev server with a temp `UNIOVI_DATA_DIR`, never real data on a public relay.

**Order.** After §4 (cheaper answers, about 1 hour), and after the pilot.
