import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("./claude-supervisor.js", import.meta.url));

export async function runClaudeCli({
  command,
  homeDir,
  configDir = null,
  args = [],
  env = process.env,
  signal = null,
  spawnImpl = spawn,
} = {}) {
  const rawCommand = typeof command === "string" ? command.trim() : "";
  const rawHome = typeof homeDir === "string" ? homeDir.trim() : "";
  const rawConfigDir = typeof configDir === "string" ? configDir.trim() : "";
  if (
    !rawCommand
    || !path.isAbsolute(rawCommand)
    || !rawHome
    || !path.isAbsolute(rawHome)
    || (rawConfigDir && !path.isAbsolute(rawConfigDir))
  ) {
    throw new Error("Claude launch requires an absolute executable, home, and config directory.");
  }
  const resolvedHome = path.resolve(rawHome);
  const launchEnv = {
    ...env,
    HOME: resolvedHome,
  };
  if (rawConfigDir) {
    const resolvedConfigDir = path.resolve(rawConfigDir);
    // Claude's file store and macOS secure-storage namespace must be pinned to
    // the same exact per-label directory. HOME alone is not a Keychain boundary.
    launchEnv.CLAUDE_CONFIG_DIR = resolvedConfigDir;
    launchEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = resolvedConfigDir;
  } else {
    delete launchEnv.CLAUDE_CONFIG_DIR;
    delete launchEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR;
  }
  const resolvedCommand = path.resolve(rawCommand);
  const child = spawnImpl(process.execPath, [
    SUPERVISOR_PATH,
    resolvedCommand,
    ...(Array.isArray(args) ? args : []),
  ], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: launchEnv,
  });
  if (child?.error) {
    throw child.error;
  }
  if (Number.isInteger(child?.status) || typeof child?.signal === "string") {
    const childSignal = typeof child?.signal === "string" ? child.signal : null;
    return {
      status: childSignal ? 1 : Number.isInteger(child.status) ? child.status : 1,
      signal: childSignal,
    };
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("Claude launch did not return a process handle.");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let forcedKillTimer = null;
    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The close/error event remains the authoritative process result.
      }
      forcedKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error event remains the authoritative process result.
        }
      }, 5_000);
      forcedKillTimer.unref?.();
    };
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, childSignal) => {
      const normalizedSignal = typeof childSignal === "string" ? childSignal : null;
      finish(resolve, {
        status: normalizedSignal ? 1 : Number.isInteger(code) ? code : 1,
        signal: normalizedSignal,
      });
    });
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.("abort", onAbort, { once: true });
    }
  });
}
