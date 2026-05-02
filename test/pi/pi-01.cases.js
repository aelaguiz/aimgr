import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("pi use writes auth.json, preserves non-openai providers, and status reports the active Pi target", async () => {
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
      piCli: {},
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
        const out = JSON.parse(await runCli(["pi", "use", "--home", home], { fetchImpl }));
        assert.equal(out.ok, true);
        assert.equal(out.activated.status, "activated");
        assert.equal(out.activated.receipt.label, "boss");

        const auth = JSON.parse(fs.readFileSync(path.join(piAgentDir, "auth.json"), "utf8"));
        assert.deepEqual(auth.anthropic, { type: "api_key", key: "ANTHROPIC_KEY" });
        assert.deepEqual(auth["openai-codex"], {
          type: "oauth",
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          expires: auth["openai-codex"].expires,
          accountId: "acct_123",
        });
        assert.equal(typeof auth["openai-codex"].expires, "number");

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.piCli.activeLabel, "boss");
        assert.equal(updatedState.targets.piCli.expectedAccountId, "acct_123");
        assert.equal(updatedState.targets.piCli.lastSelectionReceipt.status, "activated");

        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.piCli.activeLabel, "boss");
        assert.equal(status.piCli.actualAccountId, "acct_123");
        assert.equal(status.piCli.authPath, path.join(piAgentDir, "auth.json"));
        assert.equal(status.piCli.readback.providerEntryPresent, true);
        assert.equal(status.piCli.readback.providerEntryType, "oauth");
      },
    );
});

test("pi use prefers weekly pool headroom over the lowest short-window usage", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const piAgentDir = path.join(home, ".pi-test", "agent");
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
      piCli: {},
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

    await withEnv(
      {
        PI_CODING_AGENT_DIR: piAgentDir,
      },
      async () => {
        const result = JSON.parse(await runCli(["pi", "use", "--home", home], { fetchImpl }));
        assert.equal(result.ok, true);
        assert.equal(result.activated.status, "activated");
        assert.equal(result.activated.receipt.label, "pro2");

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.piCli.activeLabel, "pro2");
        assert.equal(updatedState.targets.piCli.lastSelectionReceipt.label, "pro2");
      },
    );
});
