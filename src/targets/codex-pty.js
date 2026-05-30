import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";

const HELPER_URL = new URL("./codex-pty-helper.py", import.meta.url);

function encodeData(data) {
  return Buffer.from(data ?? "").toString("base64");
}

function decodeData(data) {
  return Buffer.from(String(data ?? ""), "base64");
}

export function hasResumeGoalPrompt(text) {
  return /Resume paused goal\?/i.test(String(text ?? "")) && /Resume goal/i.test(String(text ?? ""));
}

export function hasActiveGoalPane(text) {
  return /Goal active|Pursuing goal|Goal achieved/i.test(String(text ?? ""));
}

export function createGoalIntentDetector({ onGoalIntent } = {}) {
  let buffer = "";
  let observed = false;

  const submit = (line) => {
    const candidate = String(line ?? "");
    if (!observed && /^\s*\/goal(?:\s|$)/.test(candidate)) {
      observed = true;
      onGoalIntent?.(candidate);
    }
  };

  return {
    push(chunk) {
      const bytes = Buffer.from(chunk ?? "");
      for (const byte of bytes) {
        if (byte === 0x0d || byte === 0x0a) {
          submit(buffer);
          buffer = "";
          continue;
        }
        if (byte === 0x08 || byte === 0x7f) {
          buffer = buffer.slice(0, -1);
          continue;
        }
        if (byte === 0x1b) {
          continue;
        }
        if (byte < 0x20) {
          continue;
        }
        buffer += Buffer.from([byte]).toString("utf8");
        if (buffer.length > 4096) {
          buffer = buffer.slice(-4096);
        }
      }
    },
    get observed() {
      return observed;
    },
  };
}

export class CodexPtySession extends EventEmitter {
  constructor({
    pythonBin = "python3",
    helperPath = fileURLToPath(HELPER_URL),
    spawnImpl = spawn,
    stdin = process.stdin,
    stdout = process.stdout,
    stderr = process.stderr,
    attach = true,
    onGoalIntent,
  } = {}) {
    super();
    this.pythonBin = pythonBin;
    this.helperPath = helperPath;
    this.spawnImpl = spawnImpl;
    this.stdin = stdin;
    this.stdout = stdout;
    this.stderr = stderr;
    this.attach = attach;
    this.onGoalIntent = onGoalIntent;
    this.helper = null;
    this.output = [];
    this.exitInfo = null;
    this.ready = false;
    this.disposed = false;
    this.lineBuffer = "";
    this.stdinWasRaw = false;
    this.stdinDataHandler = null;
    this.resizeHandler = null;
    this.goalDetector = createGoalIntentDetector({ onGoalIntent });
    this.exitWaiters = [];
    this.readyInfo = null;
    this.readyWaiters = [];
  }

  start({ argv, cwd, env = {}, cols, rows }) {
    if (this.helper) {
      throw new Error("Codex PTY session already started.");
    }
    const effectiveCols = cols || this.stdout?.columns || 120;
    const effectiveRows = rows || this.stdout?.rows || 40;
    this.helper = this.spawnImpl(this.pythonBin, [this.helperPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });
    if (this.helper.error) throw this.helper.error;
    this.helper.on?.("error", (err) => {
      const info = {
        status: "error",
        reason: err?.code === "ENOENT" ? "python3_unavailable" : "helper_spawn_failed",
        error: err,
      };
      this.readyInfo ??= info;
      this.exitInfo ??= { exitCode: null, signal: null, error: err, reason: info.reason };
      this.emit("helper_error", info);
      this.resolveReadyWaiters();
      this.resolveExitWaiters();
    });
    this.helper.stdout.on("data", (chunk) => this.handleStdout(chunk));
    this.helper.stderr.on("data", (chunk) => {
      this.emit("helper_stderr", Buffer.from(chunk).toString("utf8"));
    });
    this.helper.on("exit", (exitCode, signal) => {
      if (!this.exitInfo) {
        this.exitInfo = { exitCode, signal };
      }
      if (!this.readyInfo) {
        this.readyInfo = { status: "error", reason: "helper_exited", exitCode, signal };
        this.resolveReadyWaiters();
      }
      this.resolveExitWaiters();
    });
    this.sendMessage({
      type: "start",
      argv,
      cwd,
      env,
      cols: effectiveCols,
      rows: effectiveRows,
    });
    if (this.attach) {
      this.attachTerminal();
    }
    return this;
  }

  attachTerminal() {
    if (!this.stdin?.isTTY) return;
    this.stdinWasRaw = Boolean(this.stdin.isRaw);
    this.stdin.setRawMode?.(true);
    this.stdin.resume?.();
    this.stdinDataHandler = (chunk) => {
      this.goalDetector.push(chunk);
      this.write(chunk);
    };
    this.stdin.on("data", this.stdinDataHandler);
    this.resizeHandler = () => {
      this.resize({
        cols: this.stdout?.columns || 120,
        rows: this.stdout?.rows || 40,
      });
    };
    this.stdout?.on?.("resize", this.resizeHandler);
  }

  handleStdout(chunk) {
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
      this.handleMessage(message);
    }
  }

  handleMessage(message) {
    if (message.type === "ready") {
      this.ready = true;
      this.readyInfo = { status: "ready", message };
      this.emit("ready", message);
      this.resolveReadyWaiters();
      return;
    }
    if (message.type === "output") {
      const data = decodeData(message.data);
      this.output.push(data);
      if (this.output.length > 200) this.output.shift();
      if (this.attach) this.stdout?.write?.(data);
      this.emit("output", data);
      return;
    }
    if (message.type === "exit") {
      this.exitInfo = { exitCode: message.exitCode, signal: message.signal ?? null };
      this.emit("exit", this.exitInfo);
      this.resolveExitWaiters();
      return;
    }
    if (message.type === "error") {
      if (!this.readyInfo) {
        this.readyInfo = { status: "error", reason: message.reason ?? "helper_error", message };
        this.resolveReadyWaiters();
      }
      this.emit("helper_error", message);
    }
  }

  sendMessage(message) {
    if (!this.helper?.stdin?.writable) return;
    this.helper.stdin.write(`${JSON.stringify(message)}\n`);
  }

  write(data) {
    this.sendMessage({ type: "input", data: encodeData(data) });
  }

  sendEnter() {
    this.write("\r");
  }

  sendExit() {
    this.write("/exit\r");
  }

  resize({ cols, rows }) {
    this.sendMessage({ type: "resize", cols, rows });
  }

  snapshotOutput() {
    return Buffer.concat(this.output).toString("utf8");
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

  terminate() {
    this.sendMessage({ type: "terminate" });
  }

  dispose() {
    if (this.disposed) return;
    this.disposed = true;
    if (this.stdinDataHandler) {
      this.stdin.off?.("data", this.stdinDataHandler);
    }
    if (this.resizeHandler) {
      this.stdout?.off?.("resize", this.resizeHandler);
    }
    if (this.stdin?.isTTY) {
      this.stdin.setRawMode?.(this.stdinWasRaw);
    }
    try {
      this.helper?.stdin?.end?.();
    } catch {}
    if (this.helper && this.helper.exitCode === null && this.helper.signalCode === null) {
      this.helper.kill?.("SIGTERM");
    }
  }
}

export function createCodexPtySession(options = {}) {
  return new CodexPtySession(options);
}
