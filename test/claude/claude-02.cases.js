import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("aim claude use restores hasCompletedOnboarding + hasAvailableSubscription after /logout", async () => {
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

  writeJson(path.join(home, ".claude.json"), {
    hasCompletedOnboarding: false,
    hasAvailableSubscription: false,
    numStartups: 5,
    unrelatedField: "preserve-me",
  });

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(await runCli(["claude", "use", "boss", "--home", home]));
      assert.equal(out.ok, true);
      assert.equal(out.activated.receipt.label, "boss");

      const appState = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
      assert.equal(appState.hasCompletedOnboarding, true);
      assert.equal(appState.hasAvailableSubscription, true);
      assert.equal(appState.oauthAccount.emailAddress, "boss@example.com");
      assert.equal(appState.numStartups, 5);
      assert.equal(appState.unrelatedField, "preserve-me");

      const auth = JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
      assert.equal(auth.claudeAiOauth.accessToken, "ACCESS_BOSS");
      assert.equal(auth.claudeAiOauth.refreshToken, "REFRESH_BOSS");
    },
  );
});

test("aim claude use keeps the next-best pooled Claude selection behavior", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
      qa: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential({
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          emailAddress: "boss@example.com",
          organizationName: "Boss Org",
          organizationUuid: "org_boss",
        }),
        qa: buildAnthropicClaudeCredential({
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          emailAddress: "qa@example.com",
          organizationName: "QA Org",
          organizationUuid: "org_qa",
        }),
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
  const fetchImpl = async (url, options = {}) => {
    const accessToken = String(options?.headers?.Authorization ?? options?.headers?.authorization ?? "").replace(/^Bearer\s+/i, "");
    if (!String(url ?? "").includes("/api/oauth/usage")) {
      throw new Error(`Unexpected fetch url in test: ${String(url ?? "")}`);
    }
    if (accessToken === "ACCESS_BOSS") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 72, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 61, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
        }),
      };
    }
    if (accessToken === "ACCESS_QA") {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 11, resets_at: new Date(Date.now() + 3600_000).toISOString() },
          seven_day: { utilization: 21, resets_at: new Date(Date.now() + 24 * 3600_000).toISOString() },
        }),
      };
    }
    throw new Error(`Unexpected access token in usage probe: ${accessToken}`);
  };

    await withEnv(
      {
        PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}`,
      },
      async () => {
        const out = JSON.parse(await runCli(["claude", "use", "--home", home], { fetchImpl }));
        assert.equal(out.ok, true);
        assert.equal(out.activated.receipt.label, "qa");
      },
    );
});

test("aim claude export-live and import-native round-trip a native Claude bundle between homes", async () => {
  const sourceHome = mkTempHome();
  const targetHome = mkTempHome();
  const bundlePath = path.join(sourceHome, "claude-native-bundle.json");
  const targetStatePath = path.join(targetHome, ".aimgr", "secrets.json");

  writeClaudeNativeBundle(sourceHome, {
    accessToken: "ACCESS_EXPORT",
    refreshToken: "REFRESH_EXPORT",
    oauthAccount: {
      emailAddress: "export@example.com",
      organizationName: "Export Org",
      organizationUuid: "org_export",
    },
  });

  writeJson(targetStatePath, {
    schemaVersion: "0.2",
    accounts: {
      imported: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const exported = JSON.parse(await runCli(["claude", "export-live", "--home", sourceHome, "--out", bundlePath]));
  assert.equal(exported.ok, true);
  assert.equal(exported.exported.filePath, bundlePath);

  const imported = JSON.parse(
    await runCli(["claude", "import-native", "imported", "--home", targetHome, "--in", bundlePath]),
  );
  assert.equal(imported.ok, true);
  assert.equal(imported.imported.label, "imported");

  const targetState = JSON.parse(fs.readFileSync(targetStatePath, "utf8"));
  assert.equal(targetState.credentials.anthropic.imported.access, "ACCESS_EXPORT");
  assert.equal(targetState.credentials.anthropic.imported.refresh, "REFRESH_EXPORT");
  assert.equal(targetState.credentials.anthropic.imported.emailAddress, "export@example.com");
  assert.equal(targetState.credentials.anthropic.imported.organizationUuid, "org_export");
});

test("sync claude bootstraps consumer state and preserves authority labels without complete native bundles", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
      claudalyst: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential(),
        claudalyst: {
          access: "ACCESS_CLAUDALYST",
          refresh: "REFRESH_CLAUDALYST",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
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

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {},
    credentials: {
      "openai-codex": {},
      anthropic: {},
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

  await runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.anthropic.source, path.resolve(authorityStatePath));
  assert.deepEqual(consumerState.imports.authority.anthropic.labels, ["boss", "claudalyst"]);
  assert.equal(consumerState.accounts.boss.reauth.mode, "native-claude");
  assert.equal(consumerState.accounts.boss.browser, null);
  assert.equal(consumerState.accounts.claudalyst.reauth.mode, "native-claude");
  assert.equal(consumerState.accounts.claudalyst.browser, null);
  assert.equal(consumerState.credentials.anthropic.claudalyst.access, "ACCESS_CLAUDALYST");
  assert.equal(consumerState.credentials.anthropic.claudalyst.refresh, "REFRESH_CLAUDALYST");
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, false);
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.claudalyst.dirtyLocal, false);
});

test("aim claude capture-native can promote a label imported before the authority had credentials", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
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

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {},
    credentials: {
      "openai-codex": {},
      anthropic: {},
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

  await runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome]);

  writeClaudeNativeBundle(consumerHome, {
    accessToken: "ACCESS_CAPTURED",
    refreshToken: "REFRESH_CAPTURED",
  });
  const captured = JSON.parse(await runCli(["claude", "capture-native", "boss", "--home", consumerHome]));
  assert.equal(captured.ok, true);

  let consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  // A label imported before the authority had native credentials has no baseline fingerprint yet;
  // the first local capture is exactly the dirty update that must be promotable back upstream.
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, true);
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.baseCredentialFingerprint, undefined);
  assert.ok(typeof consumerState.imports.authority.anthropic.labelsByName.boss.dirtyObservedAt === "string");

  const promoted = JSON.parse(await runCli(["promote", "claude", "--to", authorityStatePath, "boss", "--home", consumerHome]));
  assert.equal(promoted.promoted.status, "applied");

  const authorityState = JSON.parse(fs.readFileSync(authorityStatePath, "utf8"));
  assert.equal(authorityState.credentials.anthropic.boss.refresh, "REFRESH_CAPTURED");

  consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, false);
});

test("aim claude capture-native marks imported Claude labels dirty after a local native capture", async () => {
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
        boss: buildAnthropicClaudeCredential({
          access: "ACCESS_OLD",
          refresh: "REFRESH_OLD",
        }),
      },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
        },
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

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_NEW",
    refreshToken: "REFRESH_NEW",
  });

  const out = JSON.parse(await runCli(["claude", "capture-native", "boss", "--home", home]));
  assert.equal(out.ok, true);
  assert.equal(out.captured.label, "boss");

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.credentials.anthropic.boss.access, "ACCESS_NEW");
  assert.equal(updatedState.credentials.anthropic.boss.refresh, "REFRESH_NEW");
  assert.equal(updatedState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, true);
  assert.ok(typeof updatedState.imports.authority.anthropic.labelsByName.boss.dirtyObservedAt === "string");
});
