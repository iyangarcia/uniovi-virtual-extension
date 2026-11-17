// Builds both halves with esbuild (tsc is only used for type-checking).
//   extension/dist  -> load as unpacked extension in chrome://extensions
//   server/dist     -> node server/dist/index.js  (MCP stdio + HTTP bridge)
import { copyFile, cp, mkdir } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const extDist = "extension/dist";

async function copyStatic() {
  await mkdir(extDist, { recursive: true });
  await copyFile("extension/manifest.json", `${extDist}/manifest.json`);
  await copyFile("extension/src/popup.html", `${extDist}/popup.html`);
  await cp("extension/icons", `${extDist}/icons`, { recursive: true });
}

const copyPlugin = { name: "copy-static", setup: (b) => b.onEnd(copyStatic) };

const configs = [
  // Content scripts cannot be ES modules: bundle as IIFE.
  { entryPoints: ["extension/src/content.ts"], outfile: `${extDist}/content.js`, format: "iife", platform: "browser", target: "chrome120" },
  {
    entryPoints: ["extension/src/background.ts", "extension/src/popup.ts"],
    outdir: extDist,
    format: "esm",
    platform: "browser",
    target: "chrome120",
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
