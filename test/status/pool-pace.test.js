import test from "node:test";
import assert from "node:assert/strict";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { computePoolPace, recordStatusPoolPace } from "../../src/status/pool-pace.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.parse("2026-11-25T14:00:00Z");
const RESET = NOW + 2 * DAY;

function reading(hoursAgo, weekUsedPercent, weekResetAt = RESET) {
  return { observedAtMs: NOW - hoursAgo * HOUR, weekUsedPercent, weekResetAt };
}

test("pool pace sums weighted account usage and takes the earliest counted start", () => {
  const perAccount = new Map([
    ["same-week", [20, NOW - 25 * HOUR]],
    ["reset", [50, NOW - 20 * HOUR]],
    ["stale", [0]],
  ]);
  const pool = { left: 10, accountRows: [
    { label: "same-week", weight: 1 },
    { label: "reset", weight: 0.46 },
    { label: "stale", weight: 1 },
  ] };
  const pace = computePoolPace(pool, perAccount, NOW);
  assert.equal(pace.used.toFixed(2), "0.43");
  assert.equal(pace.hours, 24);
  assert.equal(pace.perDay.toFixed(2), "0.47");
  assert.equal(pace.lastsUntilMs, null);
});

test("pool pace sums each account's daily rate over its own observed span", () => {
  const pool = { left: 10, accountRows: [
    { label: "long", weight: 1 },
    { label: "short", weight: 1 },
  ] };
  const perAccount = new Map([
    ["long", [10, NOW - 20 * HOUR]],
    ["short", [30, NOW - 3 * HOUR]],
  ]);
  const pace = computePoolPace(pool, perAccount, NOW);
  assert.equal(pace.used, 0.4);
  assert.equal(pace.hours, 20);
  assert.equal(pace.perDay, 0.1 / 20 * 24 + 0.3 / 3 * 24);
});

test("pool pace needs readings at least two hours back and measures the observed span", () => {
  const pool = { left: 4, accountRows: [{ label: "account", weight: 1 }, { label: "stale", weight: 1 }] };
  const perAccount = new Map([
    ["stale", [0]],
    ["account", [20, NOW - 1.99 * HOUR]],
  ]);
  assert.equal(computePoolPace(pool, perAccount, NOW), null);
  perAccount.set("account", [20, NOW - 6 * HOUR]);
  assert.deepEqual(computePoolPace(pool, perAccount, NOW), {
    used: 0.2, hours: 6, perDay: 0.8, lastsUntilMs: NOW + 5 * DAY,
  });
  perAccount.set("stale", [10, NOW - HOUR / 3]);
  assert.equal(computePoolPace(pool, perAccount, NOW).perDay, 2);
});

test("forecast adds remaining weekly resets before it can run out", () => {
  const perAccount = new Map([["account", [50, NOW - 24 * HOUR]]]);
  const resetAt = NOW + 12 * HOUR;
  const pool = { left: 0.5, accountRows: [
    { label: "account", weight: 1, weekUsedPercent: 100, weekResetAt: resetAt },
  ] };
  assert.equal(computePoolPace(pool, perAccount, NOW).lastsUntilMs, NOW + 3 * DAY);

  pool.accountRows[0].weekResetAt = NOW + DAY;
  assert.equal(computePoolPace(pool, perAccount, NOW).lastsUntilMs, NOW + 3 * DAY);

  pool.accountRows[0].weekResetAt = NOW + DAY + MINUTE;
  assert.equal(computePoolPace(pool, perAccount, NOW).lastsUntilMs, NOW + DAY);
});

test("Redis history appends readings ten minutes apart, trims at 25 hours, and scopes by pool", async () => {
  const client = new FakeRedisClient({ nowMs: NOW });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:pace-test" });
  const label = "account";
  const key = store.keys.poolUsage({ pool: "claude", label });
  assert.equal(key, "aimgr:pace-test:poolUsage:claude:account");
  const write = (nowMs, observedAtMs, weekUsedPercent, name = "claude") => recordStatusPoolPace(store, {
    [name]: { left: 0.5, accountRows: [{ label, weight: 1, observedAtMs, weekUsedPercent, weekResetAt: RESET }] },
  }, nowMs);

  await write(NOW, NOW, 10);
  await write(NOW + 9 * MINUTE, NOW + 9 * MINUTE, 15);
  await write(NOW + 10 * MINUTE, NOW, 20);
  await write(NOW + 10 * MINUTE, NOW - MINUTE, 0);
  await Promise.all([write(NOW + 10 * MINUTE, NOW + 10 * MINUTE, 25), write(NOW + 10 * MINUTE, NOW + 10 * MINUTE, 25)]);
  await write(NOW + 10 * MINUTE, NOW + 10 * MINUTE, 50, "codex");
  assert.deepEqual(JSON.parse(await client.get(key)), [reading(0, 10), reading(-1 / 6, 25)]);
  assert.equal(JSON.parse(await client.get(store.keys.poolUsage({ pool: "codex", label })))[0].weekUsedPercent, 50);

  client.advanceTime(25 * HOUR + MINUTE);
  await write(client.nowMs, NOW + 10 * MINUTE, 25);
  assert.deepEqual(JSON.parse(await client.get(key)), [reading(-1 / 6, 25)]);

  client.advanceTime(10 * MINUTE);
  await write(client.nowMs, NOW + 10 * MINUTE, 25);
  assert.equal(await client.get(key), null);
});

test("Redis calculates fractional usage from the latest retained baseline and valid weekly pairs", async () => {
  const client = new FakeRedisClient({ nowMs: NOW });
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:pace-math" });
  const cases = [
    { label: "baseline", samples: [reading(25.01, 0), reading(24.5, 10), reading(24, 10.125), reading(2, 10.375), reading(-1, 90)], used: 0.00375, hours: 24 },
    { label: "reset", samples: [reading(8, 80), reading(6, 85, RESET + HOUR), reading(4, 90, RESET), reading(2, 12.25, RESET + HOUR + 1)], used: 0.2225, hours: 8 },
    { label: "falling", samples: [reading(5, 50), reading(1, 40)], used: 0, hours: 5 },
    { label: "earlier-reset", samples: [reading(5, 10), reading(1, 20, RESET - HOUR - 1)], pace: null },
    { label: "missing-reset", samples: [reading(5, 10, null), reading(1, 20)], pace: null },
    { label: "string-reset", samples: [reading(5, 10, String(RESET)), reading(1, 20)], pace: null },
    { label: "future", samples: [reading(5, 10), reading(-1, 20)], pace: null },
  ];
  for (const item of cases) {
    const key = store.keys.poolUsage({ pool: "claude", label: item.label });
    await client.set(key, JSON.stringify(item.samples));
    const pool = { left: 10, accountRows: [{ label: item.label, weight: 1, observedAtMs: null, weekUsedPercent: null }] };
    await recordStatusPoolPace(store, { claude: pool }, NOW);
    if (item.pace === null) {
      assert.equal(pool.pace, null, item.label);
    } else {
      assert.equal(pool.pace.used, item.used, item.label);
      assert.equal(pool.pace.hours, item.hours, item.label);
    }
    if (item.label === "baseline") {
      assert.deepEqual(JSON.parse(await client.get(key)), item.samples.slice(1));
    }
  }
});
