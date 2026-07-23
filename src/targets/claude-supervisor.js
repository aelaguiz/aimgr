import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const DEFAULT_CHILD_KILL_GRACE_MS = 4_000;

function normalizedResult(code, signal, requestedSignal = null) {
  const childSignal = typeof signal === "string" ? signal : null;
  if (childSignal) {
    return { status: 1, signal: childSignal };
  }
  if (requestedSignal) {
    return { status: 1, signal: requestedSignal };
  }
  return {
    status: Number.isInteger(code) ? code : 1,
    signal: null,
  };
}

/**
 * Own the real Claude process behind an IPC connection to AIM.
 *
 * The IPC channel is a parent-liveness signal: when AIM disappears, Node
 * emits `disconnect` in this process and Claude is terminated before the
 * supervisor exits. The trusted Claude executable is still spawned directly;
 * this layer never invokes a shell or resolves a second executable name.
 */
export async function superviseClaudeProcess({
  command,
  args = [],
  env = process.env,
  parentProcess = process,
  spawnImpl = spawn,
  childKillGraceMs = DEFAULT_CHILD_KILL_GRACE_MS,
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  const rawCommand = typeof command === "string" ? command.trim() : "";
  if (!rawCommand || !path.isAbsolute(rawCommand)) {
    throw new Error("Claude supervisor requires an absolute executable.");
  }
  if (!parentProcess || typeof parentProcess.once !== "function") {
    throw new Error("Claude supervisor requires an IPC-capable parent process.");
  }

  const resolvedCommand = path.resolve(rawCommand);
  const resolvedArgs = Array.isArray(args) ? args : [];
  const boundedKillGraceMs = Math.min(
    5_000,
    Math.max(0, Number.isFinite(childKillGraceMs) ? childKillGraceMs : DEFAULT_CHILD_KILL_GRACE_MS),
  );
  let child = null;
  let settled = false;
  let forcedKillTimer = null;
  let requestedSignal = null;

  const clearForcedKillTimer = () => {
    if (!forcedKillTimer) return;
    clearTimeoutImpl(forcedKillTimer);
    forcedKillTimer = null;
  };
  const removeParentListeners = () => {
    parentProcess.removeListener?.("disconnect", onDisconnect);
    for (const signal of TERMINATION_SIGNALS) {
      parentProcess.removeListener?.(signal, signalHandlers.get(signal));
    }
  };
  const killChild = (signal) => {
    if (!child || settled) return;
    try {
      child.kill(signal);
    } catch {
      // The child error/close event remains the authoritative result.
    }
  };
  const requestTermination = (signal = "SIGTERM") => {
    requestedSignal ??= signal;
    if (!child || settled) return;
    killChild(requestedSignal);
    if (!forcedKillTimer) {
      forcedKillTimer = setTimeoutImpl(() => {
        if (!settled) killChild("SIGKILL");
      }, boundedKillGraceMs);
    }
  };
  const onDisconnect = () => requestTermination("SIGTERM");
  const signalHandlers = new Map(
    TERMINATION_SIGNALS.map((signal) => [signal, () => requestTermination(signal)]),
  );

  parentProcess.once("disconnect", onDisconnect);
  for (const [signal, handler] of signalHandlers) {
    parentProcess.once(signal, handler);
  }

  // Never launch Claude if AIM's IPC channel was already lost during startup.
  if (parentProcess.connected !== true) {
    requestedSignal = "SIGTERM";
    removeParentListeners();
    return normalizedResult(null, null, requestedSignal);
  }

  try {
    child = spawnImpl(resolvedCommand, resolvedArgs, {
      stdio: "inherit",
      env,
    });
  } catch (error) {
    removeParentListeners();
    throw error;
  }
  if (child?.error) {
    removeParentListeners();
    throw child.error;
  }
  if (!child || typeof child.once !== "function") {
    removeParentListeners();
    throw new Error("Claude supervisor did not receive a process handle.");
  }

  return await new Promise((resolve, reject) => {
    const cleanup = () => {
      removeParentListeners();
      clearForcedKillTimer();
      child.removeListener?.("error", onError);
      child.removeListener?.("close", onClose);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onError = (error) => {
      // Once shutdown has started, a failed TERM attempt must not cancel the
      // pending KILL escalation and let Claude outlive this supervisor.
      if (requestedSignal) return;
      finish(reject, error);
    };
    const onClose = (code, signal) => {
      finish(resolve, normalizedResult(code, signal, requestedSignal));
    };

    child.once("error", onError);
    child.once("close", onClose);
    if (requestedSignal) requestTermination(requestedSignal);
  });
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  let result;
  try {
    result = await superviseClaudeProcess({ command, args });
  } catch {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  }

  if (process.connected) process.disconnect();
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      process.exitCode = 1;
    }
    return;
  }
  process.exitCode = result.status;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(MODULE_PATH)) {
  await main();
}
