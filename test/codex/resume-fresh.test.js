import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { resolveManagedCodexHomeDir } from "../../src/io/paths.js";
import { resolveCodexLabelInstallationId } from "../../src/targets/codex-installation-id.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome } from "../helpers/files.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";

const KEY_PREFIX = "aimgr:codex-resume-fresh-test";
const SOURCE_THREAD = "01a0b222-95ce-7fa3-96d8-680acb15cbcc";
const TURN = "01a0b222-96ae-7241-8dfc-c8c63bebf91b";

function codexRecord(label, accountId, nowMs) {
  const token = makeFakeJwt({
    exp: Math.floor((nowMs + 4 * 60 * 60_000) / 1000),
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
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
      expiresAt: new Date(nowMs + 4 * 60 * 60_000).toISOString(),
    },
    policy: { pool: { enabled: true }, reauth: { mode: "manual-callback" } },
    health: { status: "ready", reason: null },
  };
}

function usage(usedPercent) {
  return {
    provider: "openai-codex",
    ok: true,
    windows: [
      { label: "Week", usedPercent, resetAt: Date.now() + 6 * 24 * 60 * 60_000 },
      { label: "Legacy", usedPercent, resetAt: Date.now() + 24 * 60 * 60_000 },
    ],
  };
}

function rolloutLines({ withSpawnEvent = false, compacted = false, spawnItemType = null } = {}) {
  return [
    {
      timestamp: "2026-09-17T10:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        session_id: SOURCE_THREAD,
        id: SOURCE_THREAD,
        timestamp: "2026-09-17T09:59:59.000Z",
        cwd: process.cwd(),
        originator: "codex-tui",
        cli_version: "0.154.0-alpha.3",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        history_mode: "paginated",
        context_window: { window_id: "01a0b222-95ce-7fa3-96d8-680acb15cb01" },
      },
    },
    {
      timestamp: "2026-09-17T10:00:02.000Z",
      ordinal: 1,
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c111",
        role: "user",
        content: [{ type: "input_text", text: "carry me across accounts" }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1789695001.5 },
      },
    },
    {
      timestamp: "2026-09-17T10:00:02.500Z",
      ordinal: 2,
      type: "token_usage_record",
      payload: {
        session_id: SOURCE_THREAD,
        thread_id: SOURCE_THREAD,
        turn_id: TURN,
        root_turn_id: TURN,
        response_id: "resp_abc123def456",
        usage: { input_tokens: 1, output_tokens: 2 },
        turn_token_usage: { input_tokens: 1, output_tokens: 2 },
        thread_token_usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    ...(withSpawnEvent
      ? [{
          timestamp: "2026-09-17T10:00:03.000Z",
          ordinal: 3,
          type: "event_msg",
          payload: { type: "sub_agent_activity", agent_thread_id: "01a0b222-95ce-7fa3-96d8-680acb15cbc1", thread_id: SOURCE_THREAD },
        }]
      : []),
    ...(spawnItemType
      ? [{
          timestamp: "2026-09-17T10:00:03.500Z",
          ordinal: 4,
          type: "event_msg",
          payload: { type: "item_completed", thread_id: SOURCE_THREAD, turn_id: TURN, item: { type: spawnItemType, id: "call_child" } },
        }]
      : []),
    ...(compacted
      ? [{
          timestamp: "2026-09-17T10:00:04.000Z",
          ordinal: 5,
          type: "compacted",
          payload: {
            message: "",
            replacement_history: [
              {
                type: "message",
                id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c333",
                role: "developer",
                content: [{ type: "input_text", text: "instructions" }],
                internal_chat_message_metadata_passthrough: { turn_id: TURN },
              },
              { type: "compaction", id: "cmp_085e491022de5600016aac9421ad3487d193d5a151e24a2780", encrypted_content: "ENCRYPTED_COMPACTION_BLOB" },
            ],
            window_number: 0,
            window_id: "01a0b222-95ce-7fa3-96d8-680acb15cb02",
            latest_token_usage_record: {
              session_id: SOURCE_THREAD,
              thread_id: SOURCE_THREAD,
              turn_id: TURN,
              root_turn_id: TURN,
              response_id: "resp_abc123def456",
              usage: { input_tokens: 1, output_tokens: 2 },
              turn_token_usage: { input_tokens: 1, output_tokens: 2 },
              thread_token_usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
        }]
      : []),
  ];
}

function writeRollout({ codexHome, threadId = SOURCE_THREAD, options = {} }) {
  const dir = path.join(codexHome, "sessions", "2026", "09", "17");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-17T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${rolloutLines(options).map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

async function setup(labels = ["boss", "writer"], options = {}) {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const nowMs = Date.now();
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: KEY_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: KEY_PREFIX });
  await importCredentialsSnapshot(store, {
    credentials: labels.map((label, index) => codexRecord(label, `acct_${index + 1}`, nowMs)),
  }, { updatedBy: "test", observedAt: new Date(nowMs).toISOString() });
  const codexHome = resolveManagedCodexHomeDir({ homeDir: home, env: {} });
  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(path.join(codexHome, "yolo.config.toml"), "model = \"gpt-6-astra\"\n\n[features]\ngoals = true\n", "utf8");
  const sourcePath = writeRollout({ codexHome, options });
  return {
    home,
    codexHome,
    sourcePath,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: KEY_PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      // Least-used selection must land on `writer` first, like the use/watch tests.
      "openai-codex": Object.fromEntries(labels.map((label, index) => [label, usage(label === "writer" ? 10 : 20 + index)])),
      anthropic: {},
    }),
  };
}

function authCodexHome(homeDir) {
  return homeDir;
}

function listCopiedRollouts({ codexHome, exclude }) {
  const root = path.join(codexHome, "sessions");
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(entryPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entryPath !== exclude) found.push(entryPath);
    }
  };
  if (fs.existsSync(root)) walk(root);
  return found;
}

test("resume-fresh rotates, copies the thread into a new id, scrubs it, and resumes the copy", async () => {
  const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup();
  const sourceBytes = fs.readFileSync(sourcePath, "utf8");
  let launched = null;
  const out = await runCli(["codex", "resume-fresh", SOURCE_THREAD, "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
    env: {},
    stdout: { isTTY: true },
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    runCodexInteractiveImpl: async (request) => {
      launched = request;
      return { code: 0, signal: null };
    },
  });

  const copies = listCopiedRollouts({ codexHome, exclude: sourcePath });
  assert.equal(copies.length, 1);
  const copiedLines = fs.readFileSync(copies[0], "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const newId = copiedLines[0].payload.id;
  assert.equal(copiedLines[0].payload.session_id, newId);
  assert.notEqual(newId, SOURCE_THREAD);
  assert.deepEqual(launched.args, ["-p", "yolo", "resume", newId]);
  assert.equal(copiedLines[0].payload.forked_from_id, undefined);
  assert.equal(copiedLines[0].payload.history_base, undefined);
  assert.equal(fs.readFileSync(copies[0], "utf8").includes(SOURCE_THREAD), false);
  assert.equal(fs.readFileSync(copies[0], "utf8").includes(TURN), false);
  assert.equal(copiedLines[1].payload.internal_chat_message_metadata_passthrough.create_time, undefined);

  // The source thread is untouched.
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceBytes);
  assert.equal(fs.existsSync(sourcePath), true);

  // Receipts name the rotation, the new thread, and the untouched source.
  assert.match(out, /\[aim\] Codex account: writer/);
  assert.match(out, new RegExp(`\\[aim\\] new thread ${newId} from ${SOURCE_THREAD}`));
  assert.match(out, /\[aim\] source thread untouched/);

  // Analytics is disabled in the profile aim launches with.
  assert.match(fs.readFileSync(path.join(codexHome, "yolo.config.toml"), "utf8"), /\[analytics\]\nenabled = false/);

  // The selected label gets its own Codex installation id, written wherever auth.json is written.
  const installationId = fs.readFileSync(path.join(codexHome, "installation_id"), "utf8").trim();
  assert.equal(installationId, resolveCodexLabelInstallationId({ label: "writer" }));
});

test("resume-fresh chains: the copy becomes the next source and the account rotates again", async () => {
  const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup();
  const launches = [];
  const run = (sourceId) => runCli(["codex", "resume-fresh", sourceId, "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
    env: {},
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    runCodexInteractiveImpl: async (request) => {
      launches.push(request.args[3]);
      return { code: 0, signal: null };
    },
  });

  await run(SOURCE_THREAD);
  await run(launches[0]);
  assert.equal(new Set(launches).size, 2);
  assert.equal(launches[0] !== SOURCE_THREAD, true);
  const copied = listCopiedRollouts({ codexHome, exclude: sourcePath });
  assert.equal(copied.length, 2);
  for (const file of copied) {
    const header = JSON.parse(fs.readFileSync(file, "utf8").split("\n")[0]);
    assert.equal(header.payload.session_id, header.payload.id);
    assert.equal(fs.readFileSync(file, "utf8").includes(SOURCE_THREAD), false);
  }
});

test("resume-fresh does not copy or launch when no alternate account exists", async () => {
  const { home, codexHome, sourcePath, connectRedisStoreImpl } = await setup(["boss"]);
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl, env: {} });
  const result = await runCliWithExitCode(["codex", "resume-fresh", SOURCE_THREAD, "--home", home], {
    connectRedisStoreImpl,
    env: {},
    probeUsageSnapshotsByProviderImpl: async () => ({ "openai-codex": { boss: usage(10) }, anthropic: {} }),
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    runCodexInteractiveImpl: async () => assert.fail("must not launch without a rotated account"),
  });
  assert.equal(result.exitCode, 1);
  assert.equal(JSON.parse(result.stdout).activated.receipt.blockers[0].reason, "no_alternate_pool_account");
  assert.deepEqual(listCopiedRollouts({ codexHome, exclude: sourcePath }), []);
});

test("resume-fresh --dry-run is side-effect free: no rotation, no copy, no profile or install-id write", async () => {
  const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup();
  const authPath = resolveManagedCodexHomeDir({ homeDir: home, env: {} });
  await runCli(["codex", "use", "boss", "--home", home], { connectRedisStoreImpl, env: {} });
  const authBefore = fs.readFileSync(path.join(authCodexHome(authPath), "auth.json"), "utf8");
  const profileBefore = fs.readFileSync(path.join(codexHome, "yolo.config.toml"), "utf8");
  const installBefore = fs.existsSync(path.join(codexHome, "installation_id"))
    ? fs.readFileSync(path.join(codexHome, "installation_id"), "utf8")
    : null;

  const out = await runCli(["codex", "resume-fresh", SOURCE_THREAD, "--dry-run", "--home", home], {
    connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl,
    env: {},
    spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
    runCodexInteractiveImpl: async () => assert.fail("dry run must not launch"),
  });
  const plan = JSON.parse(out);
  assert.equal(plan.dryRun, true);
  assert.equal(plan.rotated, false);
  assert.equal(plan.source.id, SOURCE_THREAD);
  assert.equal(plan.scrub.dropServerBlobs, true);
  assert.equal(plan.analytics.disabled, false, "the profile is untouched by a dry run");
  assert.equal(plan.scan.ids > 0, true);
  assert.ok(plan.target.id);

  assert.deepEqual(listCopiedRollouts({ codexHome, exclude: sourcePath }), []);
  assert.equal(fs.readFileSync(path.join(authCodexHome(authPath), "auth.json"), "utf8"), authBefore);
  assert.equal(fs.readFileSync(path.join(codexHome, "yolo.config.toml"), "utf8"), profileBefore);
  assert.equal(
    fs.existsSync(path.join(codexHome, "installation_id")) ? fs.readFileSync(path.join(codexHome, "installation_id"), "utf8") : null,
    installBefore,
  );
});

test("compacted sources need an explicit decision: refuse, keep blobs, or accept context loss", async (t) => {
  await t.test("default refuses", async () => {
    const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup(["boss", "writer"], { compacted: true });
    await assert.rejects(
      () => runCli(["codex", "resume-fresh", SOURCE_THREAD, "--home", home], {
        connectRedisStoreImpl,
        probeUsageSnapshotsByProviderImpl,
        env: {},
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      }),
      /was compacted/,
    );
    assert.deepEqual(listCopiedRollouts({ codexHome, exclude: sourcePath }), []);
  });

  await t.test("--keep-server-blobs copies with the blob intact", async () => {
    const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup(["boss", "writer"], { compacted: true });
    let launched = null;
    await runCli(["codex", "resume-fresh", SOURCE_THREAD, "--keep-server-blobs", "--home", home], {
      connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl,
      env: {},
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      runCodexInteractiveImpl: async (request) => {
        launched = request;
        return { code: 0, signal: null };
      },
    });
    const copies = listCopiedRollouts({ codexHome, exclude: sourcePath });
    assert.equal(copies.length, 1);
    const text = fs.readFileSync(copies[0], "utf8");
    assert.equal(text.includes("ENCRYPTED_COMPACTION_BLOB"), true);
    assert.equal(text.includes(SOURCE_THREAD), false);
    assert.equal(text.includes(TURN), false);
    assert.equal(launched.args[3], JSON.parse(text.split("\n")[0]).payload.id);
  });

  await t.test("--allow-context-loss copies without the blob", async () => {
    const { home, codexHome, sourcePath, connectRedisStoreImpl, probeUsageSnapshotsByProviderImpl } = await setup(["boss", "writer"], { compacted: true });
    await runCli(["codex", "resume-fresh", SOURCE_THREAD, "--allow-context-loss", "--home", home], {
      connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl,
      env: {},
      spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      runCodexInteractiveImpl: async () => ({ code: 0, signal: null }),
    });
    const copies = listCopiedRollouts({ codexHome, exclude: sourcePath });
    assert.equal(copies.length, 1);
    const text = fs.readFileSync(copies[0], "utf8");
    assert.equal(text.includes("ENCRYPTED_COMPACTION_BLOB"), false);
    assert.equal(text.includes(SOURCE_THREAD), false);
  });
});

test("resume-fresh refuses bad ids and threads that spawned subagents", async (t) => {
  const { home, connectRedisStoreImpl } = await setup();
  await assert.rejects(
    () => runCli(["codex", "resume-fresh", "not-a-uuid", "--home", home], { connectRedisStoreImpl, env: {} }),
    /needs a Codex thread id/,
  );
  await assert.rejects(
    () => runCli(["codex", "resume-fresh", "--home", home], { connectRedisStoreImpl, env: {} }),
    /Usage: aim codex resume-fresh/,
  );

  await t.test("subagent threads are refused", async () => {
    const spawned = await setup(["boss", "writer"], { withSpawnEvent: true });
    await assert.rejects(
      () => runCli(["codex", "resume-fresh", SOURCE_THREAD, "--home", spawned.home], {
        connectRedisStoreImpl: spawned.connectRedisStoreImpl,
        probeUsageSnapshotsByProviderImpl: spawned.probeUsageSnapshotsByProviderImpl,
        env: {},
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      }),
      /spawned subagents/,
    );
    assert.deepEqual(listCopiedRollouts({ codexHome: spawned.codexHome, exclude: spawned.sourcePath }), []);
  });

  await t.test("item_completed subagent activity is refused even without a sub_agent event", async () => {
    const spawned = await setup(["boss", "writer"], { spawnItemType: "SubAgentActivity" });
    await assert.rejects(
      () => runCli(["codex", "resume-fresh", SOURCE_THREAD, "--home", spawned.home], {
        connectRedisStoreImpl: spawned.connectRedisStoreImpl,
        probeUsageSnapshotsByProviderImpl: spawned.probeUsageSnapshotsByProviderImpl,
        env: {},
        spawnSyncImpl: () => ({ status: 1, stdout: "", stderr: "" }),
      }),
      /spawned subagents/,
    );
    assert.deepEqual(listCopiedRollouts({ codexHome: spawned.codexHome, exclude: spawned.sourcePath }), []);
  });
});
