import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { writeJsonFileIfChanged } from "../../src/io/json-store.js";
import { resolveCodexAuthFilePath, resolveManagedCodexHomeDir } from "../../src/io/paths.js";
import { activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel } from "../../src/targets/codex-cli.js";
import { CodexPtySession, createGoalIntentDetector } from "../../src/targets/codex-pty.js";
import {
  readCompleteJsonlRecords,
  resolveOwnedThreadFromRunTag,
  resolveRolloutForThreadId,
  tailGoalStatus,
} from "../../src/targets/codex-rollout.js";
import { acquireCodexTendThreadLock } from "../../src/targets/codex-tend-lock.js";
import { runCodexTender } from "../../src/targets/codex-tender.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

const SESSION_ID = "019e5487-026d-7f52-8fbd-1d123045f1c6";
const OTHER_SESSION_ID = "019e5487-026d-7f52-8fbd-1d123045f1c7";
const THIRD_SESSION_ID = "019e5487-026d-7f52-8fbd-1d123045f1c8";
const REDIS_PREFIX = "aimgr:codex-tend-test";

function token(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
}

function codexCredential(accountId = "acct_boss", refresh = "REFRESH_BOSS") {
  return {
    access: token(accountId),
    refresh,
    idToken: token(accountId),
    accountId,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

async function seedRedisCodexTender({ home, client }) {
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: REDIS_PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: REDIS_PREFIX });
  await importCredentialsSnapshot(
    store,
    {
      credentials: [
        {
          provider: "openai-codex",
          label: "boss",
          credential: codexCredential(),
          identity: { accountId: "acct_boss" },
          policy: { pool: { enabled: true } },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { updatedBy: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

function writeMinimalState(home) {
  writeJson(path.join(home, ".aimgr", "secrets.json"), {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });
}

function writeRollout({
  home,
  threadId = SESSION_ID,
  fileName = `rollout-2026-05-30T14-00-00-${threadId}.jsonl`,
  originator = "aimgr-tend-test",
  source = "cli",
  threadSource = "user",
  goalStatus = "active",
  partial = "",
}) {
  const codexHome = resolveManagedCodexHomeDir({ homeDir: home, env: {} });
  const rolloutPath = path.join(codexHome, "sessions", "2026", "05", "30", fileName);
  fs.mkdirSync(path.dirname(rolloutPath), { recursive: true });
  const records = [
    {
      type: "session_meta",
      payload: {
        id: threadId,
        originator,
        source,
        thread_source: threadSource,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "thread_goal_updated",
        threadId,
        goal: { threadId, status: goalStatus },
      },
    },
  ];
  fs.writeFileSync(
    rolloutPath,
    `${records.map((record) => JSON.stringify(record)).join("\n")}\n${partial}`,
    "utf8",
  );
  return rolloutPath;
}

function createFakePtyFactory({
  output = "",
  ready = { status: "ready" },
  exitAfterStart = false,
  onStart,
} = {}) {
  const sessions = [];
  const factory = (options = {}) => {
    const session = {
      options,
      output,
      starts: [],
      sentEnter: 0,
      sentExit: 0,
      terminated: 0,
      disposed: 0,
      exitInfo: exitAfterStart ? { exitCode: 0, signal: null } : null,
      start(config) {
        this.starts.push(config);
        onStart?.({ session: this, config, options });
        return this;
      },
      waitForReady() {
        return Promise.resolve(ready);
      },
      on() {
        return this;
      },
      snapshotOutput() {
        return this.output;
      },
      sendEnter() {
        this.sentEnter += 1;
      },
      sendExit() {
        this.sentExit += 1;
        this.exitInfo = { exitCode: 0, signal: null };
      },
      waitForExit() {
        return Promise.resolve(this.exitInfo);
      },
      terminate() {
        this.terminated += 1;
        this.exitInfo = { exitCode: null, signal: "SIGTERM" };
      },
      dispose() {
        this.disposed += 1;
      },
    };
    sessions.push(session);
    return session;
  };
  return { factory, sessions };
}

class FakeWritable extends EventEmitter {
  constructor() {
    super();
    this.chunks = [];
    this.writable = true;
    this.ended = false;
  }

  write(chunk) {
    this.chunks.push(Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk));
    return true;
  }

  end() {
    this.ended = true;
    this.writable = false;
  }
}

class FakeHelperProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new FakeWritable();
    this.stdout = new EventEmitter();
    this.stderr = new EventEmitter();
    this.exitCode = null;
    this.signalCode = null;
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    this.signalCode = signal;
  }
}

function createFakeHelperSpawn() {
  const helpers = [];
  return {
    helpers,
    spawnImpl() {
      const helper = new FakeHelperProcess();
      helpers.push(helper);
      return helper;
    },
  };
}

function helperMessages(helper) {
  return helper.stdin.chunks
    .join("")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function emitHelperMessage(helper, message) {
  helper.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
}

test("codex run --tend wires PTY supervision options and Codex args", async () => {
  let captured = null;
  const out = await runCli(
    [
      "codex",
      "run",
      "--tend",
      "--no-attach",
      "--codex-bin",
      "/tmp/codex-bin",
      "--max-restarts",
      "2",
      "--poll-seconds",
      "0.25",
      "--bind-timeout-seconds",
      "7",
      "--workdir",
      "/tmp/work",
      "-p",
      "yolo",
      "--",
      "--model",
      "gpt-5.5",
      "--search",
    ],
    {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          threadId: "thread-1",
          restarts: 0,
          events: [],
        };
      },
    },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tended.status, "ended");
  assert.equal(Object.hasOwn(captured, "sessionName"), false);
  assert.equal(captured.codexBin, "/tmp/codex-bin");
  assert.equal(captured.cwd, "/tmp/work");
  assert.equal(captured.attach, false);
  assert.equal(captured.maxRestarts, "2");
  assert.equal(captured.pollSeconds, "0.25");
  assert.equal(captured.bindTimeoutSeconds, "7");
  assert.equal(captured.codexProfile, "yolo");
  assert.deepEqual(captured.codexArgs, ["--model", "gpt-5.5", "--search"]);
});

test("codex run --tend rejects obsolete tmux session option", async () => {
  await assert.rejects(
    runCli(["codex", "run", "--tend", "--tmux-session", "overnight-codex"]),
    /--tmux-session.*obsolete.*PTY supervisor/,
  );
});

for (const flag of ["--profile", "--codex-profile"]) {
  test(`codex run --tend accepts ${flag} for Codex profile selection`, async () => {
    let captured = null;
    await runCli(["codex", "run", "--tend", "--no-attach", flag, "yolo"], {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          threadId: "thread-1",
          restarts: 0,
          events: [],
        };
      },
    });

    assert.equal(captured.codexProfile, "yolo");
  });
}

for (const flag of ["--resume", "--session-id"]) {
  test(`codex run --tend accepts ${flag} for existing Codex session tending`, async () => {
    let captured = null;
    await runCli(["codex", "run", "--tend", "--no-attach", "-p", "yolo", flag, SESSION_ID], {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          threadId: SESSION_ID,
          restarts: 0,
          events: [],
        };
      },
    });

    assert.equal(captured.codexProfile, "yolo");
    assert.equal(captured.resumeSessionId, SESSION_ID);
  });
}

test("codex run --tend reports blocked tender with exit code 1", async () => {
  const result = await runCliWithExitCode(["codex", "run", "--tend", "--no-attach"], {
    runCodexTenderImpl: async () => ({
      status: "blocked",
      reason: "rotation_blocked",
      events: [],
    }),
  });

  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.tended.status, "blocked");
  assert.equal(parsed.tended.reason, "rotation_blocked");
});

test("runCodexTender rejects Codex remote passthrough before starting a PTY", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  let started = false;

  await assert.rejects(
    runCodexTender(
      {
        statePath: path.join(home, ".aimgr", "secrets.json"),
        homeDir: home,
        preflight: false,
        codexArgs: ["--remote", "ws://localhost:9999"],
      },
      {
        createPtySessionImpl: () => {
          started = true;
          return createFakePtyFactory().factory();
        },
      },
    ),
    /--remote is incompatible with the PTY\/rollout Tend runtime/,
  );
  assert.equal(started, false);
});

test("runCodexTender binds a new goal by Codex rollout originator without tmux or app-server state", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const { factory, sessions } = createFakePtyFactory({
    exitAfterStart: true,
    onStart({ config }) {
      writeRollout({
        home,
        threadId: SESSION_ID,
        originator: config.env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE,
      });
    },
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      codexArgs: ["--model", "gpt-5.5"],
      preflight: false,
      attach: false,
      pollSeconds: 0,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, SESSION_ID);
  assert.equal(result.rolloutPath.endsWith(`${SESSION_ID}.jsonl`), true);
  assert.deepEqual(sessions[0].starts[0].argv, ["/tmp/codex", "--no-alt-screen", "--model", "gpt-5.5"]);
  assert.equal(sessions[0].starts[0].env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE, result.originator);
  assert.equal(result.events.some((event) => event.type === "thread_bound"), true);
});

test("runCodexTender blocks ambiguous tagged goal rollouts", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const { factory } = createFakePtyFactory({ exitAfterStart: true });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      preflight: false,
      attach: false,
      pollSeconds: 0,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
      resolveOwnedThreadFromRunTagImpl: () => ({
        status: "ambiguous",
        candidates: [{ threadId: SESSION_ID }, { threadId: OTHER_SESSION_ID }],
      }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ambiguous_tagged_goal_rollouts");
});

test("runCodexTender resumes a known thread using session_meta.id fallback", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const rolloutPath = writeRollout({
    home,
    threadId: SESSION_ID,
    fileName: "rollout-2026-05-30T14-00-00-nonmatching.jsonl",
  });
  const { factory, sessions } = createFakePtyFactory({
    output: "Goal active",
    exitAfterStart: true,
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      resumeSessionId: SESSION_ID,
      preflight: false,
      attach: false,
      pollSeconds: 0,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, SESSION_ID);
  assert.equal(result.rolloutPath, rolloutPath);
  assert.deepEqual(sessions[0].starts[0].argv, ["/tmp/codex", "--no-alt-screen", "resume", SESSION_ID]);
});

test("runCodexTender blocks if an explicit resume prompt cannot be confirmed", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  writeRollout({ home, threadId: SESSION_ID });
  const { factory } = createFakePtyFactory({ exitAfterStart: true });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      resumeSessionId: SESSION_ID,
      preflight: false,
      attach: false,
      pollSeconds: 0,
      promptTimeoutSeconds: 1,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "resume_prompt_unconfirmed");
});

test("runCodexTender blocks duplicate live owners for an explicit thread", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  writeRollout({ home, threadId: SESSION_ID });
  const lock = acquireCodexTendThreadLock({
    homeDir: home,
    threadId: SESSION_ID,
    runid: "existing-run",
    originator: "aimgr-tend-existing",
    cwd: "/tmp",
    mode: "resume",
  });
  try {
    const { factory } = createFakePtyFactory({ output: "Goal active" });
    const result = await runCodexTender(
      {
        statePath: path.join(home, ".aimgr", "secrets.json"),
        homeDir: home,
        resumeSessionId: SESSION_ID,
        preflight: false,
        attach: false,
        startedAtMs: 0,
      },
      {
        createPtySessionImpl: factory,
        sleepImpl: async () => {},
      },
    );

    assert.equal(result.status, "blocked");
    assert.equal(result.reason, "thread_already_tended");
  } finally {
    lock.release();
  }
});

test("Codex Tend thread lock reclaims stale locks and release only removes the same run", () => {
  const home = mkTempHome();
  const stale = acquireCodexTendThreadLock({
    homeDir: home,
    threadId: SESSION_ID,
    runid: "stale-run",
    originator: "aimgr-tend-stale",
    cwd: "/tmp",
    mode: "resume",
    pid: 0,
  });
  const fresh = acquireCodexTendThreadLock({
    homeDir: home,
    threadId: SESSION_ID,
    runid: "fresh-run",
    originator: "aimgr-tend-fresh",
    cwd: "/tmp",
    mode: "resume",
    pid: process.pid,
  });

  assert.equal(fresh.status, "acquired");
  stale.release();
  assert.equal(fs.existsSync(fresh.path), true);
  fresh.release();
  assert.equal(fs.existsSync(fresh.path), false);
});

test("runCodexTender rotates only on owned goal usageLimited and resumes active goal", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  writeRollout({ home, threadId: SESSION_ID, goalStatus: "usageLimited" });
  const { factory, sessions } = createFakePtyFactory({
    output: ["Resume paused goal?", "1. Resume goal"].join("\n"),
  });
  let tailCalls = 0;

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      resumeSessionId: SESSION_ID,
      preflight: false,
      attach: false,
      pollSeconds: 0,
      promptTimeoutSeconds: 1,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => ({ status: "activated", receipt: {} }),
      tailGoalStatusImpl: () => {
        tailCalls += 1;
        const status = tailCalls === 1 ? "usageLimited" : "active";
        return { offset: tailCalls, status, goal: { threadId: SESSION_ID, status } };
      },
    },
  );

  assert.equal(result.status, "poll_limit_reached");
  assert.equal(result.restarts, 1);
  assert.equal(result.rotations.length, 1);
  assert.equal(sessions.length, 2);
  assert.equal(sessions[0].sentExit, 1);
  assert.equal(sessions[1].sentEnter, 1);
  assert.deepEqual(sessions[1].starts[0].argv, ["/tmp/codex", "--no-alt-screen", "resume", SESSION_ID]);
});

test("runCodexTender returns python3_unavailable when the PTY helper cannot spawn", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      preflight: false,
      attach: false,
    },
    {
      createPtySessionImpl: () => ({
        on() {
          return this;
        },
        start() {
          return this;
        },
        waitForReady() {
          return Promise.resolve({ status: "error", reason: "python3_unavailable" });
        },
        dispose() {},
      }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "python3_unavailable");
});

test("runCodexTender blocks after goal intent when no owned rollout binds", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const { factory } = createFakePtyFactory({
    onStart({ options }) {
      options.onGoalIntent();
    },
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      preflight: false,
      attach: false,
      bindTimeoutSeconds: 0.001,
      pollSeconds: 0.001,
      maxPollIterations: 10,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: () => new Promise((resolve) => setTimeout(resolve, 2)),
      resolveOwnedThreadFromRunTagImpl: () => ({ status: "missing", candidates: [] }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "goal_bind_timeout");
});

test("runCodexTender ignores generic pane rate-limit text when the owned rollout is active", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  writeRollout({ home, threadId: SESSION_ID, goalStatus: "active" });
  const { factory } = createFakePtyFactory({
    output: "Rate limit reached. Goal active",
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      resumeSessionId: SESSION_ID,
      preflight: false,
      attach: false,
      pollSeconds: 0,
      maxPollIterations: 1,
      startedAtMs: 0,
    },
    {
      createPtySessionImpl: factory,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        throw new Error("generic pane/global usage trigger should not rotate");
      },
    },
  );

  assert.equal(result.status, "poll_limit_reached");
  assert.equal(result.rotations.length, 0);
});

test("rollout reader ignores corrupt and partial records while preserving offsets", () => {
  const home = mkTempHome();
  const rolloutPath = writeRollout({
    home,
    threadId: SESSION_ID,
  });
  fs.appendFileSync(rolloutPath, "not-json\n{\"type\":\"event_msg\",\"payload\":{\"type\":\"thread_goal_updated\"", "utf8");

  const read = readCompleteJsonlRecords(rolloutPath);
  assert.equal(read.records.length, 2);
  assert.equal(read.nextOffset < fs.statSync(rolloutPath).size, true);

  const status = tailGoalStatus({ rolloutPath, threadId: SESSION_ID });
  assert.equal(status.status, "active");
});

test("rollout binding uses originator and treats multiple tagged goal sessions as ambiguous", () => {
  const home = mkTempHome();
  const originator = "aimgr-tend-ambiguous";
  writeRollout({ home, threadId: SESSION_ID, originator });
  writeRollout({ home, threadId: OTHER_SESSION_ID, originator });
  writeRollout({ home, threadId: THIRD_SESSION_ID, originator: "aimgr-tend-other" });
  const sessionsDir = path.join(resolveManagedCodexHomeDir({ homeDir: home, env: {} }), "sessions");

  const resolved = resolveOwnedThreadFromRunTag({ sessionsDir, originator, startedAtMs: 0 });
  assert.equal(resolved.status, "ambiguous");
  assert.deepEqual(
    resolved.candidates.map((candidate) => candidate.threadId).sort(),
    [OTHER_SESSION_ID, SESSION_ID].sort(),
  );

  const byMeta = resolveRolloutForThreadId({ sessionsDir, threadId: THIRD_SESSION_ID });
  assert.equal(byMeta.status, "found");
});

test("rollout binding ignores same-originator sub-agent rollouts", () => {
  const home = mkTempHome();
  const originator = "aimgr-tend-subagents";
  writeRollout({ home, threadId: SESSION_ID, originator });
  writeRollout({ home, threadId: OTHER_SESSION_ID, originator, threadSource: "subagent" });
  const sessionsDir = path.join(resolveManagedCodexHomeDir({ homeDir: home, env: {} }), "sessions");

  const resolved = resolveOwnedThreadFromRunTag({ sessionsDir, originator, startedAtMs: 0 });
  assert.equal(resolved.status, "bound");
  assert.equal(resolved.threadId, SESSION_ID);
});

test("Codex goal intent detector observes user /goal submissions only", () => {
  const observed = [];
  const detector = createGoalIntentDetector({
    onGoalIntent: (line) => observed.push(line),
  });

  detector.push(Buffer.from("hello\r"));
  detector.push(Buffer.from("/goaX\x7fl test\r"));
  detector.push(Buffer.from("/goal ignored\r"));

  assert.deepEqual(observed, ["/goal test"]);
  assert.equal(detector.observed, true);
});

test("CodexPtySession frames helper protocol, output, resize, exit, and helper errors", async () => {
  const { spawnImpl, helpers } = createFakeHelperSpawn();
  const session = new CodexPtySession({
    spawnImpl,
    attach: false,
    stdout: { columns: 90, rows: 30, write() {} },
  });

  session.start({ argv: ["/tmp/codex", "--no-alt-screen"], cwd: "/tmp/work", env: { TEST_ENV: "1" } });
  const helper = helpers[0];
  assert.deepEqual(helperMessages(helper)[0], {
    type: "start",
    argv: ["/tmp/codex", "--no-alt-screen"],
    cwd: "/tmp/work",
    env: { TEST_ENV: "1" },
    cols: 90,
    rows: 30,
  });

  const readyPromise = session.waitForReady({ timeoutMs: 10 });
  emitHelperMessage(helper, { type: "ready", pid: 123 });
  assert.equal((await readyPromise).status, "ready");

  emitHelperMessage(helper, { type: "output", data: Buffer.from("hello").toString("base64") });
  session.resize({ cols: 101, rows: 41 });
  session.write("x");
  session.sendExit();
  await new Promise((resolve) => setTimeout(resolve, 1000));
  const exitPromise = session.waitForExit({ timeoutMs: 10 });
  emitHelperMessage(helper, { type: "exit", exitCode: 0, signal: null });

  assert.equal(session.snapshotOutput(), "hello");
  assert.deepEqual(await exitPromise, { exitCode: 0, signal: null });
  const messages = helperMessages(helper);
  assert.equal(messages.some((message) => message.type === "resize" && message.cols === 101 && message.rows === 41), true);
  const inputPayloads = messages
    .filter((message) => message.type === "input")
    .map((message) => Buffer.from(message.data, "base64").toString("utf8"));
  assert.deepEqual(inputPayloads.slice(-5), ["x", "\x1b", "\x15", "\x04", "\x04"]);
});

test("CodexPtySession attached mode relays stdin, resize, goal intent, and restores raw mode", () => {
  const { spawnImpl, helpers } = createFakeHelperSpawn();
  const stdin = new EventEmitter();
  stdin.isTTY = true;
  stdin.isRaw = false;
  stdin.rawCalls = [];
  stdin.setRawMode = (value) => {
    stdin.rawCalls.push(value);
    stdin.isRaw = value;
  };
  stdin.resume = () => {
    stdin.resumed = true;
  };
  const stdout = new EventEmitter();
  stdout.columns = 120;
  stdout.rows = 40;
  stdout.write = () => {};
  const observed = [];
  const session = new CodexPtySession({
    spawnImpl,
    attach: true,
    stdin,
    stdout,
    onGoalIntent: (line) => observed.push(line),
  });

  session.start({ argv: ["/tmp/codex"], cwd: "/tmp/work", env: {} });
  const helper = helpers[0];
  stdin.emit("data", Buffer.from("/goal now\r"));
  stdout.columns = 80;
  stdout.rows = 24;
  stdout.emit("resize");
  session.dispose();

  const messages = helperMessages(helper);
  assert.deepEqual(observed, ["/goal now"]);
  assert.deepEqual(messages[1], { type: "input", data: Buffer.from("/goal now\r").toString("base64") });
  assert.deepEqual(messages[2], { type: "resize", cols: 80, rows: 24 });
  assert.deepEqual(stdin.rawCalls, [true, false]);
  assert.equal(stdin.resumed, true);
  assert.equal(helper.stdin.ended, true);
  assert.equal(helper.killedWith, "SIGTERM");
});

test("writeJsonFileIfChanged is atomic enough for unchanged rewrites and leaves no temp files", () => {
  const home = mkTempHome();
  const filePath = path.join(home, ".aimgr", "state.json");
  const first = writeJsonFileIfChanged(filePath, { ok: true }, { mode: 0o600 });
  const second = writeJsonFileIfChanged(filePath, { ok: true }, { mode: 0o600 });
  const leftovers = fs.readdirSync(path.dirname(filePath)).filter((name) => name.includes(".tmp"));

  assert.equal(first.wrote, true);
  assert.equal(second.wrote, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { ok: true });
  assert.deepEqual(leftovers, []);
});

test("redis-configured codex run --tend publishes live auth rotation through Redis state runtime", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedRedisCodexTender({ home, client });

  await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: REDIS_PREFIX }),
  });

  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED_BY_TEND");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  let preserved = null;
  const out = await runCli(["codex", "run", "--tend", "--no-attach", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: REDIS_PREFIX }),
    runCodexTenderImpl: async ({ stateRuntime, homeDir, env }) => {
      assert.ok(stateRuntime?.withMutableState);
      const readOnly = await stateRuntime.withReadOnlyState(async (state) => ({
        activeLabel: state.targets.codexCli.activeLabel,
        refresh: state.credentials["openai-codex"].boss.refresh,
      }));
      assert.deepEqual(readOnly, {
        activeLabel: "boss",
        refresh: "REFRESH_BOSS",
      });
      const result = await stateRuntime.withMutableState(async (state, helpers) => {
        const preserveResult = preserveLiveCodexAuthForActiveLabel({
          state,
          homeDir,
          env,
          observedAt: "2026-05-30T14:30:00.000Z",
        });
        await helpers.publishCodexPreserveResult(preserveResult);
        return preserveResult;
      });
      preserved = result;
      return {
        status: "ended",
        threadId: "thread-1",
        restarts: 0,
        events: [{ type: "test_preserve", status: result.status }],
      };
    },
  });

  assert.equal(JSON.parse(out).ok, true);
  assert.equal(preserved.status, "updated");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_ROTATED_BY_TEND");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured codex run --tend does not publish staged live auth when mutation fails", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedRedisCodexTender({ home, client });

  await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: REDIS_PREFIX }),
  });

  const rotated = codexCredential("acct_boss", "REFRESH_SHOULD_NOT_COMMIT");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  await assert.rejects(
    runCli(["codex", "run", "--tend", "--no-attach", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: REDIS_PREFIX }),
      runCodexTenderImpl: async ({ stateRuntime, homeDir, env }) => {
        await stateRuntime.withMutableState(async (state, helpers) => {
          const preserveResult = preserveLiveCodexAuthForActiveLabel({
            state,
            homeDir,
            env,
            observedAt: "2026-05-30T14:35:00.000Z",
          });
          await helpers.publishCodexPreserveResult(preserveResult);
          throw new Error("selection failed after preserve");
        });
      },
    }),
    /selection failed after preserve/,
  );

  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.credentials.find((credential) => credential.label === "boss").credential.refresh, "REFRESH_BOSS");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("activateCodexPoolSelection can require an alternate without clearing the current auth", async () => {
  const home = mkTempHome();
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "REFRESH_BOSS",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
      },
    },
    pool: { openaiCodex: { history: [] } },
  };

  const result = await activateCodexPoolSelection({
    state,
    homeDir: home,
    observedAt: "2026-05-23T00:00:00.000Z",
    usageByProvider: {
      "openai-codex": {
        boss: {
          ok: true,
          windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
        },
      },
    },
    selectionMode: "weighted_usage",
    avoidCurrentLabel: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.blockers[0].reason, "no_alternate_pool_account");
  assert.equal(state.targets.codexCli.activeLabel, "boss");
  const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
});

test("preserveLiveCodexAuthForActiveLabel stores refreshed live auth before rotation", () => {
  const home = mkTempHome();
  const oldJwt = makeFakeJwt({
    email: "boss@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const newJwt = makeFakeJwt({
    email: "boss@example.com",
    exp: Math.floor(Date.now() / 1000) + 7200,
    refreshed: true,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const oldCredential = {
    access: oldJwt,
    refresh: "OLD_REFRESH",
    idToken: oldJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_boss",
  };
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: oldCredential },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_boss",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(oldCredential),
              dirtyLocal: false,
            },
          },
        },
        anthropic: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
      },
    },
    pool: { openaiCodex: { history: [] } },
  };
  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: newJwt,
      access_token: newJwt,
      refresh_token: "NEW_REFRESH",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });

  const preserved = preserveLiveCodexAuthForActiveLabel({ state, homeDir: home, observedAt: "2026-05-23T00:00:00.000Z" });

  assert.equal(preserved.status, "updated");
  assert.equal(preserved.label, "boss");
  assert.equal(state.credentials["openai-codex"].boss.access, newJwt);
  assert.equal(state.credentials["openai-codex"].boss.refresh, "NEW_REFRESH");
  assert.equal(state.credentials["openai-codex"].boss.idToken, newJwt);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyObservedAt, "2026-05-23T00:00:00.000Z");
  assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), true);
});
