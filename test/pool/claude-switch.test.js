import assert from "node:assert/strict";
import { test } from "node:test";
import { rankClaudeSwitchAccounts } from "../../src/pool/claude-switch.js";

const NOW_MS = Date.parse("2026-11-25T18:00:00Z");
const HOUR_MS = 60 * 60_000;
const HOUR_RESET = NOW_MS + HOUR_MS;
const WEEK_RESET = NOW_MS + 24 * HOUR_MS;

function account(label, windows, overrides = {}) {
  return {
    label,
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    egress: { mode: "direct" },
    poolEnabled: true,
    credentialReady: true,
    credentialState: "credential_ready",
    locked: false,
    localSessions: 0,
    source: "cache",
    authState: "usage_readable",
    usageObservedAtMs: NOW_MS - 30_000,
    usage: { ok: windows.length > 0, windows },
    ...overrides,
  };
}

function rank(accounts, preset = "opus") {
  return rankClaudeSwitchAccounts(accounts, { preset, nowMs: NOW_MS });
}

test("Claude recovery ranks a nearly full Team seat below a Max seat with a recent weekly-only reading", () => {
  const team = account("team", [
    { label: "5h", usedPercent: 98, resetAt: HOUR_RESET },
    { label: "Week", usedPercent: 86, resetAt: WEEK_RESET },
  ], { subscriptionType: "team", rateLimitTier: "team", localSessions: 2, locked: true });
  const max = account("max20", [
    { label: "Week", usedPercent: 81, resetAt: WEEK_RESET },
  ]);

  assert.deepEqual(rank([team, max]), {
    candidates: [
      { account: max, score: 19, remainingPercent: 19, confirmed: true },
      { account: team, score: 2 / 3, remainingPercent: 2 / 3, confirmed: true },
    ],
    blocked: [],
  });
});

test("Claude recovery weights weekly and model meters and can still prefer a healthy Team seat", () => {
  const team = account("team", [
    { label: "5h", usedPercent: 10 },
    { label: "Week", usedPercent: 10 },
    { label: "Opus", usedPercent: 20 },
  ], { subscriptionType: "team", rateLimitTier: "team" });
  const max = account("max", [
    { label: "5h", usedPercent: 20 },
    { label: "Week", usedPercent: 75 },
  ]);

  assert.deepEqual(rank([max, team]).candidates, [
    { account: team, score: 80 * 0.46, remainingPercent: 80, confirmed: true },
    { account: max, score: 25, remainingPercent: 25, confirmed: true },
  ]);
});

test("Claude recovery breaks equal headroom scores by fewer local sessions and then label", () => {
  const busy = account("alpha-busy", [{ label: "5h", usedPercent: 20 }], { localSessions: 1, locked: true });
  const idleA = account("alpha-idle", [{ label: "5h", usedPercent: 60 }]);
  const idleZ = account("zulu-idle", [{ label: "5h", usedPercent: 60 }]);

  assert.deepEqual(rank([busy, idleZ, idleA]).candidates.map(({ account: entry, score }) => (
    [entry.label, score]
  )), [["alpha-idle", 40], ["zulu-idle", 40], ["alpha-busy", 40]]);
});

test("Claude recovery shares Fable and Sonnet limits and ignores known other model scopes", () => {
  const fableFull = account("fable-full", [
    { kind: "weekly_all", label: "All models", usedPercent: 30 },
    { kind: "weekly_scoped", label: "Claude Sonnet 5.5", usedPercent: 100, resetAt: HOUR_RESET },
    { kind: "weekly_scoped", label: "Claude Haiku 4.5", usedPercent: 100, resetAt: WEEK_RESET },
  ], { authState: "usage_limited" });
  const opusFull = account("opus-full", [
    { label: "Week", usedPercent: 30 },
    { label: "Opus", usedPercent: 100, resetAt: HOUR_RESET },
  ], { authState: "usage_limited" });

  assert.deepEqual(rank([fableFull, opusFull]), {
    candidates: [{ account: fableFull, score: 70, remainingPercent: 70, confirmed: true }],
    blocked: [{ account: opusFull, resetAt: HOUR_RESET }],
  });
  for (const preset of ["fable", "sonnet"]) {
    assert.deepEqual(rank([fableFull, opusFull], preset), {
      candidates: [{ account: opusFull, score: 70, remainingPercent: 70, confirmed: true }],
      blocked: [{ account: fableFull, resetAt: HOUR_RESET }],
    });
  }
});

test("Claude recovery applies unknown scoped caps and waits for the last applicable blocking window", () => {
  const limited = account("limited", [
    { label: "5h", usedPercent: 105, resetAt: HOUR_RESET },
    { label: "Week", usedPercent: 97, severity: "exceeded", resetAt: WEEK_RESET },
    { kind: "weekly_scoped", label: "Context", usedPercent: 90, severity: "blocked", resetAt: WEEK_RESET + HOUR_MS },
    { label: "Fable", usedPercent: 100, resetAt: WEEK_RESET + 2 * HOUR_MS },
  ], { authState: "usage_limited" });
  const unknownReset = account("unknown-reset", [
    { label: "5h", usedPercent: 100, resetAt: HOUR_RESET },
    { label: "Opus", usedPercent: 100 },
  ], { authState: "usage_limited" });

  assert.deepEqual(rank([limited, unknownReset]), {
    candidates: [],
    blocked: [
      { account: limited, resetAt: WEEK_RESET + HOUR_MS },
      { account: unknownReset, resetAt: null },
    ],
  });
});

test("Claude recovery distinguishes recent local observations from probe candidates", () => {
  const windows = [{ label: "Week", usedPercent: 40 }];
  const accounts = [
    account("live", windows, { source: "live", usageObservedAtMs: NOW_MS }),
    account("cache", windows),
    account("session", windows, { source: "session" }),
    account("older-cache", windows, { usageObservedAtMs: NOW_MS - 120_001 }),
    account("stale-cache", windows, { source: "stale-cache" }),
    account("redis", windows, { source: "redis" }),
    account("expired-login", windows, { credentialReady: false, credentialState: "credential_expired" }),
    account("provider-error", windows, { source: "live", authState: "provider_error", errorKind: "provider_error" }),
    account("missing", [], { source: "redis", usageObservedAtMs: null }),
  ];

  for (const preset of ["opus", "fable", "sonnet"]) {
    const { candidates } = rank(accounts, preset);
    assert.deepEqual(
      candidates.filter(({ confirmed }) => confirmed).map(({ account: entry }) => entry.label),
      preset === "opus" ? ["cache", "live", "session"] : ["cache", "live"],
    );
    assert.deepEqual(candidates.at(-1), {
      account: accounts.at(-1), score: -1, remainingPercent: null, confirmed: false,
    });
  }
});

test("Claude recovery probes after applicable resets instead of counting projected zero", () => {
  const week = { label: "Week", usedPercent: 30 };
  const live = { source: "live", usageObservedAtMs: NOW_MS };
  const elapsed = { label: "5h", usedPercent: 100, resetAt: NOW_MS };
  const projected = { label: "5h", usedPercent: 0, active: false };
  const cases = [
    [account("elapsed", [elapsed, week], live), 70, false],
    [account("elapsed-inactive", [{ ...elapsed, active: false }, week], live), 70, true],
    [account("elapsed-unrelated", [week, { ...elapsed, label: "Fable" }], live), 70, true],
    [account("projected", [projected, week]), 70, false],
    [account("projected-only", [projected], { source: "stale-cache" }), null, false],
    [account("fresh-idle", [projected], live), 100, true],
    [account("inactive-full", [week, { label: "5h", usedPercent: 100, active: false }], live), 70, true],
    [account("opus-only", [{ label: "Opus", usedPercent: 70 }], live), 30, false],
  ];

  for (const [entry, remainingPercent, confirmed] of cases) {
    assert.deepEqual(rank([entry]), {
      candidates: [{ account: entry, score: remainingPercent ?? -1, remainingPercent, confirmed }],
      blocked: [],
    }, entry.label);
  }
});

test("Claude recovery requires an admitted local login, pool membership, route, and a locally shareable lock", () => {
  const windows = [{ label: "5h", usedPercent: 10 }];
  const rejected = [
    account("disabled", windows, { poolEnabled: false }),
    account("enterprise", windows, { subscriptionType: "enterprise" }),
    account("missing-route", windows, { egress: { mode: "missing_assignment" } }),
    account("unconfigured-route", windows, { egress: { mode: "proxy", localStatus: "not_configured" } }),
    account("route-error", windows, {
      egress: { mode: "proxy", localStatus: "configured" }, errorKind: "proxy_unavailable",
    }),
    account("not-signed-in", windows, { credentialReady: false, credentialState: "credential_missing" }),
    account("auth-invalid", windows, { authState: "auth_invalid" }),
    account("stale-auth", windows, { errorKind: "stale_auth" }),
    account("scope-blocked", windows, { authState: "scope_blocked" }),
    account("reauth", windows, { authState: "reauth_required" }),
    account("remote-lock", windows, { locked: true }),
    account("unknown-lock", windows, { locked: null }),
  ];
  const local = account("local", windows, {
    egress: { mode: "proxy", localStatus: "configured" }, locked: true, localSessions: 1,
  });

  assert.deepEqual(rank([...rejected, local]), {
    candidates: [{ account: local, score: 45, remainingPercent: 45, confirmed: true }],
    blocked: [],
  });
});
