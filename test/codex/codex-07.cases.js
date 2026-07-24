import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

function buildCodexCredential({ jwt, accountId, expiresAt = new Date(Date.now() + 2 * 24 * 3600_000).toISOString() }) {
  return {
    access: jwt,
    refresh: `REFRESH_${accountId}`,
    idToken: jwt,
    expiresAt,
    accountId,
  };
}

function writeExplicitCodexState({ home, accounts, credentials, labels = Object.keys(accounts) }) {
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts,
    credentials: {
      "openai-codex": credentials?.["openai-codex"] ?? {},
      anthropic: credentials?.anthropic ?? {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels,
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });
  return statePath;
}

test("codex use picks the eligible label with the lowest current 5h usage", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
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

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      pro2: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_qa",
        },
        pro2: {
          access: pro2Jwt,
          refresh: "REFRESH_PRO2",
          idToken: pro2Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_pro2",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["qa", "pro2"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
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
      const primaryUsedPercent = accountId === "acct_qa" ? 0 : 2;
      const secondaryUsedPercent = accountId === "acct_qa" ? 92 : 1;
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
    assert.equal(result.activated.receipt.label, "qa");
    assert.deepEqual(result.activated.receipt.reasons, ["lowest_5h_used"]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "qa");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "qa");
    assert.deepEqual(updatedState.targets.codexCli.lastSelectionReceipt.reasons, ["lowest_5h_used"]);
});

test("back-to-back codex use runs resolve equal usage deterministically", async () => {
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
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss", "qa"],
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

    const first = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));
    const second = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));

    assert.equal(first.activated.status, "activated");
    assert.equal(first.activated.receipt.label, "boss");
    assert.deepEqual(first.activated.receipt.reasons, ["lowest_5h_used"]);
    assert.equal(second.activated.receipt.label, "boss");
    assert.equal(second.activated.receipt.previousLabel, "boss");
    assert.deepEqual(second.activated.receipt.reasons, ["lowest_5h_used"]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
});

test("codex use <label> activates the requested label without probing usage", async () => {
  const home = mkTempHome();
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const pro6Jwt = makeFakeJwt({
    email: "pro6@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro6",
      chatgpt_plan_type: "pro",
    },
  });
  const statePath = writeExplicitCodexState({
    home,
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      pro6: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: buildCodexCredential({ jwt: bossJwt, accountId: "acct_boss" }),
        pro6: buildCodexCredential({ jwt: pro6Jwt, accountId: "acct_pro6" }),
      },
    },
  });
  const fetchImpl = async () => {
    throw new Error("explicit Codex activation should not probe usage");
  };

    const out = JSON.parse(await runCli(["codex", "use", "pro6", "--home", home], { fetchImpl }));
    assert.equal(out.ok, true);
    assert.equal(out.activated.status, "activated");
    assert.equal(out.activated.receipt.label, "pro6");
    assert.equal(out.activated.receipt.accountId, "acct_pro6");
    assert.equal(out.activated.receipt.explicit, true);
    assert.deepEqual(out.activated.receipt.reasons, ["explicit_label"]);
    assert.equal(out.activated.receipt.authPath, path.join(home, ".codex", "auth.json"));

    const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    assert.equal(auth.tokens.account_id, "acct_pro6");

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "pro6");
    assert.equal(updatedState.targets.codexCli.expectedAccountId, "acct_pro6");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.explicit, true);
});

test("plain codex use selects the lowest usage after an explicit activation", async () => {
  const home = mkTempHome();
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const pro6Jwt = makeFakeJwt({
    email: "pro6@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_pro6",
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
  writeExplicitCodexState({
    home,
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      pro6: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: buildCodexCredential({ jwt: bossJwt, accountId: "acct_boss" }),
        pro6: buildCodexCredential({ jwt: pro6Jwt, accountId: "acct_pro6" }),
        qa: buildCodexCredential({ jwt: qaJwt, accountId: "acct_qa" }),
      },
    },
  });
  const fetchImpl = async (url, init) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const accountId =
        init && init.headers && typeof init.headers["ChatGPT-Account-Id"] === "string"
          ? init.headers["ChatGPT-Account-Id"]
          : "";
      const secondaryUsedPercent = accountId === "acct_qa" ? 10 : accountId === "acct_pro6" ? 40 : 60;
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

    const explicit = JSON.parse(await runCli(["codex", "use", "pro6", "--home", home], {
      fetchImpl: async () => {
        throw new Error("explicit Codex activation should not probe usage");
      },
    }));
    const rotated = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));

    assert.equal(explicit.activated.receipt.label, "pro6");
    assert.equal(rotated.activated.receipt.previousLabel, "pro6");
    assert.equal(rotated.activated.receipt.label, "qa");
    assert.deepEqual(rotated.activated.receipt.reasons, ["lowest_5h_used"]);
});

test("codex use <label> records a blocked receipt for invalid explicit labels", async () => {
  const home = mkTempHome();
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const expiredJwt = makeFakeJwt({
    email: "expired@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_expired",
      chatgpt_plan_type: "pro",
    },
  });
  const statePath = writeExplicitCodexState({
    home,
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      claudalyst: { provider: "anthropic", reauth: { mode: "native-claude" } },
      expired: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: buildCodexCredential({ jwt: bossJwt, accountId: "acct_boss" }),
        expired: buildCodexCredential({
          jwt: expiredJwt,
          accountId: "acct_expired",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
        }),
      },
      anthropic: {},
    },
  });
  const fetchImpl = async () => {
    throw new Error("explicit Codex activation should not probe usage");
  };

    const unknown = await runCliWithExitCode(["codex", "use", "missing", "--home", home], { fetchImpl });
    const wrongProvider = await runCliWithExitCode(["codex", "use", "claudalyst", "--home", home], { fetchImpl });
    const expired = await runCliWithExitCode(["codex", "use", "expired", "--home", home], { fetchImpl });

    const parsedUnknown = JSON.parse(unknown.stdout);
    const parsedWrongProvider = JSON.parse(wrongProvider.stdout);
    const parsedExpired = JSON.parse(expired.stdout);

    assert.equal(unknown.exitCode, 1);
    assert.equal(parsedUnknown.ok, false);
    assert.equal(parsedUnknown.activated.receipt.explicit, true);
    assert.equal(parsedUnknown.activated.receipt.blockers[0].reason, "unknown_label");

    assert.equal(wrongProvider.exitCode, 1);
    assert.equal(parsedWrongProvider.ok, false);
    assert.equal(parsedWrongProvider.activated.receipt.blockers[0].reason, "wrong_provider");

    assert.equal(expired.exitCode, 1);
    assert.equal(parsedExpired.ok, false);
    assert.equal(parsedExpired.activated.receipt.blockers[0].reason, "expired_credentials");

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "expired");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.status, "blocked");
});

test("codex use reports the inferred active label but does not keep it on an equal-usage tie", async () => {
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

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: qaJwt,
      access_token: qaJwt,
      refresh_token: "REFRESH_QA",
      account_id: "acct_qa",
    },
    last_refresh: new Date().toISOString(),
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
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss", "qa"],
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

    const result = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));
    assert.equal(result.activated.receipt.previousLabel, "qa");
    assert.equal(result.activated.receipt.label, "boss");
    assert.deepEqual(result.activated.receipt.reasons, ["lowest_5h_used"]);
});
