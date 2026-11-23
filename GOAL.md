# Goal 04: install once, use from the web — the student's PC is the server

A student installs one thing (the installer, which brings the extension and a local helper), syncs from the
campus, and connects claude.ai / ChatGPT / Gemini by pasting one URL. Files and answers stay on their PC;
nothing is hosted centrally; no accounts besides the AI's. Windows only for now.
Tick an item only when implemented AND verified; log evidence (command + result) under "Log".
Human-only checks (campus Wi-Fi, logging into the AIs, the installer as a fresh student) go in
docs/PRUEBAS-MANUALES.md, not here.

## 1. Tunnel that works on campus networks (443, no account)
- [x] Spike: tunnelmole client (npm) — licence OK to bundle, connects over wss:443, random https URL, MCP Streamable HTTP POSTs pass through; findings in Log
- [x] tunnel.ts → pluggable providers behind one interface (url/ready/error/down): tunnelmole (default), localhost.run via built-in `ssh` (port 443 if supported, else 22), cloudflared (only if installed); (order revised after the spike, see Log: localhost.run → tunnelmole → pinggy → cloudflared) automatic fallback when a provider doesn't become ready within N s; restart-on-drop kept
- [x] Unit tests: URL parsing per provider (real captured output as fixtures), fallback order, URL republished after a drop
- [x] End-to-end from this PC: `--remote` through tunnelmole, MCP SDK client over the PUBLIC url lists tools and calls get_deadlines/search/fetch against a fixture data dir; wrong token / other paths → 404 over the public url
- [x] Same end-to-end through the localhost.run fallback

## 2. Helper (the existing server, as a background service)
- [x] Config file `%LOCALAPPDATA%\UnioviVirtual\config.json` (dataDir, tunnel on/off); dataDir default Documents\Uniovi, or existing %USERPROFILE%\uniovi-data; UNIOVI_DATA_DIR still overrides
- [x] `--service` mode: ingest + remote MCP + tunnel, no console banner, logs to a rotating file in %LOCALAPPDATA%\UnioviVirtual\logs; single instance (second start exits cleanly)
- [x] GET /api/status reports helper version, tunnel state (connecting/ready/error + provider + last error) besides remoteUrl
- [x] Fully bundled build (`npm run package:helper`: esbuild with all packages bundled, runs with plain node.exe and no node_modules); verified by running it from a temp dir

## 3. Native Messaging (extension ↔ helper control)
- [x] Native host `es.uniovi.virtual` (node.exe + bundled host script): messages status / start / stop / setDataDir / setTunnel; starts the helper detached and hidden if not running
- [x] Test: drive the host over stdio with Chrome's 4-byte length framing (status, start → /api/status answers, stop)
- [x] Extension: `nativeMessaging` permission, fixed `key` in manifest (ID documented, matches allowed_origins)

## 4. Extension popup
- [x] Popup shows helper state (not installed / stopped / connecting / ready / error), Iniciar/Detener, the URL with Copiar, the data folder with Cambiar, and the privacy note (provider sees traffic in transit) — textContent only
- [x] Background notifies when the connector URL changes ("pega la nueva URL en tu IA"), at most once per change
- [x] Without the helper installed, panel + notifications still work exactly as today

## 5. Installer (per-user, no admin)
- [x] `npm run package` builds `release/UnioviVirtual-Setup-<version>.exe` with Inno Setup: portable node.exe, bundled helper + host, extension folder; installs to %LOCALAPPDATA%\UnioviVirtual; HKCU Native Messaging registration; Startup entry that launches the helper hidden; uninstaller removes all of it (data folder kept)
- [x] Verified on this PC: silent install → helper autostart command works → /api/status ready → native host answers → silent uninstall leaves no registry keys/startup entry (state restored afterwards)

## 6. Docs
- [x] docs/USO-CON-IA-WEB.md rewritten for students (Spanish): install, load extension, sync, copy URL into claude.ai / ChatGPT / Gemini, what to do when the URL changes, SmartScreen "Más información → Ejecutar de todas formas", privacy
- [x] docs/PRUEBAS-MANUALES.md: human checklist — campus Wi-Fi tunnel, each of the three AIs answering "¿qué exámenes tengo esta semana?", fresh-user install, reboot → URL change flow
- [x] CLAUDE.md + README updated (helper, providers, native host, packaging); start-remote.bat kept for developers or removed with a note

## 7. Gate
- [ ] npm run typecheck, npm test and npm run build pass; all spawned helpers/tunnels stopped at the end

## Log

### 2026-11-24 wave 1 (agents A tunnel, B helper, C extension; merged and re-verified by the coordinator)

**Section 1, tunnel (agent A, e77adad).**
- **Spike (the plan changed):** the tunnelmole npm client is MIT, but it connects on wss **:8083**, not 443. Through it, MCP notifications came back as nginx 502, because the client copies `transfer-encoding: chunked` onto a body it has already de-chunked. It also calls process.exit, writes to stdout, and sends telemetry. So it is not bundled. `server/src/tunnel/tunnelmole.ts` reimplements its protocol on Node's built-in WebSocket instead (no new dependency).
- **Other providers:** localhost.run accepts ssh on **22 only** (443 and 80 are closed). **pinggy** (`ssh -p 443 nokey@a.pinggy.io`) is the only no-account provider found on 443, and its anonymous sessions end after 60 min. Tunnelmole and pinggy hostnames contain the student's public IP.
- **Order:** localhost.run (22), tunnelmole (8083), pinggy (443), cloudflared (7844, only if installed). Each gets a 25 s ready timeout, all-fail retries back off from 10 to 120 s, and a drop restarts from the first provider.
- **Tests:** server/test/tunnel.test.ts (19 tests) uses real captured fixtures in server/test/fixtures/tunnel/.
- **Agent's public end-to-end runs:** `e2e-remote.sh` passed over tunnelmole, over localhost.run, over a real fallback (tunnelmole on a dead endpoint, then localhost.run), and over pinggy. A drop test killed ssh.exe, and the tunnel reconnected with a new URL that was republished.
- **Coordinator re-run:** `e2e-remote.sh coord-pinggy pinggy` gave https://…free.pinggy.net. The tool list, get_deadlines (Práctica 2), search (material:5:/apuntes.txt, post:10) and fetch all PASS. Six wrong token/path requests all returned 404. The helper wrote 0 stdout bytes, and remote.json publicUrl was cleared after stop.
- **Campus Wi-Fi is NOT verified.** Ports 22 and 8083 may be blocked there, leaving pinggy on 443 (60-min URLs). This is in the manual checklist.

**Section 2, helper (agent B, 03ffa27, then coordinator 751c944 and the merge).**
- **Data folder:** config.json comes from config.ts. Data dir precedence is UNIOVI_DATA_DIR, then config, then ~/uniovi-data, then ~/Documents/Uniovi. The test is "config.json: defaults, round trip, and data dir precedence".
- **`--service`:** service.ts plus log.ts give a file log rotating at 1 MB (3 kept), a pid file, and a single-instance check (pid alive AND remote port answers).
- **/api/status:** returns helperVersion and tunnel, which are persisted in remote.json with a pid liveness check.
- **Coordinator check:** copied release/app (no node_modules) to tmp\coord\run, then ran `UNIOVI_TUNNEL_PROVIDERS=pinggy node helper.js --service`.
  - /api/status returned `{"helperVersion":"0.1.0","tunnel":{"state":"ready","provider":"pinggy","url":"https://…run.pinggy-free.link"},"remoteUrl":"…/mcp/<token>"}`.
  - The e2e client got 10/10 PASS over the public URL.
  - A second `node helper.js --service` exited 0, logging "another helper is already running".
  - svc.out was 0 bytes, and the log is at app\logs\helper.log.
- **Bundle:** release/app/helper.js is 3.9 MB, ESM, next to package.json {"type":"module"}.

**Sections 3 and 4, native host and extension (agent C, 4350dfa, then coordinator 751c944).**
- **Host rename:** the host is renamed **host.cjs**. Otherwise the ESM package.json in the install folder made Node load it as ESM, and the tests timed out.
- **Tests:** nativehost.test.ts drives the host over 4-byte framing (status, start, /api/status 200, setTunnel restart, stop, stale pid, oversized frame), against an install dir that has the ESM package.json. The extension-ID test recomputes amagekgnbkaeigjhbenkilkhoklkdieo from the manifest key, and it matches allowed_origins.
- **Coordinator check with the REAL bundled helper**, framed messages to `node host.cjs`:
  - status returned running:true.
  - stop returned running:false, the bridge went down, and the ssh tunnel child was gone (taskkill /T).
  - setTunnel false, then start, gave /api/status `"tunnel":{"state":"off"}`; stop then took the bridge down again.
- **Popup:** deriveHelperView is unit-tested (nativehost-popup.test.ts), and the URL-change rule remoteUrlChange is unit-tested. Typecheck and build pass. Nobody has clicked the popup in Chrome yet; that's on the manual checklist, together with "does a helper started by Chrome's host survive Chrome closing" (job object).
- **Without the helper:** snapshot, panel and notification code is unchanged, and the alarm makes no new requests until a connector URL has been seen.

Gate after the merges: `npm run typecheck && npm test && npm run build && npm run package:helper && npm run package:host` gave 99 pass, 0 fail. All coordinator-spawned helpers and ssh processes are stopped (tasklist).

### 2026-11-24 wave 2 (agent D installer + docs, f290592; merged and re-verified by the coordinator)

**Section 5, installer.**
- **Build:** `npm run package` runs scripts/package.mjs, then installer/UnioviVirtual.iss, and produces release/UnioviVirtual-Setup-0.1.0.exe (24.4 MB).
- **Portable Node:** node.exe v24.20.0, checked against SHASUMS256 (sha256 5c976096…707b5).
- **Inno Setup:** 6.7.3, installed per user with winget.
- **Install:** PrivilegesRequired=lowest into {localappdata}\UnioviVirtual, with a /DIR override refused.
- **Registry (HKCU):** Chrome and Edge NativeMessagingHosts\es.uniovi.virtual keys (uninsdeletekey), and a Run value using `conhost.exe --headless … helper.js --service` (no VBScript).
- **config.json:** never shipped, so an existing one is kept.
- **Uninstall:** runs `host.cjs --stop` first (a new flag, with the test "host --stop (installer / uninstaller)"), and the upgrade path stops the helper too.
- **Agent's verification:**
  - The Run value launched as stored gave conhost and node with MainWindowHandle 0 and 0 visible windows. /api/status (fixture data, tunnel off) returned `{"helperVersion":"0.1.0",…,"tunnel":{"state":"off"}}`.
  - The installed host.cmd replied to status, stop and start; the helper survived the host exiting and had no window.
  - The /STARTHELPER upgrade stopped the old helper and started a new hidden one.
  - The uninstall killed the helper and removed the app dir. A registry diff against the pre-state was identical, and ~\uniovi-data had 638 files with identical mtimes before and after.
- **Coordinator re-run** (fixture config {tunnel:false}): `npm run package` passes, and the gate gives 100 pass.
  - Silent install exit 0. The files were present, the Chrome key pointed at …\UnioviVirtual\es.uniovi.virtual.json, the Run value matched, config.json was kept, the manifest path was the absolute host.cmd, and no helper was started by the silent install.
  - Silent uninstall exit 0. The app dir is gone, the Chrome and Edge keys are gone, the Run value is gone, and the ~\uniovi-data count is unchanged. Pre-state restored.
- **Not verified here (manual checklist §6):**
  - Chrome launching the host from the popup, and the helper surviving Chrome closing.
  - The interactive wizard.
  - A reboot and logon autostart.
  - A non-ASCII username.
  - SmartScreen.
  - The tunnel on campus.

**Section 6, docs.**
- docs/USO-CON-IA-WEB.md is rewritten for students in Spanish. It covers install, SmartScreen, the extension, the first sync, popup states, claude.ai, ChatGPT developer mode, Gemini (stating it depends on plan and country), URL changes, pinggy's 60 min sessions, privacy, examples and troubleshooting.
- docs/PRUEBAS-MANUALES.md has a new §6 human checklist.
- CLAUDE.md covers the package commands, service, config, providers, native host (host.cjs), the installer, and gotchas (reserved port ranges cause EACCES; `Start-Process -Wait` waits for the whole process tree).
- README has a student intro. start-remote.bat is kept for developers, with cloudflared now optional.
