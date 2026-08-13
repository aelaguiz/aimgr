import test from "node:test";
import assert from "node:assert/strict";
import {
  collectXaiRedisAccountInventory,
  collectXaiRedisAccountUsageStatus,
  renderXaiRedisAccountUsageStatus,
} from "../../src/status/xai-redis-view.js";

test("xai inventory ignores other providers and ranks by label", () => {
  const rows = collectXaiRedisAccountInventory({
    credentials: [
      { provider: "anthropic", label: "pro1", identity: { emailAddress: "pro1@fun.country" }, credential: {} },
      {
        provider: "xai",
        label: "pro1",
        identity: { emailAddress: "pro1@fun.country" },
        health: { status: "ready" },
        credential: { expiresAt: "2026-08-13T20:00:00.000Z", emailAddress: "pro1@fun.country" },
      },
      {
        provider: "xai",
        label: "amir",
        identity: { emailAddress: "amir@fun.country" },
        health: { status: "ready" },
        credential: { expiresAt: "2026-08-13T21:00:00.000Z" },
      },
    ],
  });
  assert.deepEqual(rows.map((row) => row.label), ["amir", "pro1"]);
});

test("xai usage status uses monthly leftover fields only", async () => {
  const rows = await collectXaiRedisAccountUsageStatus({
    credentials: [
      {
        provider: "xai",
        label: "pro1",
        identity: { emailAddress: "pro1@fun.country" },
        health: { status: "ready" },
        credential: {
          access: "tok",
          expiresAt: "2026-08-13T20:00:00.000Z",
          emailAddress: "pro1@fun.country",
        },
      },
    ],
  }, {
    fetchXaiUsageSnapshotImpl: async () => ({
      ok: true,
      used: 113,
      limit: 10000,
      remaining: 9887,
      allowAccess: true,
      subscriptionTier: "SuperGrok Heavy",
    }),
  });
  const rendered = renderXaiRedisAccountUsageStatus(rows);
  assert.match(rendered, /113\/10000/);
  assert.match(rendered, /SuperGrok Heavy/);
  assert.doesNotMatch(rendered, /weekly/i);
});
