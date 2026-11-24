// Builds both halves with esbuild (tsc is only used for type-checking).
//   extension/dist  -> load as unpacked extension in chrome://extensions
//   server/dist     -> node server/dist/index.js  (MCP stdio + HTTP bridge)
// `npm run package` (scripts/package.mjs) zips extension/dist for students.
import { copyFile, cp, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const extDist = "extension/dist";

async function copyStatic() {
  await mkdir(extDist, { recursive: true });
  await copyFile("extension/manifest.json", `${extDist}/manifest.json`);
  for (const page of ["popup", "welcome", "files"]) await copyFile(`extension/src/${page}.html`, `${extDist}/${page}.html`);
  await cp("extension/icons", `${extDist}/icons`, { recursive: true });
}

const copyPlugin = { name: "copy-static", setup: (b) => b.onEnd(copyStatic) };

const configs = [
  // Content scripts cannot be ES modules: bundle as IIFE.
  { entryPoints: ["extension/src/content.ts"], outfile: `${extDist}/content.js`, format: "iife", platform: "browser", target: "chrome120" },
  // The background service worker bundles the MCP core with unpdf, fflate and the MCP SDK (~3.9 MB).
  // MV3 module workers forbid dynamic import(), so no code splitting: esbuild inlines everything.
  {
    entryPoints: ["extension/src/background.ts", "extension/src/popup.ts", "extension/src/welcome.ts", "extension/src/files.ts"],
    outdir: extDist,
    format: "esm",
    platform: "browser",
    target: "chrome120",
    splitting: false,
    plugins: [copyPlugin],
  },
  {
    entryPoints: ["server/src/index.ts"],
    outfile: "server/dist/index.js",
    format: "esm",
    platform: "node",
    target: "node22",
    packages: "external",
  },
];

const shared = { bundle: true, sourcemap: true, logLevel: "info" };

if (watch) {
  for (const c of configs) await (await esbuild.context({ ...shared, ...c })).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build({ ...shared, ...c })));
}
