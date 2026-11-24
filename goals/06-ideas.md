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
- Still to find out: whether the connector stays after Gemini is reopened, and whether it works in ordinary
  chats outside the Developer Mode workspace. Until then, keep recommending Claude (free) first.

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

Every tool call's output counts against the AI's limits. Ideas:
- `read_material` default 40,000 → about 15,000 characters (the AI pages with `offset`);
- compact JSON (no indentation);
- fewer search snippets by default;
- server instructions that don't push 3–4 calls per question.

Measure the tool-output sizes on real data before and after. Students should still be told: Claude (free) is
recommended; Gemini is advanced and its free quota is small.
