import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import type { Resource, Snapshot } from "../../shared/types.ts";

// store.ts reads UNIOVI_DATA_DIR at import time: point it at a throwaway dir first.
const dir = mkdtempSync(join(tmpdir(), "uniovi-store-"));
process.env.UNIOVI_DATA_DIR = dir;
const { loadIndex, relocateFiles, storeFile } = await import("../src/store.ts");
after(() => rmSync(dir, { recursive: true, force: true }));

const junk = "Seleccionar sección Teoría / Theory Colapsar Expandir Teoría / Theory";
const res = (key: string, section: string, filename: string): Resource & { filename: string } => ({
  key,
  cmid: 1,
  courseId: 7,
  section,
  name: filename,
  modname: "section-file",
  url: "",
  filename,
});

test("relocateFiles moves files to label/clean-section paths and keeps them readable", async () => {
  await storeFile(res("a", junk, "Tema 1.pdf"), "T_S,A_(GIISOF01-2-007)", "application/pdf", new Uint8Array([1, 2, 3]));
  await storeFile(res("b", junk, "Tema 2.pdf"), "T_S,A_(GIISOF01-2-007)", "application/pdf", new Uint8Array([4]));
  const before = await loadIndex();
  assert.match(before.a!.path, /T_S,A_\(GIISOF01-2-007\)\/Seleccionar/);

  const snapshot = {
    courses: [{ id: 7, shortname: "T_S,A_(GIISOF01-2-007)", fullname: "Comunicación Persona-Máquina (Grado)", url: "" }],
    resources: [res("a", "Teoría / Theory", "Tema 1.pdf"), res("b", "Teoría / Theory", "Tema 2.pdf")],
  } as unknown as Snapshot;
  const moved = await relocateFiles(snapshot, () => "Comunicación Persona-Máquina");
  assert.equal(moved, 2);

  const after = await loadIndex();
  assert.equal(after.a!.path, "files/Comunicación Persona-Máquina/Teoría _ Theory/Tema 1.pdf");
  assert.equal(after.a!.resource.section, "Teoría / Theory");
  assert.deepEqual([...readFileSync(join(dir, ...after.a!.path.split("/")))], [1, 2, 3]);
  assert.ok(!existsSync(join(dir, "files", "T_S,A_(GIISOF01-2-007)")), "emptied old folders are removed");

  assert.equal(await relocateFiles(snapshot, () => "Comunicación Persona-Máquina"), 0, "idempotent");
});
