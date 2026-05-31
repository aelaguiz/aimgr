import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const HELPER_URL = new URL("./codex-foreground-relay.py", import.meta.url);

function encodeData(data) {
  return Buffer.from(data ?? "").toString("base64");
}

function defaultHelperStdio() {
  return ["inherit", "inherit", "inherit", "pipe", "pipe"];
}

export class CodexForegroundRelaySession extends EventEmitter {
  constructor({
    pythonBin = "python3",
    helperPath = fileURLToPath(HELPER_URL),
    spawnImpl = spawn,
    stdio = defaultHelperStdio(),
    requireTty = true,
    snapshotTimeoutMs = 1_000,
    onGoalIntent,
  } = {}) {
    super();
    this.pythonBin = pythonBin;
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
    this.stdio = stdio;
    this.requireTty = requireTty;
    this.snapshotTimeoutMs = snapshotTimeoutMs;
    this.onGoalIntent = onGoalIntent;
    this.helper = null;
    this.control = null;
    this.events = null;
    this.lineBuffer = "";
    this.ready = false;
    this.readyInfo = null;
    this.exitInfo = null;
    this.disposed = false;
    this.nextSnapshotId = 1;
    this.snapshotWaiters = new Map();
    this.readyWaiters = [];
    this.exitWaiters = [];
  }

  start({ argv, cwd, env = {}, cols, rows }) {
    if (this.helper) {
      throw new Error("Codex foreground relay session already started.");
    }
    const effectiveCols = cols || process.stdout?.columns || 120;
    const effectiveRows = rows || process.stdout?.rows || 40;
    this.helper = this.spawnImpl(this.pythonBin, [this.helperPath], {
      stdio: this.stdio,
    });
    if (this.helper.error) throw this.helper.error;
    this.control = this.helper.stdio?.[3];
    this.events = this.helper.stdio?.[4];
    if (!this.control?.write || !this.events?.on) {
      throw new Error("Foreground relay helper did not expose control/event side-channel pipes.");
    }
    this.helper.on?.("error", (err) => {
      const info = {
        status: "error",
        reason: err?.code === "ENOENT" ? "python3_unavailable" : "foreground_relay_spawn_failed",
        error: err,
      };
      this.readyInfo ??= info;
      this.exitInfo ??= { exitCode: null, signal: null, error: err, reason: info.reason };
      this.emit("helper_error", info);
      this.resolveReadyWaiters();
      this.resolveExitWaiters();
      this.resolveSnapshotWaiters("");
    });
    this.events.on("data", (chunk) => this.handleEventChunk(chunk));
    this.helper.on?.("exit", (exitCode, signal) => {
      if (!this.exitInfo) {
        this.exitInfo = { exitCode, signal };
      }
      if (!this.readyInfo) {
        this.readyInfo = { status: "error", reason: "foreground_relay_exited", exitCode, signal };
        this.resolveReadyWaiters();
      }
      this.resolveExitWaiters();
      this.resolveSnapshotWaiters("");
    });
    this.sendCommand({
      type: "start",
      argv,
      cwd,
      env,
      cols: effectiveCols,
      rows: effectiveRows,
      requireTty: this.requireTty,
    });
    return this;
  }

  handleEventChunk(chunk) {
    this.lineBuffer += Buffer.from(chunk).toString("utf8");
    while (this.lineBuffer.includes("\n")) {
      const index = this.lineBuffer.indexOf("\n");
      const line = this.lineBuffer.slice(0, index).trim();
      this.lineBuffer = this.lineBuffer.slice(index + 1);
      if (!line) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.emit("protocol_error", line);
        continue;
      }
      this.handleEvent(message);
    }
  }

  handleEvent(message) {
    if (message.type === "ready") {
      this.ready = true;
      this.readyInfo = { status: "ready", message };
      this.emit("ready", message);
      this.resolveReadyWaiters();
      return;
    }
    if (message.type === "exit") {
      this.exitInfo = { exitCode: message.exitCode, signal: message.signal ?? null };
      this.emit("exit", this.exitInfo);
      this.resolveExitWaiters();
      this.resolveSnapshotWaiters("");
      return;
    }
    if (message.type === "error") {
      if (!this.readyInfo) {
        this.readyInfo = { status: "error", reason: message.reason ?? "foreground_relay_error", message };
        this.resolveReadyWaiters();
      }
      this.emit("helper_error", message);
      return;
    }
    if (message.type === "goal_intent") {
      this.onGoalIntent?.(message.line ?? "");
      this.emit("goal_intent", message);
      return;
    }
    if (message.type === "snapshot") {
      const requestId = message.requestId;
      const waiter = this.snapshotWaiters.get(requestId);
      if (!waiter) return;
      clearTimeout(waiter.timeout);
      this.snapshotWaiters.delete(requestId);
      waiter.resolve(String(message.text ?? ""));
      return;
    }
    this.emit("protocol_event", message);
  }

  sendCommand(message) {
    if (!this.control?.writable) return false;
    this.control.write(`${JSON.stringify(message)}\n`);
    return true;
  }

  sendInput(data) {
    this.sendCommand({ type: "send_input", data: encodeData(data) });
  }

  sendEnter() {
    this.sendCommand({ type: "send_enter" });
  }

  sendExit() {
    this.sendCommand({ type: "send_exit" });
  }

  resize({ cols, rows }) {
    this.sendCommand({ type: "resize", cols, rows });
  }

  snapshotOutput({ timeoutMs = this.snapshotTimeoutMs } = {}) {
    if (!this.control?.writable) return Promise.resolve("");
    const requestId = this.nextSnapshotId;
    this.nextSnapshotId += 1;
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        timeout: setTimeout(() => {
          this.snapshotWaiters.delete(requestId);
          resolve("");
        }, timeoutMs),
      };
      this.snapshotWaiters.set(requestId, waiter);
      if (!this.sendCommand({ type: "snapshot", requestId })) {
        clearTimeout(waiter.timeout);
        this.snapshotWaiters.delete(requestId);
        resolve("");
      }
    });
  }

  waitForReady({ timeoutMs } = {}) {
    if (this.readyInfo) return Promise.resolve(this.readyInfo);
    return new Promise((resolve) => {
      const waiter = { resolve };
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        waiter.timeout = setTimeout(() => {
          this.readyWaiters = this.readyWaiters.filter((item) => item !== waiter);
          resolve(null);
        }, timeoutMs);
      }
      this.readyWaiters.push(waiter);
    });
  }

  waitForExit({ timeoutMs } = {}) {
    if (this.exitInfo) return Promise.resolve(this.exitInfo);
    return new Promise((resolve) => {
      const waiter = { resolve };
      if (Number.isFinite(timeoutMs) && timeoutMs >= 0) {
        waiter.timeout = setTimeout(() => {
          this.exitWaiters = this.exitWaiters.filter((item) => item !== waiter);
          resolve(null);
        }, timeoutMs);
      }
      this.exitWaiters.push(waiter);
    });
  }

  resolveReadyWaiters() {
    for (const waiter of this.readyWaiters.splice(0)) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.readyInfo);
    }
  }

  resolveExitWaiters() {
    for (const waiter of this.exitWaiters.splice(0)) {
      if (waiter.timeout) clearTimeout(waiter.timeout);
      waiter.resolve(this.exitInfo);
    }
  }

  resolveSnapshotWaiters(value) {
    for (const [, waiter] of this.snapshotWaiters) {
      clearTimeout(waiter.timeout);
      waiter.resolve(value);
    }
    this.snapshotWaiters.clear();
  }

  terminate() {
    this.sendCommand({ type: "terminate" });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    this.resolveSnapshotWaiters("");
    try {
      this.control?.end?.();
    } catch {}
    if (this.helper && this.helper.exitCode === null && this.helper.signalCode === null) {
      this.helper.kill?.("SIGTERM");
    }
  }
}

export function createCodexForegroundRelaySession(options = {}) {
  return new CodexForegroundRelaySession(options);
}
