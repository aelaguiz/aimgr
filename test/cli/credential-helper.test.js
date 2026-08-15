import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { readHeldRedisCredentialLeaseLabels } from "../../src/coordination/redis-credential-lease.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { buildHarnessIdentityFingerprint } from "../../src/credentials/harness-access.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

async function helperFixture({ automaticFailoverApproved = false, extraCredentials = [] } = {}) {
  const homeDir = mkTempHome();
  const client = new FakeRedisClient();
  const keyPrefix = `aimgr:helper:${Math.random().toString(16).slice(2)}:`;
  const access = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_alpha" } });
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix } } });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, {
    credentials: [{
      provider: "openai-codex",
      label: "alpha",
      credential: {
        access,
        refresh: "NEVER_RETURN_REFRESH",
        idToken: access,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        accountId: "acct_alpha",
      },
      identity: { accountId: "acct_alpha" },
      policy: {
        reauth: {},
        pool: {
          enabled: true,
          ...(automaticFailoverApproved ? { automaticFailoverApproved: true } : {}),
        },
      },
      health: { status: "ready", reason: null },
    }, ...extraCredentials],
  }, { updatedBy: "test" });
  const snapshot = await readSnapshot(store);
  const request = {
    schemaVersion: 1,
    operation: "resolve",
    provider: "openai-codex",
    binding: "alpha",
    expectedIdentityFingerprint: buildHarnessIdentityFingerprint(snapshot.credentials[0]),
  };
  return {
    homeDir,
    access,
    request,
    client,
    keyPrefix,
    store,
    credentialVersion: snapshot.credentials[0].version,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
  };
}

test("credential-helper accepts one bounded stdin object and emits access only", async () => {
  const fixture = await helperFixture();
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify(fixture.request)]),
    connectRedisStoreImpl: fixture.connectRedisStoreImpl,
  });
  assert.equal(result.exitCode, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(response.ok, true);
  assert.equal(response.accessToken, fixture.access);
  assert.equal(response.binding, "alpha");
  assert.equal(typeof response.credentialVersion, "number");
  assert.equal("refreshToken" in response, false);
  assert.equal("refresh" in response, false);
  assert.doesNotMatch(result.stdout, /NEVER_RETURN_REFRESH|acct_alpha/);
});

test("credential-helper rejects legacy requestId/minValidity and malformed or oversized input", async () => {
  const fixture = await helperFixture();
  for (const payload of [
    { ...fixture.request, requestId: "legacy" },
    { ...fixture.request, minValidityMs: 60_000 },
    { ...fixture.request, schemaVersion: 2 },
    { ...fixture.request, operation: "resolve", reason: "usage_limit_reached" },
    { ...fixture.request, operation: "advance", reason: "rate_limit_exceeded" },
    { ...fixture.request, operation: "advance", provider: "anthropic", reason: "usage_limit_reached" },
    { ...fixture.request, operation: "advance", provider: "xai", reason: "usage_limit_reached" },
    "not-json",
    `${JSON.stringify(fixture.request)}${" ".repeat(9 * 1024)}`,
  ]) {
    const raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    const result = await runCliWithExitCode(["credential-helper"], {
      env: { HOME: fixture.homeDir },
      stdin: Readable.from([raw]),
      connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    });
    assert.equal(result.exitCode, 1);
    const response = JSON.parse(result.stdout);
    assert.deepEqual(response, {
      schemaVersion: 1,
      ok: false,
      code: "protocol_mismatch",
      message: "The AIM credential helper protocol request is invalid.",
      action: "Update AIM and the calling harness to compatible versions.",
    });
    assert.doesNotMatch(result.stdout, /NEVER_RETURN_REFRESH/);
  }
});

test("credential-helper refuses TTY and missing stdin without prompting", async () => {
  const fixture = await helperFixture();
  const tty = new PassThrough();
  tty.isTTY = true;
  tty.end(JSON.stringify(fixture.request));
  for (const stdin of [tty, Readable.from([])]) {
    const result = await runCliWithExitCode(["credential-helper"], {
      env: { HOME: fixture.homeDir },
      stdin,
      connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    });
    assert.equal(result.exitCode, 1);
    assert.equal(JSON.parse(result.stdout).code, "protocol_mismatch");
  }
});

test("credential-helper maps Redis internals to a fixed redacted coordination error", async () => {
  const homeDir = mkTempHome();
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix: "aimgr:redact:" } } });
  const request = {
    schemaVersion: 1,
    operation: "resolve",
    provider: "openai-codex",
    binding: "alpha",
    expectedIdentityFingerprint: "aimgr-id-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
  };
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: homeDir },
    stdin: Readable.from([JSON.stringify(request)]),
    connectRedisStoreImpl: async () => {
      throw new Error("rediss://alice:TOP_SECRET@example.test?token=LEAK");
    },
  });
  assert.equal(result.exitCode, 1);
  const response = JSON.parse(result.stdout);
  assert.equal(response.code, "coordination_unavailable");
  assert.doesNotMatch(result.stdout, /alice|TOP_SECRET|LEAK|rediss:/);
});


test("credential-helper reports missing HOME through the fixed protocol", async () => {
  const result = await runCliWithExitCode(["credential-helper"], {
    env: {},
    stdin: Readable.from(["{}"]),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).code, "coordination_unavailable");
});


test("credential-helper honors rejectedCredentialVersion by rotating the exact current version once", async () => {
  const fixture = await helperFixture();
  const rotatedAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_alpha" },
    rotation: 2,
  });
  let requests = 0;
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify({
      ...fixture.request,
      rejectedCredentialVersion: fixture.credentialVersion,
    })]),
    connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    fetchJsonWithTimeoutImpl: async () => {
      requests += 1;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: rotatedAccess,
          refresh_token: "ROTATED_REFRESH_MUST_NOT_ESCAPE",
          expires_in: 3600,
        }),
      };
    },
  });
  assert.equal(result.exitCode, 0);
  const response = JSON.parse(result.stdout);
  assert.equal(requests, 1);
  assert.equal(response.credentialVersion, fixture.credentialVersion + 1);
  assert.equal(response.accessToken, rotatedAccess);
  assert.doesNotMatch(result.stdout, /ROTATED_REFRESH_MUST_NOT_ESCAPE/);
});

test("credential-helper advance returns one different eligible policy-approved Codex credential read-only", async () => {
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  const gammaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_gamma" },
  });
  const expiresAt = new Date(Date.now() + 60 * 60_000).toISOString();
  const fixture = await helperFixture({
    automaticFailoverApproved: true,
    extraCredentials: [
      {
        provider: "openai-codex",
        label: "beta",
        credential: {
          access: betaAccess,
          refresh: "BETA_REFRESH_MUST_NOT_ESCAPE",
          idToken: betaAccess,
          expiresAt,
          accountId: "acct_beta",
        },
        identity: { accountId: "acct_beta" },
        policy: { reauth: {}, pool: { enabled: true } },
        health: { status: "ready", reason: null },
      },
      {
        provider: "openai-codex",
        label: "gamma",
        credential: {
          access: gammaAccess,
          refresh: "GAMMA_REFRESH_MUST_NOT_ESCAPE",
          idToken: gammaAccess,
          expiresAt,
          accountId: "acct_gamma",
        },
        identity: { accountId: "acct_gamma" },
        policy: {
          reauth: {},
          pool: { enabled: true, automaticFailoverApproved: true },
        },
        health: { status: "ready", reason: null },
      },
    ],
  });
  const before = await readSnapshot(fixture.store);
  let probedLabels = null;
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify({
      ...fixture.request,
      operation: "advance",
      reason: "usage_limit_reached",
    })]),
    connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async (state) => {
      probedLabels = Object.keys(state.credentials["openai-codex"]);
      return {
        "openai-codex": {
          gamma: {
            ok: true,
            windows: [
              { kind: "primary", usedPercent: 20 },
              { kind: "secondary", usedPercent: 20 },
            ],
          },
        },
      };
    },
  });
  assert.equal(result.exitCode, 0);
  const response = JSON.parse(result.stdout);
  const gammaRecord = before.credentials.find((record) => record.label === "gamma");
  assert.deepEqual(probedLabels, ["gamma"]);
  assert.equal(response.ok, true);
  assert.equal(response.provider, "openai-codex");
  assert.equal(response.binding, "gamma");
  assert.equal(response.identityFingerprint, buildHarnessIdentityFingerprint(gammaRecord));
  assert.equal(response.accessToken, gammaAccess);
  assert.notEqual(response.binding, fixture.request.binding);
  assert.doesNotMatch(
    result.stdout,
    /BETA_REFRESH_MUST_NOT_ESCAPE|GAMMA_REFRESH_MUST_NOT_ESCAPE|acct_beta|acct_gamma/,
  );
  assert.deepEqual((await readSnapshot(fixture.store)).credentials, before.credentials);
});

test("credential-helper advance is default-deny when the current pool is not policy-approved", async () => {
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  const fixture = await helperFixture({
    extraCredentials: [{
      provider: "openai-codex",
      label: "beta",
      credential: {
        access: betaAccess,
        refresh: "BETA_REFRESH_MUST_NOT_ESCAPE",
        idToken: betaAccess,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        accountId: "acct_beta",
      },
      identity: { accountId: "acct_beta" },
      policy: {
        reauth: {},
        pool: { enabled: true, automaticFailoverApproved: true },
      },
      health: { status: "ready", reason: null },
    }],
  });
  let probes = 0;
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify({
      ...fixture.request,
      operation: "advance",
      reason: "usage_limit_reached",
    })]),
    connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      probes += 1;
      return {};
    },
  });
  assert.equal(result.exitCode, 1);
  assert.equal(probes, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    schemaVersion: 1,
    ok: false,
    code: "automatic_failover_disabled",
    message: "Automatic AIM credential failover is disabled for this pool.",
    action: "Use manual credential handoff unless the provider-approved pool policy is enabled.",
  });
  assert.doesNotMatch(result.stdout, /BETA_REFRESH_MUST_NOT_ESCAPE/);
});

test("credential-helper advance reports no eligible account when every approved alternate is exhausted", async () => {
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  const fixture = await helperFixture({
    automaticFailoverApproved: true,
    extraCredentials: [{
      provider: "openai-codex",
      label: "beta",
      credential: {
        access: betaAccess,
        refresh: "BETA_REFRESH_MUST_NOT_ESCAPE",
        idToken: betaAccess,
        expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
        accountId: "acct_beta",
      },
      identity: { accountId: "acct_beta" },
      policy: {
        reauth: {},
        pool: { enabled: true, automaticFailoverApproved: true },
      },
      health: { status: "ready", reason: null },
    }],
  });
  const before = await readSnapshot(fixture.store);
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify({
      ...fixture.request,
      operation: "advance",
      reason: "usage_limit_reached",
    })]),
    connectRedisStoreImpl: fixture.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        beta: {
          ok: true,
          windows: [
            { kind: "primary", usedPercent: 100 },
            { kind: "secondary", usedPercent: 100 },
          ],
        },
      },
    }),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).code, "no_eligible_account");
  assert.doesNotMatch(result.stdout, /BETA_REFRESH_MUST_NOT_ESCAPE/);
  assert.deepEqual((await readSnapshot(fixture.store)).credentials, before.credentials);
});

test("credential-helper closes a connected Redis store when local runtime loading fails", async () => {
  const fixture = await helperFixture();
  fs.writeFileSync(path.join(fixture.homeDir, ".aimgr", "local-state.json"), "{broken-json");
  let quits = 0;
  fixture.client.quit = async () => {
    quits += 1;
    fixture.client.isOpen = false;
  };
  const ownedStore = { ...fixture.store, ownsClient: true };
  const signalEmitter = new EventEmitter();
  const result = await runCliWithExitCode(["credential-helper"], {
    env: { HOME: fixture.homeDir },
    stdin: Readable.from([JSON.stringify(fixture.request)]),
    connectRedisStoreImpl: async () => ownedStore,
    signalEmitter,
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).code, "coordination_unavailable");
  assert.equal(quits, 1);
  assert.equal(fixture.client.isOpen, false);
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
});


test("credential-helper SIGTERM aborts Claude maintenance and releases the exact Redis lease", async () => {
  const homeDir = mkTempHome();
  const client = new FakeRedisClient();
  const keyPrefix = `aimgr:helper-signal:${Math.random().toString(16).slice(2)}:`;
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
    expiresAtMs: Date.now() + 30_000,
    emailAddress: "signal@example.test",
    organizationUuid: "org_signal",
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = "acct_signal";
  const record = {
    provider: "anthropic",
    label: "signal",
    credential,
    identity: buildStableIdentityForCredential("anthropic", credential),
    policy: {
      expect: { email: "signal@example.test" },
      reauth: { mode: "native-claude" },
      pool: { enabled: true },
    },
    health: { status: "ready", reason: null },
  };
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix } } });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: [record] }, { updatedBy: "test" });
  const snapshot = await readSnapshot(store);
  const request = {
    schemaVersion: 1,
    operation: "resolve",
    provider: "anthropic",
    binding: "signal",
    expectedIdentityFingerprint: buildHarnessIdentityFingerprint(snapshot.credentials[0]),
  };
  const signalEmitter = new EventEmitter();
  const resolver = () => process.execPath;
  resolver.prepareClaudeCliLaunchImpl = ({ command, userHomeDir, homeDir, configDir }) => ({
    command: path.resolve(command),
    userHomeDir,
    homeDir,
    configDir,
  });
  const cliPromise = runCliWithExitCode(["credential-helper"], {
    env: { HOME: homeDir },
    stdin: Readable.from([JSON.stringify(request)]),
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
    resolveExecutableOnPathImpl: resolver,
    signalEmitter,
    runClaudeCliNoninteractiveImpl: ({ signal }) => new Promise((resolve, reject) => {
      const abort = () => {
        const error = new Error("aborted maintenance");
        error.name = "AbortError";
        reject(error);
      };
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }),
  });
  const earlyResult = await Promise.race([
    cliPromise,
    new Promise((resolve) => setTimeout(() => resolve(null), 100)),
  ]);
  assert.equal(earlyResult, null, `helper exited before maintenance: ${JSON.stringify(earlyResult)}`);
  let heldLabels = [];
  const leaseDeadline = Date.now() + 2_000;
  while (Date.now() < leaseDeadline) {
    heldLabels = [...await readHeldRedisCredentialLeaseLabels(store, {
      provider: "anthropic",
      labels: ["signal"],
    })];
    if (heldLabels.length > 0) break;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.deepEqual(heldLabels, ["signal"]);
  signalEmitter.emit("SIGTERM");
  const result = await cliPromise;
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).code, "helper_timeout");
  assert.equal(signalEmitter.listenerCount("SIGTERM"), 0);
  assert.deepEqual(
    [...await readHeldRedisCredentialLeaseLabels(store, {
      provider: "anthropic",
      labels: ["signal"],
    })],
    [],
  );
});
