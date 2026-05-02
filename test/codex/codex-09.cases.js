import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { extractSessionModelRefFromEntry } from "../../src/openclaw/sessions.js";
import { pickNextCodexUseRoundRobinLabel } from "../../src/pool/ranking.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("codex use refuses non-file-backed Codex homes", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
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
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    'cli_auth_credentials_store = "auto"\n',
    "utf8",
  );

  await assert.rejects(
    () => runCli(["codex", "use", "--home", home]),
    /Managed Codex activation requires file-backed auth storage/,
  );
});

test("sync codex refuses to clear a stale activation from a non-file-backed Codex home", async () => {
  const home = mkTempHome();
  const authorityHome = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });
  const codexHome = path.join(home, ".codex");
  const authPath = path.join(codexHome, "auth.json");

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "config.toml"), 'cli_auth_credentials_store = "keyring"\n', "utf8");
  writeJson(authPath, {
    sentinel: "must-not-delete",
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "BOSS_REFRESH",
      account_id: "acct_boss",
    },
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        qa: {
          access: qaJwt,
          refresh: "QA_REFRESH",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, piCli: {}, claudeCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
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
          refresh: "BOSS_REFRESH",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: authorityStatePath,
          importedAt: new Date().toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date().toISOString(),
              baseAccountId: "acct_boss",
              dirtyLocal: false,
            },
          },
        },
        anthropic: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
        lastAppliedAt: new Date().toISOString(),
      },
      piCli: {},
      claudeCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["sync", "codex", "--from", authorityStatePath, "--home", home]),
    /Managed Codex activation requires file-backed auth storage/,
  );

  // Sync cleanup is allowed to remove AIM-owned file-backed auth, but a keyring/auto
  // Codex home is outside AIM's managed write contract and must be left untouched.
  assert.equal(fs.existsSync(authPath), true);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).sentinel, "must-not-delete");
  const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persistedState.targets.codexCli.activeLabel, "boss");
  assert.equal(persistedState.credentials["openai-codex"].boss.refresh, "BOSS_REFRESH");
});

test("pi use clears stale managed openai-codex auth and preserves other Pi providers when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const piAgentDir = path.join(home, ".pi-test", "agent");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(piAgentDir, "auth.json"), {
    anthropic: {
      type: "api_key",
      key: "ANTHROPIC_KEY",
    },
    "openai-codex": {
      type: "oauth",
      access: fakeJwt,
      refresh: "REFRESH_TOKEN",
      expires: Date.now() + 3600_000,
      accountId: "acct_123",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          idToken: fakeJwt,
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
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
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      piCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
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
              used_percent: 5,
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
        PI_CODING_AGENT_DIR: piAgentDir,
      },
      async () => {
        const result = await runCliWithExitCode(["pi", "use", "--home", home], { fetchImpl });
        assert.equal(result.exitCode, 1);
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.activated.status, "blocked");
        assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

        const auth = JSON.parse(fs.readFileSync(path.join(piAgentDir, "auth.json"), "utf8"));
        assert.deepEqual(auth, {
          anthropic: {
            type: "api_key",
            key: "ANTHROPIC_KEY",
          },
        });

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.piCli.activeLabel, undefined);
        assert.equal(updatedState.targets.piCli.expectedAccountId, undefined);
        assert.equal(updatedState.targets.piCli.lastAppliedAt, undefined);
        assert.equal(updatedState.targets.piCli.lastSelectionReceipt.status, "blocked");

        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.piCli.activeLabel, null);
        assert.equal(status.piCli.readback.exists, true);
        assert.equal(status.piCli.readback.providerEntryPresent, false);
      },
    );
});

test("pi use refuses stale cleanup when Pi auth is malformed", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const piAgentDir = path.join(home, ".pi-test", "agent");
  const authPath = path.join(piAgentDir, "auth.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  fs.mkdirSync(path.dirname(authPath), { recursive: true });
  fs.writeFileSync(authPath, "{not-json", "utf8");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          idToken: fakeJwt,
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
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
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      piCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
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
              used_percent: 5,
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
        PI_CODING_AGENT_DIR: piAgentDir,
      },
      async () => {
        await assert.rejects(
          () => runCli(["pi", "use", "--home", home], { fetchImpl }),
          /Refusing to mutate unreadable Pi auth file/,
        );

        // Pi auth.json may contain provider entries outside AIM's ownership.
        // If cleanup cannot parse the file, the safe outcome is no file or target metadata mutation.
        assert.equal(fs.readFileSync(authPath, "utf8"), "{not-json");
        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.piCli.activeLabel, "boss");
        assert.equal(updatedState.targets.piCli.expectedAccountId, "acct_123");
        assert.equal(updatedState.targets.piCli.lastSelectionReceipt, undefined);
      },
    );
});

test("pickNextCodexUseRoundRobinLabel rotates to the next eligible label in pool order", () => {
  const picked = pickNextCodexUseRoundRobinLabel({
    poolLabels: ["pro1", "pro2", "pro3"],
    eligibleLabels: ["pro1", "pro2", "pro3"],
    currentLabel: "pro1",
  });

  assert.deepEqual(picked, {
    label: "pro2",
    keptCurrent: false,
    reasons: ["round_robin_next_eligible"],
  });
});

test("pickNextCodexUseRoundRobinLabel bootstraps to the first eligible label when the current label is unavailable", () => {
  const picked = pickNextCodexUseRoundRobinLabel({
    poolLabels: ["boss", "qa", "zzz"],
    eligibleLabels: ["qa", "zzz"],
    currentLabel: "boss",
  });

  assert.deepEqual(picked, {
    label: "qa",
    keptCurrent: false,
    reasons: ["round_robin_bootstrap_first_eligible"],
  });
});

test("pickNextCodexUseRoundRobinLabel keeps the only eligible label", () => {
  const picked = pickNextCodexUseRoundRobinLabel({
    poolLabels: ["boss", "qa"],
    eligibleLabels: ["qa"],
    currentLabel: "qa",
  });

  assert.deepEqual(picked, {
    label: "qa",
    keptCurrent: true,
    reasons: ["round_robin_single_eligible"],
  });
});

test("extractSessionModelRefFromEntry prefers runtime over override", () => {
  const parsed = extractSessionModelRefFromEntry({
    modelProvider: "openai",
    model: "gpt-5.4",
    providerOverride: "openai-codex",
    modelOverride: "gpt-5.4",
  });
  assert.deepEqual(parsed, { source: "runtime", provider: "openai", model: "gpt-5.4" });
});
