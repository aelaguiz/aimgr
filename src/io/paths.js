import fs from "node:fs";
import path from "node:path";
import { DEFAULT_AGENTS_REPO_ROOT } from "../core/constants.js";
import { normalizeAbsolutePath } from "../core/normalize.js";

export function resolveHomeDir(cliHome, { env = {} } = {}) {
  const resolved = cliHome ? path.resolve(cliHome) : env.HOME;
  if (!resolved) {
    throw new Error("No HOME available. Provide --home.");
  }
  return resolved;
}

export function resolveAgentsRepoRoot({ repoRoot, env = {} } = {}) {
  const explicit = normalizeAbsolutePath(repoRoot);
  if (explicit && fs.existsSync(explicit)) return explicit;
  const envRoot = normalizeAbsolutePath(env.WORKSPACE_DIR);
  if (envRoot && fs.existsSync(envRoot)) return envRoot;
  return DEFAULT_AGENTS_REPO_ROOT;
}

export function expandHomeShorthandPath(rawPath, { homeDir }) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) return raw;
  if (raw === "~" || raw === "$HOME") {
    return homeDir;
  }
  if (raw.startsWith("~/")) {
    return path.join(homeDir, raw.slice(2));
  }
  if (raw.startsWith("$HOME/")) {
    return path.join(homeDir, raw.slice("$HOME/".length));
  }
  return raw;
}

export function resolveCliPath(rawPath, { homeDir, optionName }) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return path.resolve(expandHomeShorthandPath(raw, { homeDir }));
}

export function resolveOptionalSourceHome(rawPath, { homeDir }) {
  if (rawPath === undefined) return homeDir;
  return resolveCliPath(rawPath, { homeDir, optionName: "--source-home" });
}

export function resolveAimgrStatePath(params, { env = {} } = {}) {
  const homeDir = resolveHomeDir(params.home, { env });
  if (params.state) {
    return path.resolve(expandHomeShorthandPath(params.state, { homeDir }));
  }
  return path.join(homeDir, ".aimgr", "secrets.json");
}

export function resolveAimgrStateDir({ homeDir }) {
  return path.join(homeDir, ".aimgr");
}

export function resolveAimgrConfigPath({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "config.yaml");
}

export function resolveAimgrRedisCachePath({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "redis-cache.json");
}

export function resolveAimgrLocalStatePath({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "local-state.json");
}

export function resolveAimgrRoutinesDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "routines");
}

export function resolveAimgrRoutinePromptsDir({ homeDir }) {
  return path.join(resolveAimgrRoutinesDir({ homeDir }), "prompts");
}

export function resolveAimgrRoutineRunsDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "routine-runs");
}

export function resolveAimgrRoutineLocksDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "routine-locks");
}

export function resolveAimgrRoutineBootstrapLockPath({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "routine-bootstrap.lock");
}

export function resolveAimgrRoutineLogsDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "logs");
}

export function resolveAimgrClaudeLabelHomeDir({ homeDir, label }) {
  const safeLabel = String(label ?? "").trim().replace(/[^A-Za-z0-9_.-]/g, "_");
  if (!safeLabel) {
    throw new Error("Missing Claude label for managed Claude home.");
  }
  return path.join(resolveAimgrStateDir({ homeDir }), "claude-homes", safeLabel);
}

export function resolveHermesProfilesRoot(homeDir) {
  return path.join(homeDir, ".hermes", "profiles");
}

export function resolveHermesHomePath(homeDir, homeId) {
  return path.join(resolveHermesProfilesRoot(homeDir), homeId);
}

export function resolveHermesStateDbPath(homeDir, homeId) {
  return path.join(resolveHermesHomePath(homeDir, homeId), "state.db");
}

export function resolveOpenclawAuthStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
}

export function resolveExplicitHermesAuthFilePath(value) {
  const authPath = normalizeAbsolutePath(value);
  if (!authPath) {
    throw new Error("Missing Hermes auth target. Usage: aim auth write hermes <label> --auth-file <abs-path>.");
  }
  if (path.basename(authPath) !== "auth.json") {
    throw new Error(`Refusing Hermes auth write to non-auth.json path: ${authPath}`);
  }
  return authPath;
}

export function resolveManagedCodexHomeDir({ homeDir, env = {} }) {
  const override = String(env.CODEX_HOME ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(homeDir, ".codex");
}

export function resolveManagedPiAgentDir({ homeDir, env = {} }) {
  const override = String(env.PI_CODING_AGENT_DIR ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(homeDir, ".pi", "agent");
}

export function resolveManagedPrimeAgentDir({ homeDir, env = {} }) {
  const override = String(env.PRIME_AGENT_CODING_AGENT_DIR ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(homeDir, ".prime", "agent");
}

export function resolveManagedClaudeDir({ homeDir }) {
  return path.join(homeDir, ".claude");
}

export function resolveClaudeAppStatePath({ homeDir }) {
  return path.join(homeDir, ".claude.json");
}

export function resolveCodexAuthFilePath(codexHome) {
  return path.join(codexHome, "auth.json");
}

export function resolveClaudeAuthFilePath(claudeDir) {
  return path.join(claudeDir, ".credentials.json");
}

export function resolvePiAuthFilePath(agentDir) {
  return path.join(agentDir, "auth.json");
}

export function resolvePrimeAuthFilePath(agentDir) {
  return path.join(agentDir, "auth.json");
}

export function resolveCodexConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}
