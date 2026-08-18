import test from "node:test";
import assert from "node:assert/strict";
import { projectPoolCapacity } from "../../src/pool/capacity.js";
import { isUsageSnapshotHardRateLimited } from "../../src/pool/account-status.js";
import { pickLeastUsedCodexPoolLabel, pickNextBestLocalCliPoolLabel, pickNextBestPoolLabel, rankPoolCandidates } from "../../src/pool/ranking.js";
import { fetchCodexUsageSnapshot } from "../../src/pool/usage.js";

test("rankPoolCandidates keeps current label when it stays within the weighted hysteresis threshold", () => {
  const ranked = rankPoolCandidates({
    labels: ["boss", "qa"],
    currentLabel: "boss",
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 18 }, { kind: "secondary", usedPercent: 12 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 17 }, { kind: "secondary", usedPercent: 11 }],
      },
    },
    now: Date.now(),
  });

  assert.equal(ranked[0].label, "boss");
  assert.equal(ranked[0].keptCurrent, true);
  assert.deepEqual(ranked[0].reasons, ["within_weighted_hysteresis"]);
  assert.equal(pickNextBestPoolLabel({ rankedCandidates: ranked }).label, "boss");
});

test("rankPoolCandidates favors weekly weighted headroom over the lowest 5h-used label", () => {
  const ranked = rankPoolCandidates({
    labels: ["qa", "pro2"],
    usage: {
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 92 }],
      },
      pro2: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 2 }, { kind: "secondary", usedPercent: 1 }],
      },
    },
    now: Date.now(),
  });

  assert.equal(ranked[0].label, "pro2");
  assert.equal(ranked[1].label, "qa");
});

test("pickLeastUsedCodexPoolLabel chooses lowest 5h usage before weekly usage", () => {
  const picked = pickLeastUsedCodexPoolLabel({
    labels: ["qa", "pro2"],
    usage: {
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 92 }],
      },
      pro2: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 2 }, { kind: "secondary", usedPercent: 1 }],
      },
    },
  });

  assert.equal(picked.label, "qa");
  assert.equal(picked.keptCurrent, false);
  assert.deepEqual(picked.reasons, ["lowest_5h_used"]);
});

test("pickNextBestLocalCliPoolLabel picks the lowest weekly-used label over the 5h-free gate", () => {
  const ranked = rankPoolCandidates({
    labels: ["pro1", "pro2", "pro3"],
    currentLabel: "pro1",
    usage: {
      pro1: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 12 }, { kind: "secondary", usedPercent: 75 }],
      },
      pro2: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 6 }],
      },
      pro3: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 5 }, { kind: "secondary", usedPercent: 24 }],
      },
    },
    now: Date.now(),
  });

  const picked = pickNextBestLocalCliPoolLabel({ rankedCandidates: ranked });
  assert.equal(picked.label, "pro2");
  assert.equal(picked.keptCurrent, false);
  assert.deepEqual(picked.reasons, ["lowest_weekly_used_over_5h_gate"]);
});

test("pickNextBestLocalCliPoolLabel relaxes the 5h gate when every account is hot", () => {
  const ranked = rankPoolCandidates({
    labels: ["boss", "cfo", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 30 }, { kind: "secondary", usedPercent: 92 }],
      },
      cfo: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 35 }, { kind: "secondary", usedPercent: 88 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 40 }, { kind: "secondary", usedPercent: 90 }],
      },
    },
    now: Date.now(),
  });

  const picked = pickNextBestLocalCliPoolLabel({ rankedCandidates: ranked });
  assert.equal(picked.label, "cfo");
  assert.deepEqual(picked.reasons, ["lowest_weekly_used_after_5h_gate_relaxed"]);
});

test("pickNextBestLocalCliPoolLabel refuses all-unusable candidates instead of relaxing blindly", () => {
  const ranked = rankPoolCandidates({
    labels: ["boss", "qa"],
    usage: {
      boss: {
        ok: false,
        status: "error",
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 96 }, { kind: "secondary", usedPercent: 20 }],
      },
    },
    now: Date.now(),
  });

  // The 5h gate relaxation is for hot-but-usable accounts. If every ranked
  // candidate is unavailable or exhausted, callers must block instead of activating one.
  assert.equal(pickNextBestLocalCliPoolLabel({ rankedCandidates: ranked }), null);
});

test("pickNextBestLocalCliPoolLabel can force selection away from the current label", () => {
  const ranked = rankPoolCandidates({
    labels: ["boss", "qa"],
    currentLabel: "boss",
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 12 }, { kind: "secondary", usedPercent: 12 }],
      },
    },
    now: Date.now(),
  });

  assert.equal(pickNextBestLocalCliPoolLabel({ rankedCandidates: ranked }).label, "boss");
  assert.equal(pickNextBestLocalCliPoolLabel({ rankedCandidates: ranked, avoidLabel: "boss" }).label, "qa");
  assert.equal(pickNextBestLocalCliPoolLabel({ rankedCandidates: [ranked[0]], avoidLabel: "boss" }), null);
});

test("fetchCodexUsageSnapshot preserves hard WHAM rate-limit fields", async () => {
  const snapshot = await fetchCodexUsageSnapshot({
    accessToken: "token",
    accountId: "acct_1",
    timeoutMs: 1000,
    fetchJsonWithTimeoutImpl: async () => ({
      ok: true,
      json: async () => ({
        allowed: false,
        limit_reached: true,
        rate_limit_reached_type: "primary",
        rate_limit_reset_credits: { available_count: 3 },
        rate_limit: {
          primary_window: {
            used_percent: 100,
            limit_window_seconds: 10800,
          },
          secondary_window: {
            used_percent: 42,
            limit_window_seconds: 604800,
          },
        },
      }),
    }),
  });

  assert.equal(snapshot.ok, true);
  assert.equal(snapshot.allowed, false);
  assert.equal(snapshot.limitReached, true);
  assert.equal(snapshot.rateLimitReachedType, "primary");
  assert.equal(snapshot.resetCreditsAvailable, 3);
  assert.equal(isUsageSnapshotHardRateLimited(snapshot), true);
});

test("fetchCodexUsageSnapshot preserves hard rate-limit fields from non-OK responses", async () => {
  const snapshot = await fetchCodexUsageSnapshot({
    accessToken: "token",
    accountId: "acct_1",
    timeoutMs: 1000,
    fetchJsonWithTimeoutImpl: async () => ({
      ok: false,
      status: 429,
      json: async () => ({
        message: "Rate limit reached for gpt-5.",
        rate_limit: {
          allowed: false,
          limit_reached: true,
          rate_limit_reached_type: "secondary",
        },
      }),
    }),
  });

  assert.equal(snapshot.ok, false);
  assert.equal(snapshot.status, 429);
  assert.equal(snapshot.error, "Rate limit reached for gpt-5.");
  assert.equal(snapshot.allowed, false);
  assert.equal(snapshot.limitReached, true);
  assert.equal(snapshot.rateLimitReachedType, "secondary");
  assert.equal(isUsageSnapshotHardRateLimited(snapshot), true);
});

test("projectPoolCapacity flags high risk from blocked receipts and no-spare exhaustion", () => {
  const now = Date.parse("2026-03-21T12:00:00Z");
  const projected = projectPoolCapacity({
    now,
    history: [
      {
        observedAt: "2026-03-20T12:00:00Z",
        kind: "rebalance",
        status: "blocked",
        reason: "no_eligible_pool_account",
      },
      {
        observedAt: "2026-03-19T12:00:00Z",
        kind: "exhaustion",
        label: "boss",
        hadSpareEligibleCapacity: false,
      },
      {
        observedAt: "2026-03-18T12:00:00Z",
        kind: "exhaustion",
        label: "qa",
        hadSpareEligibleCapacity: false,
      },
      {
        observedAt: "2026-03-17T12:00:00Z",
        kind: "rebalance",
        status: "applied_with_warnings",
      },
      {
        observedAt: "2026-03-16T12:00:00Z",
        kind: "rebalance",
        status: "applied_with_warnings",
        reason: "projected_demand_exceeds_eligible_supply",
      },
    ],
    liveUsage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 96 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_cold: { source: "cold-start-equal-share", demandWeight: 75 },
    },
    lastApplyReceipt: {
      perAccountLoad: [
        {
          label: "boss",
          carriedAgentCount: 3,
          carriedDemandWeight: 180,
          targetDemandWeight: 120,
        },
      ],
    },
  });

  assert.equal(projected.needMoreAccounts, true);
  assert.equal(projected.riskLevel, "high");
  assert.deepEqual(projected.basedOn.currentHighUtilizationLabels, ["boss"]);
  assert.equal(projected.basedOn.knownAgentDemandCount, 1);
  assert.equal(projected.basedOn.coldStartAgentCount, 1);
  assert.equal(projected.byAccountPressure[0].label, "boss");
  assert.ok(projected.reasons.some((reason) => reason.includes("blocked receipt")));
  assert.ok(projected.reasons.some((reason) => reason.includes("no spare eligible capacity")));
  assert.ok(projected.reasons.some((reason) => reason.includes("overflowed projected demand")));
});
