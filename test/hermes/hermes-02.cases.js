import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { writeHermesAuthFile } from "../helpers/hermes.js";

function writeSingleCodexHermesState(statePath, { label = "product", jwt, refresh = "refresh-product", accountId = "acct_product" }) {
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      [label]: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        [label]: {
          access: jwt,
          refresh,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId,
          idToken: jwt,
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    pool: { openaiCodex: { history: [], agentDemand: {} }, anthropic: { history: [] } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
  });
}

test("auth write hermes fails loud when the Hermes auth parent directory is missing", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "product@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_product",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      product: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        product: {
          access: fakeJwt,
          refresh: "refresh-product",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_product",
          idToken: fakeJwt,
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
      },
      anthropic: {
        history: [],
      },
    },
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
  });

  await assert.rejects(
    () => runCli(
      [
        "auth",
        "write",
        "hermes",
        "product",
        "--auth-file",
        path.join(home, ".hermes", "profiles", "agent_product_growth", "auth.json"),
        "--home",
        home,
      ],
    ),
    /Hermes auth parent directory does not exist/,
  );
});

test("auth write hermes refuses non-auth.json target paths without touching the file", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "product@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_product",
      chatgpt_plan_type: "pro",
    },
  });
  const hermesHome = path.join(home, ".hermes", "profiles", "agent_product_growth");
  const unsafePath = path.join(hermesHome, "tokens.json");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(unsafePath, "sentinel", "utf8");
  writeSingleCodexHermesState(statePath, { jwt: fakeJwt });

  await assert.rejects(
    () => runCli(["auth", "write", "hermes", "product", "--auth-file", unsafePath, "--home", home]),
    /Refusing Hermes auth write to non-auth\.json path/,
  );

  // The exact auth.json basename is the ownership boundary for direct Hermes writes.
  // A sibling runtime file must not be accepted or rewritten by AIM.
  assert.equal(fs.readFileSync(unsafePath, "utf8"), "sentinel");
  assert.equal(fs.existsSync(path.join(hermesHome, "auth.json")), false);
});

test("auth write hermes refuses malformed current auth without replacing it", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "product@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_product",
      chatgpt_plan_type: "pro",
    },
  });
  const hermesHome = path.join(home, ".hermes", "profiles", "agent_product_growth");
  const authPath = path.join(hermesHome, "auth.json");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(authPath, "{not-json", "utf8");
  writeSingleCodexHermesState(statePath, { jwt: fakeJwt });

  await assert.rejects(
    () => runCli(["auth", "write", "hermes", "product", "--auth-file", authPath, "--home", home]),
    /Failed to read current Hermes auth\.json before write/,
  );

  // Malformed auth may still contain non-AIM provider material after manual repair.
  // The safe direct-write behavior is to fail before overwriting the existing file.
  assert.equal(fs.readFileSync(authPath, "utf8"), "{not-json");
});

test("status --json maps drifted Hermes homes by account id and marks them for sync", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const staleJwt = makeFakeJwt({
    email: "ads@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_ads",
      chatgpt_plan_type: "pro",
    },
  });
  const freshJwt = makeFakeJwt({
    email: "ads@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_ads",
      chatgpt_plan_type: "pro",
    },
    sub: "fresh",
  });

  writeHermesAuthFile(home, "agent_ads", {
    accessToken: staleJwt,
    refreshToken: "OLD_REFRESH",
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      ads: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        ads: {
          access: freshJwt,
          refresh: "NEW_REFRESH",
          idToken: freshJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_ads",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: { source: "agents@localhost", importedAt: new Date().toISOString(), labels: ["ads"] } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
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
            secondary_window: {
              used_percent: 5,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const statusJson = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    assert.equal(statusJson.hermesFleet.homeCount, 1);
    assert.equal(statusJson.hermesFleet.mappedHomeCount, 1);
    assert.equal(statusJson.hermesFleet.warningHomeCount, 1);
    assert.equal(statusJson.hermesFleet.homes[0].currentLabel, "ads");
    assert.equal(statusJson.hermesFleet.homes[0].matchMode, "account_id");
    assert.equal(statusJson.hermesFleet.homes[0].authDrifted, true);
    assert.equal(statusJson.hermesFleet.homes[0].needsSync, true);
    assert.equal(statusJson.hermesFleet.homes[0].warnings[0].kind, "hermes_home_auth_drifted");
});

test("status --json marks Hermes homes missing credential_pool for sync", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "product@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_product",
      chatgpt_plan_type: "pro",
    },
  });
  writeHermesAuthFile(home, "agent_product_growth", {
    accessToken: fakeJwt,
    refreshToken: "refresh-product",
    credentialPool: null,
  });
  writeSingleCodexHermesState(statePath, { jwt: fakeJwt });

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
            secondary_window: {
              used_percent: 5,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  const statusJson = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));

  // Hermes auth writes require one coherent device-code pool entry. A home with
  // matching provider tokens but no pool entry still needs sync so watch/rebalance can repair runtime auth.
  assert.equal(statusJson.hermesFleet.homes[0].currentLabel, "product");
  assert.equal(statusJson.hermesFleet.homes[0].authDrifted, false);
  assert.equal(statusJson.hermesFleet.homes[0].needsSync, true);
  assert.equal(statusJson.hermesFleet.homes[0].warnings[0].kind, "hermes_home_auth_needs_sync");
  assert.equal(statusJson.hermesFleet.warningHomeCount, 1);
});

test("sync hermes fails loud with migration guidance to the auth-only Hermes command", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {},
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
      },
      anthropic: {
        history: [],
      },
    },
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
  });

  await assert.rejects(
    () => runCli(["sync", "hermes", "product-growth", "product", "--home", home]),
    /`aim sync hermes` was removed/,
  );
});

test("rebalance hermes resyncs same-label drifted homes instead of treating them as unchanged", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const staleJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const freshJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
    sub: "fresh",
  });

  writeHermesAuthFile(home, "agent_boss", {
    accessToken: staleJwt,
    refreshToken: "OLD_REFRESH",
    credentialPool: {
      "openai-codex": [
        {
          id: "pool01",
          label: "device_code",
          auth_type: "oauth",
          priority: 0,
          source: "device_code",
          access_token: staleJwt,
          refresh_token: "OLD_REFRESH",
          last_status: "exhausted",
          last_status_at: 123,
          last_error_code: 401,
          base_url: "https://chatgpt.com/backend-api/codex",
          last_refresh: "2026-03-29T00:00:00.000Z",
          request_count: 3,
        },
      ],
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: freshJwt,
          refresh: "NEW_REFRESH",
          idToken: freshJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: { source: "agents@localhost", importedAt: new Date().toISOString(), labels: ["boss"] } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {}, hermesFleet: { demandByHome: {} } }, anthropic: { history: [] } },
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

    const result = JSON.parse(await runCli(["rebalance", "hermes", "--home", home], { fetchImpl }));
    assert.equal(result.ok, true);
    assert.equal(result.rebalanced.status, "applied");
    assert.deepEqual(result.rebalanced.receipt.moved, []);
    assert.deepEqual(result.rebalanced.receipt.resynced.map((entry) => entry.homeId), ["agent_boss"]);
    assert.deepEqual(result.rebalanced.receipt.unchanged, []);

    const authJson = JSON.parse(fs.readFileSync(path.join(home, ".hermes", "profiles", "agent_boss", "auth.json"), "utf8"));
    assert.equal(authJson.providers["openai-codex"].tokens.refresh_token, "NEW_REFRESH");
    assert.equal(authJson.credential_pool["openai-codex"][0].refresh_token, "NEW_REFRESH");
    assert.equal(authJson.credential_pool["openai-codex"][0].last_status, null);
    assert.equal(authJson.credential_pool["openai-codex"][0].last_status_at, null);
    assert.equal(authJson.credential_pool["openai-codex"][0].last_error_code, null);
    assert.equal(authJson.credential_pool["openai-codex"][0].request_count, 0);

    const statusJson = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    assert.equal(statusJson.hermesFleet.homes[0].matchMode, "token_pair");
    assert.equal(statusJson.hermesFleet.homes[0].authDrifted, false);
    assert.equal(statusJson.hermesFleet.homes[0].needsSync, false);
    assert.equal(statusJson.hermesFleet.warningHomeCount, 0);
});
