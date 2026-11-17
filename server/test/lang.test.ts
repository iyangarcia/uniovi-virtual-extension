import assert from "node:assert/strict";
import { test } from "node:test";
import { courseLabel, courseLanguage, isLowPriority, priorityOf, resourceLanguage } from "../../shared/lang.ts";
import type { Course, Resource } from "../../shared/types.ts";

// Real names from Uniovi Virtual (2026-27).
const course = (id: number, shortname: string, fullname: string): Course => ({ id, shortname, fullname, url: "" });
const compEn = course(
  2782,
  "T_S,A_(GIISOF01-2-005,2GIISMAT-2-004),G_((Ing-01))",
  "Computabilidad (Grado en Ingeniería Informática del Software y PCEO Grado en Ingeniería Informática del Software / Grado en Matemáticas - Grupo Inglés)",
);
const compEs = course(
  2761,
  "T_S,A_(GIISOF01-2-005,2GIISMAT-2-004),G_((01,02))",
  "Computabilidad (Grupos en Castellano) (Grado en Ingeniería Informática del Software y PCEO Grado en Ingeniería Informática del Software / Grado en Matemáticas)",
);
const cpm = course(2683, "T_S,A_(GIISOF01-2-007,MINGEWEB-C-001,2GIISMAT-2-006)", "Comunicación Persona-Máquina (Grado en Ingeniería Informática del Software)");
const ed = course(1175, "T_S,A_(GIISOF01-2-003,2GIISMAT-2-005),G_((01,02,Ing-01))", "Estructuras de datos (Grupos A ,B, Inglés) (Grado en Ingeniería Informática del Software)");
const tec = course(2736, "T_S,A_(GIISOF01-2-001,2GIISMAT-3-004),G_((01,02,Ing-01))", "Tecnología Electrónica de Computadores (Grupos Castellano e Inglés) (Grado en Ingeniería Informática del Software)");
const escuela = course(194, "T_SP,P_(GIISOF01,MINGEWEB,2GIISMAT,MUINGWEB),R_ESTUDIANTE", "Canal Escuela de Ingeniería Informática");
const all = [compEn, compEs, cpm, ed, tec, escuela];

const res = (c: Course, name: string, section = "", filename?: string): Resource => ({
  key: name,
  cmid: 1,
  courseId: c.id,
  section,
  name,
  modname: "resource",
  url: "",
  filename,
});

test("course language from group codes and names", () => {
  assert.equal(courseLanguage(compEn, all), "en");
  assert.equal(courseLanguage(compEs, all), "es");
  assert.equal(courseLanguage(ed, all), "mixed"); // Spanish + English groups in one course
  assert.equal(courseLanguage(tec, all), "mixed");
  assert.equal(courseLanguage(cpm, all), "mixed");
  assert.equal(courseLanguage(escuela, all), "mixed");
});

test("resource language: explicit markers, then section, then course", () => {
  assert.equal(resourceLanguage(res(cpm, "Tema 1 (Castellano)"), cpm, all), "es");
  assert.equal(resourceLanguage(res(cpm, "Tema 1 (English)"), cpm, all), "en");
  assert.equal(resourceLanguage(res(ed, "Guía docente oficial en SIES (Español/English)"), ed, all), "both");
  assert.equal(resourceLanguage(res(cpm, "Práctica 3 (Archivos)"), cpm, all), "unknown");
  assert.equal(resourceLanguage(res(cpm, "Tema 2", "", "Tema2_es.pdf"), cpm, all), "es");
  assert.equal(resourceLanguage(res(cpm, "Course guide", "English"), cpm, all), "en");
  // Whole-course language is inherited
  assert.equal(resourceLanguage(res(compEs, "Diapositivas Tema 1: Lógica Proposiciones", "Parte 1"), compEs, all), "es");
  assert.equal(resourceLanguage(res(compEn, "Slides Propositional Logic", "Part 1"), compEn, all), "en");
  // Spanish-only material in a mixed course stays unknown: never demoted on a guess
  assert.equal(resourceLanguage(res(ed, "Árboles AVL", "Teoría"), ed, all), "unknown");
});

test("priority ranks, never hides", () => {
  const en = { materialLanguage: "en" as const, lowPriorityCourses: ["Canal Escuela"] };
  assert.equal(priorityOf("es", compEs, en), "backup");
  assert.equal(priorityOf("en", compEn, en), "normal");
  assert.equal(priorityOf("unknown", ed, en), "normal");
  assert.equal(priorityOf("both", cpm, en), "normal");
  assert.equal(priorityOf("mixed", escuela, en), "low");
  assert.equal(priorityOf("es", compEs, {}), "normal"); // no preference: everything normal
  assert.ok(isLowPriority(escuela, { lowPriorityCourses: ["canal escuela"] }));
  assert.ok(isLowPriority(escuela, { lowPriorityCourses: ["194"] }));
  assert.ok(!isLowPriority(cpm, { lowPriorityCourses: ["", " "] }));
});

test("course labels are readable and unique", () => {
  assert.equal(courseLabel(compEn, all), "Computabilidad (English group)");
  assert.equal(courseLabel(compEs, all), "Computabilidad (Spanish group)");
  assert.equal(courseLabel(cpm, all), "Comunicación Persona-Máquina");
  assert.equal(courseLabel(escuela, all), "Canal Escuela de Ingeniería Informática");
  const twin = course(9, "X", "Computabilidad (Grupo Inglés)");
  const labels = [compEn, twin].map((c) => courseLabel(c, [compEn, twin]));
  assert.equal(new Set(labels).size, 2);
});
