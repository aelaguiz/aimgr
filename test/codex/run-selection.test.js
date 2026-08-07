import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { buildCodexDesktopIdentityFingerprint } from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { resolveCodexAuthFilePath, resolveManagedCodexHomeDir, resolveNativeCodexHomeDir } from "../../src/io/paths.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";

const KEY_PREFIX = "aimgr:codex-run-test";

// `aim codex run` is the only local rotating Codex mutator. These tests drive
// it end to end with a fake spawned child and prove two-home isolation: the
// native Desktop sentinel must stay byte-identical on every path.
const NATIVE_SENTINEL = `${JSON.stringify({
  OPENAI_API_KEY: null,
  tokens: { account_id: "acct_desktop_native" },
  last_refresh: "2026-01-01T00:00:00.000Z",
}, null, 2)}\n`;

function seedNativeSentinel(home) {
  const nativePath = resolveCodexAuthFilePath(resolveNativeCodexHomeDir({ homeDir: home }));
  fs.mkdirSync(path.dirname(nativePath), { recursive: true });
  fs.writeFileSync(nativePath, NATIVE_SENTINEL, "utf8");
  return nativePath;
}

function assertNativeUntouched(nativePath) {
  assert.equal(fs.readFileSync(nativePath, "utf8"), NATIVE_SENTINEL);
}

function managedAuthPath(home) {
  return resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
}

function codexRecord(label, accountId, nowMs, { expiresAtMs = nowMs + 4 * 60 * 60_000, credential = undefined } = {}) {
  const token = makeFakeJwt({
    exp: Math.floor(expiresAtMs / 1000),
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
  return {
    provider: "openai-codex",
    label,
    identity: { accountId },
    credential: credential ?? {
      access: token,
      refresh: `REFRESH_${label}`,
      idToken: token,
      accountId,
      expiresAt: new Date(expiresAtMs).toISOString(),
    },
    policy: { pool: { enabled: true }, reauth: { mode: "manual-callback" } },
    health: { status: "ready", reason: null },
  };
}

function buildFakeSpawn({ exitCode = 0, signal = null, pid = 4242 } = {}) {
  const calls = [];
  const spawnCodexImpl = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.pid = pid;
    process.nextTick(() => {
      child.emit("spawn");
      process.nextTick(() => child.emit("exit", exitCode, signal));
    });
    return child;
  };
  spawnCodexImpl.calls = calls;
  return spawnCodexImpl;
}

async function setup(records, nowMs = Date.now()) {
  const home = mkTempHome();
  const nativePath = seedNativeSentinel(home);
  const client = new FakeRedisClient();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(store, { credentials: records }, {
    updatedBy: "test",
    observedAt: new Date(nowMs).toISOString(),
  });
  return {
    home,
    nativePath,
    store,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
  };
}

function usage(usedPercent, weeklyUsedPercent = Math.min(99, usedPercent + 5)) {
  return {
    provider: "openai-codex",
    ok: true,
    windows: [
      { label: "5h", usedPercent, resetAt: Date.now() + 60 * 60_000 },
      { label: "Week", usedPercent: weeklyUsedPercent, resetAt: Date.now() + 24 * 60 * 60_000 },
    ],
  };
}

test("explicit codex run projects into the managed home, launches codex there, and never touches native auth", async () => {
  const nowMs = Date.now();
  const { home, nativePath, connectRedisStoreImpl } = await setup([
    codexRecord("boss", "acct_1", nowMs),
    codexRecord("writer", "acct_2", nowMs),
  ], nowMs);
  const spawnCodexImpl = buildFakeSpawn();
  let probes = 0;

  const out = await runCli(["codex", "run", "boss", "--home", home, "--", "exec", "hello"], {
    env: {},
    connectRedisStoreImpl,
    spawnCodexImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      probes += 1;
      throw new Error("explicit run must not probe usage");
    },
  });
  const result = JSON.parse(out);

  assert.equal(result.ok, true);
  assert.equal(result.action, "codex_run");
  assert.equal(result.label, "boss");
  assert.equal(result.activated.receipt.label, "boss");
  assert.equal(result.exitCode, 0);
  assert.equal(probes, 0);
  assert.equal(spawnCodexImpl.calls.length, 1);
  assert.equal(spawnCodexImpl.calls[0].command, "codex");
  assert.deepEqual(spawnCodexImpl.calls[0].args, ["exec", "hello"]);
  assert.equal(
    spawnCodexImpl.calls[0].options.env.CODEX_HOME,
    resolveManagedCodexHomeDir({ homeDir: home }),
  );
  assert.equal(JSON.parse(fs.readFileSync(managedAuthPath(home), "utf8")).tokens.account_id, "acct_1");
  assertNativeUntouched(nativePath);
  // Operator output carries labels, booleans, and fixed reasons only.
  assert.doesNotMatch(out, /acct_1|acct_2|acct_desktop_native|REFRESH_|wss:\/\//);
});

test("unlabeled codex run picks the least-used eligible label and excludes expired and exhausted accounts", async () => {
  const nowMs = Date.now();
  const { home, nativePath, connectRedisStoreImpl } = await setup([
    codexRecord("expired", "acct_1", nowMs, { expiresAtMs: nowMs - 60_000 }),
    codexRecord("exhausted", "acct_2", nowMs),
    codexRecord("busy", "acct_3", nowMs),
    codexRecord("idle", "acct_4", nowMs),
  ], nowMs);
  const spawnCodexImpl = buildFakeSpawn();

  const out = await runCli(["codex", "run", "--home", home], {
    env: {},
    connectRedisStoreImpl,
    spawnCodexImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        expired: usage(0, 0),
        exhausted: usage(1, 96),
        busy: usage(60),
        idle: usage(10),
      },
      anthropic: {},
    }),
  });
  const result = JSON.parse(out);

  assert.equal(result.ok, true);
  assert.equal(result.activated.receipt.label, "idle");
  assert.deepEqual(result.activated.receipt.reasons, ["lowest_5h_used"]);
  assert.equal(JSON.parse(fs.readFileSync(managedAuthPath(home), "utf8")).tokens.account_id, "acct_4");
  assertNativeUntouched(nativePath);
});

test("codex run with no eligible pool account blocks with exit 1, spawns nothing, and leaves native auth alone", async () => {
  const nowMs = Date.now();
  const { home, nativePath, connectRedisStoreImpl } = await setup([
    codexRecord("boss", "acct_1", nowMs, { expiresAtMs: nowMs - 60_000 }),
  ], nowMs);
  const spawnCodexImpl = buildFakeSpawn();

  const result = await runCliWithExitCode(["codex", "run", "--home", home], {
    env: {},
    connectRedisStoreImpl,
    spawnCodexImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({ "openai-codex": {}, anthropic: {} }),
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 1);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.activated.status, "blocked");
  assert.equal(parsed.activated.receipt.blockers[0].reason, "no_eligible_pool_account");
  assert.equal(spawnCodexImpl.calls.length, 0);
  assert.equal(fs.existsSync(managedAuthPath(home)), false);
  assertNativeUntouched(nativePath);
  assert.doesNotMatch(result.stdout, /acct_1|acct_desktop_native|REFRESH_|wss:\/\//);
});

test("explicit codex run of a Desktop-reserved label fails closed with zero writes", async () => {
  const nowMs = Date.now();
  const reserved = codexRecord("personal", "acct_reserved", nowMs, { credential: {} });
  reserved.policy = {
    ...reserved.policy,
    pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
    expect: {
      codexDesktop: {
        reserved: true,
        ownerHost: "test-host",
        identityFingerprint: buildCodexDesktopIdentityFingerprint("acct_reserved"),
        reservedAt: new Date(nowMs).toISOString(),
      },
    },
  };
  reserved.health = { status: "native_owned", reason: "codex_desktop_reserved" };
  const { home, nativePath, store, connectRedisStoreImpl } = await setup([
    reserved,
    codexRecord("boss", "acct_1", nowMs),
  ], nowMs);
  const before = await readSnapshot(store);
  const spawnCodexImpl = buildFakeSpawn();

  await assert.rejects(
    runCli(["codex", "run", "personal", "--home", home], {
      env: {},
      connectRedisStoreImpl,
      spawnCodexImpl,
    }),
    /codex_desktop_reserved/,
  );

  assert.equal(spawnCodexImpl.calls.length, 0);
  assert.equal(fs.existsSync(managedAuthPath(home)), false);
  assertNativeUntouched(nativePath);
  const after = await readSnapshot(store);
  assert.deepEqual(after.credentials, before.credentials);
});

test("codex run propagates a nonzero child exit code and releases the run lock", async () => {
  const nowMs = Date.now();
  const { home, nativePath, connectRedisStoreImpl } = await setup([
    codexRecord("boss", "acct_1", nowMs),
  ], nowMs);

  const first = await runCliWithExitCode(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl,
    spawnCodexImpl: buildFakeSpawn({ exitCode: 3 }),
  });
  assert.equal(first.exitCode, 3);
  assert.equal(JSON.parse(first.stdout).ok, false);

  // The lock must be gone: a second run succeeds instead of failing closed.
  const second = await runCliWithExitCode(["codex", "run", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl,
    spawnCodexImpl: buildFakeSpawn({ exitCode: 0 }),
  });
  assert.equal(second.exitCode, 0);
  assert.equal(JSON.parse(second.stdout).ok, true);
  assertNativeUntouched(nativePath);
});

test("codex use and watch are removed with a loud pointer to codex run", async () => {
  const home = mkTempHome();
  await assert.rejects(runCli(["codex", "use", "boss", "--home", home]), /was removed/);
  await assert.rejects(runCli(["codex", "watch", "--once", "--home", home]), /was removed/);
});
