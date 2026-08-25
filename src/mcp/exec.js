// Child-process boundary for the MCP `aim_exec` tool. Every MCP command runs as a
// fresh `node bin/aimgr.js …` child so the server never shares CLI state, and so a
// hung command dies on a bounded timeout instead of holding an MCP request open.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const AIM_MCP_DEFAULT_TIMEOUT_MS = 120_000;
export const AIM_MCP_OUTPUT_CAP_CHARS = 200_000;
export const AIM_MCP_KILL_GRACE_MS = 5_000;

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
} = {}) {
  const args = argv.map(String);
  const startedAt = nowImpl();

  return new Promise((resolve) => {
    const child = spawnImpl(process.execPath, [binPath, ...args], {
      cwd: path.dirname(path.dirname(binPath)),
      env: buildAimChildEnv(env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    const stdoutSink = { text: "", truncated: false };
    const stderrSink = { text: "", truncated: false };
    const budget = createOutputBudget(AIM_MCP_OUTPUT_CAP_CHARS);
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => budget.append(stdoutSink, chunk));
    child.stderr?.on("data", (chunk) => budget.append(stderrSink, chunk));

    let killTimer;
    const timeoutTimer = setTimeout(() => {
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), killGraceMs);
      killTimer.unref?.();
    }, timeoutMs);
    timeoutTimer.unref?.();

    let settled = false;
    const settle = (exitCode, signal, spawnError) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        ok: spawnError === undefined && exitCode === 0,
        exitCode,
        signal: signal ?? null,
        durationMs: nowImpl() - startedAt,
        stdout: finishSink(stdoutSink, AIM_MCP_OUTPUT_CAP_CHARS),
        stderr: spawnError === undefined
          ? finishSink(stderrSink, AIM_MCP_OUTPUT_CAP_CHARS)
          : `${finishSink(stderrSink, AIM_MCP_OUTPUT_CAP_CHARS)}${spawnError}`,
        truncated: stdoutSink.truncated || stderrSink.truncated,
      });
    };

    child.on("error", (error) => {
      settle(null, null, `aim mcp: failed to spawn aim: ${String(error?.message ?? error)}`);
    });
    child.on("close", (code, signal) => {
      settle(code === null ? null : code, signal);
    });
  });
}
