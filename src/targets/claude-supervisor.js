import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MODULE_PATH = fileURLToPath(import.meta.url);
const TERMINATION_SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const DEFAULT_CHILD_KILL_GRACE_MS = 4_000;
export const CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE = "aimgr:claude-process-control-v1";
export const CLAUDE_PROCESS_CONTROL_ACK_TYPE = "aimgr:claude-process-control-ack-v1";

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
  environmentFd = null,
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
  if (environmentFd !== null) {
    if (!Number.isInteger(environmentFd) || environmentFd < 3) throw new Error("Claude supervisor requires a private environment transfer.");
    const stat = fs.fstatSync(environmentFd);
    if (!stat.isFile() || stat.uid !== process.getuid() || stat.nlink !== 0 || (stat.mode & 0o077)
      || stat.size < 1 || stat.size > 16 * 1024 * 1024) throw new Error("Claude supervisor requires a private environment transfer.");
  }
  const boundedKillGraceMs = Math.min(
    5_000,
    Math.max(0, Number.isFinite(childKillGraceMs) ? childKillGraceMs : DEFAULT_CHILD_KILL_GRACE_MS),
  );
  let child = null;
  let settled = false;
  let forcedKillTimer = null;
  let requestedSignal = null;
  let childPaused = false;

  const clearForcedKillTimer = () => {
    if (!forcedKillTimer) return;
    clearTimeoutImpl(forcedKillTimer);
    forcedKillTimer = null;
  };
  const removeParentListeners = () => {
    parentProcess.removeListener?.("disconnect", onDisconnect);
    parentProcess.removeListener?.("message", onMessage);
    for (const signal of TERMINATION_SIGNALS) {
      parentProcess.removeListener?.(signal, signalHandlers.get(signal));
    }
  };
  const killChild = (signal) => {
    if (!child || settled) return false;
    try {
      return child.kill(signal) !== false;
    } catch {
      // The child error/close event remains the authoritative result.
      return false;
    }
  };
  const requestTermination = (signal = "SIGTERM") => {
    requestedSignal ??= signal;
    if (!child || settled) return;
    if (childPaused) {
      killChild("SIGCONT");
      childPaused = false;
    }
    killChild(requestedSignal);
    if (!forcedKillTimer) {
      forcedKillTimer = setTimeoutImpl(() => {
        if (!settled) killChild("SIGKILL");
      }, boundedKillGraceMs);
    }
  };
  const onMessage = (message) => {
    if (
      message?.type !== CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE
      || !["pause", "resume"].includes(message.action)
      || !Number.isSafeInteger(message.requestId)
      || message.requestId < 1
    ) return;
    let ok = false;
    if (child && !settled && !requestedSignal) {
      if (message.action === "pause") {
        ok = childPaused || killChild("SIGSTOP");
        if (ok) childPaused = true;
      } else {
        ok = !childPaused || killChild("SIGCONT");
        if (ok) childPaused = false;
      }
    }
    try {
      parentProcess.send?.({
        type: CLAUDE_PROCESS_CONTROL_ACK_TYPE,
        requestId: message.requestId,
        action: message.action,
        ok,
      });
    } catch {
      // AIM times out an unacknowledged control request and terminates Claude.
    }
  };
  const onDisconnect = () => requestTermination("SIGTERM");
  const signalHandlers = new Map(
    TERMINATION_SIGNALS.map((signal) => [signal, () => requestTermination(signal)]),
  );

  parentProcess.once("disconnect", onDisconnect);
  parentProcess.on("message", onMessage);
  for (const [signal, handler] of signalHandlers) {
    parentProcess.once(signal, handler);
  }

  // Never launch Claude if AIM's IPC channel was already lost during startup.
  if (parentProcess.connected !== true) {
    requestedSignal = "SIGTERM";
    removeParentListeners();
    if (environmentFd !== null) fs.closeSync(environmentFd);
    return normalizedResult(null, null, requestedSignal);
  }

  try {
    child = spawnImpl(resolvedCommand, resolvedArgs, {
      // 'inherit' is exactly fd0..2. Never forward AIM's coordination fd4 or
      // its IPC descriptor to the vendor: the supervisor retains the lock
      // until Claude exits, including when AIM loses its own FD on a crash.
      // Only the fixed native privacy entry receives one additional handle,
      // mapped to fd3. It restores this environment AFTER policy installation
      // and closes every non-stdio handle before vendor exec. The supervisor's
      // own IPC/assignment descriptors still never reach vendor code.
      stdio: environmentFd === null ? "inherit" : ["inherit", "inherit", "inherit", environmentFd],
      env: environmentFd === null ? env : { PATH: "/usr/bin:/bin:/usr/sbin:/sbin", LANG: "C.UTF-8", NODE_V8_COVERAGE: undefined },
    });
  } catch (error) {
    removeParentListeners();
    throw error;
  } finally {
    if (environmentFd !== null) fs.closeSync(environmentFd);
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
  const inputs = process.argv.slice(2);
  const privacyEntry = inputs[0] === "--privacy-entry-v1";
  if (privacyEntry) inputs.shift();
  const [command, ...args] = inputs;
  const routedMac = privacyEntry && process.platform === "darwin" && args[0] === "route-v1"
    && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(args[1] ?? "");
  let terminal;
  let result;
  try {
    if (privacyEntry && !/^\/opt\/aimgr-claude-runtime\/artifacts\/[a-f0-9]{64}\/launcher$/.test(command ?? "")) {
      throw new Error("Claude supervisor requires the admitted native entry.");
    }
    if (routedMac && process.stdin.isTTY) {
      // The Mac route now execs all the way into Claude to preserve pause and
      // forced-kill semantics. Save terminal state in this surviving owner,
      // before any native child can enter raw mode. A fixed Python termios
      // call also lets restore skip a background job without SIGTTOU.
      terminal = execFileSync("/usr/bin/python3", ["-I", "-c",
        "import json,termios;print(json.dumps(termios.tcgetattr(0),default=lambda b:list(b)))"],
      { stdio: [0, "pipe", "ignore"], timeout: 2000, maxBuffer: 8192, encoding: "utf8" }).trim();
    }
    result = await superviseClaudeProcess({ command, args, environmentFd: privacyEntry ? 5 : null });
    if (routedMac && (result.status !== 0 || result.signal)
      && fs.existsSync(`/opt/aimgr-claude-proxy/${args[1]}-state/failed`)) {
      // The guardian kills all routed native owners after marking failure.
      // Retain the old visible failure/receipt semantics even though the
      // supervisor now observes the vendor's signal directly.
      process.stderr.write(`Claude proxy ${args[1]} failed; affected work was stopped. Repair the proxy/tunnel, then explicitly retry or resume.\n`);
      result = { status: 125, signal: null };
    }
  } catch {
    process.exitCode = 1;
    if (process.connected) process.disconnect();
    return;
  } finally {
    if (terminal) {
      try {
        execFileSync("/usr/bin/python3", ["-I", "-c",
          "import json,os,sys,termios;a=json.loads(sys.argv[1]);a[6]=[bytes(v) if isinstance(v,list) else v for v in a[6]];termios.tcsetattr(0,termios.TCSANOW,a) if os.tcgetpgrp(0)==os.getpgrp() else None", terminal],
        { stdio: [0, "ignore", "ignore"], timeout: 2000 });
      } catch {
        // A disconnected controlling terminal cannot be restored. Do not
        // replace the native result or wait on a background process group.
      }
    }
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
