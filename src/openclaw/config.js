import { spawnSync } from "node:child_process";

export function readOpenclawAgentsListFromConfig() {
  const result = spawnSync("openclaw", ["config", "get", "agents.list", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to run openclaw config get: ${String(result.error?.message ?? result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `openclaw config get failed (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }
  const raw = String(result.stdout ?? "").trim();
  if (!raw) {
    throw new Error("openclaw config get agents.list returned empty output.");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("expected JSON array");
    }
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse JSON from openclaw config get agents.list: ${String(err?.message ?? err)}`);
  }
}

export function readOpenclawBindingsFromConfig() {
  const result = spawnSync("openclaw", ["config", "get", "bindings", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to run openclaw config get bindings: ${String(result.error?.message ?? result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `openclaw config get bindings failed (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }
  const raw = String(result.stdout ?? "").trim();
  if (!raw) {
    throw new Error("openclaw config get bindings returned empty output.");
  }
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      throw new Error("expected JSON array");
    }
    return parsed;
  } catch (err) {
    throw new Error(`Failed to parse JSON from openclaw config get bindings: ${String(err?.message ?? err)}`);
  }
}

export function applyOpenclawModelSyncOps(ops) {
  const list = Array.isArray(ops) ? ops : [];
  const applied = [];
  for (const op of list) {
    if (!op || typeof op.path !== "string" || typeof op.value !== "string") {
      throw new Error("Invalid model sync op (expected {path,value} strings).");
    }
    const result = spawnSync("openclaw", ["config", "set", "--strict-json", op.path, op.value], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    if (result.error) {
      throw new Error(`Failed to run openclaw config set ${op.path}: ${String(result.error?.message ?? result.error)}`);
    }
    if (result.status !== 0) {
      throw new Error(
        `openclaw config set failed for ${op.path} (exit ${result.status}). ` +
          `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
      );
    }
    applied.push({ path: op.path, value: op.value });
  }
  return applied;
}
