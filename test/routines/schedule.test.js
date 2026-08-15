import test from "node:test";
import assert from "node:assert/strict";
import { buildRoutineFireKey, deriveRoutineOccurrence } from "../../src/routines/schedule.js";

process.env.TZ = "America/Los_Angeles";

const routine = {
  id: "community-sweep",
  calendar: [{ hour: 7, minute: 0 }, { hour: 17, minute: 0 }],
  spaceTitleFormat: "community sweep · {scheduled_local}",
};

test("scheduled occurrence uses the latest local calendar slot and a ten-minute window", () => {
  const accepted = deriveRoutineOccurrence(routine, { now: new Date(2026, 7, 15, 17, 9, 59) });
  assert.equal(accepted.admitted, true);
  assert.match(accepted.title, /^community sweep · 2026-08-15 17:00 /);

  const missed = deriveRoutineOccurrence(routine, { now: new Date(2026, 7, 15, 17, 10, 1) });
  assert.equal(missed.admitted, false);
});

test("fire keys distinguish repeated wall-clock minutes across the DST fallback", () => {
  const first = new Date("2026-11-01T01:30:00-07:00");
  const second = new Date("2026-11-01T01:30:00-08:00");
  const firstKey = buildRoutineFireKey("demo", first);
  const secondKey = buildRoutineFireKey("demo", second);
  assert.notEqual(firstKey, secondKey);
  assert.match(firstKey, /-0700$/);
  assert.match(secondKey, /-0800$/);
});
