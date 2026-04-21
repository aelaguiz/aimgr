import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("aim claude use skips pre-switch capture when authority import is newer than live", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  const authorityExpiresMs = Date.now() + 2 * 60 * 60_000;
  const storedCred = buildAnthropicClaudeCredential({
    access: "ACCESS_FRESH",
    refresh: "REFRESH_FRESH",
    expiresAtMs: authorityExpiresMs,
    emailAddress: "shared@example.com",
    organizationName: "Shared Org",
    organizationUuid: "org_shared",
  });
  storedCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_shared";

  const importedAt = new Date(Date.now() + 60_000).toISOString();

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      shared: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { shared: storedCred },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: "agents@studio",
          importedAt,
          labels: ["shared"],
          labelsByName: {
            shared: {
              importedAt,
              dirtyLocal: false,
              baseCredentialFingerprint: "fp_fresh",
              baseIdentity: {
                accountUuid: "acct_shared",
                emailAddress: "shared@example.com",
                organizationUuid: "org_shared",
              },
            },
          },
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "shared" },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_STALE",
    refreshToken: "REFRESH_STALE",
    oauthAccount: {
      accountUuid: "acct_shared",
      emailAddress: "shared@example.com",
      organizationName: "Shared Org",
      organizationUuid: "org_shared",
    },
  });

  const credentialsPath = path.join(home, ".claude", ".credentials.json");
  const staleMtimeSec = Math.floor((Date.parse(importedAt) - 60_000) / 1000);
  fs.utimesSync(credentialsPath, staleMtimeSec, staleMtimeSec);

  await withEnv(
    { PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}` },
    async () => {
      const out = JSON.parse(await runCli(["claude", "use", "shared", "--home", home]));
      assert.equal(out.ok, true);

      const sync = out.activated.receipt.preSwitchSync;
      assert.ok(sync);
      assert.equal(sync.synced, false);
      assert.equal(sync.reason, "authority_import_newer");
      assert.equal(sync.label, "shared");

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(updatedState.credentials.anthropic.shared.access, "ACCESS_FRESH");
      assert.equal(updatedState.credentials.anthropic.shared.refresh, "REFRESH_FRESH");

      const liveAuth = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
      assert.equal(liveAuth.claudeAiOauth.accessToken, "ACCESS_FRESH");
      assert.equal(liveAuth.claudeAiOauth.refreshToken, "REFRESH_FRESH");
    },
  );
});

test("aim claude use still captures rotation when live is newer than authority import", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  const storedExpiresMs = Date.now() + 60 * 60_000;
  const rotatedExpiresMs = Date.now() + 3 * 60 * 60_000;

  const storedCred = buildAnthropicClaudeCredential({
    access: "ACCESS_BASELINE",
    refresh: "REFRESH_BASELINE",
    expiresAtMs: storedExpiresMs,
    emailAddress: "shared@example.com",
    organizationName: "Shared Org",
    organizationUuid: "org_shared",
  });
  storedCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_shared";

  const otherCred = buildAnthropicClaudeCredential({
    access: "ACCESS_OTHER",
    refresh: "REFRESH_OTHER",
    emailAddress: "other@example.com",
    organizationName: "Other Org",
    organizationUuid: "org_other",
  });
  otherCred.nativeClaudeBundle.oauthAccount.accountUuid = "acct_other";

  const importedAt = new Date(Date.now() - 2 * 60 * 60_000).toISOString();

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      shared: { provider: "anthropic", reauth: { mode: "native-claude" } },
      other: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { shared: storedCred, other: otherCred },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: "agents@studio",
          importedAt,
          labels: ["shared"],
          labelsByName: {
            shared: {
              importedAt,
              dirtyLocal: false,
              baseCredentialFingerprint: "fp_old",
              baseIdentity: {
                accountUuid: "acct_shared",
                emailAddress: "shared@example.com",
                organizationUuid: "org_shared",
              },
            },
          },
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "shared" },
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_ROTATED",
    refreshToken: "REFRESH_ROTATED",
    expiresAtMs: rotatedExpiresMs,
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
      const out = JSON.parse(await runCli(["claude", "use", "other", "--home", home]));
      assert.equal(out.ok, true);

      const sync = out.activated.receipt.preSwitchSync;
      assert.ok(sync);
      assert.equal(sync.synced, true);
      assert.equal(sync.label, "shared");

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.equal(updatedState.credentials.anthropic.shared.access, "ACCESS_ROTATED");
      assert.equal(updatedState.credentials.anthropic.shared.refresh, "REFRESH_ROTATED");
    },
  );
});
