import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { superviseClaudeProcess } from "../../src/targets/claude-supervisor.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("../../src/targets/claude-supervisor.js", import.meta.url));

class FakeParentProcess extends EventEmitter {
  constructor({ connected = true } = {}) {
    super();
    this.connected = connected;
  }
}

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.killedWith = [];
  }

  kill(signal) {
    this.killedWith.push(signal);
    return true;
  }
}

test("Claude supervisor spawns the exact executable and propagates a normal nonzero exit", async () => {
  const parentProcess = new FakeParentProcess();
  const child = new FakeChildProcess();
  const calls = [];
  const resultPromise = superviseClaudeProcess({
    command: process.execPath,
    args: ["--first", "argument with spaces"],
    env: { PINNED: "yes" },
    parentProcess,
    spawnImpl: (command, args, options) => {
      calls.push({ command, args, options });
      return child;
    },
  });

  assert.deepEqual(calls, [{
    command: process.execPath,
    args: ["--first", "argument with spaces"],
    options: { stdio: "inherit", env: { PINNED: "yes" } },
  }]);
  child.emit("close", 9, null);
  assert.deepEqual(await resultPromise, { status: 9, signal: null });
  assert.equal(parentProcess.listenerCount("disconnect"), 0);
});

test("Claude supervisor kills Claude when AIM disconnects and escalates within five seconds", async () => {
  const parentProcess = new FakeParentProcess();
  const child = new FakeChildProcess();
  let forcedKillTimer = null;
  const resultPromise = superviseClaudeProcess({
    command: process.execPath,
    parentProcess,
    spawnImpl: () => child,
    setTimeoutImpl: (callback, delayMs) => {
      forcedKillTimer = { callback, delayMs, cleared: false };
      return forcedKillTimer;
    },
    clearTimeoutImpl: (timer) => {
      timer.cleared = true;
    },
  });

  parentProcess.connected = false;
  parentProcess.emit("disconnect");
  assert.deepEqual(child.killedWith, ["SIGTERM"]);
  assert.ok(forcedKillTimer);
  assert.ok(forcedKillTimer.delayMs <= 5_000);

  forcedKillTimer.callback();
  assert.deepEqual(child.killedWith, ["SIGTERM", "SIGKILL"]);
  child.emit("close", null, "SIGKILL");
  assert.deepEqual(await resultPromise, { status: 1, signal: "SIGKILL" });
  assert.equal(forcedKillTimer.cleared, true);
});

test("Claude supervisor forwards termination signals to Claude", async () => {
  const parentProcess = new FakeParentProcess();
  const child = new FakeChildProcess();
  const resultPromise = superviseClaudeProcess({
    command: process.execPath,
    parentProcess,
    spawnImpl: () => child,
  });

  parentProcess.emit("SIGHUP");
  assert.deepEqual(child.killedWith, ["SIGHUP"]);
  child.emit("close", null, "SIGHUP");
  assert.deepEqual(await resultPromise, { status: 1, signal: "SIGHUP" });
});

test("Claude supervisor refuses to launch after its AIM IPC channel is gone", async () => {
  const parentProcess = new FakeParentProcess({ connected: false });
  let spawned = false;
  const result = await superviseClaudeProcess({
    command: process.execPath,
    parentProcess,
    spawnImpl: () => {
      spawned = true;
      return new FakeChildProcess();
    },
  });

  assert.equal(spawned, false);
  assert.deepEqual(result, { status: 1, signal: "SIGTERM" });
});

test("standalone Claude supervisor observes a real Node IPC disconnect", async () => {
  const supervisor = spawn(process.execPath, [
    SUPERVISOR_PATH,
    process.execPath,
    "-e",
    "console.log('READY'); setTimeout(() => process.exit(0), 1000)",
  ], {
    stdio: ["ignore", "pipe", "ignore", "ipc"],
  });
  await new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => {
      clearTimeout(timer);
      supervisor.removeListener("error", onError);
      supervisor.stdout.removeListener("data", onData);
    };
    const finish = (fn, value) => {
      cleanup();
      fn(value);
    };
    const onError = (error) => finish(reject, error);
    const onData = (chunk) => {
      output += chunk.toString("utf8");
      if (!output.includes("READY")) return;
      finish(resolve);
    };
    const timer = setTimeout(
      () => finish(reject, new Error("Claude supervisor child did not start.")),
      2_000,
    );
    supervisor.once("error", onError);
    supervisor.stdout.on("data", onData);
  });
  supervisor.disconnect();

  const deadline = Date.now() + 2_000;
  while (supervisor.exitCode === null && supervisor.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGKILL");
  }
  assert.equal(supervisor.signalCode, "SIGTERM");
});
