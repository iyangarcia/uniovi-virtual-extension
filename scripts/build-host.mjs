// Bundles the native-messaging host for the installer (agent-independent of scripts/build.mjs):
//   release/app/host.js               server/src/nativehost.ts as one CommonJS file (Node built-ins only)
//   release/app/host.cmd              what Chrome launches: runs host.js with the portable node.exe next to it
//   release/app/es.uniovi.virtual.json host manifest; `path` is relative (allowed on Windows), so it is
//                                      valid wherever the folder is installed
// CommonJS, so plain `node.exe host.js` runs it with no package.json next to it.
import { mkdir, writeFile } from "node:fs/promises";
import * as esbuild from "esbuild";

const out = process.argv[2] ?? "release/app";

export const hostBuildOptions = (outfile) => ({
  entryPoints: ["server/src/nativehost.ts"],
  outfile,
  bundle: true,
  format: "cjs",
  platform: "node",
  target: "node22",
  logLevel: "info",
});

await mkdir(out, { recursive: true });
await esbuild.build(hostBuildOptions(`${out}/host.js`));
await writeFile(`${out}/host.cmd`, '@"%~dp0node.exe" "%~dp0host.js" %*\r\n');

// The manifest comes from the host itself, so name / allowed_origins can't drift from shared/helper.ts.
const { hostManifest } = await import("../server/src/nativehost.ts");
await writeFile(`${out}/es.uniovi.virtual.json`, `${JSON.stringify(hostManifest("host.cmd"), null, 2)}\n`);
console.error(`host -> ${out}/host.js, host.cmd, es.uniovi.virtual.json`);
