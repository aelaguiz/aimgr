import test from "node:test";
import assert from "node:assert/strict";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { loadRedisRuntime, closeRedisRuntime } from "../../src/coordination/runtime.js";
import {
  buildHarnessIdentityFingerprint,
  HarnessCredentialError,
  resolveHarnessAccessCredential,
} from "../../src/credentials/harness-access.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";

async function runtimeFor(records) {
  const homeDir = mkTempHome();
  const keyPrefix = `aimgr:harness:${Math.random().toString(16).slice(2)}:`;
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir,
    config: { redis: { url: "redis://fake:6379", keyPrefix } },
  });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: records }, { updatedBy: "test" });
  writeLocalState({ homeDir, localState: {} });
  const connectRedisStoreImpl = () => connectRedisStore({ client, keyPrefix });
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  return { homeDir, client, keyPrefix, store, runtime, connectRedisStoreImpl };
}

function codexRecord(label, {
  access = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: `acct_${label}` } }),
  refresh = `refresh_${label}`,
  expiresAt = new Date(Date.now() + 60 * 60_000).toISOString(),
} = {}) {
  return {
    provider: "openai-codex",
    label,
    credential: { access, refresh, expiresAt, accountId: `acct_${label}`, idToken: access },
    identity: { accountId: `acct_${label}` },
    policy: { reauth: {}, pool: { enabled: true } },
    health: { status: "ready", reason: null },
  };
}

test("fresh exact-label access resolution is lock-free, opaque, and access-only", async () => {
  const fixture = await runtimeFor([
    codexRecord("alpha"),
    {
      provider: "anthropic",
      label: "fable",
      credential: buildAnthropicClaudeCredential({ expiresAtMs: Date.now() + 60 * 60_000 }),
      identity: { accountUuid: "acct_boss", emailAddress: "boss@example.com", organizationUuid: "org_boss" },
      policy: { reauth: {}, pool: { enabled: true } },
      health: { status: "ready", reason: null },
    },
  ]);
  try {
    for (const provider of ["openai-codex", "anthropic"]) {
      const label = provider === "openai-codex" ? "alpha" : "fable";
      const record = fixture.runtime.snapshot.credentials.find(
        (entry) => entry.provider === provider && entry.label === label,
      );
      const result = await resolveHarnessAccessCredential({ nowMs: Date.now() }, {
        runtime: fixture.runtime,
        provider,
        binding: label,
        expectedIdentityFingerprint: buildHarnessIdentityFingerprint(record),
      });
      assert.equal(result.ok, true);
      assert.equal(result.provider, provider);
      assert.equal(result.binding, label);
      assert.match(result.identityFingerprint, /^aimgr-id-v1:/);
      assert.equal(typeof result.accessToken, "string");
      assert.equal("refreshToken" in result, false);
      assert.equal("refresh" in result, false);
      assert.equal("credential" in result, false);
      assert.doesNotMatch(JSON.stringify(result), /boss@example\.com|acct_boss|refresh_/);
    }
  } finally {
    await closeRedisRuntime(fixture.runtime);
  }
});

test("50 due resolves serialize one Codex refresh and stale callers fail with lease_busy", async () => {
  const nowMs = Date.now();
  const initial = codexRecord("alpha", { expiresAt: new Date(nowMs + 30_000).toISOString() });
  const fixture = await runtimeFor([initial]);
  const record = fixture.runtime.snapshot.credentials[0];
  const fingerprint = buildHarnessIdentityFingerprint(record);
  const nextAccess = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_alpha" } });
  let refreshes = 0;
  const context = {
    runtime: fixture.runtime,
    nowMs,
    fetchJsonWithTimeoutImpl: async () => {
      refreshes += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: nextAccess,
          refresh_token: "refresh_rotated",
          expires_in: 3600,
        }),
      };
    },
  };
  try {
    const settled = await Promise.allSettled(Array.from({ length: 50 }, () => (
      resolveHarnessAccessCredential(context, {
        runtime: fixture.runtime,
        provider: "openai-codex",
        binding: "alpha",
        expectedIdentityFingerprint: fingerprint,
      })
    )));
    assert.equal(refreshes, 1);
    assert.equal(settled.filter((entry) => entry.status === "fulfilled").length, 1);
    const failures = settled.filter((entry) => entry.status === "rejected");
    assert.equal(failures.length, 49);
    assert.ok(failures.every((entry) => entry.reason instanceof HarnessCredentialError));
    assert.ok(failures.every((entry) => entry.reason.code === "lease_busy"));
    const snapshot = await readSnapshot(fixture.store);
    assert.equal(snapshot.credentials[0].version, 2);
    assert.equal(snapshot.credentials[0].credential.refresh, "refresh_rotated");
  } finally {
    await closeRedisRuntime(fixture.runtime);
  }
});

test("different Codex labels maintain in parallel while identity changes fail closed", async () => {
  const nowMs = Date.now();
  const fixture = await runtimeFor([
    codexRecord("alpha", { expiresAt: new Date(nowMs + 30_000).toISOString() }),
    codexRecord("beta", { expiresAt: new Date(nowMs + 30_000).toISOString() }),
  ]);
  let active = 0;
  let maxActive = 0;
  const fetchJsonWithTimeoutImpl = async (_url, init) => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 10));
    active -= 1;
    const refresh = String(init.body.get("refresh_token"));
    const label = refresh.endsWith("beta") ? "beta" : "alpha";
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: `acct_${label}` } }),
        refresh_token: `rotated_${label}`,
        expires_in: 3600,
      }),
    };
  };
  try {
    await Promise.all(fixture.runtime.snapshot.credentials.map((record) => (
      resolveHarnessAccessCredential({ nowMs, fetchJsonWithTimeoutImpl }, {
        runtime: fixture.runtime,
        provider: record.provider,
        binding: record.label,
        expectedIdentityFingerprint: buildHarnessIdentityFingerprint(record),
      })
    )));
    assert.equal(maxActive, 2);
    await assert.rejects(
      resolveHarnessAccessCredential({ nowMs: Date.now() }, {
        runtime: fixture.runtime,
        provider: "openai-codex",
        binding: "alpha",
        expectedIdentityFingerprint: "aimgr-id-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      }),
      (error) => error instanceof HarnessCredentialError && error.code === "identity_conflict",
    );
  } finally {
    await closeRedisRuntime(fixture.runtime);
  }
});

test("records without stable identity and cross-provider labels fail with fixed types", async () => {
  const snapshot = {
    credentials: [
      { ...codexRecord("alpha"), identity: {} },
      { ...codexRecord("beta"), provider: "openai-codex" },
    ],
  };
  const state = buildCoordinationView(snapshot, { localState: {} });
  const runtime = { snapshot, state, localState: {}, store: {} };
  await assert.rejects(
    resolveHarnessAccessCredential({ nowMs: Date.now() }, {
      runtime,
      provider: "openai-codex",
      binding: "alpha",
      expectedIdentityFingerprint: "aimgr-id-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    (error) => error.code === "credential_incomplete",
  );
  await assert.rejects(
    resolveHarnessAccessCredential({ nowMs: Date.now() }, {
      runtime,
      provider: "anthropic",
      binding: "beta",
      expectedIdentityFingerprint: "aimgr-id-v1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
    }),
    (error) => error.code === "provider_mismatch",
  );
});


test("helper resolution never succeeds inside the fixed five-minute freshness floor", async () => {
  const nowMs = Date.now();
  const fixture = await runtimeFor([
    codexRecord("alpha", { expiresAt: new Date(nowMs + 30_000).toISOString() }),
  ]);
  const record = fixture.runtime.snapshot.credentials[0];
  try {
    await assert.rejects(
      resolveHarnessAccessCredential({
        nowMs,
        fetchJsonWithTimeoutImpl: async () => ({
          ok: true,
          status: 200,
          json: async () => ({
            access_token: makeFakeJwt({
              "https://api.openai.com/auth": { chatgpt_account_id: "acct_alpha" },
            }),
            refresh_token: "refresh_too_short",
            expires_in: 4 * 60,
          }),
        }),
      }, {
        runtime: fixture.runtime,
        provider: "openai-codex",
        binding: "alpha",
        expectedIdentityFingerprint: buildHarnessIdentityFingerprint(record),
      }),
      (error) => error instanceof HarnessCredentialError && error.code === "credential_expired",
    );
  } finally {
    await closeRedisRuntime(fixture.runtime);
  }
});


test("identity fingerprints use only provider-stable immutable identity bases", () => {
  const codex = codexRecord("alpha");
  const codexEnriched = {
    ...codex,
    identity: {
      ...codex.identity,
      emailAddress: "new-address@example.test",
      organizationUuid: "mutable-org",
    },
  };
  assert.equal(
    buildHarnessIdentityFingerprint(codexEnriched),
    buildHarnessIdentityFingerprint(codex),
  );

  const credential = buildAnthropicClaudeCredential({
    access: "ACCESS_ONE",
    refresh: "REFRESH_ONE",
    expiresAtMs: Date.now() + 60 * 60_000,
    emailAddress: "old@example.test",
    organizationUuid: "org-old",
  });
  credential.nativeClaudeBundle.oauthAccount.accountUuid = "acct-stable";
  const rotatedCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_TWO",
    refresh: "REFRESH_TWO",
    expiresAtMs: Date.now() + 2 * 60 * 60_000,
    emailAddress: "new@example.test",
    organizationUuid: "org-new",
  });
  rotatedCredential.nativeClaudeBundle.oauthAccount.accountUuid = "acct-stable";
  const first = {
    provider: "anthropic",
    credential,
    identity: {
      accountUuid: "acct-stable",
      emailAddress: "old@example.test",
      organizationUuid: "org-old",
    },
  };
  const enriched = {
    provider: "anthropic",
    credential: rotatedCredential,
    identity: {
      accountUuid: "acct-stable",
      emailAddress: "new@example.test",
      organizationUuid: "org-new",
      displayName: "Enriched Later",
    },
  };
  assert.equal(
    buildHarnessIdentityFingerprint(enriched),
    buildHarnessIdentityFingerprint(first),
  );
  assert.throws(
    () => buildHarnessIdentityFingerprint({
      provider: "anthropic",
      identity: { emailAddress: "email-only@example.test" },
    }),
    (error) => error instanceof HarnessCredentialError && error.code === "credential_incomplete",
  );
});


test("credential helper rejects a Desktop-reserved binding and a drifted alias with zero writes", async () => {
  const { buildCodexDesktopIdentityFingerprint } = await import("../../src/coordination/codex-identity.js");
  const reservedAccess = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_reserved" } });
  const reservedRecord = {
    provider: "openai-codex",
    label: "personal",
    credential: {},
    identity: { accountId: "acct_reserved" },
    policy: {
      reauth: {},
      pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
      expect: {
        codexDesktop: {
          reserved: true,
          ownerHost: "test-host",
          identityFingerprint: buildCodexDesktopIdentityFingerprint("acct_reserved"),
          reservedAt: "2026-08-07T00:00:00.000Z",
        },
      },
    },
    health: { status: "native_owned", reason: "codex_desktop_reserved" },
  };
  // Drifted alias: identity claims another account, credential material is the
  // reserved account's. The gate must check both.
  const drifted = {
    provider: "openai-codex",
    label: "drifter",
    credential: {
      access: reservedAccess,
      refresh: "refresh_drifter",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      accountId: "acct_reserved",
      idToken: reservedAccess,
    },
    identity: { accountId: "acct_drift" },
    policy: { reauth: {}, pool: { enabled: true } },
    health: { status: "ready", reason: null },
  };
  const fixture = await runtimeFor([reservedRecord, drifted, codexRecord("alpha")]);
  try {
    const before = JSON.stringify([...fixture.client.values.entries()].sort());
    for (const binding of ["personal", "drifter"]) {
      const record = fixture.runtime.snapshot.credentials.find(
        (entry) => entry.provider === "openai-codex" && entry.label === binding,
      );
      let fingerprint = null;
      try {
        fingerprint = buildHarnessIdentityFingerprint(record);
      } catch {
        fingerprint = "aimgr-id-v1:unavailable";
      }
      await assert.rejects(
        () => resolveHarnessAccessCredential({
          nowMs: Date.now(),
          fetchJsonWithTimeoutImpl: async () => {
            throw new Error("network must not be touched for a reserved binding");
          },
        }, {
          runtime: fixture.runtime,
          provider: "openai-codex",
          binding,
          expectedIdentityFingerprint: fingerprint,
          // Force the maintenance path too: rejection must land before refresh.
          rejectedCredentialVersion: record.version,
        }),
        (err) => err instanceof HarnessCredentialError && err.code === "desktop_reserved",
      );
    }
    // Zero Redis writes across both rejections.
    assert.equal(JSON.stringify([...fixture.client.values.entries()].sort()), before);
    // A non-reserved sibling still resolves normally.
    const alphaRecord = fixture.runtime.snapshot.credentials.find(
      (entry) => entry.provider === "openai-codex" && entry.label === "alpha",
    );
    const ok = await resolveHarnessAccessCredential({ nowMs: Date.now() }, {
      runtime: fixture.runtime,
      provider: "openai-codex",
      binding: "alpha",
      expectedIdentityFingerprint: buildHarnessIdentityFingerprint(alphaRecord),
    });
    assert.equal(ok.ok, true);
  } finally {
    await closeRedisRuntime(fixture.runtime);
  }
});
