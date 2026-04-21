import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("codex use writes auth.json and status reports active imported label", async () => {
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

    await runCli(["codex", "use", "--home", home], { fetchImpl });

    const authPath = path.join(home, ".codex", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(auth.OPENAI_API_KEY, null);
    assert.equal(auth.tokens.account_id, "acct_123");
    assert.equal(auth.tokens.access_token, fakeJwt);
    assert.equal(auth.tokens.id_token, fakeJwt);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.status, "activated");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "activated",
      label: "boss",
      accountId: "acct_123",
      hadSpareEligibleCapacity: false,
      reason: "next_best",
    });

    const out = await runCli(["status", "--json", "--home", home], { fetchImpl });
    const parsed = JSON.parse(out);
    assert.equal(parsed.codexCli.activeLabel, "boss");
    assert.equal(parsed.codexCli.source, "ssh://studio.local/~/.aimgr/secrets.json");
    assert.equal(parsed.codexCli.storeMode, "file");
    assert.equal(parsed.codexCli.actualAccountId, "acct_123");
    assert.equal(parsed.nextBestCandidate.label, "boss");
    assert.ok(parsed.warnings.every((warning) => !String(warning.kind).startsWith("codex_target_")));
});

test("codex use clears stale managed auth when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt,
      access_token: fakeJwt,
      refresh_token: "REFRESH_TOKEN",
      account_id: "acct_123",
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
      codexCli: {
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

    const result = await runCliWithExitCode(["codex", "use", "--home", home], { fetchImpl });
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.activated.status, "blocked");
    assert.equal(parsed.activated.receipt.previousLabel, "boss");
    assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, undefined);
    assert.equal(updatedState.targets.codexCli.expectedAccountId, undefined);
    assert.equal(updatedState.targets.codexCli.lastAppliedAt, undefined);
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.status, "blocked");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "blocked",
      reason: "no_eligible_pool_account",
      hadSpareEligibleCapacity: false,
    });
    assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), false);

    const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    assert.equal(status.codexCli.activeLabel, null);
    assert.equal(status.codexCli.readback.exists, false);
    assert.equal(status.codexCli.lastSelectionReceipt.status, "blocked");
});

test("codex use blocks instead of selecting a weekly-exhausted ready account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const cratejoyJwt = makeFakeJwt({
    email: "cratejoy@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_cratejoy",
      chatgpt_plan_type: "pro",
    },
  });
  const funCountryJwt = makeFakeJwt({
    email: "fun-country@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_fun_country",
      chatgpt_plan_type: "pro",
    },
  });
  const personalJwt = makeFakeJwt({
    email: "personal@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_personal",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: cratejoyJwt,
      access_token: cratejoyJwt,
      refresh_token: "REFRESH_CRATEJOY",
      account_id: "acct_cratejoy",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      amir_cratejoy_personal: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      amir_elaguizy_fun_country: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      amir_personal: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        amir_cratejoy_personal: {
          access: cratejoyJwt,
          refresh: "REFRESH_CRATEJOY",
          idToken: cratejoyJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_cratejoy",
        },
        amir_elaguizy_fun_country: {
          access: funCountryJwt,
          refresh: "REFRESH_FUN_COUNTRY",
          idToken: funCountryJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_fun_country",
        },
        amir_personal: {
          access: personalJwt,
          refresh: "REFRESH_PERSONAL",
          idToken: personalJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_personal",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["amir_cratejoy_personal", "amir_elaguizy_fun_country", "amir_personal"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "amir_cratejoy_personal",
        expectedAccountId: "acct_cratejoy",
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
              used_percent: 0,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 5 * 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_cratejoy" ? 99 : 100,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const result = await runCliWithExitCode(["codex", "use", "--home", home], { fetchImpl });
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.activated.status, "blocked");
    assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, undefined);
    assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), false);
});
