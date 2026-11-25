import test from "node:test";
import assert from "node:assert/strict";
import { PLAN_WEEK_WEIGHTS, formatPoolCapacityLines, summarizePoolCapacity } from "../../src/status/table.js";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-11-25T14:00:00Z");

function entry(provider, planKey, usedPercent, resetInHours, sessionResetInHours, observedAtMs) {
  const weights = PLAN_WEEK_WEIGHTS[provider];
  return {
    weight: weights[planKey] ?? 1,
    planKey,
    knownPlan: Object.hasOwn(weights, planKey),
    week: { usedPercent, resetAt: resetInHours == null ? null : NOW + resetInHours * HOUR },
    session: sessionResetInHours == null ? null : { usedPercent: 100, resetAt: NOW + sessionResetInHours * HOUR },
    observedAtMs,
  };
}

test("plan weights measure weekly capacity in weeks of the provider's biggest plan", () => {
  assert.deepEqual(PLAN_WEEK_WEIGHTS, {
    claude: { max_20x: 1, team: 0.46 },
    codex: { promax: 1, pro: 0.46 },
  });
});

test("pool capacity weights usage, separates room by limits, and counts resets and stale readings", () => {
  const summary = summarizePoolCapacity([
    entry("claude", "max_20x", 80, 120, null, NOW - HOUR),
    entry("claude", "max_20x", 100, 6, null, NOW - 147 * HOUR),
    entry("claude", "team", 50, 12, 0.7, NOW - 2 * HOUR),
    entry("claude", "max_20x", 25, 24, 3),
    entry("claude", "max_5x", 95, 48, 0.5),
    entry("claude", "plus", 40, 72, -1, null),
    entry("claude", "team", 99, 0, 0),
    entry("claude", "plus", 20, null),
    entry("claude", "team", NaN, 1, null, NOW - 200 * HOUR),
    entry("claude", "team", null, 1),
  ], NOW);

  assert.equal(summary.measured, 8);
  assert.equal(summary.capacity.toFixed(2), "6.92");
  assert.equal(summary.used.toFixed(2), "3.83");
  assert.equal(summary.left.toFixed(2), "3.09");
  assert.equal(summary.open.toFixed(2), "2.06");
  assert.equal(summary.held.toFixed(2), "0.98");
  assert.equal(summary.nearlyFull.toFixed(2), "0.05");
  assert.equal(summary.nextOpenMs, 0.7 * HOUR);
  assert.equal(summary.halfBackMs, 48 * HOUR);
  assert.equal(summary.stale, 2);
  assert.equal(summary.oldestAgeMs, 147 * HOUR);
  assert.deepEqual(summary.unknownPlans, ["max_5x", "plus"]);

  assert.deepEqual(formatPoolCapacityLines(summary, {
    unit: "Max 20x weeks", weightNote: "a team account counts 0.46", excluded: "3 blocked accounts",
  }), [
    "Pool: 6.9 Max 20x weeks (a team account counts 0.46) · 3.8 used (55%) · 3.1 left (45%)",
    "Left: 2.1 open now · 1.0 behind a 5-hour limit (next opens in 0.7h) · 0.1 on accounts 95% or more used",
    "Comes back: 1.0 in 6h · 1.2 in 12h · 1.5 in 24h · 2.4 in 2d · 2.8 in 3d · 3.6 in 5d · half of what's used within 2.0d",
    "Readings: 2 of 8 are over an hour old (oldest 6.1d), so the pool is at least this used; aim cluster status reads every machine.",
    "Not counted: 2 accounts without a reading, 3 blocked accounts",
    "Plans with no measured size, counted as 1: max_5x, plus",
  ]);
});

test("pending resets may return less than half and room rounded to zero is omitted", () => {
  const summary = summarizePoolCapacity([
    entry("codex", "promax", 99, null),
    entry("codex", "promax", 100, null),
    entry("codex", "promax", 100, 6),
  ], NOW);

  assert.equal(summary.halfBackMs, null);
  assert.deepEqual(formatPoolCapacityLines(summary, { unit: "Pro Max weeks" }), [
    "Pool: 3.0 Pro Max weeks · 3.0 used (100%) · 0.0 left (0%)",
    "Left: nothing",
    "Comes back: 1.0 in 6h · 1.0 in 12h · 1.0 in 24h · 1.0 in 2d · 1.0 in 3d · 1.0 in 5d",
  ]);
});

test("an expired week counts as empty and a missing reading contributes no capacity", () => {
  const expired = entry("codex", "pro", 100, 0);
  const missing = { ...entry("codex", "promax"), week: null };
  const summary = summarizePoolCapacity([expired, missing], NOW);
  assert.equal(summary.capacity, 0.46);
  assert.equal(summary.used, 0);
  assert.equal(summary.open, 0.46);
  assert.equal(summary.halfBackMs, null);
  assert.ok(Object.values(summary.returns).every((count) => count === 0));
  assert.deepEqual(formatPoolCapacityLines(summarizePoolCapacity([missing], NOW), { unit: "Pro Max weeks" }), [
    "Pool: no weekly usage readings",
  ]);
});
