import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { CodexForegroundRelaySession } from "../../src/targets/codex-foreground-relay.js";

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

class FakeForegroundHelperProcess extends EventEmitter {
  constructor() {
    super();
    this.stdio = [null, null, null, new FakeWritable(), new EventEmitter()];
    this.exitCode = null;
    this.signalCode = null;
    this.killedWith = null;
  }

  kill(signal) {
    this.killedWith = signal;
    this.signalCode = signal;
  }
}

function createFakeForegroundHelperSpawn() {
  const helpers = [];
  const calls = [];
  return {
    helpers,
    calls,
    spawnImpl(command, args, options) {
      const helper = new FakeForegroundHelperProcess();
      helpers.push(helper);
      calls.push({ command, args, options });
      return helper;
    },
  };
}

function foregroundHelperMessages(helper) {
  return helper.stdio[3].chunks
    .join("")
    .split(/\n/)
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line));
}

function emitForegroundHelperMessage(helper, message) {
  helper.stdio[4].emit("data", Buffer.from(`${JSON.stringify(message)}\n`, "utf8"));
}

async function waitForPredicate(predicate, { timeoutMs = 1_000, intervalMs = 10 } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await predicate();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  return null;
}

test("CodexForegroundRelaySession speaks side-channel protocol without terminal byte forwarding", async () => {
  const observedGoalIntents = [];
  const { spawnImpl, helpers, calls } = createFakeForegroundHelperSpawn();
  const session = new CodexForegroundRelaySession({
    spawnImpl,
    pythonBin: "/usr/bin/python3",
    helperPath: "/tmp/codex-foreground-relay.py",
    onGoalIntent: (line) => observedGoalIntents.push(line),
  });

  session.start({ argv: ["/tmp/codex", "--no-alt-screen"], cwd: "/tmp/work", env: { TEST_ENV: "1" }, cols: 90, rows: 30 });
  const helper = helpers[0];
  assert.deepEqual(calls[0], {
    command: "/usr/bin/python3",
    args: ["/tmp/codex-foreground-relay.py"],
    options: { stdio: ["inherit", "inherit", "inherit", "pipe", "pipe"] },
  });
  assert.deepEqual(foregroundHelperMessages(helper)[0], {
    type: "start",
    argv: ["/tmp/codex", "--no-alt-screen"],
    cwd: "/tmp/work",
    env: { TEST_ENV: "1" },
    cols: 90,
    rows: 30,
    requireTty: true,
  });

  const readyPromise = session.waitForReady({ timeoutMs: 10 });
  emitForegroundHelperMessage(helper, { type: "ready", pid: 456 });
  assert.equal((await readyPromise).status, "ready");

  emitForegroundHelperMessage(helper, { type: "goal_intent", line: "/goal ship it" });
  assert.deepEqual(observedGoalIntents, ["/goal ship it"]);

  const snapshotPromise = session.snapshotOutput({ timeoutMs: 50 });
  const snapshotRequest = foregroundHelperMessages(helper).find((message) => message.type === "snapshot");
  emitForegroundHelperMessage(helper, {
    type: "snapshot",
    requestId: snapshotRequest.requestId,
    text: "Resume paused goal?\n1. Resume goal",
  });
  assert.equal(await snapshotPromise, "Resume paused goal?\n1. Resume goal");

  session.sendInput("x");
  session.sendEnter();
  session.sendExit();
  session.resize({ cols: 101, rows: 41 });
  session.terminate();
  const exitPromise = session.waitForExit({ timeoutMs: 10 });
  emitForegroundHelperMessage(helper, { type: "exit", exitCode: 0, signal: null });
  assert.deepEqual(await exitPromise, { exitCode: 0, signal: null });
  helper.exitCode = 0;
  session.dispose();

  const messages = foregroundHelperMessages(helper);
  assert.equal(messages.some((message) => message.type === "send_input" && Buffer.from(message.data, "base64").toString("utf8") === "x"), true);
  assert.equal(messages.some((message) => message.type === "send_enter"), true);
  assert.equal(messages.some((message) => message.type === "send_exit"), true);
  assert.equal(messages.some((message) => message.type === "resize" && message.cols === 101 && message.rows === 41), true);
  assert.equal(messages.some((message) => message.type === "terminate"), true);
  assert.equal(messages.some((message) => message.type === "output"), false);
  assert.equal(helper.stdio[3].ended, true);
  assert.equal(helper.killedWith, null);
});

test("CodexForegroundRelaySession reports helper errors before ready", async () => {
  const { spawnImpl, helpers } = createFakeForegroundHelperSpawn();
  const session = new CodexForegroundRelaySession({ spawnImpl });

  session.start({ argv: ["/tmp/codex"], cwd: "/tmp/work", env: {} });
  const readyPromise = session.waitForReady({ timeoutMs: 10 });
  emitForegroundHelperMessage(helpers[0], { type: "error", reason: "not_tty", message: "foreground relay requires TTY stdin/stdout" });

  const ready = await readyPromise;
  assert.equal(ready.status, "error");
  assert.equal(ready.reason, "not_tty");
});

test("Codex foreground relay helper moves terminal bytes outside the side channel", async () => {
  const pythonBin = process.env.AIMGR_PYTHON_BIN || "python3";
  const observedGoalIntents = [];
  const childCode = [
    "import os, termios, tty",
    "attrs = termios.tcgetattr(0)",
    "tty.setraw(0, termios.TCSANOW)",
    "os.write(1, b'child-ready\\n')",
    "buf = b''",
    "while not buf.endswith(b'\\r'):",
    "    buf += os.read(0, 1)",
    "os.write(1, b'ECHO:' + buf + b'\\n')",
    "termios.tcsetattr(0, termios.TCSADRAIN, attrs)",
  ].join("\n");
  const session = new CodexForegroundRelaySession({
    pythonBin,
    requireTty: false,
    stdio: ["pipe", "pipe", "pipe", "pipe", "pipe"],
    onGoalIntent: (line) => observedGoalIntents.push(line),
  });

  session.start({
    argv: [pythonBin, "-u", "-c", childCode],
    cwd: process.cwd(),
    env: {},
    cols: 80,
    rows: 24,
  });
  try {
    const ready = await session.waitForReady({ timeoutMs: 1_000 });
    assert.equal(ready.status, "ready");
    const childReady = await waitForPredicate(async () => {
      const output = await session.snapshotOutput({ timeoutMs: 100 });
      return output.includes("child-ready") ? output : null;
    });
    assert.match(childReady, /child-ready/);

    session.helper.stdin.write("/goal helper-test\r");
    const goalIntent = await waitForPredicate(() => observedGoalIntents[0], { timeoutMs: 1_000 });
    assert.equal(goalIntent, "/goal helper-test");
    const snapshot = await waitForPredicate(async () => {
      const output = await session.snapshotOutput({ timeoutMs: 100 });
      return output.includes("ECHO:/goal helper-test") ? output : null;
    });
    assert.match(snapshot, /ECHO:\/goal helper-test/);
  } finally {
    session.terminate();
    await session.waitForExit({ timeoutMs: 1_000 });
    session.dispose();
  }
});
