import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { refreshHermesHomeDemandLedger } from "../../src/pool/demand-ledger.js";
import { readHermesHomeTokenUsage } from "../../src/pool/token-usage.js";
import { planWeightedHermesRebalance } from "../../src/pool/weighted-planner.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { writeHermesStateDb } from "../helpers/hermes.js";

test("sync codex clears stale managed local activations and drops legacy Hermes AIM state when the active imported label is removed", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");
  const consumerHermesHome = path.join(consumerHome, ".hermes", "profiles", "agent_product_growth");
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      qa: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
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
  });

  writeJson(path.join(consumerHome, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "REFRESH_BOSS",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });
  writeJson(path.join(consumerHome, ".pi", "agent", "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: bossJwt,
      refresh: "REFRESH_BOSS",
      expires: Date.now() + 3600_000,
      accountId: "acct_boss",
    },
  });
  writeJson(path.join(consumerHermesHome, "auth.json"), {
    version: "1",
    updated_at: new Date().toISOString(),
    active_provider: "openai-codex",
    providers: {
      "openai-codex": {
        tokens: {
          access_token: bossJwt,
          refresh_token: "REFRESH_BOSS",
        },
        last_refresh: new Date().toISOString(),
        auth_mode: "chatgpt",
      },
    },
  });
  fs.mkdirSync(consumerHermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(consumerHermesHome, "config.yaml"),
    "model:\n  provider: openai-codex\n  default: gpt-5.4\nagent:\n  reasoning_effort: xhigh\ncwd: /tmp/product-growth\n",
    "utf8",
  );
  fs.writeFileSync(
    path.join(consumerHermesHome, ".env"),
    "SLACK_BOT_TOKEN=xoxb-product\nSLACK_APP_TOKEN=xapp-product\nMESSAGING_CWD=/tmp/product-growth\n",
    "utf8",
  );

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "old-source",
          importedAt: new Date(0).toISOString(),
          labels: ["boss", "qa"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
        lastAppliedAt: new Date().toISOString(),
        lastSelectionReceipt: {
          action: "codex_use",
          status: "activated",
          label: "boss",
          observedAt: new Date().toISOString(),
        },
        lastWatchReceipt: {
          action: "codex_watch",
          status: "noop",
          observedAt: new Date().toISOString(),
          currentLabelBefore: "boss",
          currentLabelAfter: "boss",
        },
      },
      piCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
        lastAppliedAt: new Date().toISOString(),
        lastSelectionReceipt: {
          action: "pi_use",
          status: "activated",
          label: "boss",
          observedAt: new Date().toISOString(),
        },
      },
      productGrowthHermes: {
        hermesHome: consumerHermesHome,
        workspaceDir: "/tmp/product-growth",
        workspaceContextPath: "/tmp/product-growth/.hermes.md",
        activeLabel: "boss",
        expectedProvider: "openai-codex",
        expectedModel: "gpt-5.4",
        lastAppliedAt: new Date().toISOString(),
        lastApplyReceipt: {
          action: "sync_product_growth_hermes",
          status: "applied",
          observedAt: new Date().toISOString(),
          label: "boss",
        },
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.accounts.boss, undefined);
  assert.equal(consumerState.credentials["openai-codex"].boss, undefined);
  assert.equal(consumerState.targets.codexCli.activeLabel, undefined);
  assert.equal(consumerState.targets.codexCli.expectedAccountId, undefined);
  assert.equal(consumerState.targets.codexCli.lastAppliedAt, undefined);
  assert.equal(consumerState.targets.codexCli.lastSelectionReceipt, undefined);
  assert.equal(consumerState.targets.codexCli.lastWatchReceipt, undefined);
  assert.equal(consumerState.targets.piCli.activeLabel, undefined);
  assert.equal(consumerState.targets.piCli.expectedAccountId, undefined);
  assert.equal(consumerState.targets.piCli.lastAppliedAt, undefined);
  assert.equal(consumerState.targets.piCli.lastSelectionReceipt, undefined);
  assert.equal(consumerState.targets.productGrowthHermes, undefined);
  assert.equal(consumerState.targets.hermes, undefined);
  assert.equal(fs.existsSync(path.join(consumerHome, ".codex", "auth.json")), false);
  assert.equal(fs.existsSync(path.join(consumerHermesHome, "auth.json")), true);
  assert.equal(fs.existsSync(path.join(consumerHermesHome, "config.yaml")), true);
  const piAuth = JSON.parse(fs.readFileSync(path.join(consumerHome, ".pi", "agent", "auth.json"), "utf8"));
  assert.deepEqual(piAuth, {});
  const hermesEnv = fs.readFileSync(path.join(consumerHermesHome, ".env"), "utf8");
  assert.match(hermesEnv, /SLACK_BOT_TOKEN=xoxb-product/);
  assert.match(hermesEnv, /SLACK_APP_TOKEN=xapp-product/);
  assert.match(hermesEnv, /MESSAGING_CWD=\/tmp\/product-growth/);
});

test("readHermesHomeTokenUsage and refreshHermesHomeDemandLedger import Hermes state.db session counters", () => {
  const home = mkTempHome();
  const now = Date.parse("2026-03-21T12:00:00Z");
  const recent = now / 1000 - 60;
  const stale = now / 1000 - 10 * 24 * 60 * 60;
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
        hermesFleet: {
          demandByHome: {
            agent_removed: {
              updatedAt: new Date(now - 3600_000).toISOString(),
              lookbackDays: 7,
              source: "hermes-session-tokens",
              inputTokens: 999,
              outputTokens: 999,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              reasoningTokens: 0,
              totalTokens: 1998,
              demandWeight: 1998,
            },
          },
        },
      },
      anthropic: { history: [] },
    },
  };

  writeHermesStateDb(home, "agent_heavy", [
    { id: "s1", startedAt: recent, inputTokens: 120, outputTokens: 30, cacheReadTokens: 20, reasoningTokens: 10 },
    { id: "s2", startedAt: recent, inputTokens: 60, outputTokens: 10 },
    { id: "stale", startedAt: stale, inputTokens: 999, outputTokens: 999, cacheReadTokens: 999 },
  ]);
  writeHermesStateDb(home, "agent_cold", [
    { id: "s1", startedAt: recent, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, reasoningTokens: 0 },
  ]);

  const usage = readHermesHomeTokenUsage({ homeDir: home, homeId: "agent_heavy", now, lookbackDays: 7 });
  assert.equal(usage.totalTokens, 250);
  assert.equal(usage.inputTokens, 180);
  assert.equal(usage.outputTokens, 40);
  assert.equal(usage.cacheReadTokens, 20);
  assert.equal(usage.reasoningTokens, 10);

  const refreshed = refreshHermesHomeDemandLedger({
    state,
    homeDir: home,
    homes: [{ homeId: "agent_heavy" }, { homeId: "agent_cold" }],
    now,
    lookbackDays: 7,
  });

  assert.equal(refreshed.allocationMode, "demand_weighted");
  assert.deepEqual(state.pool.openaiCodex.hermesFleet.demandByHome.agent_heavy, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "hermes-session-tokens",
    inputTokens: 180,
    outputTokens: 40,
    cacheReadTokens: 20,
    cacheWriteTokens: 0,
    reasoningTokens: 10,
    totalTokens: 250,
    demandWeight: 250,
  });
  assert.deepEqual(state.pool.openaiCodex.hermesFleet.demandByHome.agent_cold, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "cold-start-equal-share",
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    totalTokens: 0,
    demandWeight: 250,
  });
  // Removed Hermes homes are no longer allocator inputs. Refresh must prune their
  // stale demand rows so future rebalance/status projections do not count ghost load.
  assert.equal(state.pool.openaiCodex.hermesFleet.demandByHome.agent_removed, undefined);
  assert.equal(refreshed.demandByHome.agent_removed, undefined);
});

test("planWeightedHermesRebalance supports many-to-one cold-start spread without inventing a second allocator", () => {
  const plan = planWeightedHermesRebalance({
    configuredHomes: ["agent_a", "agent_b", "agent_c"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 40 }, { kind: "secondary", usedPercent: 40 }],
      },
    },
    homeDemand: {},
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.equal(plan.allocationMode, "cold_start_equal_share");
  assert.deepEqual(plan.assignments, {
    agent_a: "boss",
    agent_b: "qa",
    agent_c: "boss",
  });
  assert.deepEqual(plan.unchanged[0], {
    homeId: "agent_a",
    label: "boss",
    reason: "kept_current_hysteresis",
    demandWeight: 1,
    demandSource: "cold-start-equal-share",
    targetDemandWeight: 1.8,
    projectedDemandWeight: 1,
  });
});
