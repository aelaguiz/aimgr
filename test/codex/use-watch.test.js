import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { resolveCodexAuthFilePath, resolveManagedCodexHomeDir } from "../../src/io/paths.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";

const KEY_PREFIX = "aimgr:codex-command-test";

function codexRecord(label, accountId, nowMs, { expiresAtMs = nowMs + 4 * 60 * 60_000 } = {}) {
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
    credential: {
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

async function setup(labels = ["boss", "writer"], { recordOptionsByLabel = {} } = {}) {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: labels.map((label, index) => codexRecord(
      label,
      `acct_${index + 1}`,
      nowMs,
      recordOptionsByLabel[label],
    )),
  }, { updatedBy: "test", observedAt: new Date(nowMs).toISOString() });
  return {
    home,
    nowMs,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
  };
}

function usage(label, usedPercent, weeklyUsedPercent = Math.min(99, usedPercent + 5)) {
  return {
    provider: "openai-codex",
    ok: true,
    windows: [
      { label: "5h", usedPercent, resetAt: Date.now() + 60 * 60_000 },
      { label: "Week", usedPercent: weeklyUsedPercent, resetAt: Date.now() + 24 * 60 * 60_000 },
    ],
  };
}

test("explicit Redis-backed Codex use reconciles and activates without usage", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  let probes = 0;
  const out = await runCli(["codex", "use", "boss", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      probes += 1;
      throw new Error("explicit use must not probe");
    },
  });
  const result = JSON.parse(out);

  assert.equal(result.ok, true);
  assert.equal(result.activated.receipt.label, "boss");
  assert.equal(probes, 0);
  assert.equal(result.reconciliation.status, "skipped");
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_1");
});

test("automatic Codex use probes missing labels once, then reuses fresh credential-bound cache", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  let probes = 0;
  const probeUsageSnapshotsByProviderImpl = async (state) => {
    probes += 1;
    assert.deepEqual(Object.keys(state.credentials["openai-codex"]).sort(), ["boss", "writer"]);
    return {
      "openai-codex": { boss: usage("boss", 60), writer: usage("writer", 10) },
      anthropic: {},
    };
  };

  const first = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));
  const second = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));

  assert.equal(first.activated.receipt.label, "writer");
  assert.equal(second.activated.receipt.label, "writer");
  assert.equal(second.activated.status, "noop");
  assert.equal(second.activated.wrote, false);
  assert.equal(probes, 1);
});

test("automatic Codex use resolves equal usage deterministically by label", async () => {
  const { home, connectRedisStoreImpl } = await setup(["writer", "boss"]);
  const probeUsageSnapshotsByProviderImpl = async () => ({
    "openai-codex": { writer: usage("writer", 10, 20), boss: usage("boss", 10, 20) },
    anthropic: {},
  });

  const first = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));
  const second = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));

  assert.equal(first.activated.receipt.label, "boss");
  assert.equal(second.activated.receipt.label, "boss");
});

test("automatic Codex use excludes expired credentials", async () => {
  const nowMs = Date.now();
  const { home, connectRedisStoreImpl } = await setup(["boss", "writer"], {
    recordOptionsByLabel: { boss: { expiresAtMs: nowMs - 60_000 } },
  });
  const result = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 1, 1), writer: usage("writer", 40, 50) },
      anthropic: {},
    }),
  }));

  assert.equal(result.activated.receipt.label, "writer");
});

test("automatic Codex use excludes weekly-exhausted accounts", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  const result = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 1, 96), writer: usage("writer", 40, 50) },
      anthropic: {},
    }),
  }));

  assert.equal(result.activated.receipt.label, "writer");
});

test("Codex watch noops while the active account remains above the threshold", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });

  const result = JSON.parse(await runCli(["codex", "watch", "--once", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 20, 30), writer: usage("writer", 10, 20) },
      anthropic: {},
    }),
  }));

  assert.equal(result.watched.status, "noop");
  assert.equal(result.watched.receipt.currentLabelAfter, "boss");
  assert.equal(result.watched.receipt.primaryRemainingPctBefore, 80);
  assert.equal(result.watched.receipt.triggeredSelection, false);
});

test("Codex watch rotates when the active account falls below the threshold", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });

  const result = JSON.parse(await runCli(["codex", "watch", "--once", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 85, 70), writer: usage("writer", 10, 20) },
      anthropic: {},
    }),
  }));

  assert.equal(result.watched.status, "activated");
  assert.equal(result.watched.receipt.currentLabelBefore, "boss");
  assert.equal(result.watched.receipt.currentLabelAfter, "writer");
  assert.equal(result.watched.receipt.primaryRemainingPctBefore, 15);
  assert.equal(result.watched.receipt.triggeredSelection, true);
});

test("Codex watch reuses reconciliation and keeps a valid target when telemetry is unavailable", async () => {
  const { home, connectRedisStoreImpl } = await setup(["boss"]);
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
  const before = JSON.parse(fs.readFileSync(authPath, "utf8"));

  const result = await runCliWithExitCode(["codex", "watch", "--once", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      throw new Error("telemetry unavailable");
    },
  });
  const parsed = JSON.parse(result.stdout);

  assert.equal(result.exitCode, 1);
  assert.equal(parsed.reconciliation.status, "redis_newer");
  assert.equal(parsed.watched.status, "blocked");
  const after = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.deepEqual(after.tokens, before.tokens);
});

test("Codex credential commands fail quickly when Redis is unconfigured", async () => {
  const home = mkTempHome();
  await assert.rejects(
    runCli(["codex", "use", "boss", "--home", home]),
    /AIM is not attached to Redis/,
  );
});
