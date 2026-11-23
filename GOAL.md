# Goal 04: install once, use from the web — the student's PC is the server

A student installs one thing (the installer, which brings the extension and a local helper), syncs from the
campus, and connects claude.ai / ChatGPT / Gemini by pasting one URL. Files and answers stay on their PC;
nothing is hosted centrally; no accounts besides the AI's. Windows only for now.
Tick an item only when implemented AND verified; log evidence (command + result) under "Log".
Human-only checks (campus Wi-Fi, logging into the AIs, the installer as a fresh student) go in
docs/PRUEBAS-MANUALES.md, not here.

## 1. Tunnel that works on campus networks (443, no account)
- [ ] Spike: tunnelmole client (npm) — licence OK to bundle, connects over wss:443, random https URL, MCP Streamable HTTP POSTs pass through; findings in Log
- [ ] tunnel.ts → pluggable providers behind one interface (url/ready/error/down): tunnelmole (default), localhost.run via built-in `ssh` (port 443 if supported, else 22), cloudflared (only if installed); automatic fallback in that order when a provider doesn't become ready within N s; restart-on-drop kept
- [ ] Unit tests: URL parsing per provider (real captured output as fixtures), fallback order, URL republished after a drop
- [ ] End-to-end from this PC: `--remote` through tunnelmole, MCP SDK client over the PUBLIC url lists tools and calls get_deadlines/search/fetch against a fixture data dir; wrong token / other paths → 404 over the public url
- [ ] Same end-to-end through the localhost.run fallback

## 2. Helper (the existing server, as a background service)
- [ ] Config file `%LOCALAPPDATA%\UnioviVirtual\config.json` (dataDir, tunnel on/off); dataDir default Documents\Uniovi, or existing %USERPROFILE%\uniovi-data; UNIOVI_DATA_DIR still overrides
- [ ] `--service` mode: ingest + remote MCP + tunnel, no console banner, logs to a rotating file in %LOCALAPPDATA%\UnioviVirtual\logs; single instance (second start exits cleanly)
- [ ] GET /api/status reports helper version, tunnel state (connecting/ready/error + provider + last error) besides remoteUrl
- [ ] Fully bundled build (`npm run package:helper`: esbuild with all packages bundled, runs with plain node.exe and no node_modules); verified by running it from a temp dir

## 3. Native Messaging (extension ↔ helper control)
- [ ] Native host `es.uniovi.virtual` (node.exe + bundled host script): messages status / start / stop / setDataDir / setTunnel; starts the helper detached and hidden if not running
- [ ] Test: drive the host over stdio with Chrome's 4-byte length framing (status, start → /api/status answers, stop)
- [ ] Extension: `nativeMessaging` permission, fixed `key` in manifest (ID documented, matches allowed_origins)

## 4. Extension popup
- [ ] Popup shows helper state (not installed / stopped / connecting / ready / error), Iniciar/Detener, the URL with Copiar, the data folder with Cambiar, and the privacy note (provider sees traffic in transit) — textContent only
- [ ] Background notifies when the connector URL changes ("pega la nueva URL en tu IA"), at most once per change
- [ ] Without the helper installed, panel + notifications still work exactly as today

## 5. Installer (per-user, no admin)
- [ ] `npm run package` builds `release/UnioviVirtual-Setup-<version>.exe` with Inno Setup: portable node.exe, bundled helper + host, extension folder; installs to %LOCALAPPDATA%\UnioviVirtual; HKCU Native Messaging registration; Startup entry that launches the helper hidden; uninstaller removes all of it (data folder kept)
- [ ] Verified on this PC: silent install → helper autostart command works → /api/status ready → native host answers → silent uninstall leaves no registry keys/startup entry (state restored afterwards)

## 6. Docs
- [ ] docs/USO-CON-IA-WEB.md rewritten for students (Spanish): install, load extension, sync, copy URL into claude.ai / ChatGPT / Gemini, what to do when the URL changes, SmartScreen "Más información → Ejecutar de todas formas", privacy
- [ ] docs/PRUEBAS-MANUALES.md: human checklist — campus Wi-Fi tunnel, each of the three AIs answering "¿qué exámenes tengo esta semana?", fresh-user install, reboot → URL change flow
- [ ] CLAUDE.md + README updated (helper, providers, native host, packaging); start-remote.bat kept for developers or removed with a note

## 7. Gate
- [ ] npm run typecheck, npm test and npm run build pass; all spawned helpers/tunnels stopped at the end

## Log
