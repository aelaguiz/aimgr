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

export function resolveCodexConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}
