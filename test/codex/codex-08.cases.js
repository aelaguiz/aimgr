import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("repeated codex use runs stay on the same label when headroom ties", async () => {
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
      codexCli: {},
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

    const labels = [];
    for (let i = 0; i < 4; i += 1) {
      const result = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));
      labels.push(result.activated.receipt.label);
    }

    assert.deepEqual(labels, ["pro1", "pro1", "pro1", "pro1"]);
});

test("codex use activates the label with the most weekly headroom", async () => {
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
      const primaryUsedPercent = accountId === "acct_pro1" ? 12 : accountId === "acct_pro2" ? 0 : 5;
      const secondaryUsedPercent = accountId === "acct_pro1" ? 75 : accountId === "acct_pro2" ? 6 : 24;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: primaryUsedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
            secondary_window: {
              used_percent: secondaryUsedPercent,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 6 * 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const result = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));
    assert.equal(result.ok, true);
    assert.equal(result.activated.status, "activated");
    assert.equal(result.activated.receipt.label, "pro2");
    assert.deepEqual(result.activated.receipt.reasons, ["lowest_weekly_used_over_5h_gate"]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "pro2");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "pro2");
    assert.deepEqual(updatedState.targets.codexCli.lastSelectionReceipt.reasons, ["lowest_weekly_used_over_5h_gate"]);
});

test("codex use skips expired labels and activates the next eligible pool account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
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

  writeJson(statePath, {
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
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
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
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
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

    const result = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.deepEqual(result.activated.receipt.reasons, ["lowest_weekly_used_over_5h_gate"]);
    assert.equal(updatedState.targets.codexCli.activeLabel, "qa");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "qa");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "activated",
      label: "qa",
      accountId: "acct_qa",
      hadSpareEligibleCapacity: false,
      reason: "next_best",
    });
});
