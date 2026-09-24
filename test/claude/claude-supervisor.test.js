import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CLAUDE_PROCESS_CONTROL_ACK_TYPE,
  CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE,
  superviseClaudeProcess,
} from "../../src/targets/claude-supervisor.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("../../src/targets/claude-supervisor.js", import.meta.url));

class FakeParentProcess extends EventEmitter {
  constructor({ connected = true } = {}) {
    super();
    this.connected = connected;
    this.sent = [];
  }

  send(message) {
    this.sent.push(message);
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

test("Claude supervisor acknowledges pause and resumes a stopped child before termination", async () => {
  const parentProcess = new FakeParentProcess();
  const child = new FakeChildProcess();
  const resultPromise = superviseClaudeProcess({
    command: process.execPath,
    parentProcess,
    spawnImpl: () => child,
  });

  parentProcess.emit("message", {
    type: CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE,
    requestId: 1,
    action: "pause",
  });
  assert.deepEqual(child.killedWith, ["SIGSTOP"]);
  assert.deepEqual(parentProcess.sent, [{
    type: CLAUDE_PROCESS_CONTROL_ACK_TYPE,
    requestId: 1,
    action: "pause",
    ok: true,
  }]);

  parentProcess.emit("SIGTERM");
  assert.deepEqual(child.killedWith, ["SIGSTOP", "SIGCONT", "SIGTERM"]);
  child.emit("close", null, "SIGTERM");
  assert.deepEqual(await resultPromise, { status: 1, signal: "SIGTERM" });
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

test("real supervisor IPC stops and resumes its Claude child", async () => {
  if (process.platform === "win32") return;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-claude-pause-"));
  const scriptPath = path.join(dir, "counter.cjs");
  const countPath = path.join(dir, "count.txt");
  fs.writeFileSync(scriptPath, `
    const fs = require("node:fs");
    let count = 0;
    setInterval(() => fs.writeFileSync(process.argv[2], String(++count)), 20);
  `);
  const supervisor = spawn(process.execPath, [
    SUPERVISOR_PATH,
    process.execPath,
    scriptPath,
    countPath,
  ], { stdio: ["ignore", "ignore", "ignore", "ipc"] });
  const count = () => {
    try { return Number(fs.readFileSync(countPath, "utf8")); } catch { return 0; }
  };
  const waitFor = async (predicate) => {
    const deadline = Date.now() + 2_000;
    while (!predicate()) {
      if (Date.now() >= deadline) throw new Error("Claude process control did not settle.");
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  };
  const sendControl = (requestId, action) => new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error("Claude control acknowledgement timed out.")), 2_000);
    const finish = (error, ok) => {
      clearTimeout(timer);
      supervisor.removeListener("message", onMessage);
      if (error) reject(error);
      else resolve(ok);
    };
    const onMessage = (message) => {
      if (message?.type === CLAUDE_PROCESS_CONTROL_ACK_TYPE && message.requestId === requestId) {
        finish(null, message.ok);
      }
    };
    supervisor.on("message", onMessage);
    supervisor.send({ type: CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE, requestId, action });
  });
  try {
    await waitFor(() => count() >= 3);
    assert.equal(await sendControl(1, "pause"), true);
    const before = count();
    await new Promise((resolve) => setTimeout(resolve, 120));
    const stoppedAt = count();
    assert.ok(stoppedAt <= before + 1);
    assert.equal(await sendControl(2, "resume"), true);
    await waitFor(() => count() >= stoppedAt + 2);
  } finally {
    supervisor.kill("SIGTERM");
    await new Promise((resolve) => {
      if (supervisor.exitCode !== null || supervisor.signalCode !== null) resolve();
      else supervisor.once("close", resolve);
    });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
