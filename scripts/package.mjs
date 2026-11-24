// npm run package: a clean build, then the zip students download.
//   release/uniovi-virtual-<version>.zip  versioned asset for the GitHub Release
//   release/uniovi-virtual.zip            same bytes, stable name for the Pages "Descargar" link
//                                         (…/releases/latest/download/uniovi-virtual.zip)
// The zip holds extension/dist (no source maps) under one folder, uniovi-virtual/, so Windows
// "Extraer todo" gives a folder whose root has manifest.json: that is the folder to pick in
// "Cargar descomprimida".
import { execFileSync } from "node:child_process";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { zipSync } from "fflate";
import { zipName } from "../shared/release.ts";

const DIST = "extension/dist";
const TOP = "uniovi-virtual";

// Start from an empty dist so files left by older builds never ship.
await rm(DIST, { recursive: true, force: true });
execFileSync(process.execPath, ["scripts/build.mjs"], { stdio: "inherit" });

const { version } = JSON.parse(await readFile(join(DIST, "manifest.json"), "utf8"));
if (!/^\d+(\.\d+){0,3}$/.test(version)) throw new Error(`Bad manifest version: ${version}`);

async function* walk(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(path);
    else yield path;
  }
}

const mtime = new Date();
const files = {};
let count = 0;
for await (const path of walk(DIST)) {
  if (path.endsWith(".map")) continue;
  const name = `${TOP}/${relative(DIST, path).replaceAll("\\", "/")}`;
  files[name] = [new Uint8Array(await readFile(path)), { mtime }];
  count++;
}
if (!files[`${TOP}/manifest.json`]) throw new Error("manifest.json missing from the zip");

const zip = zipSync(files, { level: 9, mtime });
await mkdir("release", { recursive: true });
const versioned = join("release", zipName(version));
const stable = join("release", "uniovi-virtual.zip");
await writeFile(versioned, zip);
await writeFile(stable, zip);

const mb = ((await stat(versioned)).size / 1024 / 1024).toFixed(2);
console.log(`\n${versioned} (${count} files, ${mb} MB)`);
console.log(`${stable} (same bytes; upload both to the GitHub Release)`);
