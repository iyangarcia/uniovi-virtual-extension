# Uniovi Virtual → Claude

A Chrome extension for **Uniovi Virtual** (Moodle). It does three things:

1. **Panel on your dashboard.** At the top of *Área personal* it shows exams and deadlines for the next 21 days across all your courses, plus what's new since your last visit (posts, materials and new grades). Exam dates come from the calendar and from teachers' forum announcements; forum-detected dates are tagged *del foro*, and hovering shows the sentence they came from.
2. **Notifications.** When a sync finds a new announcement that mentions an exam, a deadline or a date, or a new grade in the gradebook, you get a desktop notification. Clicking it opens the post or the grade.
3. **Study help with Claude.** Your slides and PDFs are copied to `~/uniovi-data`, and Claude can read them through MCP. Ready-made commands:
   - `semana`: your week, covering deadlines, exams, new announcements and priorities
   - `preparar_examen <asignatura>`: exam details from the announcements, a study plan, condensed notes and practice questions, citing slides and pages
   - `estudiar_tema <asignatura> <tema>`: summary, key concepts, flashcards and a mini quiz

Nothing runs in the background. The extension syncs when you open the campus, if the last sync is older than 6 hours, using your normal login. 1 and 2 don't need Claude at all. Data for Claude is kept until Claude is open and then handed over automatically.

## Setup

```sh
npm install
npm run build
```

1. **Extension:** open `chrome://extensions`, enable *Developer mode*, click *Load unpacked*, and pick `extension/dist`. Then open Uniovi Virtual; the first sync takes about 20 seconds.
2. **Claude Code:** run `claude` in this folder; `.mcp.json` registers the server. To use it from any folder:
   `claude mcp add --scope user uniovi-virtual -- node C:/dev/uniovi_virtual_extension/server/dist/index.js`
3. **Claude Desktop:** add this to `%APPDATA%\Claude\claude_desktop_config.json`:
   ```json
   { "mcpServers": { "uniovi-virtual": { "command": "node", "args": ["C:/dev/uniovi_virtual_extension/server/dist/index.js"] } } }
   ```

Data lives in `~/uniovi-data` (override with `UNIOVI_DATA_DIR`). To pin the bridge to your extension's ID, set `UNIOVI_EXTENSION_ID`.

## Using it with Claude

Just ask in your own words; Claude picks the tools. For example: *"¿cuándo es el examen de Lógica?"*, *"where do the slides explain resolution?"*, *"any new grades this week?"*. The ready-made commands are in the `/` menu of Claude Code (listed under the `uniovi-virtual` server) and in Claude Desktop's **+** menu.

| Tool | What it gives Claude |
|---|---|
| `sync_status` | Last sync, counts, collection warnings, your preferences. Ask for it when answers look incomplete. |
| `list_courses` | Your courses, labelled by language group where a subject has two |
| `list_materials`, `read_material`, `search_materials` | Course files, their text (with page/slide markers), full-text search |
| `get_deadlines`, `get_exam_dates` | Calendar and assignment dates, plus dates detected in announcements |
| `search_forums`, `get_forum_post` | Announcements and full threads |
| `get_grades` | Graded items from the gradebook, newest first |

Only courses that let students see their gradebook are covered; some (e.g. CPM) hide it and publish marks as forum posts or PDFs instead.

## Preferences (private)

Copy `config.example.json` to `~/uniovi-data/config.json` and edit it. It lives next to your data, outside the repo, so it is never committed. Don't put passwords in it; nothing here needs one.

- `materialLanguage` (`"en"` / `"es"`): material in the other language is ranked after yours and marked *backup*, never hidden. For subjects split into two courses (e.g. Computabilidad's English and Spanish groups), both stay included: Claude prefers your group but still uses the other one when it has something yours doesn't.
- `replyLanguage`: the language of the study commands' answers.
- `lowPriorityCourses`: course names or ids (e.g. `"Canal Escuela"`) shown last and dimmed in the panel, with no pop-up notifications. They are still included.
- `email`: stored for a future mail integration; not used yet.

Changes apply on the next Claude call; the panel picks them up within a minute while Claude is open.
