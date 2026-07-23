import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("status --json surfaces receipt and projection branches", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    `${JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt,
        access_token: fakeJwt,
        refresh_token: "REFRESH_TOKEN",
        account_id: "acct_123",
      },
      last_refresh: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  writeJson(statePath, {
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
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          idToken: fakeJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
        lastApplyReceipt: {
          action: "rebalance_openclaw",
          status: "applied_with_warnings",
          allocationMode: "demand_weighted",
          observedAt: new Date().toISOString(),
          perAccountLoad: [
            {
              label: "boss",
              carriedAgentCount: 3,
              carriedDemandWeight: 180,
              targetDemandWeight: 120,
            },
          ],
          warnings: [{ kind: "stale_pin" }],
          blockers: [],
        },
      },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
        lastSelectionReceipt: {
          action: "codex_use",
          status: "activated_with_warnings",
          observedAt: new Date().toISOString(),
          warnings: [{ kind: "readback_note" }],
          blockers: [],
        },
        lastWatchReceipt: {
          action: "codex_watch",
          status: "noop",
          observedAt: new Date().toISOString(),
          thresholdPct: 20,
          currentLabelBefore: "boss",
          currentLabelAfter: "boss",
          primaryRemainingPctBefore: 42,
          triggeredSelection: false,
          warnings: [],
          blockers: [],
        },
      },
    },
    pool: {
      openaiCodex: {
        agentDemand: {
          agent_heavy: {
            source: "openclaw-session-tokens",
            demandWeight: 150,
          },
          agent_cold: {
            source: "cold-start-equal-share",
            demandWeight: 75,
          },
        },
        history: [
          {
            observedAt: new Date().toISOString(),
            kind: "rebalance",
            status: "blocked",
            reason: "no_eligible_pool_account",
          },
          {
            observedAt: new Date().toISOString(),
            kind: "exhaustion",
            label: "boss",
            hadSpareEligibleCapacity: false,
          },
          {
            observedAt: new Date().toISOString(),
            kind: "rebalance",
            status: "applied_with_warnings",
          },
        ],
      },
    },
  });
  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 96,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const out = await runCli(["status", "--json", "--home", home], { fetchImpl });
    const parsed = JSON.parse(out);
    assert.equal(parsed.openclaw.lastApplyReceipt.status, "applied_with_warnings");
    assert.equal(parsed.openclaw.lastApplyReceipt.allocationMode, "demand_weighted");
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].label, "boss");
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].carriedAgentCount, 3);
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].carriedDemandWeight, 180);
    assert.equal(parsed.codexCli.lastSelectionReceipt.status, "activated_with_warnings");
    assert.equal(parsed.codexCli.lastWatchReceipt.status, "noop");
    assert.equal(parsed.codexCli.lastWatchReceipt.currentLabelBefore, "boss");
    assert.equal(parsed.capacity.needMoreAccounts, true);
    assert.equal(parsed.capacity.riskLevel, "high");
    assert.deepEqual(parsed.capacity.basedOn.currentHighUtilizationLabels, ["boss"]);
    assert.equal(parsed.capacity.basedOn.knownAgentDemandCount, 1);
    assert.equal(parsed.capacity.basedOn.coldStartAgentCount, 1);
    assert.equal(parsed.capacity.byAccountPressure[0].label, "boss");
    assert.equal(parsed.capacity.byAccountPressure[0].carriedAgentCount, 3);
    assert.equal(parsed.capacity.byAccountPressure[0].carriedDemandWeight, 180);
    assert.equal(parsed.capacity.byAccountPressure[0].overTargetDemandWeight, 60);
    assert.equal(parsed.pool_now.ready_accounts, 1);
    assert.equal(parsed.pool_now.total_accounts, 1);
    assert.equal(parsed.pool_now.active_agents, 3);
    assert.equal(parsed.pool_now.total_agents, 3);
    assert.equal(parsed.pool_now.assigned_load_w, 180);
    assert.equal(parsed.pool_now.usable_capacity_w, 120);
    assert.equal(parsed.pool_now.pool_load_pct, 150);
    assert.equal(parsed.pool_now.spare_w, 0);
    assert.equal(parsed.pool_now.spare_heavy, 0);
    assert.equal(parsed.pool_now.spare_medium, 0);
    assert.equal(parsed.pool_now.spare_light, 0);
    assert.equal(parsed.windows.pool_5h_used_pct, 96);
    assert.equal(parsed.windows.floor_5h_label, "boss");
    assert.equal(parsed.windows.floor_7d_label, "boss");
    assert.equal(parsed.pressure.recent_overflows_14d, 0);
    assert.equal(parsed.pressure.rebalances_blocked_14d, 1);
    assert.equal(parsed.pressure.rebalances_warn_14d, 1);
    assert.equal(parsed.pressure.cold_start_agents, 1);
    assert.equal(parsed.pressure.over_target_accounts, 1);
    assert.equal(parsed.projection.first_constraint, "5h");
    assert.equal(parsed.projection.first_constraint_label, "boss");
    assert.equal(parsed.projection.overflow_eta_h, 0);
    assert.ok(parsed.projection.load_pct_6h > parsed.pool_now.pool_load_pct);
    assert.ok(parsed.projection.load_pct_24h >= parsed.projection.load_pct_6h);
    assert.ok(parsed.projection.load_pct_72h >= parsed.projection.load_pct_24h);
    assert.ok(parsed.projection.load_pct_7d >= parsed.projection.load_pct_72h);

    const textOut = await runCli(["status", "--home", home], { fetchImpl });
    assert.match(textOut, /^CODEX ACCOUNTS \(1\)/);
    assert.match(textOut, /\nCLAUDE ACCOUNTS \(0\)/);
    assert.doesNotMatch(textOut, /OpenClaw assignments/);
    assert.doesNotMatch(textOut, /agent_boss -> boss/);
    assert.match(textOut, /average\s+--\s+--\s+\S+\s+96%\s+1\.0h\s+--\s+--\s+all\s+-/);
    assert.doesNotMatch(textOut, /POOL NOW|LAST REBALANCE|Spread:|last_watch|WARNINGS/);
    assert.match(
      textOut,
      /\nCODEX ACTIVE\nlabel=boss  5h_used=96%  5h_in=1\.0h  wk_used=--  wk_in=--\n\nCLAUDE ACTIVE\nlabel=none\n$/,
    );

    const compactOut = await runCli(["status", "--compact", "--home", home], { fetchImpl });
    assert.match(compactOut, /^load=150(?:\.0)?%  spare=0w  5h_floor=\d+(?:\.\d+)?%\(boss\)  7d_floor=\d+(?:\.\d+)?%\(boss\)  eta=0(?:\.0)?h\n$/);

    const textOutWithAccounts = await runCli(["status", "--accounts", "--home", home], { fetchImpl });
    assert.match(textOutWithAccounts, /^CODEX ACCOUNTS \(1\)/);
    assert.match(textOutWithAccounts, /\nCLAUDE ACCOUNTS \(0\)/);
    assert.match(textOutWithAccounts, /label\s+st\s+login\s+exp\s+5h_used\s+5h_in\s+wk_used\s+wk_in\s+provider\s+flags/);
    assert.match(textOutWithAccounts, /average\s+--\s+--\s+\S+\s+96%\s+1\.0h\s+--\s+--\s+all\s+-/);
    assert.doesNotMatch(textOutWithAccounts, /POOL NOW|LAST REBALANCE|Spread:|last_watch/);

    const textOutWithAssignments = await runCli(["status", "--assignments", "--home", home], { fetchImpl });
    assert.match(textOutWithAssignments, /^CODEX ACCOUNTS \(1\)/);
    assert.match(textOutWithAssignments, /OpenClaw assignments/);
    assert.match(textOutWithAssignments, /- agent_boss -> boss/);
    assert.match(textOutWithAssignments, /average\s+--\s+--\s+\S+\s+96%\s+1\.0h\s+--\s+--\s+all\s+-/);
    assert.doesNotMatch(textOutWithAssignments, /POOL NOW|last_watch/);
    assert.match(
      textOutWithAssignments,
      /\nCODEX ACTIVE\nlabel=boss  5h_used=96%  5h_in=1\.0h  wk_used=--  wk_in=--\n\nCLAUDE ACTIVE\nlabel=none\n$/,
    );
});

test("codex watch --once noops when the active label stays above the 5h remaining threshold", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "REFRESH_BOSS",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
        lastAppliedAt: new Date().toISOString(),
      },
    },
    pool: { openaiCodex: { history: [] } },
  });
  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 15,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: 40,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const result = JSON.parse(await runCli(["codex", "watch", "--once", "--home", home], { fetchImpl }));
    assert.equal(result.ok, true);
    assert.equal(result.watched.status, "noop");
    assert.equal(result.watched.receipt.currentLabelBefore, "boss");
    assert.equal(result.watched.receipt.currentLabelAfter, "boss");
    assert.equal(result.watched.receipt.primaryRemainingPctBefore, 85);
    assert.equal(result.watched.receipt.triggeredSelection, false);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.status, "noop");
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.primaryRemainingPctBefore, 85);
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt, undefined);

    const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    assert.equal(status.codexCli.lastWatchReceipt.status, "noop");
    assert.equal(status.codexCli.lastWatchReceipt.primaryRemainingPctBefore, 85);
});
