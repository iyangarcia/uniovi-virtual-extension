# Goal 02: real-world bring-up of the remote connector

Tick an item only once it is done AND verified. Record evidence (command + result) under "Log".

- [x] cloudflared installed (`winget install --id Cloudflare.cloudflared`) and runnable (`cloudflared --version`, or via CLOUDFLARED env with the full path if PATH isn't refreshed)
- [x] `npm run build` passes
- [x] `--remote` started against a **temporary fixture data dir** (UNIOVI_DATA_DIR, never the real ~/uniovi-data over a public tunnel); tunnel URL parsed and printed; remote.json gets publicUrl + pid
- [ ] Over the **public https URL**: MCP SDK client (StreamableHTTPClientTransport) initializes, lists tools, calls get_deadlines, search, fetch successfully
- [ ] Over the public URL: wrong token and other paths return 404; root returns 404
- [x] /api/status on 127.0.0.1:47823 returns remoteUrl while running (if 47823 is owned by another instance, verify via liveRemoteUrl logic or a temp run of the bridge) and stops returning it after shutdown
- [x] Shutdown (Ctrl+C / SIGTERM) clears publicUrl; tunnel restart-on-crash observed (kill cloudflared child, URL republished)
- [x] Real-data local check (NO tunnel, http://127.0.0.1 only): every tool against ~/uniovi-data returns sensible output; note latency of search_materials / search on the real corpus
- [x] Any bugs found are fixed with a regression test; `npm run typecheck && npm test && npm run build` pass
- [x] All spawned processes (node, cloudflared) stopped at the end

## Log

### 2026-11-23 bring-up (agent run)

**Environment limitation (items 4 and 5 left unticked):** this PC is on the Uniovi campus network
(DNS `lagoenol.si.uniovi.es`, 10.38.x.x). cloudflared's own pre-check reports `TCP Connectivity
region1/2.v2.argotunnel.com FAIL ... Allow outbound TCP on port 7844`. QUIC handshakes pass, but
every tunnel stream dies with `failed to accept QUIC stream: timeout: no recent network activity`.
I tried `--protocol quic`, `--region us` and `--edge-ip-version 6` (no IPv6 edge), and none ever
logged `Registered tunnel connection`. The public URL only ever answered Cloudflare **530 / error 1033**,
and later URLs didn't even resolve. So nothing could be verified *through* the public URL here.
Everything behind it was verified on http://127.0.0.1:47824, the exact origin cloudflared forwards to.
**For the human:** rerun items 4-5 on another network (phone hotspot or home Wi-Fi). Run
`start-remote.bat` or `npm run remote`, then point an MCP client (the `remote.test.ts` pattern) at the printed URL.

1. cloudflared: `winget install --id Cloudflare.cloudflared --accept-source-agreements --accept-package-agreements`
   printed "Instalado correctamente". PATH wasn't refreshed in this shell. The exe is at
   `C:\Program Files (x86)\cloudflared\cloudflared.exe`, and `--version` printed `cloudflared version 2026.11.1 (built 2026-11-17T05:28 UTC)`.
   I ran it through `CLOUDFLARED=<that path>`.
2. `npm run build` produced server/dist/index.js (44 kB) and the extension dist, and printed "Done" three times.
3. I seeded the fixture dir `C:\Users\Usuario\.claude\jobs\217363ae\tmp\fixture-data` with the remote.test.ts fixture
   (1 course, apuntes.txt, Práctica 2, post 10), then ran `UNIOVI_DATA_DIR=<fixture> CLOUDFLARED=<exe> node server/dist/index.js --remote`.
   It logged `[bridge] port 47823 in use; assuming another instance is ingesting` and `[remote] MCP endpoint on http://127.0.0.1:47824/mcp/<token>`.
   The banner printed `https://encouraging-caution-attitudes-was.trycloudflare.com/mcp/<token>`, and remote.json held {token, publicUrl, pid: 14428}.
   After the fix below, the URL is printed as "got …, waiting for cloudflared to connect". It's written to remote.json
   only once cloudflared registers a connection, which this network never allows.
4. Public URL: the MCP client failed with `StreamableHTTPError 530 … Error 1033: Cloudflare Tunnel error` (see the limitation above).
   The same client against `http://127.0.0.1:47824/mcp/<token>` worked:
   - init took 80 ms.
   - The tools listed were sync_status, list_courses, list_materials, read_material, search_materials, get_deadlines,
     get_exam_dates, search_forums, get_forum_post, search and fetch.
   - get_deadlines returned Práctica 2.
   - search "termodinamica" returned material:5:/apuntes.txt and post:10.
   - fetch of both returned {id,title,text,url,metadata} with the text.
5. Public URL: unreachable (530 or no DNS). Locally on 47824, each of these returned 404: POST `/mcp/<wrong 32-char token>`, `/mcp`, `/`,
   `/api/status` and `/mcp/<token>/extra`, plus `GET /`.
6. Port 47823 belongs to Claude's stdio instance (pid 24528). So `startHttp` gained an optional `port` (default 47823), and I queried
   a temp bridge on a random port with the fixture dir (`tmp/bridge-check.ts`). While --remote ran it returned
   `remoteUrl: https://dis-reduced-declare-palm.trycloudflare.com/mcp/<token>`, and after shutdown `remoteUrl: undefined`.
   bringup.test.ts also covers this ("bridge /api/status reports remoteUrl only while…").
7. Restart-on-crash: I ran `taskkill /PID <cloudflared child> /F`.
   - remote.json lost publicUrl immediately (onDown), and the log showed `[tunnel] cloudflared exited (1); restarting in 2s`.
   - On the old build a new banner followed, and remote.json got publicUrl `https://dis-reduced-declare-palm…`.
   - On the new build the log showed `exited (1); restarting in 2s` and then `got https://large-depot-feature-rna…`.

   Shutdown:
   - I couldn't inject Ctrl+C here. The harness starts processes with Ctrl+C disabled: GenerateConsoleCtrlEvent returned sent=True,
     but the event was ignored.
   - So I used the window-close path: `PostMessage(WM_CLOSE)` to the hidden console of the --remote process (`tmp/closewin.ps1`).
     That raised SIGHUP and ran shutdown. The process and cloudflared both exited, remote.json went back to `{token}`, and no
     "restarting" line appeared (tunnel.stop() ran). SIGHUP wasn't handled before this run (see bugs).
   - A hard kill of node (Stop-Process -Force) also takes cloudflared down ("cf alive after hard kill of node: False"),
     so tunnels aren't left orphaned.
8. Real data, local only: `tmp/realcheck.ts` imports startRemote with a `newToken()` that's never saved, so remote.json in
   ~/uniovi-data is untouched. It listens on 127.0.0.1 with port 0, no tunnel, and an MCP client calls every tool.

   Corpus: 7 courses, 406 materials, 343 downloaded files (299 MB, 292 extractable), 91 posts.

   All tools returned sensible output:
   - sync_status says the data is 97 h old and lists the 3 known servicenotavailable warnings.
   - get_deadlines says "No deadlines in that window", since assignments=0.
   - get_exam_dates lists forum-detected dates with snippets.
   - get_forum_post shows the thread.

   Latencies in ms ("warm" means the text cache already exists):
   - Small tools: sync_status 17, list_courses 8-21, list_materials 11-21, get_deadlines 10-19, get_exam_dates 9-24, search_forums 7-14, get_forum_post 12-19, fetch 11-21.
   - read_material: the largest file (26 MB PDF, 2.7k chars) took 212 cold and 15 warm. The longest text (ATmega328 datasheet,
     745k chars, maxChars 200000) took 8-9 warm. Its cold extraction alone takes 6.1 s.
   - search_materials "examen": 35-82 warm (it stops at 30 hits).
   - search_materials "xyzzyq" has no hits, so it scans all 292 files: 548 warm before the fix, 270 after.
   - search_materials "memoria cache": 1964 warm before the fix, 261-275 after.
   - search "examen": 158-585 warm before the fix, 77-92 after.

   Cold run, using a copy of the corpus without .cache in a local tmp dir (deleted afterwards):
   - Extracting all 292 files one after another took 84.6 s, with 0 failures.
   - Before the fix, the first `search` hit the MCP client's 60 s request timeout (`McpError -32001: Request timed out`).
   - After the fix, the first search takes 20.2 s and includes a note that "249 of 292 files are still being indexed … search
     again in a minute". Later calls take 0.4-1.4 s while the background indexer runs, and the indexer finishes in about 70 s.
9. Bugs fixed (regression tests in server/test/bringup.test.ts, 5 tests):
   - tunnel.ts announced and published the trycloudflare URL as soon as cloudflared printed it, before any edge connection.
     On a blocked network the popup and banner showed a dead URL forever, and cloudflared's errors were swallowed. Now a line
     parser (`tunnelLogParser`) announces the URL only after `Registered tunnel connection`. It logs cloudflared ERR lines to
     stderr (deduped per kind), and after 45 s without a connection it prints a hint that port 7844 may be blocked.
   - store.ts `writeAtomic` used one tmp name per process, so concurrent writes of the same file raced. 20 parallel
     `saveRemoteState` calls gave 16 ENOENT errors, then EPERM on Windows. This happens on shutdown, when onDown and the
     shutdown handler both clear remote.json, and could crash the process with an unhandled rejection. Now tmp names are unique,
     writes to one path are serialised, and EPERM/EACCES/EBUSY get a bounded retry.
   - index.ts: closing the console window (what the banner tells users to do) arrives as SIGHUP on Windows, and nothing handled
     it. A handler is added. Startup now also clears a stale publicUrl left by a previous run that was hard-killed, since its pid could be reused.
   - A cold search took longer than remote clients' ~60 s tool timeout (see 8). Now `searchMaterials` extracts files inline for at
     most 20 s (`searchBudget`), and only when the background indexer isn't running. Otherwise it searches cached text and reports
     `pending`. `--remote` starts `warmTextCache` at launch, and duplicate extractions of the same file are merged while one is running.
     Warm search now folds each file once instead of once per 3-line window (~2 s down to ~0.27 s).

   `npm run typecheck` passed, `npm test` passed 50/50, and `npm run build` printed "Done" three times.
10. Processes: all --remote node processes (14428, 9072, 6012, 17316) and every cloudflared are stopped, including the diagnostic
    ones (372, 23760) and the children. `Get-CimInstance Win32_Process` shows no cloudflared.exe. The only node processes left
    weren't started by this run: the stdio MCP servers (24528, 12372, 22428) and another agent's test run.
    Minor, not fixed: `read_material` with an offset past the end prints "chars 40000-40000 of 2687".
