import assert from "node:assert/strict";
import { test } from "node:test";
import { findDates } from "../../shared/dates.ts";

const posted = new Date("2026-11-10T09:00:00Z");

test("Spanish long date with year and time, classified as exam", () => {
  const [d] = findDates("El examen final será el 15 de enero de 2027 a las 10:00 en el aula A-3.", posted);
  assert.deepEqual({ date: d?.date, time: d?.time, kind: d?.kind }, { date: "2027-01-15", time: "10:00", kind: "exam" });
});

test("infers next year for a January date posted in November", () => {
  const [d] = findDates("Parcial: 20 de enero", posted);
  assert.equal(d?.date, "2027-01-20");
});

test("numeric date as deadline", () => {
  const [d] = findDates("La fecha límite de entrega de la práctica 2 es el 01/12/2026 23:59.", posted);
  assert.equal(d?.date, "2026-12-01");
  assert.equal(d?.time, "23:59");
  assert.equal(d?.kind, "deadline");
});

test("exam and deadline in the same post are classified separately", () => {
  const found = findDates(
    "El examen parcial será el 20 de enero a las 9:30 en el aula B-2. La entrega de la práctica es el 15/12.",
    posted,
  );
  assert.deepEqual(
    found.map((d) => [d.date, d.kind]).sort(),
    [["2026-12-15", "deadline"], ["2027-01-20", "exam"]],
  );
});

test("'prácticas' alone (internships) is not a deadline", () => {
  const [d] = findDates("Prácticas en empresa: entrevistas el 18 de noviembre.", posted);
  assert.equal(d?.kind, "other");
});

test("ISO date is read whole, not as a day/month fragment", () => {
  const found = findDates("Examen: 2027-01-12", posted);
  assert.deepEqual(found.map((d) => d.date), ["2027-01-12"]);
});

test("ignores times that look like dates and invalid dates", () => {
  assert.equal(findDates("Nos vemos a las 10.30 en clase", posted).length, 0);
  assert.equal(findDates("Versión 31/02", posted).length, 0);
});
