import test from "node:test";
import assert from "node:assert/strict";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { installFakeOpenclaw, readFakeOpenclawRestarts, readFakeOpenclawSessionPatches } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson, writeOpenclawAuthStore, writeOpenclawSessionsStore } from "../helpers/files.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";

test("Redis-backed rebalance openclaw runs the real sync path and then settles to noop on repeat", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
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
      openclaw: {
        assignments: { agent_boss: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: {
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai-codex:qa",
      updatedAt: 1,
    },
  });
  await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const fetchImpl = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 10 : 88;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    await withEnv(
      {
        HOME: home,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
      async () => {
        const firstOut = await runCli(["rebalance", "openclaw"], { fetchImpl });
        const first = JSON.parse(firstOut);
        assert.equal(first.ok, true);
        assert.equal(first.rebalanced.status, "applied");
        assert.equal(readFakeOpenclawRestarts(home).length, 1);
        assert.equal(readFakeOpenclawSessionPatches(home).length, 0);

        const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
        assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.cleanupMode, "disk");

        const mainStore = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"), "utf8"),
        );
        assert.equal(mainStore.order?.["openai-codex"], undefined);
        assert.equal(mainStore.lastGood?.["openai-codex"], undefined);

        const sessions = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_boss", "sessions", "sessions.json"), "utf8"),
        );
        assert.equal(sessions.s1.modelProvider, undefined);
        assert.equal(sessions.s1.model, undefined);
        assert.equal(sessions.s1.providerOverride, undefined);
        assert.equal(sessions.s1.modelOverride, undefined);
        assert.equal(sessions.s1.authProfileOverride, undefined);

        const secondOut = await runCli(["rebalance", "openclaw"], { fetchImpl });
        const second = JSON.parse(secondOut);
        assert.equal(second.ok, true);
        assert.equal(second.rebalanced.status, "noop");
        assert.equal(readFakeOpenclawRestarts(home).length, 1);
      },
    );
});

test("Redis-backed rebalance openclaw reports blocked when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

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
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_boss",
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
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });
  await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });

  const result = await withEnv(
    {
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
    () => runCliWithExitCode(["rebalance", "openclaw"]),
  );

  assert.equal(result.exitCode, 1);
  assert.equal(readFakeOpenclawRestarts(home).length, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rebalanced.status, "blocked");
  assert.deepEqual(parsed.rebalanced.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

  const updatedState = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
  assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "blocked");
  assert.deepEqual(updatedState.targets.openclaw.lastApplyReceipt.blockers, [{ reason: "no_eligible_pool_account" }]);
});
