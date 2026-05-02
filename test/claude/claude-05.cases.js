import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("claude use clears stale managed auth when no Claude pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  writeClaudeNativeBundle(home, {
    appState: {
      theme: "dark",
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
        boss: buildAnthropicClaudeCredential({
          expiresAtMs: Date.now() - 3600_000,
        }),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {
        activeLabel: "boss",
        credentialsPath: path.join(home, ".claude", ".credentials.json"),
        appStatePath: path.join(home, ".claude.json"),
        lastAppliedAt: new Date().toISOString(),
      },
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
          five_hour: { utilization: 8, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 19, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
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
        const result = await runCliWithExitCode(["claude", "use", "--home", home], { fetchImpl });
        assert.equal(result.exitCode, 1);
        const parsed = JSON.parse(result.stdout);
        assert.equal(parsed.ok, false);
        assert.equal(parsed.activated.status, "blocked");
        assert.deepEqual(parsed.activated.receipt.blockers, [{ label: "boss", reason: "missing_credentials" }]);

        assert.equal(fs.existsSync(path.join(home, ".claude", ".credentials.json")), false);
        const appState = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
        assert.equal(appState.theme, "dark");
        assert.equal(appState.oauthAccount, undefined);

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.claudeCli.activeLabel, undefined);
        assert.equal(updatedState.targets.claudeCli.credentialsPath, undefined);
        assert.equal(updatedState.targets.claudeCli.appStatePath, undefined);
        assert.equal(updatedState.targets.claudeCli.lastAppliedAt, undefined);
        assert.equal(updatedState.targets.claudeCli.lastSelectionReceipt.status, "blocked");

        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.claudeCli.activeLabel, null);
        assert.equal(status.claudeCli.readback.credentials.exists, false);
        assert.equal(status.claudeCli.readback.appState.oauthAccountPresent, false);
      },
  );
});

test("claude use does not delete credentials when app-state cleanup is unreadable", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });
  const credentialsPath = path.join(home, ".claude", ".credentials.json");
  const appStatePath = path.join(home, ".claude.json");

  writeClaudeNativeBundle(home);
  fs.writeFileSync(appStatePath, "{not-json\n", "utf8");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential({
          expiresAtMs: Date.now() - 3600_000,
        }),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {
        activeLabel: "boss",
        credentialsPath,
        appStatePath,
        lastAppliedAt: new Date().toISOString(),
      },
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
          five_hour: { utilization: 8, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 19, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
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
      await assert.rejects(
        () => runCli(["claude", "use", "--home", home], { fetchImpl }),
        /Refusing to mutate unreadable Claude app state file/,
      );
    },
  );

  // Clearing stale Claude auth has two files. If preserving .claude.json is unsafe,
  // AIM must fail before deleting .credentials.json and leaving a half-cleared target.
  assert.equal(fs.existsSync(credentialsPath), true);
  assert.equal(JSON.parse(fs.readFileSync(credentialsPath, "utf8")).claudeAiOauth.refreshToken, "REFRESH_BOSS");
  assert.equal(fs.readFileSync(appStatePath, "utf8"), "{not-json\n");
  const persistedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persistedState.targets.claudeCli.activeLabel, "boss");
  assert.equal(persistedState.targets.claudeCli.credentialsPath, credentialsPath);
});

test("claude status warns when an oauth-token env override shadows projected native auth", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

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
          five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 34, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
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
      },
    );

    await withEnv(
      {
        PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}`,
        CLAUDE_CODE_OAUTH_TOKEN: "SHADOW_TOKEN",
      },
      async () => {
        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.claudeCli.authStatus.authMethod, "oauth_token");
        assert.ok(status.warnings.some((warning) => warning.kind === "claude_target_env_override"));
      },
    );
});

test("status --json does not shell out to a mutating claude auth status command", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

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
          five_hour: { utilization: 12, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 34, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
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
      },
    );

    await withEnv(
      {
        PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}`,
        CLAUDE_AUTH_STATUS_MUTATES: "1",
      },
      async () => {
        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.claudeCli.authStatus.authMethod, "claude.ai");
        assert.equal(status.claudeCli.authStatus.subscriptionType, "max");

        const auth = JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
        assert.equal(auth.claudeAiOauth.subscriptionType, "max");
        assert.equal(auth.claudeAiOauth.rateLimitTier, "max_20x");
      },
    );
});

test("aim claude use captures rotated tokens for the prior label before switching", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  const alphaExpiresMs = Date.now() + 60 * 60_000;
  const betaExpiresMs = Date.now() + 2 * 60 * 60_000;
  const rotatedExpiresMs = Date.now() + 3 * 60 * 60_000;

  const alphaCred = buildAnthropicClaudeCredential({
    access: "ACCESS_A",
    refresh: "REFRESH_A",
    expiresAtMs: alphaExpiresMs,
    emailAddress: "alpha@example.com",
    organizationName: "Alpha Org",
    organizationUuid: "org_alpha",
  });
  alphaCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_alpha";

  const betaCred = buildAnthropicClaudeCredential({
    access: "ACCESS_B",
    refresh: "REFRESH_B",
    expiresAtMs: betaExpiresMs,
    emailAddress: "beta@example.com",
    organizationName: "Beta Org",
    organizationUuid: "org_beta",
  });
  betaCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_beta";

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      alpha: { provider: "anthropic", reauth: { mode: "native-claude" } },
      beta: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { alpha: alphaCred, beta: betaCred },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "alpha" },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_A_ROTATED",
    refreshToken: "REFRESH_A_ROTATED",
    expiresAtMs: rotatedExpiresMs,
    oauthAccount: {
      accountUuid: "acct_alpha",
      emailAddress: "alpha@example.com",
      organizationName: "Alpha Org",
      organizationUuid: "org_alpha",
    },
  });

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(await runCli(["claude", "use", "beta", "--home", home]));
      assert.equal(out.ok, true);
      assert.equal(out.activated.receipt.label, "beta");

      const sync = out.activated.receipt.preSwitchSync;
      assert.ok(sync, "receipt.preSwitchSync should be present");
      assert.equal(sync.synced, true);
      assert.equal(sync.label, "alpha");
      assert.deepEqual(sync.rotatedFields.toSorted(), ["accessToken", "expiresAt", "refreshToken"]);

      const liveAuth = JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
      assert.equal(liveAuth.claudeAiOauth.accessToken, "ACCESS_B");
      assert.equal(liveAuth.claudeAiOauth.refreshToken, "REFRESH_B");

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      const storedAlpha = updatedState.credentials.anthropic.alpha;
      assert.equal(storedAlpha.access, "ACCESS_A_ROTATED");
      assert.equal(storedAlpha.refresh, "REFRESH_A_ROTATED");
      assert.equal(storedAlpha.nativeClaudeBundle.claudeAiOauth.accessToken, "ACCESS_A_ROTATED");
      assert.equal(storedAlpha.nativeClaudeBundle.claudeAiOauth.refreshToken, "REFRESH_A_ROTATED");
      assert.equal(storedAlpha.nativeClaudeBundle.claudeAiOauth.expiresAt, rotatedExpiresMs);
      assert.equal(storedAlpha.nativeClaudeBundle.oauthAccount.accountUuid, "acct_alpha");
      assert.equal(storedAlpha.nativeClaudeBundle.oauthAccount.emailAddress, "alpha@example.com");

      assert.equal(updatedState.credentials.anthropic.beta.refresh, "REFRESH_B");
      assert.equal(updatedState.targets.claudeCli.activeLabel, "beta");
    },
  );
});
