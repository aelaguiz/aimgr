#!/usr/bin/env node
import { spawn } from "node:child_process";
import { once } from "node:events";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const helperPath = fileURLToPath(new URL("../src/targets/codex-foreground-relay.py", import.meta.url));
const pythonBin = process.env.AIMGR_PYTHON_BIN || "python3";
const burstCount = Number(process.env.AIMGR_FOREGROUND_RELAY_SMOKE_CHARS || 48);
const frameBytes = Number(process.env.AIMGR_FOREGROUND_RELAY_SMOKE_FRAME_BYTES || 240);
const frameIntervalMs = Number(process.env.AIMGR_FOREGROUND_RELAY_SMOKE_FRAME_INTERVAL_MS || 3);
const keyIntervalMs = 60_000 / (130 * 5);
const readyTimeoutMs = 3_000;
const echoTimeoutMs = 10_000;
const minVisibleOutputBytes = 50_000;

const childCode = `
import os
import termios
import threading
import time
import tty

attrs = termios.tcgetattr(0)
tty.setraw(0, termios.TCSANOW)
lock = threading.Lock()
running = True

def write(data):
    with lock:
        os.write(1, data)

def spam():
    i = 0
    while running:
        write(("FRAME %05d " % i + "." * max(0, ${frameBytes} - 12) + "\\r\\n").encode("utf-8"))
        i += 1
        time.sleep(${frameIntervalMs} / 1000)

threading.Thread(target=spam, daemon=True).start()
seq = 0
try:
    while True:
        data = os.read(0, 1)
        if not data:
            break
        if data == b"\\x04":
            break
        write(b"__AIM_ECHO__:%03d:" % seq + data + b":__END__\\n")
        seq += 1
finally:
    running = False
    termios.tcsetattr(0, termios.TCSADRAIN, attrs)
`;

function sendControl(control, message) {
  control.write(`${JSON.stringify(message)}\n`);
}

function waitForReady(events) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("foreground relay did not become ready"));
    }, readyTimeoutMs);
    const onData = (chunk) => {
      buffer += Buffer.from(chunk).toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;
        const message = JSON.parse(line);
        if (message.type === "output") {
          cleanup();
          reject(new Error("foreground relay side channel carried terminal output bytes"));
          return;
        }
        if (message.type === "error") {
          cleanup();
          reject(new Error(`foreground relay error: ${message.reason || "error"} ${message.message || ""}`.trim()));
          return;
        }
        if (message.type === "ready") {
          cleanup();
          resolve(message);
          return;
        }
      }
    };
    const cleanup = () => {
      clearTimeout(timeout);
      events.off("data", onData);
    };
    events.on("data", onData);
  });
}

async function main() {
  const helper = spawn(pythonBin, [helperPath], {
    stdio: ["pipe", "pipe", "inherit", "pipe", "pipe"],
  });
  const control = helper.stdio[3];
  const events = helper.stdio[4];
  const sentAt = new Map();
  const latencies = [];
  const payload = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ".slice(0, burstCount);
  let stdoutBuffer = "";
  let visibleOutputBytes = 0;

  helper.stdout.on("data", (chunk) => {
    const data = Buffer.from(chunk);
    visibleOutputBytes += data.length;
    stdoutBuffer += data.toString("utf8");
    let match;
    let consumed = 0;
    const pattern = /__AIM_ECHO__:(\d+):(.):__END__/g;
    while ((match = pattern.exec(stdoutBuffer))) {
      const seq = Number(match[1]);
      const started = sentAt.get(seq);
      if (started !== undefined && latencies[seq] === undefined) {
        latencies[seq] = performance.now() - started;
      }
      consumed = pattern.lastIndex;
    }
    stdoutBuffer = stdoutBuffer.slice(consumed).slice(-4096);
  });

  const exitPromise = once(helper, "exit");
  sendControl(control, {
    type: "start",
    argv: [pythonBin, "-u", "-c", childCode],
    cwd: process.cwd(),
    env: {},
    cols: 120,
    rows: 40,
    requireTty: false,
  });
  await waitForReady(events);
  await new Promise((resolve) => setTimeout(resolve, 200));

  for (let seq = 0; seq < payload.length; seq += 1) {
    sentAt.set(seq, performance.now());
    helper.stdin.write(payload[seq]);
    await new Promise((resolve) => setTimeout(resolve, keyIntervalMs));
  }

  const echoDeadline = performance.now() + echoTimeoutMs;
  while (latencies.filter((value) => Number.isFinite(value)).length < payload.length) {
    if (performance.now() > echoDeadline) {
      throw new Error(`timed out waiting for echoes: got ${latencies.length}/${payload.length}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  sendControl(control, { type: "terminate" });
  const [exitCode, signal] = await exitPromise;
  if (exitCode !== 0 && signal !== "SIGTERM") {
    throw new Error(`foreground relay exited unexpectedly: code=${exitCode} signal=${signal}`);
  }

  const sorted = latencies.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
  const max = sorted[sorted.length - 1];
  const result = {
    ok: p95 < 50 && max < 150 && visibleOutputBytes >= minVisibleOutputBytes,
    count: sorted.length,
    wpmEquivalent: 130,
    outputFrameBytes: frameBytes,
    outputFrameIntervalMs: frameIntervalMs,
    visibleOutputBytes,
    minVisibleOutputBytes,
    p95Ms: Number(p95.toFixed(2)),
    maxMs: Number(max.toFixed(2)),
  };
  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exitCode = 1;
});
