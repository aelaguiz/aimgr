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
      { label: "Week", usedPercent, resetAt: Date.now() + 6 * 24 * 60 * 60_000 },
      { label: "Legacy", usedPercent: weeklyUsedPercent, resetAt: Date.now() + 24 * 60 * 60_000 },
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

test("codex run rotates before launching the default yolo command", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  let launch;
  await runCli(["codex", "run", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 20), writer: usage("writer", 10) },
      anthropic: {},
    }),
    runCodexInteractiveImpl: async (request) => {
      launch = request;
      return { code: 0, signal: null };
    },
  });

  assert.deepEqual(launch.args, ["-p", "yolo"]);
  assert.equal(JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home })), "utf8")).tokens.account_id, "acct_2");
});

test("codex run with an explicit label preserves selection and exact Codex arguments", async (t) => {
  const cases = [
    { name: "default command", initialLabel: "writer", args: [], expected: ["-p", "yolo"] },
    { name: "exec after explicit use", initialLabel: "boss", args: ["exec", "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"', "--json", "prompt with spaces\nand a newline"] },
    { name: "resume passthrough", initialLabel: "boss", args: ["exec", "resume", "thread-123", "--json", "continue"] },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (t) => {
      const { home, connectRedisStoreImpl } = await setup();
      await runCli(["codex", "use", scenario.initialLabel, "--home", home], { connectRedisStoreImpl });
      const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
      t.after(() => assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_1"));
      let launch;
      let probes = 0;
      await runCli(["codex", "run", "boss", "--home", home, "--", ...scenario.args], {
        connectRedisStoreImpl,
        probeUsageSnapshotsByProviderImpl: async () => {
          probes += 1;
          return {
            "openai-codex": { boss: usage("boss", 20), writer: usage("writer", 10) },
            anthropic: {},
          };
        },
        runCodexInteractiveImpl: async (request) => {
          launch = request;
          assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_1");
          return { code: 0, signal: null };
        },
      });

      assert.deepEqual(launch.args, scenario.expected ?? scenario.args);
      assert.equal(probes, 0);
    });
  }
});

test("codex run rejects an unknown explicit label without rotating or launching", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
  const before = fs.readFileSync(authPath, "utf8");
  let launches = 0;
  const result = await runCliWithExitCode(["codex", "run", "missing", "--home", home, "--", "exec", "hello"], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      throw new Error("explicit run must not probe the pool");
    },
    runCodexInteractiveImpl: async () => {
      launches += 1;
      return { code: 0, signal: null };
    },
  });
  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.activated.status, "blocked");
  assert.equal(parsed.activated.receipt.label, "missing");
  assert.equal(launches, 0);
  assert.equal(fs.readFileSync(authPath, "utf8"), before);
});

test("codex resume rotates before launching a yolo resume", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  let launch;
  await runCli(["codex", "resume", "thread-123", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 20), writer: usage("writer", 10) },
      anthropic: {},
    }),
    runCodexInteractiveImpl: async (request) => {
      launch = request;
      return { code: 0, signal: null };
    },
  });

  assert.deepEqual(launch.args, ["-p", "yolo", "resume", "thread-123"]);
});

test("back-to-back Codex resumes launch with different accounts and show the selection", async () => {
  const { home, connectRedisStoreImpl } = await setup();
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
  const launchedAccounts = [];
  const outputs = [];
  for (let i = 0; i < 3; i += 1) {
    outputs.push(await runCli(["codex", "resume", "same-thread", "--home", home], {
      connectRedisStoreImpl,
      env: {},
      stdout: { isTTY: true },
      probeUsageSnapshotsByProviderImpl: async () => ({
        "openai-codex": { boss: usage("boss", 20), writer: usage("writer", 10) },
        anthropic: {},
      }),
      runCodexInteractiveImpl: async ({ args }) => {
        assert.deepEqual(args, ["-p", "yolo", "resume", "same-thread"]);
        launchedAccounts.push(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id);
        return { code: 0, signal: null };
      },
    }));
  }
  assert.deepEqual(launchedAccounts, ["acct_2", "acct_1", "acct_2"]);
  assert.match(outputs[0], /Codex account: writer/);
  assert.match(outputs[1], /Codex account: boss \(previous: writer\)/);
  assert.match(outputs[2], /Codex account: writer \(previous: boss\)/);
});

test("Codex resume does not launch when no different eligible account exists", async () => {
  const { home, connectRedisStoreImpl } = await setup(["boss"]);
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl, env: {} });
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
  const before = fs.readFileSync(authPath, "utf8");
  const result = await runCliWithExitCode(["codex", "resume", "same-thread", "--home", home], {
    connectRedisStoreImpl,
    env: {},
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 20) },
      anthropic: {},
    }),
    runCodexInteractiveImpl: async () => assert.fail("must not launch on the same account"),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).activated.receipt.blockers[0].reason, "no_alternate_pool_account");
  assert.equal(fs.readFileSync(authPath, "utf8"), before);
});

test("automatic Codex use rotates on every call while reusing fresh credential-bound usage", async () => {
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
  const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));

  const first = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));
  assert.equal(first.activated.receipt.label, "writer");
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_2");

  const second = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));

  assert.equal(second.activated.receipt.previousLabel, "writer");
  assert.equal(second.activated.receipt.label, "boss");
  assert.equal(second.activated.status, "activated");
  assert.equal(second.activated.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_1");

  const third = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
  }));
  assert.equal(third.activated.receipt.previousLabel, "boss");
  assert.equal(third.activated.receipt.label, "writer");
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).tokens.account_id, "acct_2");
  assert.equal(probes, 1);
});

test("automatic Codex use rotates even when usage is equal", async () => {
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
  assert.equal(second.activated.receipt.label, "writer");
});

test("automatic Codex use chooses the lowest-usage eligible alternative", async () => {
  const { home, connectRedisStoreImpl } = await setup(["boss", "writer", "editor"]);
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });

  const result = JSON.parse(await runCli(["codex", "use", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": { boss: usage("boss", 1), writer: usage("writer", 60), editor: usage("editor", 10) },
      anthropic: {},
    }),
  }));

  assert.equal(result.activated.receipt.previousLabel, "boss");
  assert.equal(result.activated.receipt.label, "editor");
});

test("automatic Codex use fails without changing auth when no eligible alternate exists", async (t) => {
  for (const labels of [["boss"], ["boss", "writer"]]) {
    await t.test(labels.length === 1 ? "only one account" : "alternate is exhausted", async () => {
      const { home, connectRedisStoreImpl } = await setup(labels);
      await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl });
      const authPath = resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home }));
      const before = fs.readFileSync(authPath, "utf8");

      const result = await runCliWithExitCode(["codex", "use", "--home", home], {
        connectRedisStoreImpl,
        probeUsageSnapshotsByProviderImpl: async () => ({
          "openai-codex": { boss: usage("boss", 10), writer: usage("writer", 1, 100) },
          anthropic: {},
        }),
      });
      const parsed = JSON.parse(result.stdout);

      assert.equal(result.exitCode, 1);
      assert.equal(parsed.ok, false);
      assert.equal(parsed.activated.status, "blocked");
      assert.equal(parsed.activated.receipt.previousLabel, "boss");
      assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_alternate_pool_account" }]);
      assert.equal(parsed.activated.wrote, false);
      assert.equal(fs.readFileSync(authPath, "utf8"), before);
    });
  }
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
  assert.equal(result.watched.receipt.weeklyRemainingPctBefore, 80);
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
  assert.equal(result.watched.receipt.weeklyRemainingPctBefore, 15);
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
