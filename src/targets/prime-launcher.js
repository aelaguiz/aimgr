import fs from "node:fs";
import path from "node:path";

const DIST_EXECUTION_LANE = "--dist";

export function resolvePrimeLauncher({ env = process.env, fsImpl = fs } = {}) {
  const candidates = String(env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((directory) => path.join(directory, "prime-agent"));
  for (const launcher of candidates) {
    try {
      const resolved = fsImpl.realpathSync(launcher);
      if (!fsImpl.statSync(resolved).isFile()) continue;
      fsImpl.accessSync(resolved, fs.constants.X_OK);
      return resolved;
    } catch {
      // Keep looking through PATH.
    }
  }
  throw new Error("Prime Agent launcher is unavailable on PATH.");
}

export function preparePrimeInvocation({ command, args }) {
  const normalizedCommand = String(command ?? "").trim();
  if (!normalizedCommand) throw new Error("Prime Agent launcher is unavailable on PATH.");

  const normalizedArgs = (args ?? []).map(String);
  if (normalizedArgs.includes(DIST_EXECUTION_LANE)) {
    throw new Error("AIM must not select Prime Agent's source/dist execution lane.");
  }
  return { command: normalizedCommand, args: normalizedArgs };
}
