import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("status --json never leaks access/refresh tokens", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(path.join(home, ".pi", "agent", "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: "PI_ACCESS_SHOULD_NOT_LEAK",
      refresh: "PI_REFRESH_SHOULD_NOT_LEAK",
      expires: Date.now() + 3600_000,
      accountId: "acct_123",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.1",
    accounts: {
      boss: { provider: "openai-codex", openclawBrowserProfile: "agent-boss" },
      claude: { provider: "anthropic", openclawBrowserProfile: "agent-claude" },
    },
    pins: { openclaw: {} },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN_SHOULD_NOT_LEAK",
          refresh: "REFRESH_TOKEN_SHOULD_NOT_LEAK",
          idToken: "ID_TOKEN_SHOULD_NOT_LEAK",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claude: {
          access: "ANTHROPIC_ACCESS_SHOULD_NOT_LEAK",
          refresh: "ANTHROPIC_REFRESH_SHOULD_NOT_LEAK",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      piCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
      },
    },
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
          },
        }),
      };
    }

    if (u.includes("api.anthropic.com/api/oauth/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: "2026-03-10T00:00:00Z" },
          seven_day: { utilization: 34, resets_at: "2026-03-12T00:00:00Z" },
          seven_day_opus: { utilization: 44 },
        }),
      };
    }

    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const out = await runCli(["status", "--json", "--home", home], { fetchImpl });
    assert.doesNotMatch(out, /ACCESS_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /REFRESH_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ID_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ANTHROPIC_ACCESS_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ANTHROPIC_REFRESH_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /PI_ACCESS_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /PI_REFRESH_SHOULD_NOT_LEAK/);
    const parsed = JSON.parse(out);
    const boss = parsed.accounts.find((a) => a.label === "boss");
    const claude = parsed.accounts.find((a) => a.label === "claude");
    assert.equal(boss.provider, "openai-codex");
    assert.equal(claude.provider, "anthropic");
    assert.equal(claude.usage.ok, true);
    assert.ok(claude.usage.windows.some((w) => w.label === "Opus"));
    assert.equal(parsed.piCli.activeLabel, "boss");
    assert.equal(parsed.piCli.actualAccountId, "acct_123");
});

test("login marks imported codex labels dirty after a local refresh", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const oldJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });
  const newJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
    refreshed: true,
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: oldJwt,
          refresh: "OLD_REFRESH",
          idToken: oldJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
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

  const out = JSON.parse(await runCli(["login", "boss", "--home", home], {
    refreshOpenAICodexImpl: async () => ({
      access: newJwt,
      refresh: "NEW_REFRESH",
      expires: Date.now() + 7200_000,
      accountId: "acct_123",
    }),
  }));

  assert.equal(out.authorityPromotion.status, "pending_publish");
  assert.equal(out.authorityPromotion.target, "agents@studio");

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
  assert.equal(updatedState.imports.authority.codex.labelsByName.boss.baseAccountId, "acct_123");
  assert.ok(typeof updatedState.imports.authority.codex.labelsByName.boss.dirtyObservedAt === "string");
});

test("promote codex updates only the selected authority labels and clears local dirty state", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const bossAuthorityJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const bossLocalJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    refreshed: true,
  });
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_456", chatgpt_plan_type: "pro" },
  });

  const bossAuthorityCredential = {
    access: bossAuthorityJwt,
    refresh: "AUTHORITY_REFRESH",
    idToken: bossAuthorityJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const bossLocalCredential = {
    access: bossLocalJwt,
    refresh: "LOCAL_REFRESH",
    idToken: bossLocalJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };
  const qaCredential = {
    access: qaJwt,
    refresh: "QA_REFRESH",
    idToken: qaJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_456",
  };

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: bossAuthorityCredential,
        qa: qaCredential,
      },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: bossLocalCredential,
        qa: qaCredential,
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss", "qa"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(bossAuthorityCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
            qa: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_456",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(qaCredential),
              dirtyLocal: false,
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const out = JSON.parse(await runCli(["promote", "codex", "--to", authorityStatePath, "boss", "--home", consumerHome]));
  assert.equal(out.promoted.status, "applied");
  assert.deepEqual(out.promoted.labels, ["boss"]);

  const authorityState = JSON.parse(fs.readFileSync(authorityStatePath, "utf8"));
  assert.equal(authorityState.credentials["openai-codex"].boss.refresh, "LOCAL_REFRESH");
  assert.equal(authorityState.credentials["openai-codex"].qa.refresh, "QA_REFRESH");

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, false);
  assert.equal(
    consumerState.imports.authority.codex.labelsByName.boss.baseCredentialFingerprint,
    buildCodexCredentialFingerprint(bossLocalCredential),
  );
  assert.ok(typeof consumerState.imports.authority.codex.labelsByName.boss.lastPromotedAt === "string");
});
