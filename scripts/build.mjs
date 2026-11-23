// Builds both halves with esbuild (tsc is only used for type-checking).
//   extension/dist  -> load as unpacked extension in chrome://extensions
//   server/dist     -> node server/dist/index.js  (MCP stdio + HTTP bridge)
// `--helper` (npm run package:helper) instead builds the installable helper:
//   release/app/helper.js     server with EVERY package bundled; runs with a plain node.exe and no
//                             node_modules (`node helper.js --service`)
//   release/app/package.json  {"type":"module"}: helper.js is ESM (top-level await), and Node only
//                             treats a .js file as ESM without guessing when this says so. That is
//                             why the CommonJS native host next to it is named host.cjs.
import { copyFile, cp, mkdir, rm, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");
const helper = process.argv.includes("--helper");
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

const helperConfig = {
  entryPoints: ["server/src/index.ts"],
  outfile: "release/app/helper.js",
  format: "esm",
  platform: "node",
  target: "node22",
  bundle: true,
  logLevel: "info",
  legalComments: "eof",
  // CJS dependencies (ajv, ...) call require() on Node builtins; ESM output has no `require`.
  banner: { js: 'import { createRequire as __createRequire } from "node:module"; const require = __createRequire(import.meta.url);' },
};

if (helper) {
  await rm("release/app", { recursive: true, force: true });
  await esbuild.build(helperConfig);
  await writeFile("release/app/package.json", `${JSON.stringify({ type: "module", private: true }, null, 2)}
`);
} else if (watch) {
  for (const c of configs) await (await esbuild.context({ ...shared, ...c })).watch();
} else {
  await Promise.all(configs.map((c) => esbuild.build({ ...shared, ...c })));
}
