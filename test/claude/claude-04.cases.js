import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("sync claude clears stale target metadata without deleting live Claude files when the removed label no longer owns them", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const bossCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_BOSS",
    refresh: "REFRESH_BOSS",
  });
  const qaCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_QA",
    refresh: "REFRESH_QA",
    emailAddress: "qa@example.com",
    organizationName: "QA Org",
    organizationUuid: "org_qa",
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      qa: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        qa: qaCredential,
      },
    },
    imports: { authority: { codex: {}, anthropic: { labels: [], labelsByName: {} } } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
      qa: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: bossCredential,
        qa: qaCredential,
      },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss", "qa"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {
        activeLabel: "boss",
        credentialsPath: path.join(consumerHome, ".claude", ".credentials.json"),
        appStatePath: path.join(consumerHome, ".claude.json"),
        lastAppliedAt: new Date(0).toISOString(),
        lastSelectionReceipt: { status: "activated", label: "boss" },
      },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(consumerHome, {
    accessToken: "ACCESS_QA",
    refreshToken: "REFRESH_QA",
    oauthAccount: {
      accountUuid: "acct_boss",
      emailAddress: "qa@example.com",
      organizationName: "QA Org",
      organizationUuid: "org_qa",
    },
  });

  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/api/oauth/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 34, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  await runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome], { fetchImpl });

  const updatedState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(updatedState.accounts.boss, undefined);
  assert.equal(updatedState.credentials.anthropic.boss, undefined);
  assert.equal(updatedState.targets.claudeCli.activeLabel, undefined);
  assert.equal(updatedState.targets.claudeCli.lastSelectionReceipt, undefined);
  assert.equal(fs.existsSync(path.join(consumerHome, ".claude", ".credentials.json")), true);
  assert.equal(fs.existsSync(path.join(consumerHome, ".claude.json")), true);

  const status = JSON.parse(await runCli(["status", "--json", "--home", consumerHome], { fetchImpl }));
  assert.equal(status.claudeCli.activeLabel, null);
  assert.equal(status.claudeCli.inferredLabel, "qa");
});

test("aim claude capture-native refuses duplicate stored Claude identities and email mismatches", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_BOSS",
    refreshToken: "REFRESH_BOSS",
    oauthAccount: {
      emailAddress: "boss@example.com",
      organizationName: "Boss Org",
      organizationUuid: "org_boss",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "anthropic",
        reauth: { mode: "native-claude" },
      },
      other: {
        provider: "anthropic",
        reauth: { mode: "native-claude" },
        expect: { email: "other@example.com" },
      },
      duplicate: {
        provider: "anthropic",
        reauth: { mode: "native-claude" },
      },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential(),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["claude", "capture-native", "duplicate", "--home", home]),
    /already stored on label=boss/i,
  );
  let updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.accounts.duplicate.reauth.blockedReason, undefined);
  assert.equal(typeof updatedState.accounts.duplicate.reauth.lastAttemptAt, "string");

  await assert.rejects(
    () => runCli(["claude", "capture-native", "other", "--home", home]),
    /expects other@example.com/i,
  );
  updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.match(updatedState.accounts.other.reauth.blockedReason, /expects other@example.com/i);
});

test("anthropic refresh updates token fields without losing native Claude identity metadata", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential(),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const out = JSON.parse(await runCli(["boss", "--home", home], {
    refreshAnthropicImpl: async (refreshToken) => {
      assert.equal(refreshToken, "REFRESH_BOSS");
      return {
        access: "ACCESS_REFRESHED",
        refresh: "REFRESH_REFRESHED",
        expires: Date.now() + 7200_000,
      };
    },
  }));

  assert.equal(out.ok, true);
  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.credentials.anthropic.boss.access, "ACCESS_REFRESHED");
  assert.equal(updatedState.credentials.anthropic.boss.refresh, "REFRESH_REFRESHED");
  assert.equal(updatedState.credentials.anthropic.boss.nativeClaudeBundle.claudeAiOauth.accessToken, "ACCESS_REFRESHED");
  assert.equal(updatedState.credentials.anthropic.boss.nativeClaudeBundle.oauthAccount.accountUuid, "acct_boss");
  assert.equal(updatedState.credentials.anthropic.boss.nativeClaudeBundle.oauthAccount.emailAddress, "boss@example.com");
});

test("claude use preserves unrelated .claude.json keys while projecting native auth", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  writeJson(path.join(home, ".claude.json"), {
    theme: "dark",
    telemetry: false,
    oauthAccount: {
      emailAddress: "stale@example.com",
      organizationName: "Stale Org",
      organizationUuid: "org_stale",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential(),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });
  const fetchImpl = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/api/oauth/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 11, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 21, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  await withEnv(
    {
      PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}`,
    },
    async () => {
      await runCli(["claude", "use", "--home", home], { fetchImpl });
      const appState = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
      assert.equal(appState.theme, "dark");
      assert.equal(appState.telemetry, false);
      assert.equal(appState.oauthAccount.emailAddress, "boss@example.com");
      assert.equal(appState.oauthAccount.organizationName, "Boss Org");
    },
  );
});
