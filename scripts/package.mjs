// `npm run package`: builds the per-user Windows installer release/UnioviVirtual-Setup-<version>.exe.
//   1. npm run build (extension/dist), package:helper (release/app/helper.js), package:host (host.cjs, host.cmd, manifest)
//   2. portable node.exe for NODE_VERSION, downloaded from nodejs.org once, cached in release/cache/ and
//      checked against that release's SHASUMS256.txt on every run
//   3. Inno Setup's ISCC.exe compiles installer/UnioviVirtual.iss
// Inno Setup 6 (no admin): winget install --id JRSoftware.InnoSetup -e --scope user
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Same major as the Node used to develop and test the helper. Bump together with engines in package.json.
const NODE_VERSION = "24.20.0";
// Pinned: SHASUMS256.txt comes from the same server as the binary, so it only catches corruption.
// Update both together when bumping Node (the hash is in that release's SHASUMS256.txt).
const NODE_SHA256 = "5c976096e04e5c2c1f091938926234cc9fbebfe9787ddd149351b3b0ecc707b5";
const NODE_DIST = `https://nodejs.org/dist/v${NODE_VERSION}`;
const NODE_FILE = "win-x64/node.exe";

const root = resolve(import.meta.dirname, "..");
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const cacheDir = join(root, "release", "cache", `node-v${NODE_VERSION}`);

function run(cmd, args) {
  console.error(`> ${[cmd, ...args].join(" ")}`);
  const r = spawnSync(cmd, args, { cwd: root, stdio: "inherit" });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

async function download(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Cached node.exe, verified against SHASUMS256.txt (also cached, so offline rebuilds work). */
async function portableNode() {
  mkdirSync(cacheDir, { recursive: true });
  const sumsFile = join(cacheDir, "SHASUMS256.txt");
  if (!existsSync(sumsFile)) writeFileSync(sumsFile, await download(`${NODE_DIST}/SHASUMS256.txt`));
  const line = readFileSync(sumsFile, "utf8").split("\n").find((l) => l.trim().endsWith(`  ${NODE_FILE}`));
  const expected = line?.split(/\s+/)[0];
  if (!expected || !/^[0-9a-f]{64}$/.test(expected)) throw new Error(`${NODE_FILE} not listed in ${sumsFile}`);
  if (expected !== NODE_SHA256) throw new Error(`SHASUMS256.txt lists ${expected} for ${NODE_FILE}, but the pinned hash is ${NODE_SHA256}`);

  const exe = join(cacheDir, "node.exe");
  const sha = (buf) => createHash("sha256").update(buf).digest("hex");
  if (!existsSync(exe) || sha(readFileSync(exe)) !== expected) {
    console.error(`downloading ${NODE_DIST}/${NODE_FILE}`);
    const bytes = await download(`${NODE_DIST}/${NODE_FILE}`);
    const got = sha(bytes);
    if (got !== expected) throw new Error(`node.exe checksum mismatch: expected ${expected}, got ${got}`);
    writeFileSync(exe, bytes);
  }
  console.error(`node.exe v${NODE_VERSION} sha256 ${expected} (verified)`);
  return exe;
}

/** ISCC.exe: env ISCC, PATH, per-user winget install, machine-wide installs. */
function findIscc() {
  const env = process.env;
  const candidates = [
    env.ISCC,
    env.LOCALAPPDATA && join(env.LOCALAPPDATA, "Programs", "Inno Setup 6", "ISCC.exe"),
    env["ProgramFiles(x86)"] && join(env["ProgramFiles(x86)"], "Inno Setup 6", "ISCC.exe"),
    env.ProgramFiles && join(env.ProgramFiles, "Inno Setup 6", "ISCC.exe"),
  ];
  const where = spawnSync("where", ["ISCC.exe"], { encoding: "utf8", windowsHide: true });
  if (where.status === 0) candidates.splice(1, 0, ...where.stdout.split(/\r?\n/).filter(Boolean));
  const found = candidates.find((p) => p && existsSync(p));
  if (!found) {
    throw new Error("Inno Setup 6 (ISCC.exe) not found. Install it with:\n  winget install --id JRSoftware.InnoSetup -e --scope user\nor set ISCC to the full path of ISCC.exe.");
  }
  return found;
}

if (process.platform !== "win32") throw new Error("npm run package builds a Windows installer; run it on Windows.");

run(process.execPath, ["scripts/build.mjs"]);
run(process.execPath, ["scripts/build.mjs", "--helper"]);
run(process.execPath, ["scripts/build-host.mjs"]);
const nodeExe = await portableNode();
const iscc = findIscc();

run(iscc, [
  "/Qp",
  `/DAppVersion=${version}`,
  `/DAppSrc=${join(root, "release", "app")}`,
  `/DExtSrc=${join(root, "extension", "dist")}`,
  `/DNodeExe=${nodeExe}`,
  `/DOutputDir=${join(root, "release")}`,
  join(root, "installer", "UnioviVirtual.iss"),
]);

const out = join(root, "release", `UnioviVirtual-Setup-${version}.exe`);
console.error(`installer -> ${out} (${(statSync(out).size / 1024 / 1024).toFixed(1)} MB)`);
