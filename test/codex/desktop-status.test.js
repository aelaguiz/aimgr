import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildCodexDesktopIdentityFingerprint } from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { resolveCodexAuthFilePath, resolveNativeCodexHomeDir } from "../../src/io/paths.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { readCodexDesktopStatus } from "../../src/targets/codex-cli.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { runCli } from "../helpers/cli-runner.js";

const KEY_PREFIX = "aimgr:desktop-status-test";
const RESERVED_ACCOUNT_ID = "acct_desktop_reserved";
const RESERVED_FINGERPRINT = buildCodexDesktopIdentityFingerprint(RESERVED_ACCOUNT_ID);

function stateWithDesktopTarget(target = {}) {
  return {
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    targets: { codexDesktop: target },
  };
}

function writeNativeAuth(home, accountId) {
  writeJson(resolveCodexAuthFilePath(resolveNativeCodexHomeDir({ homeDir: home })), {
    OPENAI_API_KEY: null,
    tokens: { account_id: accountId },
    last_refresh: "2026-01-01T00:00:00.000Z",
  });
}

function reservedRecord(label = "personal") {
  return {
    provider: "openai-codex",
    label,
    identity: { accountId: RESERVED_ACCOUNT_ID },
    credential: {},
    policy: {
      pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
      expect: {
        codexDesktop: {
          reserved: true,
          ownerHost: "test-host",
          identityFingerprint: RESERVED_FINGERPRINT,
          reservedAt: "2026-08-07T00:00:00.000Z",
        },
      },
    },
    health: { status: "native_owned", reason: "codex_desktop_reserved" },
  };
}

test("unpinned Desktop status reports not_pinned without creating the native home", () => {
  const home = mkTempHome();
  const status = readCodexDesktopStatus({ state: stateWithDesktopTarget(), homeDir: home });

  assert.equal(status.pinned, false);
  assert.equal(status.expectedLabel, null);
  assert.equal(status.readable, false);
  assert.equal(status.match, null);
  assert.equal(status.reserved, null);
  assert.equal(status.reason, "not_pinned");
  // The native home is strictly read-only for AIM: status must not create it.
  assert.equal(fs.existsSync(path.join(home, ".codex")), false);
});

test("pinned Desktop status reports readable/match/reserved booleans from native auth and raw records", () => {
  const home = mkTempHome();
  writeNativeAuth(home, RESERVED_ACCOUNT_ID);
  const state = stateWithDesktopTarget({
    expectedLabel: "personal",
    identityFingerprint: RESERVED_FINGERPRINT,
    pinnedAt: "2026-08-07T00:00:00.000Z",
  });

  const status = readCodexDesktopStatus({ state, homeDir: home, rawRecords: [reservedRecord()] });

  assert.deepEqual(status, {
    nativeHome: resolveNativeCodexHomeDir({ homeDir: home }),
    expectedLabel: "personal",
    pinned: true,
    pinnedAt: "2026-08-07T00:00:00.000Z",
    readable: true,
    match: true,
    reserved: true,
    reason: "ok",
  });
  // The projection never carries the raw immutable account ID.
  assert.doesNotMatch(JSON.stringify(status), new RegExp(RESERVED_ACCOUNT_ID));
});

test("a different native identity is a match=false native_identity_mismatch", () => {
  const home = mkTempHome();
  writeNativeAuth(home, "acct_someone_else");
  const state = stateWithDesktopTarget({
    expectedLabel: "personal",
    identityFingerprint: RESERVED_FINGERPRINT,
  });

  const status = readCodexDesktopStatus({ state, homeDir: home, rawRecords: [reservedRecord()] });

  assert.equal(status.readable, true);
  assert.equal(status.match, false);
  assert.equal(status.reason, "native_identity_mismatch");
});

test("missing native auth reports unreadable; missing reservation reports reservation_missing", () => {
  const home = mkTempHome();
  const state = stateWithDesktopTarget({
    expectedLabel: "personal",
    identityFingerprint: RESERVED_FINGERPRINT,
  });

  const unreadable = readCodexDesktopStatus({ state, homeDir: home, rawRecords: [] });
  assert.equal(unreadable.readable, false);
  assert.equal(unreadable.match, null);
  assert.equal(unreadable.reason, "native_auth_unreadable");

  writeNativeAuth(home, RESERVED_ACCOUNT_ID);
  const unreserved = readCodexDesktopStatus({ state, homeDir: home, rawRecords: [] });
  assert.equal(unreserved.match, true);
  assert.equal(unreserved.reserved, false);
  assert.equal(unreserved.reason, "reservation_missing");

  // Without a raw record snapshot the reservation state is unknown, not
  // guessed — and the reason says so instead of implying full verification.
  const unknown = readCodexDesktopStatus({ state, homeDir: home });
  assert.equal(unknown.reserved, null);
  assert.equal(unknown.reason, "reservation_unverified");
});

test("aim status reports safe codexDesktop and codexCli projections with no identity material", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const token = makeFakeJwt({
    exp: Math.floor((nowMs + 3_600_000) / 1000),
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_pool", chatgpt_plan_type: "pro" },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: [
      reservedRecord(),
      {
        provider: "openai-codex",
        label: "boss",
        identity: { accountId: "acct_pool" },
        credential: {
          access: token,
          refresh: "REFRESH_boss",
          idToken: token,
          accountId: "acct_pool",
          expiresAt: new Date(nowMs + 3_600_000).toISOString(),
        },
        policy: { pool: { enabled: true } },
        health: { status: "ready", reason: null },
      },
    ],
  }, { updatedBy: "test", observedAt: new Date(nowMs).toISOString() });
  writeNativeAuth(home, RESERVED_ACCOUNT_ID);
  writeLocalState({
    homeDir: home,
    localState: {
      targets: {
        codexDesktop: {
          expectedLabel: "personal",
          identityFingerprint: RESERVED_FINGERPRINT,
          pinnedAt: "2026-08-07T00:00:00.000Z",
        },
      },
    },
  });

  const jsonOut = await runCli(["status", "--json", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({ "openai-codex": {} }),
  });
  const parsed = JSON.parse(jsonOut);

  assert.equal(parsed.codexDesktop.expectedLabel, "personal");
  assert.equal(parsed.codexDesktop.pinned, true);
  assert.equal(parsed.codexDesktop.readable, true);
  assert.equal(parsed.codexDesktop.match, true);
  assert.equal(parsed.codexDesktop.reserved, true);
  assert.equal(parsed.codexDesktop.reason, "ok");
  assert.equal(parsed.codexCli.lock.locked, false);
  // Raw account IDs, tokens, opaque fingerprints, and enrollment identifiers
  // never appear in status output.
  assert.doesNotMatch(jsonOut, /acct_desktop_reserved|acct_pool|REFRESH_boss|wss:\/\//);
  assert.doesNotMatch(jsonOut, new RegExp(RESERVED_FINGERPRINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

  const textOut = await runCli(["status", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({ "openai-codex": {} }),
  });
  assert.match(textOut, /CODEX DESKTOP\nlabel=personal  readable=yes  match=yes  reserved=yes  reason=ok/);
  assert.doesNotMatch(textOut, /acct_desktop_reserved|acct_pool|REFRESH_boss/);
});
