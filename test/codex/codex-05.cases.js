import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("codex watch --once keeps weighted selection when the active label drops below the 5h remaining threshold", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const pro1Jwt = makeFakeJwt({
    email: "pro1@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro1",
      chatgpt_plan_type: "pro",
    },
  });
  const pro2Jwt = makeFakeJwt({
    email: "pro2@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro2",
      chatgpt_plan_type: "pro",
    },
  });
  const pro3Jwt = makeFakeJwt({
    email: "pro3@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro3",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: pro1Jwt,
      access_token: pro1Jwt,
      refresh_token: "REFRESH_PRO1",
      account_id: "acct_pro1",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      pro2: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      pro3: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        pro1: {
          access: pro1Jwt,
          refresh: "REFRESH_PRO1",
          idToken: pro1Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro1",
        },
        pro2: {
          access: pro2Jwt,
          refresh: "REFRESH_PRO2",
          idToken: pro2Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro2",
        },
        pro3: {
          access: pro3Jwt,
          refresh: "REFRESH_PRO3",
          idToken: pro3Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro3",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["pro1", "pro2", "pro3"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "pro1",
        expectedAccountId: "acct_pro1",
        lastAppliedAt: new Date().toISOString(),
      },
    },
    pool: { openaiCodex: { history: [] } },
  });
  const fetchImpl = async (url, init) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const accountId =
        init && init.headers && typeof init.headers["ChatGPT-Account-Id"] === "string"
          ? init.headers["ChatGPT-Account-Id"]
          : "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: accountId === "acct_pro1" ? 85 : accountId === "acct_pro2" ? 5 : 4,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_pro1" ? 70 : accountId === "acct_pro2" ? 30 : 2,
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
    assert.equal(result.watched.status, "activated");
    assert.equal(result.watched.receipt.currentLabelBefore, "pro1");
    assert.equal(result.watched.receipt.currentLabelAfter, "pro3");
    assert.equal(result.watched.receipt.primaryRemainingPctBefore, 15);
    assert.equal(result.watched.receipt.triggeredSelection, true);
    assert.equal(result.watched.receipt.selectionReceipt.label, "pro3");
    assert.deepEqual(result.watched.receipt.selectionReceipt.reasons, ["lowest_weekly_used_over_5h_gate"]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "pro3");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "pro3");
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.status, "activated");
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.currentLabelBefore, "pro1");
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.currentLabelAfter, "pro3");

    const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    assert.equal(auth.tokens.account_id, "acct_pro3");
});

test("codex watch --once blocks when the active target usage cannot be read", async () => {
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
        ok: false,
        status: 401,
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  const result = await runCliWithExitCode(["codex", "watch", "--once", "--home", home], { fetchImpl });
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.watched.status, "blocked");
  assert.equal(parsed.watched.receipt.currentLabelBefore, "boss");
  assert.equal(parsed.watched.receipt.triggeredSelection, false);
  // A token-expired usage response means watch cannot safely evaluate the active 5h window.
  // It must leave the current auth in place and report the reauth cause instead of rotating blindly.
  assert.equal(parsed.watched.receipt.blockers[0].reason, "active_target_usage_unavailable");
  assert.equal(parsed.watched.receipt.blockers[0].status, 401);
  assert.equal(parsed.watched.receipt.blockers[0].tokenExpired, true);

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
  assert.equal(updatedState.targets.codexCli.lastWatchReceipt.status, "blocked");
  assert.equal(updatedState.targets.codexCli.lastSelectionReceipt, undefined);
  const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
});

test("codex watch loop reuses the one-shot path on every interval", async () => {
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
              used_percent: 10,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: 10,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const stdout = await runCli(
      ["codex", "watch", "--interval-seconds", "1", "--home", home],
      {
        fetchImpl,
        watchLoopMaxIterations: 2,
        sleepImpl: async () => {},
      },
    );
    assert.equal((stdout.match(/"action": "codex_watch"/g) ?? []).length, 2);
    assert.equal((stdout.match(/"triggeredSelection": false/g) ?? []).length, 2);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.lastWatchReceipt.status, "noop");
    assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
});

test("codex use fails loudly before Redis migration imports pool labels", async () => {
  const home = mkTempHome();
  await assert.rejects(
    () => runCli(["codex", "use", "--home", home]),
    /Complete `aim redis migrate apply --plan <plan\.json> --confirm-breaking-cutover` before using Codex targets/,
  );
});
