import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("aim claude use skips rotation capture when the live Claude bundle matches no stored label", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  const alphaCred = buildAnthropicClaudeCredential({
    access: "ACCESS_A",
    refresh: "REFRESH_A",
    emailAddress: "alpha@example.com",
    organizationName: "Alpha Org",
    organizationUuid: "org_alpha",
  });
  alphaCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_alpha";

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      alpha: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { alpha: alphaCred },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_FOREIGN",
    refreshToken: "REFRESH_FOREIGN",
    oauthAccount: {
      accountUuid: "acct_unknown",
      emailAddress: "stranger@example.com",
      organizationName: "Foreign Org",
      organizationUuid: "org_foreign",
    },
  });

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(await runCli(["claude", "use", "alpha", "--home", home]));
      assert.equal(out.ok, true);
      assert.equal(out.activated.receipt.label, "alpha");

      const sync = out.activated.receipt.preSwitchSync;
      assert.ok(sync);
      assert.equal(sync.synced, false);
      assert.equal(sync.reason, "no_label_for_identity");

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(updatedState.credentials.anthropic.alpha.access, "ACCESS_A");
      assert.equal(updatedState.credentials.anthropic.alpha.refresh, "REFRESH_A");
    },
  );
});

test("aim claude use is a rotation no-op when live tokens already match the stored bundle", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  const expiresMs = Date.now() + 60 * 60_000;

  const alphaCred = buildAnthropicClaudeCredential({
    access: "ACCESS_A",
    refresh: "REFRESH_A",
    expiresAtMs: expiresMs,
    emailAddress: "alpha@example.com",
    organizationName: "Alpha Org",
    organizationUuid: "org_alpha",
  });
  alphaCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_alpha";

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      alpha: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { alpha: alphaCred },
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
    accessToken: "ACCESS_A",
    refreshToken: "REFRESH_A",
    expiresAtMs: expiresMs,
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
      const out = JSON.parse(await runCli(["claude", "use", "alpha", "--home", home]));
      assert.equal(out.ok, true);

      const sync = out.activated.receipt.preSwitchSync;
      assert.ok(sync);
      assert.equal(sync.synced, false);
      assert.equal(sync.reason, "tokens_unchanged");
      assert.equal(sync.label, "alpha");
    },
  );
});

test("aim sync claude auto-applies the active label to live files after import", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(consumerHome, "fake-claude") });

  const authorityExpiresMs = Date.now() + 2 * 60 * 60_000;
  const authorityCred = buildAnthropicClaudeCredential({
    access: "ACCESS_AUTHORITY",
    refresh: "REFRESH_AUTHORITY",
    expiresAtMs: authorityExpiresMs,
    emailAddress: "shared@example.com",
    organizationName: "Shared Org",
    organizationUuid: "org_shared",
  });
  authorityCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_shared";

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      shared: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { shared: authorityCred },
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const consumerStaleCred = buildAnthropicClaudeCredential({
    access: "ACCESS_STALE",
    refresh: "REFRESH_STALE",
    expiresAtMs: Date.now() + 60 * 60_000,
    emailAddress: "shared@example.com",
    organizationName: "Shared Org",
    organizationUuid: "org_shared",
  });
  consumerStaleCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_shared";

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      shared: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { shared: consumerStaleCred },
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "shared" },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(consumerHome, {
    accessToken: "ACCESS_STALE",
    refreshToken: "REFRESH_STALE",
    oauthAccount: {
      accountUuid: "acct_shared",
      emailAddress: "shared@example.com",
      organizationName: "Shared Org",
      organizationUuid: "org_shared",
    },
  });

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(
        await runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome]),
      );
      assert.equal(out.ok, true);
      assert.ok(out.liveApplied, "sync receipt should include liveApplied");
      assert.equal(out.liveApplied.label, "shared");

      const liveAuth = JSON.parse(
        fs.readFileSync(path.join(consumerHome, ".claude", ".credentials.json"), "utf8"),
      );
      assert.equal(liveAuth.claudeAiOauth.accessToken, "ACCESS_AUTHORITY");
      assert.equal(liveAuth.claudeAiOauth.refreshToken, "REFRESH_AUTHORITY");

      const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
      assert.equal(consumerState.credentials.anthropic.shared.access, "ACCESS_AUTHORITY");
      assert.equal(consumerState.credentials.anthropic.shared.refresh, "REFRESH_AUTHORITY");
    },
  );
});

test("aim sync claude leaves live files untouched when active label was not imported", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(consumerHome, "fake-claude") });

  const otherCred = buildAnthropicClaudeCredential({
    access: "ACCESS_OTHER",
    refresh: "REFRESH_OTHER",
    emailAddress: "other@example.com",
    organizationName: "Other Org",
    organizationUuid: "org_other",
  });
  otherCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_other";

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      other: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { other: otherCred },
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const consumerActiveCred = buildAnthropicClaudeCredential({
    access: "ACCESS_ACTIVE",
    refresh: "REFRESH_ACTIVE",
    emailAddress: "active@example.com",
    organizationName: "Active Org",
    organizationUuid: "org_active",
  });
  consumerActiveCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_active";

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      active: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { active: consumerActiveCred },
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "active" },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(consumerHome, {
    accessToken: "ACCESS_ACTIVE",
    refreshToken: "REFRESH_ACTIVE",
    oauthAccount: {
      accountUuid: "acct_active",
      emailAddress: "active@example.com",
      organizationName: "Active Org",
      organizationUuid: "org_active",
    },
  });

  const credentialsPath = path.join(consumerHome, ".claude", ".credentials.json");
  const appStatePath = path.join(consumerHome, ".claude.json");
  const credentialsBefore = fs.readFileSync(credentialsPath, "utf8");
  const appStateBefore = fs.readFileSync(appStatePath, "utf8");

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(
        await runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome]),
      );
      assert.equal(out.ok, true);
      assert.equal(out.liveApplied, null);
      assert.equal(out.liveApplyError, null);

      assert.equal(fs.readFileSync(credentialsPath, "utf8"), credentialsBefore);
      assert.equal(fs.readFileSync(appStatePath, "utf8"), appStateBefore);
    },
  );
});
