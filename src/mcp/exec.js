// Child-process boundary for the MCP `aim_exec` tool. Every MCP command runs as a
// fresh `node bin/aimgr.js …` child so the server never shares CLI state, and so a
// hung command dies on a bounded timeout instead of holding an MCP request open.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AIM_MCP_DEFAULT_TIMEOUT_MS = 120_000;
export const AIM_MCP_OUTPUT_CAP_CHARS = 400_000;
export const AIM_MCP_KILL_GRACE_MS = 5_000;
export const AIM_MCP_DRAIN_MS = 250;

export function resolveAimBinPath() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../bin/aimgr.js");
}

// Color escapes are noise in an MCP transcript and cost tokens. NO_COLOR wins only
// when FORCE_COLOR is absent, so the child environment drops FORCE_COLOR outright.
export function buildAimChildEnv(env = process.env) {
  const childEnv = { ...env, NO_COLOR: "1" };
  delete childEnv.FORCE_COLOR;
  return childEnv;
}

function createOutputBudget(capChars) {
  let remaining = capChars;
  return {
    append(sink, chunk) {
      const text = String(chunk);
      if (remaining <= 0) {
        sink.truncated = true;
        return;
      }
      if (text.length <= remaining) {
        sink.text += text;
        remaining -= text.length;
        return;
      }
      sink.text += text.slice(0, remaining);
      remaining = 0;
      sink.truncated = true;
    },
  };
}

function finishSink(sink, capChars) {
  if (!sink.truncated) return sink.text;
  return `${sink.text}\n[aim mcp: output truncated at ${capChars} characters]`;
}

export function runAimCommand(argv, {
  timeoutMs = AIM_MCP_DEFAULT_TIMEOUT_MS,
  binPath = resolveAimBinPath(),
  env = process.env,
  spawnImpl = spawn,
  nowImpl = Date.now,
  killGraceMs = AIM_MCP_KILL_GRACE_MS,
  drainMs = AIM_MCP_DRAIN_MS,
} = {}) {
  const args = argv.map(String);
  const startedAt = nowImpl();

  return new Promise((resolve) => {
    // detached makes the child its own process-group leader, so a timeout can kill
    // the whole tree. `aim` commands spawn real tools (git, tailscale, claude), and
    // signalling only the direct child would leave those running.
    const child = spawnImpl(process.execPath, [binPath, ...args], {
      cwd: path.dirname(path.dirname(binPath)),
      env: buildAimChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    });

    const stdoutSink = { text: "", truncated: false };
    const stderrSink = { text: "", truncated: false };
    const budget = createOutputBudget(AIM_MCP_OUTPUT_CAP_CHARS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => budget.append(stdoutSink, chunk));
    child.stderr?.on("data", (chunk) => budget.append(stderrSink, chunk));
    // Track pipe EOF from the start: a stream can end before `exit` arrives, and a
    // listener attached later would miss it and pay the full drain window.
    let openStreams = (child.stdout ? 1 : 0) + (child.stderr ? 1 : 0);
    let onStreamEnd = () => {
      openStreams -= 1;
    };
    child.stdout?.once("end", () => onStreamEnd());
    child.stderr?.once("end", () => onStreamEnd());

    // Signal the group, not the process. Falls back to the direct child when the
    // group is already gone (ESRCH) or the platform has no process groups.
    const killTree = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        try {
          child.kill(signal);
        } catch {
          // The child already exited; nothing to signal.
        }
      }
    };

    let timedOut = false;
    let killTimer;
    const timeoutTimer = setTimeout(() => {
      timedOut = true;
      killTree("SIGTERM");
      killTimer = setTimeout(() => killTree("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    let settled = false;
    const settle = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      const killedAfter = timeoutMs >= 1_000 ? `${Math.round(timeoutMs / 1_000)}s` : `${timeoutMs}ms`;
      const timeoutNote = timedOut ? `\n[aim mcp: killed after ${killedAfter}]` : "";
      resolve({
        ok: spawnError === undefined && exitCode === 0,
        exitCode,
        signal: signal ?? null,
        timedOut,
        durationMs: nowImpl() - startedAt,
        stdout: finishSink(stdoutSink, AIM_MCP_OUTPUT_CAP_CHARS),
        stderr: spawnError === undefined
          ? `${finishSink(stderrSink, AIM_MCP_OUTPUT_CAP_CHARS)}${timeoutNote}`
          : `${finishSink(stderrSink, AIM_MCP_OUTPUT_CAP_CHARS)}${spawnError}`,
        truncated: stdoutSink.truncated || stderrSink.truncated,
      });
    };

    child.on("error", (error) => {
      settle(null, null, `aim mcp: failed to spawn aim: ${String(error?.message ?? error)}`);
    });
    // Settle on `exit`, not `close`: an orphaned grandchild can hold the inherited
    // pipe write ends open forever, and `close` would never fire. Give the pipes a
    // bounded drain window so normal output is not cut off.
    child.on("exit", (code, signal) => {
      const exitCode = code === null ? null : code;
      if (openStreams <= 0) {
        settle(exitCode, signal);
        return;
      }
      onStreamEnd = () => {
        openStreams -= 1;
        if (openStreams <= 0) settle(exitCode, signal);
      };
      const drainTimer = setTimeout(() => settle(exitCode, signal), drainMs);
      drainTimer.unref?.();
    });
  });
}
