import { spawnSync } from "node:child_process";

export function runClaudeCli({ homeDir, args = [], env = process.env, spawnImpl = spawnSync } = {}) {
  const result = spawnImpl("claude", Array.isArray(args) ? args : [], {
    stdio: "inherit",
    env: {
      ...env,
      HOME: homeDir,
    },
  });
  if (result?.error) {
    throw result.error;
  }
  return {
    status: Number.isInteger(result?.status) ? result.status : 0,
    signal: typeof result?.signal === "string" ? result.signal : null,
  };
}
