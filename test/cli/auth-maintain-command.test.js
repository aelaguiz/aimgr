import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import {
  connectRedisStore,
  importCredentialsSnapshot,
  publishCredential,
  readSnapshot,
} from "../../src/coordination/redis-store.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveClaudeAuthFilePath,
} from "../../src/io/paths.js";
import { runCliWithExitCode } from "../helpers/cli-runner.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-24T12:00:00.000Z");
const PREFIX = "aimgr:auth-maintain-test";

function codexAccess(accountId) {
  return makeFakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

function codexRecord(label, {
  accountId = `acct_${label}`,
  expiresAtMs = NOW_MS + 60 * 60_000,
  policy = {},
} = {}) {
  const access = codexAccess(accountId);
  return {
    provider: "openai-codex",
    label,
    credential: {
      access,
      refresh: `REFRESH_${label}`,
      expiresAt: new Date(expiresAtMs).toISOString(),
      accountId,
      idToken: access,
    },
    identity: { accountId },
    policy: {
      ...policy,
      pool: { enabled: true },
    },
    health: { status: "ready", reason: null },
  };
}

function claudeRecord(label, { expiresAtMs = NOW_MS + 4 * 60_000 } = {}) {
  const emailAddress = `${label}@example.test`;
  const credential = buildAnthropicClaudeCredential({
    access: `ACCESS_${label}`,
    refresh: `REFRESH_${label}`,
    expiresAtMs,
    emailAddress,
    organizationName: `Org ${label}`,
    organizationUuid: `org_${label}`,
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = `acct_${label}`;
  return {
    provider: "anthropic",
    label,
    credential,
    identity: buildStableIdentityForCredential("anthropic", credential),
    policy: {
      expect: { email: emailAddress },
      reauth: { mode: "native-claude" },
      pool: { enabled: true },
    },
    health: { status: "ready", reason: null },
  };
}

function buildTestClaudeResolver() {
  const resolve = () => process.execPath;
  resolve.prepareClaudeCliLaunchImpl = ({ command, userHomeDir, homeDir, configDir }) => ({
    command: path.resolve(command),
    userHomeDir,
    homeDir,
    configDir,
  });
  return resolve;
}

function rotateProjectedClaudeCredential(configDir, {
  accessToken,
  refreshToken,
  expiresAt,
}) {
  const credentialsPath = resolveClaudeAuthFilePath(configDir);
  const projected = JSON.parse(fs.readFileSync(credentialsPath, "utf8"));
  projected.claudeAiOauth.accessToken = accessToken;
  projected.claudeAiOauth.refreshToken = refreshToken;
  projected.claudeAiOauth.expiresAt = expiresAt;
  fs.writeFileSync(credentialsPath, `${JSON.stringify(projected, null, 2)}\n`, { mode: 0o600 });
}

async function setup(records) {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importCredentialsSnapshot(
    store,
    { credentials: records },
    { updatedBy: "test", observedAt: new Date(NOW_MS - 60_000).toISOString() },
  );
  return {
    home,
    client,
    store,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  };
}

test("auth maintain refreshes only due records serially and marks missing refresh material", async () => {
  const dueClaude = claudeRecord("claude-due");
  const dueCodex = codexRecord("codex-due", { expiresAtMs: NOW_MS + 60 * 60_000 });
  const freshCodex = codexRecord("codex-fresh", { expiresAtMs: NOW_MS + 3 * 24 * 60 * 60_000 });
  const terminalCodex = codexRecord("codex-terminal", {
    expiresAtMs: NOW_MS + 30 * 60_000,
    policy: { reauth: { blockedReason: "oauth_reauth_required" } },
  });
  const incompleteClaude = {
    provider: "anthropic",
    label: "claude-incomplete",
    credential: { access: "INCOMPLETE" },
    policy: {
      expect: { email: "claude-incomplete@example.test" },
      reauth: { mode: "native-claude" },
      pool: { enabled: true },
    },
  };
  const policyOnly = {
    provider: "anthropic",
    label: "claude-candidate",
    credential: {},
    policy: {
      expect: { email: "claude-candidate@example.test" },
      pool: { enabled: true },
    },
    health: { status: "candidate", reason: "credential_missing" },
  };
  const runtime = await setup([
    freshCodex,
    terminalCodex,
    policyOnly,
    dueCodex,
    incompleteClaude,
    dueClaude,
  ]);
  const providerOrder = [];
  let codexRequests = 0;
  let claudeRuns = 0;

  const result = await runCliWithExitCode(
    ["auth", "maintain", "--home", runtime.home],
    {
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliNoninteractiveImpl: ({ configDir, args, env, timeoutMs }) => {
        providerOrder.push("anthropic:claude-due");
        claudeRuns += 1;
        assert.deepEqual(args, [
          "--safe-mode",
          "--strict-mcp-config",
          "--no-session-persistence",
          "--print",
          "--output-format",
          "json",
          "/usage",
        ]);
        assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, undefined);
        assert.equal(timeoutMs, 30_000);
        rotateProjectedClaudeCredential(configDir, {
          accessToken: "ACCESS_CLAUDE_ROTATED",
          refreshToken: "REFRESH_CLAUDE_ROTATED",
          expiresAt: NOW_MS + 2 * 60 * 60_000,
        });
        return { status: 0, signal: null, timedOut: false };
      },
      fetchJsonWithTimeoutImpl: async (url, init, timeoutMs) => {
        providerOrder.push("openai-codex:codex-due");
        codexRequests += 1;
        assert.equal(url, "https://auth.openai.com/oauth/token");
        assert.equal(timeoutMs, 8_000);
        const refresh = new URLSearchParams(init.body).get("refresh_token");
        assert.equal(refresh, "REFRESH_codex-due");
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: codexAccess("acct_codex-due"),
            refresh_token: "REFRESH_CODEX_ROTATED",
            expires_in: 7200,
          }),
        };
      },
    },
  );

  assert.deepEqual(result, {
    stdout:
      "provider=anthropic label=claude-candidate outcome=skipped reason=credential_missing\n"
      + "provider=anthropic label=claude-incomplete outcome=reauth_required reason=refresh_material_missing\n"
      + "provider=anthropic label=claude-due outcome=refreshed reason=credential_rotated\n"
      + "provider=openai-codex label=codex-terminal outcome=skipped reason=reauth_already_required\n"
      + "provider=openai-codex label=codex-due outcome=refreshed reason=credential_rotated\n"
      + "provider=openai-codex label=codex-fresh outcome=skipped reason=not_due\n"
      + "refreshed=2 unchanged=0 reauth_required=1 retryable=0 skipped=3\n",
    exitCode: 0,
  });
  assert.deepEqual(providerOrder, [
    "anthropic:claude-due",
    "openai-codex:codex-due",
  ]);
  assert.equal(claudeRuns, 1);
  assert.equal(codexRequests, 1);

  const snapshot = await readSnapshot(runtime.store);
  const byLabel = new Map(snapshot.credentials.map((record) => [record.label, record]));
  assert.equal(
    byLabel.get("claude-due").credential.nativeClaudeBundle.claudeAiOauth.refreshToken,
    "REFRESH_CLAUDE_ROTATED",
  );
  assert.equal(byLabel.get("codex-due").credential.refresh, "REFRESH_CODEX_ROTATED");
  assert.equal(
    byLabel.get("claude-incomplete").policy.reauth.blockedReason,
    "oauth_reauth_required",
  );
  assert.equal(byLabel.get("codex-fresh").version, 1);
  assert.equal(byLabel.get("codex-terminal").version, 1);
  assert.equal(byLabel.get("claude-candidate").version, 1);
  assert.equal(
    fs.existsSync(resolveClaudeAuthFilePath(
      path.join(resolveAimgrClaudeLabelHomeDir({
        homeDir: runtime.home,
        label: "claude-due",
      }), ".claude"),
    )),
    true,
  );
});

test("auth maintain marks incomplete Anthropic material under a same-label Codex collision", async () => {
  const incompleteClaude = claudeRecord("shared");
  incompleteClaude.credential = { access: "INCOMPLETE" };
  incompleteClaude.identity = {};
  const codexTwin = codexRecord("shared", {
    accountId: "acct_codex_shared",
    expiresAtMs: NOW_MS + 3 * 24 * 60 * 60_000,
  });
  const runtime = await setup([incompleteClaude, codexTwin]);
  const before = await readSnapshot(runtime.store);
  const beforeCodex = before.credentials.find(
    (record) => record.provider === "openai-codex" && record.label === "shared",
  );

  const result = await runCliWithExitCode(
    ["auth", "maintain", "--home", runtime.home],
    {
      env: {},
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
    },
  );
  assert.deepEqual(result, {
    stdout:
      "provider=anthropic label=shared outcome=reauth_required reason=refresh_material_missing\n"
      + "provider=openai-codex label=shared outcome=skipped reason=not_due\n"
      + "refreshed=0 unchanged=0 reauth_required=1 retryable=0 skipped=1\n",
    exitCode: 0,
  });

  const after = await readSnapshot(runtime.store);
  const afterAnthropic = after.credentials.find(
    (record) => record.provider === "anthropic" && record.label === "shared",
  );
  const afterCodex = after.credentials.find(
    (record) => record.provider === "openai-codex" && record.label === "shared",
  );
  assert.equal(afterAnthropic.version, 2);
  assert.deepEqual(afterAnthropic.policy.expect, incompleteClaude.policy.expect);
  assert.equal(afterAnthropic.policy.reauth.mode, "native-claude");
  assert.equal(afterAnthropic.policy.reauth.blockedReason, "oauth_reauth_required");
  assert.deepEqual(afterCodex, beforeCodex);
});

test("auth maintain continues after transient and stale-CAS failures while a busy lease skips", async () => {
  const records = [
    codexRecord("network", { expiresAtMs: NOW_MS + 60_000 }),
    codexRecord("cas", { expiresAtMs: NOW_MS + 2 * 60_000 }),
    codexRecord("busy", { expiresAtMs: NOW_MS + 3 * 60_000 }),
    codexRecord("invalid", { expiresAtMs: NOW_MS + 4 * 60_000 }),
    codexRecord("later", { expiresAtMs: NOW_MS + 5 * 60_000 }),
  ];
  const runtime = await setup(records);
  const busyLease = await acquireRedisCredentialLease(runtime.store, {
    provider: "openai-codex",
    label: "busy",
  });
  const attempted = [];

  const result = await runCliWithExitCode(
    ["auth", "maintain", "--home", runtime.home],
    {
      env: {},
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
      fetchJsonWithTimeoutImpl: async (_url, init) => {
        const refresh = new URLSearchParams(init.body).get("refresh_token");
        const label = refresh.replace("REFRESH_", "");
        attempted.push(label);
        if (label === "network") {
          throw new Error("network unavailable");
        }
        if (label === "cas") {
          const snapshot = await readSnapshot(runtime.store);
          const current = snapshot.credentials.find((record) => record.label === "cas");
          const concurrent = {
            ...current,
            credential: {
              ...current.credential,
              access: codexAccess("acct_cas"),
              refresh: "REFRESH_CONCURRENT",
              idToken: codexAccess("acct_cas"),
              expiresAt: new Date(NOW_MS + 6 * 60 * 60_000).toISOString(),
            },
          };
          const published = await publishCredential(runtime.store, {
            expectedVersion: current.version,
            updatedBy: "concurrent-test",
            observedAt: new Date(NOW_MS).toISOString(),
            credentialRecord: concurrent,
          });
          assert.equal(published.ok, true);
        }
        if (label === "invalid") {
          return {
            ok: false,
            status: 400,
            json: async () => ({ error: "invalid_grant" }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: codexAccess(`acct_${label}`),
            refresh_token: `REFRESH_ROTATED_${label}`,
            expires_in: 7200,
          }),
        };
      },
    },
  );
  assert.equal(await busyLease.release(), true);

  assert.deepEqual(result, {
    stdout:
      "provider=openai-codex label=network outcome=retryable reason=maintenance_failed detail=\"network unavailable\"\n"
      + "provider=openai-codex label=cas outcome=retryable reason=maintenance_failed detail=\"AIM credential coordination is unavailable.\"\n"
      + "provider=openai-codex label=busy outcome=skipped reason=lease_busy\n"
      + "provider=openai-codex label=invalid outcome=reauth_required reason=refresh_rejected\n"
      + "provider=openai-codex label=later outcome=refreshed reason=credential_rotated\n"
      + "refreshed=1 unchanged=0 reauth_required=1 retryable=2 skipped=1\n",
    exitCode: 0,
  });
  assert.deepEqual(attempted, ["network", "cas", "invalid", "later"]);
  const snapshot = await readSnapshot(runtime.store);
  const byLabel = new Map(snapshot.credentials.map((record) => [record.label, record]));
  assert.equal(byLabel.get("cas").credential.refresh, "REFRESH_CONCURRENT");
  assert.equal(byLabel.get("cas").version, 2);
  assert.equal(byLabel.get("invalid").policy.reauth.blockedReason, "oauth_reauth_required");
  assert.equal(byLabel.get("later").credential.refresh, "REFRESH_ROTATED_later");
  assert.equal(byLabel.get("later").version, 2);
  assert.equal(byLabel.get("busy").version, 1);
});

test("auth maintain still fails the run when the coordination store is unavailable", async () => {
  const home = mkTempHome();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });

  await assert.rejects(
    runCliWithExitCode(
      ["auth", "maintain", "--home", home],
      {
        env: {},
        nowImpl: () => NOW_MS,
        connectRedisStoreImpl: () => {
          throw new Error("redis unreachable");
        },
      },
    ),
    /redis unreachable/,
  );
});


test("auth maintain durably marks incomplete Codex refresh material under the shared leased owner", async () => {
  const incomplete = codexRecord("codex-incomplete", { expiresAtMs: NOW_MS + 60 * 60_000 });
  delete incomplete.credential.refresh;
  const runtime = await setup([incomplete]);
  let providerRequests = 0;
  const result = await runCliWithExitCode(
    ["auth", "maintain", "--home", runtime.home],
    {
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
      fetchJsonWithTimeoutImpl: async () => {
        providerRequests += 1;
        throw new Error("provider should not be called");
      },
    },
  );
  assert.deepEqual(result, {
    stdout:
      "provider=openai-codex label=codex-incomplete outcome=reauth_required reason=refresh_material_missing\n"
      + "refreshed=0 unchanged=0 reauth_required=1 retryable=0 skipped=0\n",
    exitCode: 0,
  });
  assert.equal(providerRequests, 0);
  const snapshot = await readSnapshot(runtime.store);
  assert.equal(snapshot.credentials[0].policy.reauth.blockedReason, "oauth_reauth_required");
  assert.equal(snapshot.credentials[0].version, 2);
});
