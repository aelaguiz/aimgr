import { spawn } from "node:child_process";
import path from "node:path";
import { resolveExecutableOnPath } from "../io/process.js";

export function resolveCodexCommand({ homeDir, spawnImpl = spawn } = {}) {
  if (spawnImpl !== spawn) return "codex";
  return resolveExecutableOnPath("codex", {
    extraSearchPaths: [
      homeDir ? path.join(homeDir, ".local", "bin") : "",
      "/opt/homebrew/bin",
      "/usr/local/bin",
    ].filter(Boolean),
  }) || "codex";
}

export function runCodexInteractive({
  homeDir,
  cwd = process.cwd(),
  env = process.env,
  args = [],
  spawnImpl = spawn,
} = {}) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("Codex launch arguments must be strings.");
  }
  const command = resolveCodexCommand({ homeDir, spawnImpl });
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: "inherit",
    shell: false,
  });
  if (child?.error) throw child.error;
  if (!child || typeof child.once !== "function") {
    throw new Error("Codex launch did not return a process handle.");
  }
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal: signal ?? null,
    }));
  });
}
