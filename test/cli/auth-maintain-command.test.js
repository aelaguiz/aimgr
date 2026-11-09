import { readClaudeOfflineBinding, invalidateClaudeOfflineBinding } from "../../src/network/claude-offline-binding.js";
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import {
  connectRedisStore,
  importCredentialsSnapshot,
  publishCredential,
  readSnapshot,
  REDIS_CONNECTION_POLICY_LEASED,
} from "../../src/coordination/redis-store.js";
import {
  resolveAimgrClaudeLabelHomeDir,
  resolveClaudeAuthFilePath,
} from "../../src/io/paths.js";
import { registerCliRedisFixture, runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

import { readLocalCodexCredential } from "../../src/credentials/codex-local.js";
import { localCodexFixture, CODEX_TEST_ENVIRONMENT, readCodexTestEnvironment } from "../helpers/codex-local.js";

const NOW_MS = Date.parse("2026-07-24T12:00:00.000Z");
const PREFIX = "aimgr:auth-maintain-test";

function codexAccess(accountId, expiresAtMs = Date.now() + 3_600_000) {
  return makeFakeJwt({
    exp: Math.floor(expiresAtMs / 1000),
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
      egress: { profileRef: "test" },
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
  // Only an explicitly provisioned fixture may contribute local Codex grants.
  registerCliRedisFixture(home, { readCodexEnvironmentImpl: () => null });
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX }, claudeProxyProfiles: { test: { socksPort: 1085, expectedExits: ["127.0.0.2"] } } },
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

test("auth maintain refreshes Claude and only local Codex grants without reading legacy tokens", async t => {
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
  t.after(() => fs.rmSync(runtime.home, { recursive: true, force: true }));
  registerCliRedisFixture(runtime.home, { readCodexEnvironmentImpl: readCodexTestEnvironment });
  localCodexFixture(runtime.home, "acct_codex-due", {
    ...dueCodex.credential,
    access: codexAccess("acct_codex-due", Date.now() - 60_000),
  });
  const legacyBefore = await Promise.all([dueCodex, freshCodex, terminalCodex].map(record => runtime.client.get(runtime.store.keys.credential(record))));
  const replies = [], reads = [], originalEval = runtime.client.eval.bind(runtime.client);
  runtime.client.eval = async (...args) => {
    const reply = await originalEval(...args); replies.push(reply); return reply;
  };
  for (const method of ["get", "mGet"]) {
    const original = runtime.client[method].bind(runtime.client);
    runtime.client[method] = async (...args) => {
      reads.push(...args.flat());
      return original(...args);
    };
  }
  const providerOrder = [];
  let codexRequests = 0;
  let claudeRuns = 0;

  const result = await runCliWithExitCode(
    ["auth", "maintain", "--home", runtime.home],
    {
      env: { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1" },
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: options => {
        assert.equal(options.connectionPolicy, REDIS_CONNECTION_POLICY_LEASED,
          "native maintenance must retain Redis through admission, refresh and publication");
        return runtime.connectRedisStoreImpl(options);
      },
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
        assert.equal(refresh, "LOCAL_REFRESH_codex-due");
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
      + "provider=openai-codex authority=environment-local label=codex-due outcome=refreshed reason=ready\n"
      + "provider=openai-codex authority=environment-local label=codex-fresh outcome=skipped reason=login_required\n"
      + "provider=openai-codex authority=environment-local label=codex-terminal outcome=skipped reason=login_required\n"
      + "refreshed=2 unchanged=0 reauth_required=1 retryable=0 skipped=3\n",
    exitCode: 0,
  });
  assert.deepEqual(providerOrder, [
    "anthropic:claude-due",
    "openai-codex:codex-due",
  ]);
  assert.equal(claudeRuns, 1);
  assert.equal(codexRequests, 1);

  assert.ok(replies.filter(reply => typeof reply === "string").length > 1,
    "the command must preserve its server-side projection across Claude snapshot refreshes");
  assert.equal(JSON.stringify(replies).includes("REFRESH_codex"), false);
  assert.equal(reads.some(key => String(key).includes("credential:openai-codex:")), false,
    "no client GET or MGET may retrieve a legacy Codex grant");
  const legacyAfter = await Promise.all([dueCodex, freshCodex, terminalCodex].map(record => runtime.client.get(runtime.store.keys.credential(record))));
  assert.deepEqual(legacyAfter, legacyBefore);
  assert.equal(readLocalCodexCredential({ homeDir: runtime.home, environment: CODEX_TEST_ENVIRONMENT,
    accountId: "acct_codex-due" }).credential.refresh, "REFRESH_CODEX_ROTATED");
  const snapshot = await readSnapshot(runtime.store);
  const byLabel = new Map(snapshot.credentials.map((record) => [record.label, record]));
  assert.equal(
    byLabel.get("claude-due").credential.nativeClaudeBundle.claudeAiOauth.refreshToken,
    "REFRESH_CLAUDE_ROTATED",
  );
  assert.equal(byLabel.get("codex-due").credential.refresh, "REFRESH_codex-due");
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
      + "refreshed=0 unchanged=0 reauth_required=1 retryable=0 skipped=0\n",
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

test("local Codex maintenance continues after a network failure and rejected grant", async t => {
  const labels = ["invalid", "later", "network"];
  const runtime = await setup(labels.map(label => codexRecord(label)));
  t.after(() => fs.rmSync(runtime.home, { recursive: true, force: true }));
  registerCliRedisFixture(runtime.home, { readCodexEnvironmentImpl: readCodexTestEnvironment });
  for (const label of labels) localCodexFixture(runtime.home, `acct_${label}`, {
    ...codexRecord(label).credential, access: codexAccess(`acct_${label}`, Date.now() - 60_000),
  });
  const before = await readSnapshot(runtime.store), attempted = [];
  const result = await runCliWithExitCode(["auth", "maintain", "--home", runtime.home], {
    env: {}, nowImpl: () => NOW_MS, connectRedisStoreImpl: runtime.connectRedisStoreImpl,
    fetchJsonWithTimeoutImpl: async (_url, init) => {
      const refresh = new URLSearchParams(init.body).get("refresh_token");
      assert.ok(refresh.startsWith("LOCAL_REFRESH_"));
      const label = refresh.slice("LOCAL_REFRESH_".length); attempted.push(label);
      if (label === "network") throw new Error("synthetic network unavailable");
      if (label === "invalid") return { ok: false, status: 400, json: async () => ({ error: "invalid_grant" }) };
      return { ok: true, status: 200, json: async () => ({ access_token: codexAccess(`acct_${label}`),
        refresh_token: `LOCAL_ROTATED_${label}` }) };
    },
  });
  assert.equal(result.exitCode, 0);
  assert.match(result.stdout, /label=invalid outcome=reauth_required reason=reauth_required/);
  assert.match(result.stdout, /label=later outcome=refreshed reason=ready/);
  assert.match(result.stdout, /label=network outcome=retryable reason=maintenance_failed/);
  assert.match(result.stdout, /refreshed=1 unchanged=0 reauth_required=1 retryable=1 skipped=0/);
  assert.deepEqual(attempted, labels);
  assert.deepEqual((await readSnapshot(runtime.store)).credentials, before.credentials,
    "local refresh and rejection must leave shared credentials and health unchanged");
  const local = label => readLocalCodexCredential({ homeDir: runtime.home,
    environment: CODEX_TEST_ENVIRONMENT, accountId: `acct_${label}` });
  assert.equal(local("invalid").status, "reauth_required");
  assert.equal(local("later").credential.refresh, "LOCAL_ROTATED_later");
  assert.equal(local("network").credential.refresh, "LOCAL_REFRESH_network");
});

test("auth maintain still fails the run when the coordination store is unavailable", async () => {
  const home = mkTempHome();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX }, claudeProxyProfiles: { test: { socksPort: 1085, expectedExits: ["127.0.0.2"] } } },
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


test("auth maintain leaves incomplete legacy Codex material untouched without a local environment", async () => {
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
      "refreshed=0 unchanged=0 reauth_required=0 retryable=0 skipped=0\n",
    exitCode: 0,
  });
  assert.equal(providerRequests, 0);
  const snapshot = await readSnapshot(runtime.store);
  assert.equal(snapshot.credentials[0].policy.reauth?.blockedReason, undefined);
  assert.equal(snapshot.credentials[0].version, 1);
});


test("ordinary Claude maintenance refreshes with no proxy configuration and preserves ordinary environment", async () => {
  const record = claudeRecord("ordinary");
  delete record.policy.egress;
  const runtime = await setup([record]);
  writeAimgrConfig({ homeDir: runtime.home, config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } } });
  let runs = 0;
  try {
    const result = await runCliWithExitCode(["auth", "maintain", "--home", runtime.home], {
      nowImpl: () => NOW_MS,
      env: { HTTPS_PROXY: "http://ordinary.example:3128", DISABLE_TELEMETRY: "0" },
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
      resolveExecutableOnPathImpl: buildTestClaudeResolver(),
      runClaudeCliNoninteractiveImpl: ({ configDir, egressProfile, env }) => {
        runs++;
        assert.equal(egressProfile, null);
        assert.equal(env.HTTPS_PROXY, "http://ordinary.example:3128");
        assert.equal(env.DISABLE_TELEMETRY, "0");
        rotateProjectedClaudeCredential(configDir, { accessToken: "ORDINARY_ROTATED", refreshToken: "ORDINARY_REFRESH_ROTATED", expiresAt: NOW_MS + 7_200_000 });
        return { status: 0, signal: null, timedOut: false };
      },
    });
    assert.equal(result.exitCode, 0);
    assert.match(result.stdout, /label=ordinary outcome=refreshed/);
    assert.equal(runs, 1);
    assert.equal((await readSnapshot(runtime.store)).credentials[0].policy.egress, undefined);
  } finally { fs.rmSync(runtime.home, { recursive: true, force: true }); }
});


for (const scenario of ["missing-profile", "blocked", "missing-credential"]) {
  // Each case starts with a usable ordinary cache, then observes a remote opt-in.
  // Even paths that skip maintenance must leave that cache unable to launch direct.
  test(`maintenance remembers remote opt-in before ${scenario} can expose its old ordinary cache`, async () => {
    const record = claudeRecord("ordinary"); delete record.policy.egress;
    const runtime = await setup([record]);
    const deps = { nowImpl: () => NOW_MS, connectRedisStoreImpl: runtime.connectRedisStoreImpl, resolveExecutableOnPathImpl: buildTestClaudeResolver() };
    try {
      await runCli(["claude", "run", "ordinary", "--home", runtime.home], { ...deps, runClaudeCliImpl: () => ({ status: 0, signal: null }) });
      assert.equal(readClaudeOfflineBinding(runtime.home, "ordinary"), null);
      const current = (await readSnapshot(runtime.store)).credentials[0];
      const protectedRecord = { ...current,
        credential: scenario === "missing-credential" ? {} : current.credential,
        policy: { ...current.policy,
          reauth: scenario === "blocked" ? { blockedReason: "oauth_reauth_required" } : {},
          egress: { profileRef: "not-installed" } },
      };
      assert.equal((await publishCredential(runtime.store, { expectedVersion: current.version,
        credentialRecord: protectedRecord, updatedBy: "explicit-opt-in" })).ok, true);
      const result = await runCliWithExitCode(["auth", "maintain", "--home", runtime.home], {
        ...deps, runClaudeCliNoninteractiveImpl: () => { throw new Error("invalid protected config reached child launch"); },
      });
      const expected = scenario === "missing-profile" ? "outcome=retryable reason=proxy_unavailable"
        : scenario === "blocked" ? "outcome=skipped reason=reauth_already_required"
        : "outcome=skipped reason=credential_missing";
      assert.ok(result.stdout.includes(`label=ordinary ${expected}`), result.stdout);
      assert.deepEqual(readClaudeOfflineBinding(runtime.home, "ordinary"), { required: true, invalidated: true });
      await assert.rejects(runCli(["claude", "run", "ordinary", "--home", runtime.home], {
        ...deps, connectRedisStoreImpl: async () => { throw new Error("Redis offline"); },
        runClaudeCliImpl: () => { throw new Error("protected cache reached ordinary child launch"); },
      }), /cached proxy assignment/);
    } finally { fs.rmSync(runtime.home, { recursive: true, force: true }); }
  });
}


test("maintenance losing its lease during preflight cannot restore an invalidated protected cache", async () => {
  const runtime = await setup([claudeRecord("protected")]);
  let inspected = false;
  try {
    const result = await runCliWithExitCode(["auth", "maintain", "--home", runtime.home], {
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: runtime.connectRedisStoreImpl,
      resolveExecutableOnPathImpl: () => {
        inspected = true;
        runtime.client.advanceTime(60_001);
        invalidateClaudeOfflineBinding(runtime.home, "protected");
        return process.execPath;
      },
      runClaudeCliNoninteractiveImpl: () => { throw new Error("lost lease reached native launch"); },
    });
    assert.equal(inspected, true);
    assert.match(result.stdout, /outcome=retryable reason=lease_release_failed/);
    assert.deepEqual(readClaudeOfflineBinding(runtime.home, "protected"), { required: true, invalidated: true });
  } finally { fs.rmSync(runtime.home, { recursive: true, force: true }); }
});
