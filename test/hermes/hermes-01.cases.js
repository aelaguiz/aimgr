import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("auth write hermes writes auth.json only and leaves AIM state plus runtime files untouched", async () => {
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
  const hermesAuthPath = path.join(hermesHome, "auth.json");
  fs.mkdirSync(hermesHome, { recursive: true });
  fs.writeFileSync(
    path.join(hermesHome, ".env"),
    "SLACK_BOT_TOKEN=xoxb-product\nSLACK_APP_TOKEN=xapp-product\n",
    "utf8",
  );

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
  const beforeEnv = fs.readFileSync(path.join(hermesHome, ".env"), "utf8");

  const out = await runCli(
    ["auth", "write", "hermes", "product", "--auth-file", hermesAuthPath, "--home", home],
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.written.label, "product");
  assert.equal(parsed.written.status, "applied");
  assert.equal(parsed.written.authPath, hermesAuthPath);
  assert.equal(parsed.written.wrote.auth, true);

  const authJson = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8"));
  assert.equal(authJson.active_provider, "openai-codex");
  assert.equal(authJson.providers["openai-codex"].tokens.access_token, fakeJwt);
  assert.equal(authJson.providers["openai-codex"].tokens.refresh_token, "refresh-product");
  assert.equal(authJson.credential_pool["openai-codex"].length, 1);
  assert.equal(authJson.credential_pool["openai-codex"][0].source, "device_code");
  assert.equal(authJson.credential_pool["openai-codex"][0].auth_type, "oauth");
  assert.equal(authJson.credential_pool["openai-codex"][0].access_token, fakeJwt);
  assert.equal(authJson.credential_pool["openai-codex"][0].refresh_token, "refresh-product");
  assert.equal(authJson.credential_pool["openai-codex"][0].base_url, "https://chatgpt.com/backend-api/codex");
  assert.equal(authJson.credential_pool["openai-codex"][0].last_status, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].last_status_at, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].last_error_code, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].request_count, 0);
  assert.equal(fs.existsSync(path.join(hermesHome, "config.yaml")), false);
  assert.equal(fs.readFileSync(path.join(hermesHome, ".env"), "utf8"), beforeEnv);
  const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persistedState.targets.hermes, undefined);
  assert.equal(persistedState.targets.productGrowthHermes, undefined);
  assert.deepEqual(persistedState.targets.codexCli, {});
  assert.deepEqual(persistedState.targets.claudeCli, {});
  assert.deepEqual(persistedState.targets.piCli, {});
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
    if (u.includes("api.anthropic.com/api/oauth/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 0, resets_at: "2026-03-30T00:00:00Z" },
          seven_day: { utilization: 0, resets_at: "2026-04-01T00:00:00Z" },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const statusJson = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    assert.equal(statusJson.hermesFleet.homeCount, 1);
    assert.equal(statusJson.hermesFleet.mappedHomeCount, 1);
    assert.equal(statusJson.hermesFleet.warningHomeCount, 0);
    assert.equal(statusJson.hermesFleet.homes[0].homeId, "agent_product_growth");
    assert.equal(statusJson.hermesFleet.homes[0].currentLabel, "product");
    assert.equal(statusJson.warnings.some((warning) => String(warning?.kind ?? "").includes("hermes")), false);
});

test("auth write hermes preserves unrelated provider entries while updating the Codex provider entry", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "growth@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_growth",
      chatgpt_plan_type: "pro",
    },
  });
  const hermesHome = path.join(home, ".hermes", "profiles", "agent_growth_analyst");
  const hermesAuthPath = path.join(hermesHome, "auth.json");
  fs.mkdirSync(hermesHome, { recursive: true });
  writeJson(hermesAuthPath, {
    version: 1,
    updated_at: "2026-03-29T00:00:00.000Z",
    active_provider: "github-copilot",
    providers: {
      "github-copilot": {
        tokens: {
          access_token: "copilot-access",
          refresh_token: "copilot-refresh",
        },
      },
      "openai-codex": {
        tokens: {
          access_token: "stale-access",
          refresh_token: "stale-refresh",
        },
        last_refresh: "2026-03-29T00:00:00.000Z",
        auth_mode: "chatgpt",
      },
    },
    credential_pool: {
      "github-copilot": [
        {
          id: "cop123",
          label: "manual",
          auth_type: "oauth",
          priority: 0,
          source: "manual",
          access_token: "copilot-access",
          refresh_token: "copilot-refresh",
          request_count: 8,
        },
      ],
      "openai-codex": [
        {
          id: "cod123",
          label: "device_code",
          auth_type: "oauth",
          priority: 0,
          source: "device_code",
          access_token: "stale-access",
          refresh_token: "stale-refresh",
          last_status: "exhausted",
          last_status_at: 123,
          last_error_code: 401,
          base_url: "https://chatgpt.com/backend-api/codex",
          last_refresh: "2026-03-29T00:00:00.000Z",
          request_count: 17,
        },
      ],
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      growth: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        growth: {
          access: fakeJwt,
          refresh: "refresh-growth",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_growth",
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

  const out = await runCli(
    ["auth", "write", "hermes", "growth", "--auth-file", hermesAuthPath, "--home", home],
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.written.label, "growth");
  assert.equal(parsed.written.status, "applied");
  assert.equal(parsed.written.wrote.auth, true);

  const authJson = JSON.parse(fs.readFileSync(hermesAuthPath, "utf8"));
  assert.equal(authJson.active_provider, "openai-codex");
  assert.equal(authJson.providers["openai-codex"].tokens.access_token, fakeJwt);
  assert.equal(authJson.providers["openai-codex"].tokens.refresh_token, "refresh-growth");
  assert.equal(authJson.providers["github-copilot"].tokens.access_token, "copilot-access");
  assert.equal(authJson.providers["github-copilot"].tokens.refresh_token, "copilot-refresh");
  assert.equal(authJson.credential_pool["github-copilot"][0].access_token, "copilot-access");
  assert.equal(authJson.credential_pool["openai-codex"].length, 1);
  assert.equal(authJson.credential_pool["openai-codex"][0].id, "cod123");
  assert.equal(authJson.credential_pool["openai-codex"][0].access_token, fakeJwt);
  assert.equal(authJson.credential_pool["openai-codex"][0].refresh_token, "refresh-growth");
  assert.equal(authJson.credential_pool["openai-codex"][0].last_status, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].last_status_at, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].last_error_code, null);
  assert.equal(authJson.credential_pool["openai-codex"][0].request_count, 0);
});
