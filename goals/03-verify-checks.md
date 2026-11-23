# Goal 03: are the checks actually checking? (current branch)

Audit the tests and the Stop-hook gate on the current branch by mutation: break the code on purpose and
confirm a check fails. Work in an isolated worktree; never leave a mutation in place.

- [x] Inventory: list every test in server/test/ and what behaviour it pins; list what `goal-gate.mjs` checks
- [x] Mutations on server/src/remote.ts (e.g. tokenMatches always true, drop the 404, remove rate limit, accept longer token) → each caught? record which survive
- [x] Mutations on server/src/mcp.ts remote mode (leak localPath/dataDir, break search/fetch shape, wrong fetch id handling) → caught?
- [x] Mutations on store.ts liveRemoteUrl, tunnel.ts parseTunnelUrl, http.ts status remoteUrl → caught?
- [x] Mutations on shared/dates.ts and shared/digest.ts (a few representative ones) → caught?
- [x] Gate hook: verify it blocks with an unchecked box, blocks on a failing test, allows stop when done, honours the 25 cap, and handles CRLF GOAL.md
- [x] For each surviving mutation that matters: add or strengthen a test so it is caught; re-run to confirm
- [x] `npm run typecheck && npm test && npm run build` pass with the new tests
- [x] Report: table of mutation → caught/not caught → test added, plus remaining known gaps

## Log

Isolation: the work is uncommitted, so mutations ran in a plain copy of the repo
(`~/.claude/jobs/217363ae/tmp/mutation-copy`, node_modules as a junction), driven by
`run-mutations.mjs`: apply one mutation, run `node --test "server/test/**/*.test.ts"` (and `tsc -p server`
for survivors), restore the file. Nothing under the real `server/src` or `shared/` was touched.

### Inventory (baseline: 19 tests, all pass)
- dates.test.ts (7): long Spanish date + year + time → exam; year inference Jan-after-Nov; numeric date
  + time → deadline; exam and deadline in one post classified per sentence; "prácticas" alone is not a
  deadline; ISO date read whole; "10.30" and "31/02" are not dates.
- digest.test.ts (3): upcoming() merges assignment/forum/calendar and dedupes (calendar repeat of the
  assignment, forum repeat of a calendar exam), Madrid clock; window cut-off; unseen() posts + isImportant().
- remote.test.ts (9): token persisted/stable, 32 chars, tokenMatches with/without trailing slash and two
  rejects; MCP over HTTP lists tools, instructions, get_deadlines; remote mode hides dataDir/localPath
  (sync_status, list_materials, read_material of a .txt); search/fetch shapes + unknown id isError;
  wrong token/paths → 404; searchAll/fetchById direct; parseTunnelUrl positive/negative; rotate token;
  liveRemoteUrl alive/dead/absent pid.
- Not covered at all before: http.ts (no test imports it), remote.ts body limit / bad JSON / rate limit /
  bind address, extract.ts, the extension.
- goal-gate.mjs: exits 0 silently if GOAL.md is missing or the counter `.claude/goal-iterations` ≥ 25;
  otherwise collects `- [ ]` lines (split on `\r?\n`), runs `npm run typecheck && npm test && npm run build`
  in CLAUDE_PROJECT_DIR (or cwd); if no open boxes and checks pass → exit 0, no output (counter untouched);
  else increments the counter and prints `{"decision":"block","reason":...}` with the open boxes and the
  last 3000 chars of failing output.

### Round 1: mutations against the original suite (60 mutants)
"typecheck" = only `tsc -p server` failed (the gate runs it, so it counts). Where the first version of a
mutant was only caught by `noUnusedLocals` (unused variable left behind), it was rewritten to keep the
variable used and re-run; those rewritten results are what is listed.
- remote.ts: caught R1 tokenMatches→true, R2 no 404, R4 longer token, R6 unanchored regex, R11 rotate
  ignored, R12 not remote mode. SURVIVED: R3 rate limit off, R5 shorter-prefix token accepted, R7 body
  limit off, R8 bad JSON → 500, R9 bind 0.0.0.0, R10 rate window never resets.
- mcp.ts: caught M1 local() leak, M2 read_material localPath, M5 search shape, M7 unknown id, M8 missing
  post (typecheck), M9 id split. SURVIVED: M3 unsupported-file note leaks localPath remotely, M4
  fetch(material) in local mode (leaks localPath), M6 fetch(post) metadata dropped, M10 per-file dedupe,
  M11 limit ignored, M12 any-term post match, M13 post order, M14 missing material not an error.
- store.ts: caught S1, S3; S2 (drop pid guard) caught by typecheck.
- tunnel.ts: caught T1 (no scheme), T3 (null→""). Survived T2 (http accepted), T4 (case), T5 (dots in
  subdomain): harmless, no test added.
- http.ts: nothing imported it. All survived: H1 remoteUrl dropped, H2 no Host check, H3 any Origin,
  H4 pinned id ignored, H5 stale remoteUrl, H6 snapshot validation removed.
- dates.ts: caught D3, D4, D10, D11. Survived D1 'parcial', D2 45-day look-back, D5 'a las 10'→10:30,
  D6 dotted times as dates, D7 2-digit years, D8 duplicate dates, D9 deadline-over-exam priority.
- digest.ts: caught G1, G2, G8 (typecheck). Survived G3 past items, G4 unseen resources, G5 subject
  importance, G6 newest post wins, G7 quiz=exam, G9 unseen order.

### Gate hook (run in a second copy, `gate-copy`, with CLAUDE_PROJECT_DIR pointing at it)
- All ticked + checks pass → exit 0, 0 bytes, no counter file. OK
- Unchecked box (LF) → `{"decision":"block"}` listing the box, counter 1. OK
- CRLF GOAL.md: unchecked → blocks, and the listed line has no stray `\r`; all ticked → exit 0 silent. OK
- Failing test (all ticked) → blocks with "Checks failing" and the failing test name in the tail. OK
- Type error → blocks with the tsc error. OK
- Counter 24 → blocks as "loop 25/25"; counter 25 → exit 0 silent even with open boxes. OK
- Non-numeric counter → treated as 0. No GOAL.md → exit 0 silent. OK
- Gaps: (a) the counter is never reset when a goal completes, so a later goal inherits the used loops;
  (b) only `- [ ]` is an open box (`* [ ]` is ignored); (c) **a hanging test disables the gate**:
  execSync has no timeout. A failing assertion inside remote.test.ts makes `node --test` hang
  (killed after 200 s in a probe; the test's HTTP connections keep the process alive), so the hook
  runs into Claude Code's 600 s hook timeout, which is a non-blocking error: the stop goes through.
  Verified fixes in the copy: `node --test --test-force-exit` → fails in 1 s; or
  `after(() => { server.closeAllConnections(); server.close(); })` in remote.test.ts → fails in 3 s.

### Round 2: same 60 mutants, current source + new tests (server/test/checks.test.ts, checks-shared.test.ts)
The copy was re-synced from the real repo first (another agent had changed mcp.ts/bringup.test.ts in the
meantime); baseline 49/49 pass, tsc clean.
57/60 caught. Only T2/T4/T5 survive (parseTunnelUrl accepting http://, being case-insensitive, or
allowing dots in the subdomain); they are harmless, so no tests were added for them.
Six mutants (R12, M1, M2, M5, M7, M9) were first caught only by remote.test.ts, which **hangs** when it
fails. They now also fail fast in checks.test.ts (no hang; checked by running only the new files
against each mutant). With `--test-force-exit` the remote.test.ts failures show up as well.

| Mutation | Original suite | Now | Killed by (new test) |
|---|---|---|---|
| R1 tokenMatches → true | caught | caught | + tokenMatches rejects prefixes… |
| R2 no 404 | caught | caught | (remote.test) |
| R3 rate limit off | SURVIVED | caught | remote endpoint rate-limits to 240/min, then recovers |
| R4 longer token | caught | caught | + tokenMatches rejects prefixes… |
| R5 shorter prefix token | SURVIVED | caught | tokenMatches rejects prefixes… |
| R6 unanchored regex | caught | caught | + tokenMatches rejects prefixes… |
| R7 body limit off | SURVIVED | caught | oversized body → 413, malformed JSON → 400 |
| R8 bad JSON → 500 | SURVIVED | caught | same |
| R9 bind 0.0.0.0 | SURVIVED | caught | remote endpoint listens on loopback only |
| R10 window never resets | SURVIVED | caught | rate-limit test (mock Date, tick 61 s) |
| R11 rotate ignored | caught | caught | (remote.test) |
| R12 not remote mode | caught (hangs) | caught | remote endpoint serves the tools in remote mode |
| M1 local() leaks | caught (hangs) | caught | remote: sync_status/list_materials hide local paths |
| M2 read_material localPath | caught (hangs) | caught | fetch(material) never reveals local paths |
| M3 unsupported note leaks localPath | SURVIVED | caught | remote: read_material on an unsupported file… |
| M4 fetch(material) local mode | SURVIVED | caught | fetch(material) never reveals local paths |
| M5 search shape | caught (hangs) | caught | search tool returns exactly {results:[{id,title,url}]} |
| M6 fetch(post) metadata | SURVIVED | caught | fetch(post) has the connector shape too |
| M7 unknown id → empty doc | caught (hangs) | caught | fetch errors are user errors naming the problem |
| M8 missing post | typecheck | caught | fetch errors are user errors… |
| M9 id split | caught (hangs) | caught | fetch(material) never reveals local paths |
| M10 per-file dedupe | SURVIVED | caught | searchAll: one result per file… |
| M11 limit ignored | SURVIVED | caught | same |
| M12 any-term posts | SURVIVED | caught | same |
| M13 post order | SURVIVED | caught | same |
| M14 missing material not an error | SURVIVED | caught | fetch errors are user errors… |
| S1 / S3 liveRemoteUrl | caught | caught | + bridge /api/status remoteUrl test |
| S2 drop pid guard | typecheck | typecheck | - |
| T1 / T3 parseTunnelUrl | caught | caught | (remote.test) |
| T2 / T4 / T5 parseTunnelUrl variants | survived | survived | none (harmless) |
| H1 status drops remoteUrl | SURVIVED | caught | bridge: /api/status reports remoteUrl only while alive |
| H2 no Host check | SURVIVED | caught | bridge: Host must be loopback |
| H3 any Origin | SURVIVED | caught | bridge: only chrome-extension:// origins… |
| H4 pinned id ignored | SURVIVED | caught | same |
| H5 stale remoteUrl | SURVIVED | caught | bridge /api/status remoteUrl test |
| H6 snapshot validation | SURVIVED | caught | bridge: rejects a POST that is not a snapshot |
| D1 'parcial' | SURVIVED | caught | dates: 'parcial' alone marks an exam |
| D2 45-day look-back | SURVIVED | caught | dates: a date shortly before the post keeps the post's year |
| D3 / D4 / D10 / D11 | caught | caught | (dates.test) |
| D5 'a las 10' | SURVIVED | caught | dates: 'a las 10' without minutes is 10:00 |
| D6 dotted times | SURVIVED | caught | dates: dotted times are not dates… |
| D7 2-digit year | SURVIVED | caught | dates: two-digit years mean 20xx |
| D8 duplicate date | SURVIVED | caught | dates: the same date written twice is reported once |
| D9 deadline over exam | SURVIVED | caught | dates: an exam word wins over a deadline word |
| G1 / G2 | caught | caught | (digest.test) |
| G3 past items | SURVIVED | caught | digest: past items are left out |
| G4 unseen resources | SURVIVED | caught | digest: unseen covers resources too… |
| G5 subject importance | SURVIVED | caught | digest: a subject announcing an exam is important… |
| G6 newest post wins | SURVIVED | caught | digest: when several posts announce the same date… |
| G7 quiz = exam | SURVIVED | caught | digest: quiz events are exams |
| G8 'other' dates | typecheck | caught | digest: forum dates with no exam/deadline meaning… |
| G9 unseen order | SURVIVED | caught | digest: unseen covers resources too… |

http.ts was tested with no source change: during startHttp(), `http.Server.prototype.listen` is
patched for that one call so BRIDGE_PORT becomes port 0 (47823 is held by the running bridge), and
requests go through node:http so the Host header can be set.

Final check in the real repo: `npm run typecheck && npm test && npm run build` → exit 0, 53/53 tests
(this includes bringup.test.ts, which another agent added).

### Remaining gaps (suggested fixes, not applied: source/hook/existing tests are out of scope here)
1. Gate defeated by a hanging test: add `--test-force-exit` to the `test` script, and/or
   `server.closeAllConnections()` in remote.test.ts `after`, and give execSync in goal-gate.mjs a
   `timeout` (e.g. 540_000) so a hang turns into a block, not a silent pass.
2. goal-gate counter never resets: delete `.claude/goal-iterations` when it exits 0 with everything done.
3. goal-gate ignores `* [ ]` boxes: match `/^\s*[-*] \[ \]/`.
4. parseTunnelUrl would accept `https://api.trycloudflare.com` from a cloudflared error line
   ("failed to request quick Tunnel: Post \"https://api.trycloudflare.com/tunnel\"…"), and index.ts would
   announce it as the connector URL. Fix: `/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i`, plus a test.
   Mostly mitigated now: tunnel.ts (changed concurrently) only announces a URL after "Registered tunnel
   connection", which a failed api request never prints. The regex is still worth tightening.
5. http.ts has no port parameter: `startHttp(port = BRIDGE_PORT)` would let tests drop the listen() patch.
6. Not covered: extract.ts (PDF/PPTX/DOCX text), the read_material offset/maxChars paging, and the extension.

### Follow-up fixes
Each fix has a test that was seen failing before the change and passing after.
1. remote.test.ts hang: `after` now does `server.closeAllConnections(); server.close()`. Checked by breaking
   the get_deadlines assertion: without the change `node --test server/test/remote.test.ts` hung (killed
   at 60s); with it, the file fails in ~4s. Assertion reverted.
2. tunnel.ts: `URL_RE` is `/https:\/\/(?!api\.)[a-z0-9-]+\.trycloudflare\.com/i`; the "Registered tunnel
   connection" gating is unchanged. Test: remote.test.ts "the trycloudflare API host in a cloudflared
   error is not a tunnel URL".
3. mcp.ts materialText: an offset at or past the end (when > 0) is a user error, "offset N is past the end
   (M chars)", not a "chars N-N of M" header. Test: extract.test.ts "read_material with an offset past the end…".
4. checks.test.ts: the listen() patch is gone; the bridge tests call `startHttp(0)`. Coverage is unchanged.
5. New server/test/extract.test.ts covers kindOf, plain text, a generated DOCX (paragraphs, entities), a
   generated PPTX (numeric slide order incl. slide10, `--- slide N ---` markers, `[notes]`, non-slide parts
   ignored), unsupported → null, the cache, and read_material paging (offset/maxChars/nextOffset, last page
   without nextOffset, default maxChars). PDF is not covered because generating one needs a PDF writer
   the project doesn't depend on.
Final: `npm run typecheck && npm test && npm run build` → exit 0, 61/61 tests.
