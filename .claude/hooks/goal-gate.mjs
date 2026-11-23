// Stop hook: keeps Claude working until every box in GOAL.md is ticked and the checks pass.
// Disable by removing the hook from .claude/settings.json or deleting GOAL.md.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { execSync } from "node:child_process";

const dir = process.env.CLAUDE_PROJECT_DIR ?? process.cwd();
const goalFile = `${dir}/GOAL.md`;
if (!existsSync(goalFile)) process.exit(0);

const MAX = 25;
const counter = `${dir}/.claude/goal-iterations`;
const n = existsSync(counter) ? Number(readFileSync(counter, "utf8")) || 0 : 0;
if (n >= MAX) process.exit(0); // safety cap

const open = readFileSync(goalFile, "utf8").split(/\r?\n/).filter((l) => /^\s*- \[ \]/.test(l));

let failing = "";
try {
  execSync("npm run typecheck && npm test && npm run build", { cwd: dir, stdio: "pipe" });
} catch (e) {
  failing = `${e.stdout ?? ""}${e.stderr ?? ""}`.slice(-3000);
}

if (open.length === 0 && !failing) process.exit(0);

writeFileSync(counter, String(n + 1));
console.log(
  JSON.stringify({
    decision: "block",
    reason: [
      `GOAL.md is not finished (loop ${n + 1}/${MAX}).`,
      open.length ? `Unchecked items:\n${open.join("\n")}` : "",
      failing ? `Checks failing:\n${failing}` : "",
      "Take the next unchecked item, implement and verify it, tick it in GOAL.md, then try to stop again.",
    ]
      .filter(Boolean)
      .join("\n\n"),
  }),
);
