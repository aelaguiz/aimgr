import test from "node:test";
import assert from "node:assert/strict";
import { rebalanceOpenclawPool } from "../../src/openclaw/rebalance.js";
import { mkTempHome } from "../helpers/files.js";

test("rebalanceOpenclawPool reports applied_with_warnings when sync returns warnings", async () => {
  const home = mkTempHome();
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  };

  const result = await rebalanceOpenclawPool(
    { home },
    state,
    {
      probeUsageSnapshotsByProviderImpl: async () => ({
        "openai-codex": {
          boss: {
            ok: true,
            windows: [{ kind: "primary", usedPercent: 5 }],
          },
        },
        anthropic: {},
      }),
      readOpenclawAgentsListFromConfigImpl: () => [{ id: "agent_boss", model: "openai-codex/gpt-5.4" }],
      syncOpenclawFromStateImpl: async () => ({
        auth: { wrote: [] },
        sessions: { reason: "disk" },
        warnings: [{ kind: "test_warning", system: "openclaw" }],
      }),
    },
  );

  assert.equal(result.status, "applied_with_warnings");
  assert.equal(state.targets.openclaw.lastApplyReceipt.status, "applied_with_warnings");
  assert.equal(state.targets.openclaw.lastApplyReceipt.warnings[0].kind, "test_warning");
});

test("rebalanceOpenclawPool preserves configured non-codex assignments while rebalancing the codex pool", async () => {
  const home = mkTempHome();
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      claudalyst: {
        provider: "anthropic",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claudalyst: {
          access: "ACCESS_ANTHROPIC",
          refresh: "REFRESH_ANTHROPIC",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: {
          agent_boss: "boss",
          agent_claudalyst: "claudalyst",
        },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  };

  const result = await rebalanceOpenclawPool(
    { home },
    state,
    {
      probeUsageSnapshotsByProviderImpl: async () => ({
        "openai-codex": {
          boss: {
            ok: true,
            windows: [{ kind: "primary", usedPercent: 5 }, { kind: "secondary", usedPercent: 5 }],
          },
        },
        anthropic: {},
      }),
      readOpenclawAgentsListFromConfigImpl: () => [
        { id: "agent_boss", model: "openai-codex/gpt-5.4" },
        { id: "agent_claudalyst", model: "anthropic/claude-sonnet-4.5" },
      ],
      syncOpenclawFromStateImpl: async () => ({
        auth: { wrote: [] },
        sessions: { reason: "disk" },
        warnings: [],
      }),
    },
  );

  assert.equal(result.status, "noop");
  assert.deepEqual(state.targets.openclaw.assignments, {
    agent_boss: "boss",
    agent_claudalyst: "claudalyst",
  });
  assert.equal(state.targets.openclaw.lastApplyReceipt.assignments.agent_claudalyst, "claudalyst");
});
