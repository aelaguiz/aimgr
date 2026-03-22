import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { loginAnthropic, loginOpenAICodex, refreshAnthropicToken, refreshOpenAICodexToken } from "@mariozechner/pi-ai";

const SCHEMA_VERSION = "0.2";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENCLAW_ENFORCED_CODEX_MODEL = "openai-codex/gpt-5.4";
const OPENCLAW_ENFORCED_ANTHROPIC_MODEL = "anthropic/claude-opus-4-6";
const CODEX_AUTH_STORE_MODE_FILE = "file";
const CODEX_AUTH_STORE_MODE_KEYRING = "keyring";
const CODEX_AUTH_STORE_MODE_AUTO = "auto";
const DEFAULT_AUTHORITY_STATE_REMOTE_PATH = "$HOME/.aimgr/secrets.json";
const REAUTH_MODE_BROWSER_MANAGED = "browser-managed";
const REAUTH_MODE_MANUAL_CALLBACK = "manual-callback";
const LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE = "aim-browser-profile";
const LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE = "openclaw-browser-profile";
const BROWSER_MODE_AIM_PROFILE = "aim-profile";
const BROWSER_MODE_CHROME_PROFILE = "chrome-profile";
const BROWSER_MODE_AGENT_BROWSER = "agent-browser";
const DEFAULT_AGENTS_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const STATUS_RESET_TIMEZONE = "America/Chicago";
const DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS = 7;
const MIN_AGENT_DEMAND_WEIGHT = 1;
const KEEP_CURRENT_DEMAND_RATIO_THRESHOLD = 0.15;
const KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR = 0.25;
const STATUS_RESET_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: STATUS_RESET_TIMEZONE,
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
  timeZoneName: "short",
});

const SUPPORTED_OAUTH_PROVIDERS = new Map([
  [
    OPENAI_CODEX_PROVIDER,
    {
      id: OPENAI_CODEX_PROVIDER,
      name: "OpenAI Codex (ChatGPT Plus/Pro subscription)",
    },
  ],
  [
    ANTHROPIC_PROVIDER,
    {
      id: ANTHROPIC_PROVIDER,
      name: "Anthropic (Claude Pro/Max subscription)",
    },
  ],
]);

function formatTimestampForBackup(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const ms = pad3(date.getMilliseconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}${ms}`;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function resolveExecutableOnPath(commandName, { extraSearchPaths = [] } = {}) {
  const normalized = String(commandName ?? "").trim();
  if (!normalized) return null;
  const searchDirs = [
    ...extraSearchPaths,
    ...String(process.env.PATH ?? "")
      .split(path.delimiter)
      .map((entry) => String(entry ?? "").trim())
      .filter(Boolean),
  ];
  const seen = new Set();
  for (const dir of searchDirs) {
    if (seen.has(dir)) continue;
    seen.add(dir);
    const candidate = path.join(dir, normalized);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }
  return null;
}

function resolveAgentBrowserCommand({ spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "agent-browser";
  }
  return resolveExecutableOnPath("agent-browser", {
    extraSearchPaths: [
      path.resolve(DEFAULT_AGENTS_REPO_ROOT, "..", "bin"),
      path.resolve(DEFAULT_AGENTS_REPO_ROOT, "..", "tools", "agent-browser", "node_modules", ".bin"),
    ],
  }) || "agent-browser";
}

function activateAgentBrowserApp({ spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return { ok: true };
  }
  if (process.platform !== "darwin") {
    return { ok: true };
  }
  const result = spawnImpl(
    "osascript",
    ["-e", 'tell application "Google Chrome for Testing" to activate'],
    { stdio: "ignore" },
  );
  if (result?.error) {
    return { ok: false, reason: "activate_error", error: String(result.error?.message ?? result.error) };
  }
  if (result?.status !== 0) {
    return { ok: false, reason: "activate_nonzero", status: result.status };
  }
  return { ok: true };
}

function formatBrowserLaunchFailure(opened) {
  const reason = String(opened?.reason ?? "unknown").trim() || "unknown";
  const detail = String(opened?.error ?? "").trim();
  return detail ? `${reason}: ${detail}` : reason;
}

function normalizeProviderId(provider) {
  return String(provider ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, "-");
}

function normalizeLabel(input) {
  const label = String(input ?? "").trim().toLowerCase();
  if (!label) {
    throw new Error("Missing label.");
  }
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(label)) {
    throw new Error(
      `Invalid label: ${label}. Use lowercase letters, numbers, '_' and '-' (e.g. boss, coder2).`,
    );
  }
  const reserved = new Set([
    "status",
    "login",
    "pin",
    "autopin",
    "rebalance",
    "apply",
    "sync",
    "codex",
    "browser",
    "use",
    "show",
    "set",
    "help",
  ]);
  if (reserved.has(label)) {
    throw new Error(`Refusing label=${label} (reserved CLI word). Pick a different label (e.g. boss, coder2).`);
  }
  if (label === "default") {
    throw new Error("Refusing label=default (we never want *:default in steady state).");
  }
  return label;
}

function normalizeAgentId(input) {
  const agentId = String(input ?? "").trim();
  if (!agentId) {
    throw new Error("Missing OpenClaw agent id.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(agentId)) {
    throw new Error(`Invalid OpenClaw agent id: ${agentId}`);
  }
  return agentId;
}

function parseArgs(argv) {
  const opts = {
    home: undefined,
    state: undefined,
    from: undefined,
    mode: undefined,
    seedFromOpenclaw: undefined,
    userDataDir: undefined,
    profile: undefined,
    session: undefined,
    json: false,
    compact: false,
    accounts: false,
    help: false,
    pool: undefined,
  };
  const positional = [];

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--home") {
      opts.home = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--state") {
      opts.state = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--from") {
      opts.from = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--mode") {
      opts.mode = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--seed-from-openclaw") {
      opts.seedFromOpenclaw = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--user-data-dir") {
      opts.userDataDir = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--profile-directory") {
      opts.profileDirectory = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--profile") {
      opts.profile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--session") {
      opts.session = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--json") {
      opts.json = true;
      continue;
    }
    if (arg === "--compact") {
      opts.compact = true;
      continue;
    }
    if (arg === "--accounts") {
      opts.accounts = true;
      continue;
    }
    if (arg === "--assignments") {
      opts.assignments = true;
      continue;
    }
    if (arg === "--pool") {
      opts.pool = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      opts.help = true;
      continue;
    }
    if (arg.startsWith("-")) {
      throw new Error(`Unknown option: ${arg}`);
    }
    positional.push(arg);
  }

  return { opts, positional };
}

function isInteractiveTerminal({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return Boolean(stdin?.isTTY) && Boolean(stdout?.isTTY);
}

function printHelp() {
  const lines = [
    "aim — AI account manager (label-only; one-file SSOT; plaintext on disk).",
    "",
    "Usage:",
    "  aim status [--json] [--compact] [--accounts] [--assignments]",
    "  aim <label>            # primary human path: guided label panel on a TTY; one-shot login in non-interactive use",
    "  aim login <label>      # one-shot maintenance / automation / admin lane",
    "  aim rebalance openclaw # choose pooled Codex assignments for configured OpenClaw agents",
    "  aim apply             # advanced: materialize stored OpenClaw assignments from ~/.aimgr/secrets.json",
    "  aim sync openclaw     # explicit alias for apply",
    "  aim sync codex --from <authority>  # import/refresh openai-codex labels from an authority AIM state",
    "  aim codex use         # activate the next-best pooled openai-codex label for local Codex CLI",
    "  aim browser show <label>",
    "  aim browser set <label> --mode aim-profile [--seed-from-openclaw <profileId>]",
    "  aim browser set <label> --mode chrome-profile --user-data-dir <abs-path> [--profile-directory <name>]",
    "  aim browser set <label> --mode agent-browser --profile <abs-path> --session <name>",
    "  aim browser set <label> --mode manual-callback",
    "",
    "Notes:",
    "  - SSOT file: ~/.aimgr/secrets.json (auto-backed-up on every write).",
    "  - V0 supports: openai-codex (ChatGPT/Codex OAuth) + anthropic (Claude Pro/Max OAuth) on macOS.",
    "  - Browser-managed OAuth supports explicit per-label bindings: aim-profile, chrome-profile, or agent-browser.",
    "  - `aim pin`, `aim autopin openclaw`, and `aim codex use <label>` are removed; use `aim rebalance openclaw`, `aim apply`, and `aim codex use`.",
    "  - Codex target management is file-backed only in v1; keyring/auto homes fail loud.",
    "",
    "Developer options (rare):",
    "  --home <dir>    Run against an alternate HOME (dev/test; e.g. /tmp/aimgr-home).",
    "  --state <path>  Override SSOT file path (default: <home>/.aimgr/secrets.json).",
    "  --from <src>    Authority source for `aim sync codex`.",
    "                  Examples: agents@amirs-mac-studio  |  ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json",
    "  --mode <id>     Browser binding mode for `aim browser set`.",
    "  --seed-from-openclaw <profileId>  Optional one-time OpenClaw seed source for `--mode aim-profile`.",
    "  --user-data-dir <abs-path>        Required for `--mode chrome-profile`.",
    "  --profile-directory <name>        Optional specific Chrome profile inside `--user-data-dir`.",
    "  --profile <abs-path>              Required for `--mode agent-browser`.",
    "  --session <name>                  Required for `--mode agent-browser`.",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function resolveHomeDir(cliHome) {
  const resolved = cliHome ? path.resolve(cliHome) : process.env.HOME;
  if (!resolved) {
    throw new Error("No HOME available. Provide --home.");
  }
  return resolved;
}

function resolveAgentsRepoRoot({ repoRoot } = {}) {
  const explicit = normalizeAbsolutePath(repoRoot);
  if (explicit && fs.existsSync(explicit)) return explicit;
  const envRoot = normalizeAbsolutePath(process.env.WORKSPACE_DIR);
  if (envRoot && fs.existsSync(envRoot)) return envRoot;
  return DEFAULT_AGENTS_REPO_ROOT;
}

function resolveAimgrStatePath(params) {
  const homeDir = resolveHomeDir(params.home);
  if (params.state) {
    return path.resolve(params.state);
  }
  return path.join(homeDir, ".aimgr", "secrets.json");
}

function resolveAimgrStateDir({ homeDir }) {
  return path.join(homeDir, ".aimgr");
}

function resolveOpenclawAuthStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
}

function discoverOpenclawAgentIdsWithAuthStores(homeDir) {
  const agentsRoot = path.join(homeDir, ".openclaw", "agents");
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  const ids = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    if (fs.existsSync(resolveOpenclawAuthStorePath(homeDir, agentId))) {
      ids.push(agentId);
    }
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

function discoverOpenclawAgentIdsWithSessionStores(homeDir) {
  const agentsRoot = path.join(homeDir, ".openclaw", "agents");
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  const ids = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    if (fs.existsSync(resolveOpenclawSessionsStorePath(homeDir, agentId))) {
      ids.push(agentId);
    }
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

function resolveOpenclawSessionsStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "sessions", "sessions.json");
}

export function extractOpenclawConfigAgentModelPrimary(rawModel) {
  if (!rawModel) return null;
  if (typeof rawModel === "string") {
    const trimmed = rawModel.trim();
    return trimmed ? trimmed : null;
  }
  if (!isObject(rawModel)) return null;
  const primary = rawModel.primary;
  if (typeof primary !== "string") return null;
  const trimmed = primary.trim();
  return trimmed ? trimmed : null;
}

export function buildOpenclawModelSyncOps({ agentsList, pinnedAgentIds, modelRefByAgentId }) {
  const list = Array.isArray(agentsList) ? agentsList : [];
  const ids = Array.isArray(pinnedAgentIds) ? pinnedAgentIds : [];
  const desired = isObject(modelRefByAgentId) ? modelRefByAgentId : null;

  const indexById = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!isObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (!indexById.has(id)) {
      indexById.set(id, i);
    }
  }

  const ops = [];
  for (const agentIdRaw of ids) {
    const agentId = normalizeAgentId(agentIdRaw);
    const desiredModelRef = typeof desired?.[agentId] === "string" ? desired[agentId].trim() : OPENCLAW_ENFORCED_CODEX_MODEL;
    if (!desiredModelRef) {
      throw new Error(`Missing desired modelRef for pinned agent: ${agentId}`);
    }
    const idx = indexById.get(agentId);
    if (idx === undefined) {
      throw new Error(`OpenClaw agent id not found in config agents.list: ${agentId}`);
    }
    const entry = list[idx];
    const currentPrimary = extractOpenclawConfigAgentModelPrimary(entry?.model);
    if (currentPrimary === desiredModelRef) {
      continue;
    }

    const modelValue = entry?.model;
    if (isObject(modelValue)) {
      ops.push({
        path: `agents.list[${idx}].model.primary`,
        value: JSON.stringify(desiredModelRef),
      });
      if (Object.hasOwn(modelValue, "fallbacks")) {
        ops.push({ path: `agents.list[${idx}].model.fallbacks`, value: "[]" });
      }
      continue;
    }

    ops.push({
      path: `agents.list[${idx}].model`,
      value: JSON.stringify(desiredModelRef),
    });
  }

  return ops;
}

function buildOpenclawAgentIndexById(agentsList) {
  const list = Array.isArray(agentsList) ? agentsList : [];
  const indexById = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!isObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || indexById.has(id)) continue;
    indexById.set(id, i);
  }
  return indexById;
}

export function partitionOpenclawPinsByConfiguredAgents({ pinsByAgentId, agentsList }) {
  const pins = isObject(pinsByAgentId) ? pinsByAgentId : {};
  const indexById = buildOpenclawAgentIndexById(agentsList);
  const activePins = {};
  const stalePins = [];

  for (const [agentIdRaw, labelRaw] of Object.entries(pins)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    if (indexById.has(agentId)) {
      activePins[agentId] = label;
      continue;
    }
    stalePins.push({ agentId, label });
  }

  return {
    activePins,
    stalePins: stalePins.toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
  };
}

function parseProviderModelRef(raw) {
  const trimmed = String(raw ?? "").trim();
  if (!trimmed) return null;
  const slash = trimmed.indexOf("/");
  if (slash <= 0 || slash === trimmed.length - 1) return null;
  return {
    provider: trimmed.slice(0, slash).trim(),
    model: trimmed.slice(slash + 1).trim(),
  };
}

export function extractSessionModelRefFromEntry(entry) {
  if (!isObject(entry)) return null;
  const runtimeModel = typeof entry.model === "string" ? entry.model.trim() : "";
  const runtimeProvider = typeof entry.modelProvider === "string" ? entry.modelProvider.trim() : "";
  if (runtimeModel) {
    if (runtimeProvider) {
      return { source: "runtime", provider: runtimeProvider, model: runtimeModel };
    }
    const parsed = parseProviderModelRef(runtimeModel);
    if (parsed) return { source: "runtime", provider: parsed.provider, model: parsed.model };
    return { source: "runtime", provider: null, model: runtimeModel };
  }

  const modelOverride = typeof entry.modelOverride === "string" ? entry.modelOverride.trim() : "";
  const providerOverride = typeof entry.providerOverride === "string" ? entry.providerOverride.trim() : "";
  if (modelOverride) {
    const parsed = parseProviderModelRef(modelOverride);
    if (parsed) return { source: "override", provider: parsed.provider, model: parsed.model };
    return { source: "override", provider: providerOverride || null, model: modelOverride };
  }

  return null;
}

function normalizeSessionResetTarget({ desiredProvider, desiredModel }) {
  const provider = String(desiredProvider ?? "").trim();
  const model = String(desiredModel ?? "").trim();
  if ((provider && !model) || (!provider && model)) {
    throw new Error("Session reset target requires desiredProvider + desiredModel together.");
  }
  return { provider, model };
}

function extractProviderFromAuthProfileOverride(rawValue) {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) return null;
  const delimiter = raw.indexOf(":");
  if (delimiter <= 0) return null;
  return normalizeProviderId(raw.slice(0, delimiter));
}

function shouldClearSessionAuthProfileOverride({
  authProfileOverride,
  desiredProvider,
  desiredAuthProfileId,
  clearManagedAuthProfile,
}) {
  const override = typeof authProfileOverride === "string" ? authProfileOverride.trim() : "";
  if (!override) return false;

  const desiredProfileId = typeof desiredAuthProfileId === "string" ? desiredAuthProfileId.trim() : "";
  if (desiredProfileId) {
    return override !== desiredProfileId;
  }

  if (clearManagedAuthProfile) {
    const provider = extractProviderFromAuthProfileOverride(override);
    if (provider && (provider === OPENAI_CODEX_PROVIDER || provider === ANTHROPIC_PROVIDER)) {
      return true;
    }
  }

  return Boolean(desiredProvider) && !override.startsWith(`${desiredProvider}:`);
}

export function sessionEntryNeedsModelReset({ entry, desiredProvider, desiredModel, desiredAuthProfileId, clearManagedAuthProfile = false }) {
  const { provider, model } = normalizeSessionResetTarget({ desiredProvider, desiredModel });

  const parsed = extractSessionModelRefFromEntry(entry);
  if (provider && model) {
    if (parsed?.provider && parsed.provider !== provider) return true;
    if (parsed?.model && parsed.model !== model) return true;
  }

  const authProfileOverride = typeof entry?.authProfileOverride === "string" ? entry.authProfileOverride.trim() : "";
  if (
    shouldClearSessionAuthProfileOverride({
      authProfileOverride,
      desiredProvider: provider,
      desiredAuthProfileId,
      clearManagedAuthProfile,
    })
  ) {
    return true;
  }

  return false;
}

export function resetSessionEntryToDefaults({
  entry,
  desiredProvider,
  desiredModel,
  desiredAuthProfileId,
  clearManagedAuthProfile = false,
}) {
  if (!isObject(entry)) return { changed: false, entry };
  const { provider, model } = normalizeSessionResetTarget({ desiredProvider, desiredModel });

  const next = structuredClone(entry);
  let changed = false;

  // Clear runtime model identity — it overrides everything else on restart.
  if (next.model !== undefined) {
    delete next.model;
    changed = true;
  }
  if (next.modelProvider !== undefined) {
    delete next.modelProvider;
    changed = true;
  }

  // Clear explicit per-session override so the session follows agent defaults.
  if (next.modelOverride !== undefined) {
    delete next.modelOverride;
    changed = true;
  }
  if (next.providerOverride !== undefined) {
    delete next.providerOverride;
    changed = true;
  }

  // Auth profiles are provider-scoped; clear overrides that can't possibly match.
  const authProfileOverride = typeof next.authProfileOverride === "string" ? next.authProfileOverride.trim() : "";
  if (
    shouldClearSessionAuthProfileOverride({
      authProfileOverride,
      desiredProvider: provider,
      desiredAuthProfileId,
      clearManagedAuthProfile,
    })
  ) {
    delete next.authProfileOverride;
    delete next.authProfileOverrideSource;
    delete next.authProfileOverrideCompactionCount;
    changed = true;
  }

  // If we're migrating models, clear stale fallback notices.
  if (next.fallbackNoticeSelectedModel !== undefined) {
    delete next.fallbackNoticeSelectedModel;
    changed = true;
  }
  if (next.fallbackNoticeActiveModel !== undefined) {
    delete next.fallbackNoticeActiveModel;
    changed = true;
  }
  if (next.fallbackNoticeReason !== undefined) {
    delete next.fallbackNoticeReason;
    changed = true;
  }

  if (changed && typeof next.updatedAt === "number") {
    next.updatedAt = Date.now();
  }

  return { changed, entry: next };
}

export function scanOpenclawSessionsStoreForKeysNeedingModelReset({
  store,
  desiredProvider,
  desiredModel,
  desiredAuthProfileId,
  clearManagedAuthProfile = false,
}) {
  const s = isObject(store) ? store : null;
  if (!s) return [];
  const keys = [];
  for (const [key, entry] of Object.entries(s)) {
    if (
      sessionEntryNeedsModelReset({
        entry,
        desiredProvider,
        desiredModel,
        desiredAuthProfileId,
        clearManagedAuthProfile,
      })
    ) {
      keys.push(key);
    }
  }
  return keys;
}

function applyOpenclawSessionsDiskResets({
  homeDir,
  agentId,
  desiredProvider,
  desiredModel,
  desiredAuthProfileId,
  clearManagedAuthProfile = false,
}) {
  const storePath = resolveOpenclawSessionsStorePath(homeDir, agentId);
  const existing = readJsonFile(storePath);
  if (!existing) {
    return { storePath, exists: false, sessionsTotal: 0, sessionsWouldChange: 0, sessionsChanged: 0 };
  }
  if (!isObject(existing)) {
    throw new Error(`OpenClaw sessions store is not an object map: ${storePath}`);
  }

  const keys = scanOpenclawSessionsStoreForKeysNeedingModelReset({
    store: existing,
    desiredProvider,
    desiredModel,
    desiredAuthProfileId,
    clearManagedAuthProfile,
  });
  if (keys.length === 0) {
    return {
      storePath,
      exists: true,
      sessionsTotal: Object.keys(existing).length,
      sessionsWouldChange: 0,
      sessionsChanged: 0,
    };
  }

  const next = structuredClone(existing);
  let changedCount = 0;
  for (const key of keys) {
    const current = next[key];
    const patched = resetSessionEntryToDefaults({
      entry: current,
      desiredProvider,
      desiredModel,
      desiredAuthProfileId,
      clearManagedAuthProfile,
    });
    if (patched.changed) {
      next[key] = patched.entry;
      changedCount += 1;
    }
  }

  if (changedCount > 0) {
    writeJsonFileWithBackup(storePath, next);
  }

  return {
    storePath,
    exists: true,
    sessionsTotal: Object.keys(existing).length,
    sessionsWouldChange: keys.length,
    sessionsChanged: changedCount,
  };
}

function spawnQuiet(cmd, cmdArgs, options) {
  return new Promise((resolve) => {
    const proc = spawn(cmd, cmdArgs, {
      stdio: ["ignore", "ignore", "pipe"],
      ...options,
    });

    let stderr = "";
    proc.stderr.on("data", (d) => {
      stderr += d.toString("utf8");
      if (stderr.length > 10_000) {
        stderr = stderr.slice(stderr.length - 10_000);
      }
    });

    proc.on("close", (code) => {
      resolve({ code: code ?? 1, stderr: stderr.trim() });
    });
  });
}

function probeOpenclawGateway({ timeoutMs }) {
  const params = JSON.stringify({ limit: 1 });
  const result = spawnSync(
    "openclaw",
    ["gateway", "call", "sessions.list", "--params", params, "--json", "--timeout", String(timeoutMs)],
    { encoding: "utf8", stdio: ["ignore", "ignore", "pipe"] },
  );

  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "nonzero_exit",
      status: result.status,
      stderr: String(result.stderr ?? "").trim(),
    };
  }

  return { ok: true };
}

function restartOpenclawGateway({ timeoutMs }) {
  const result = spawnSync(
    "openclaw",
    ["gateway", "restart"],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
    },
  );

  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      reason: "nonzero_exit",
      status: result.status,
      stdout: String(result.stdout ?? "").trim(),
      stderr: String(result.stderr ?? "").trim(),
    };
  }

  return {
    ok: true,
    status: "restarted",
    stdout: String(result.stdout ?? "").trim(),
  };
}

async function applySessionsModelViaGatewayOps({ ops, timeoutMs }) {
  const failures = [];
  const concurrency = 6;
  let idx = 0;

  const worker = async () => {
    while (true) {
      const nextIndex = idx;
      idx += 1;
      if (nextIndex >= ops.length) return;

      const op = ops[nextIndex];
      const params = JSON.stringify({ key: op.key, model: op.modelRef });
      const call = await spawnQuiet(
        "openclaw",
        ["gateway", "call", "sessions.patch", "--params", params, "--json", "--timeout", String(timeoutMs)],
        {},
      );
      if (call.code !== 0) {
        failures.push({ key: op.key, error: call.stderr || `exit ${call.code}` });
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, ops.length) }, () => worker()));
  return { ok: failures.length === 0, failures };
}

async function applySessionsModelViaGateway({ keys, modelRef, timeoutMs }) {
  const ops = (Array.isArray(keys) ? keys : []).map((key) => ({ key, modelRef }));
  return await applySessionsModelViaGatewayOps({ ops, timeoutMs });
}

function readOpenclawAgentsListFromConfig() {
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

function readOpenclawBindingsFromConfig() {
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

function applyOpenclawModelSyncOps(ops) {
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

function readJsonFile(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  const raw = fs.readFileSync(filePath, "utf8");
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse JSON: ${filePath} (${err.message})`);
  }
}

function writeJsonFileWithBackup(filePath, data) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });

  if (fs.existsSync(filePath)) {
    const backupPath = `${filePath}.bak.${formatTimestampForBackup()}`;
    fs.copyFileSync(filePath, backupPath);
  }
  const json = `${JSON.stringify(data, null, 2)}\n`;
  fs.writeFileSync(filePath, json, { encoding: "utf8" });
}

function writeJsonFileWithBackupIfChanged(filePath, data) {
  const next = `${JSON.stringify(data, null, 2)}\n`;
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  if (current === next) {
    return { wrote: false, path: filePath };
  }
  writeJsonFileWithBackup(filePath, data);
  return { wrote: true, path: filePath };
}

function writeTextFileIfChanged(filePath, text, { mode } = {}) {
  const next = String(text ?? "");
  let current = null;
  try {
    current = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err?.code !== "ENOENT") {
      throw err;
    }
  }
  if (current === next) {
    return { wrote: false, path: filePath };
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, next, {
    encoding: "utf8",
    ...(mode !== undefined ? { mode } : {}),
  });
  return { wrote: true, path: filePath };
}

function writeJsonFileIfChanged(filePath, data, { mode } = {}) {
  return writeTextFileIfChanged(filePath, `${JSON.stringify(data, null, 2)}\n`, { mode });
}

function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: {},
    credentials: {
      [OPENAI_CODEX_PROVIDER]: {},
      [ANTHROPIC_PROVIDER]: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
      },
    },
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
    },
  };
}

function normalizeLegacyStateV0(raw) {
  const migrated = createEmptyState();

  // Old shape: { version, accounts, openclaw: { agentPins } }
  const legacyAccounts = isObject(raw.accounts) ? raw.accounts : {};
  for (const [labelRaw, accountRaw] of Object.entries(legacyAccounts)) {
    if (!isObject(accountRaw)) continue;
    const provider = normalizeProviderId(accountRaw.provider);

    let label;
    try {
      label = normalizeLabel(labelRaw);
    } catch {
      continue;
    }

    const browser = isObject(accountRaw.browser) ? accountRaw.browser : null;
    const chromeProfileDirectory =
      browser && typeof browser.profileDirectory === "string" ? browser.profileDirectory : null;

    const expectEmail = typeof accountRaw.email === "string" ? accountRaw.email : null;

    migrated.accounts[label] = {
      provider: provider || OPENAI_CODEX_PROVIDER,
      browser: {
        mode: chromeProfileDirectory ? BROWSER_MODE_CHROME_PROFILE : BROWSER_MODE_AIM_PROFILE,
        ...(chromeProfileDirectory ? { userDataDir: chromeProfileDirectory } : {}),
      },
      reauth: {
        mode: REAUTH_MODE_BROWSER_MANAGED,
      },
      pool: {
        enabled: true,
      },
      ...(chromeProfileDirectory ? { chromeProfileDirectory } : {}),
      ...(expectEmail ? { expect: { email: expectEmail } } : {}),
    };

    // Legacy stored OpenClaw OAuth creds under account.openclaw.credential
    const oc = isObject(accountRaw.openclaw) ? accountRaw.openclaw : null;
    const cred = oc && isObject(oc.credential) ? oc.credential : null;
    if (cred && normalizeProviderId(cred.provider) === OPENAI_CODEX_PROVIDER) {
      const access = typeof cred.access === "string" ? cred.access : null;
      const refresh = typeof cred.refresh === "string" ? cred.refresh : null;
      const expires = typeof cred.expires === "number" ? cred.expires : null;
      const accountId = typeof cred.accountId === "string" ? cred.accountId : null;
      if (access && refresh && expires && accountId) {
        migrated.credentials[OPENAI_CODEX_PROVIDER] = isObject(migrated.credentials[OPENAI_CODEX_PROVIDER])
          ? migrated.credentials[OPENAI_CODEX_PROVIDER]
          : {};
        migrated.credentials[OPENAI_CODEX_PROVIDER][label] = {
          access,
          refresh,
          expiresAt: new Date(expires).toISOString(),
          accountId,
        };
      }
    }
  }

  const legacyPins = isObject(raw.openclaw?.agentPins) ? raw.openclaw.agentPins : {};
  for (const [agentId, profileId] of Object.entries(legacyPins)) {
    if (typeof profileId !== "string") continue;
    const parts = profileId.split(":");
    if (parts.length < 2) continue;
    const suffix = parts.slice(1).join(":");
    try {
      migrated.targets.openclaw.assignments[agentId] = normalizeLabel(suffix);
    } catch {
      // Ignore invalid pins on migration; they must be re-pinned explicitly.
    }
  }

  return migrated;
}

function loadAimgrState(statePath) {
  const raw = readJsonFile(statePath);
  if (!raw) {
    return createEmptyState();
  }
  const { state, changed } = normalizeAimgrStateFromJsonValue(raw, statePath);
  if (changed) {
    writeJsonFileWithBackupIfChanged(statePath, state);
  }
  return state;
}

function loadAimgrStateFromJsonValue(raw, sourceDescription = "<memory>") {
  return normalizeAimgrStateFromJsonValue(raw, sourceDescription).state;
}

function normalizeAimgrStateFromJsonValue(raw, sourceDescription = "<memory>") {
  if (!isObject(raw)) {
    throw new Error(`aimgr state must be a JSON object: ${sourceDescription}`);
  }

  // Current SSOT shape (schemaVersion present) — keep unknown keys, but ensure we have the basics.
  if (typeof raw.schemaVersion === "string") {
    const original = JSON.stringify(raw);
    const state = structuredClone(raw);
    ensureStateShape(state);
    return { state, changed: JSON.stringify(state) !== original };
  }

  // Legacy shape — migrate eagerly so the persisted state stops carrying the old truth.
  return { state: normalizeLegacyStateV0(raw), changed: true };
}

function parseTimestampLikeToMs(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) {
    return numeric;
  }
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeDemandWeight(value, fallback = 0) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < 0) {
    return fallback;
  }
  return numeric;
}

function roundDemandWeight(value) {
  return Math.round(normalizeDemandWeight(value) * 100) / 100;
}

function pruneOpenaiCodexHistory(history) {
  const list = Array.isArray(history) ? history.filter((entry) => isObject(entry)) : [];
  const cutoffMs = Date.now() - 14 * 24 * 60 * 60 * 1000;
  const filtered = list.filter((entry) => {
    const observedAtMs = parseExpiresAtToMs(entry.observedAt);
    return observedAtMs !== null && observedAtMs >= cutoffMs;
  });
  const limited = filtered.slice(-200);
  return limited.map((entry) => {
    const next = {
      observedAt: String(entry.observedAt),
      kind: String(entry.kind),
    };
    if (typeof entry.status === "string" && entry.status.trim()) next.status = entry.status.trim();
    if (typeof entry.label === "string" && entry.label.trim()) next.label = entry.label.trim();
    if (typeof entry.accountId === "string" && entry.accountId.trim()) next.accountId = entry.accountId.trim();
    if (typeof entry.reason === "string" && entry.reason.trim()) next.reason = entry.reason.trim();
    if (typeof entry.hadSpareEligibleCapacity === "boolean") {
      next.hadSpareEligibleCapacity = entry.hadSpareEligibleCapacity;
    }
    return next;
  });
}

function pruneOpenaiCodexAgentDemand(agentDemand) {
  const entries = isObject(agentDemand) ? agentDemand : {};
  const next = {};
  for (const [agentIdRaw, entry] of Object.entries(entries)) {
    try {
      const agentId = normalizeAgentId(agentIdRaw);
      const current = isObject(entry) ? entry : {};
      const updatedAtMs = parseTimestampLikeToMs(current.updatedAt);
      const lookbackDays = Math.max(1, Math.round(normalizeDemandWeight(current.lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
      const source =
        current.source === "openclaw-session-tokens" || current.source === "cold-start-equal-share"
          ? current.source
          : "cold-start-equal-share";
      next[agentId] = {
        updatedAt: updatedAtMs !== null ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
        lookbackDays,
        source,
        inputTokens: roundDemandWeight(current.inputTokens),
        outputTokens: roundDemandWeight(current.outputTokens),
        totalTokens: roundDemandWeight(current.totalTokens),
        demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(current.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
      };
    } catch {
      // Ignore malformed demand-ledger entries; the next rebalance refresh will restore them if needed.
    }
  }
  return next;
}

function sanitizeForStatus(value) {
  const exactSecretKeys = new Set(
    [
      "access",
      "refresh",
      "expires",
      "access_token",
      "refresh_token",
      "id_token",
      "key",
      "api_key",
      "client_secret",
      "token",
      "secret",
      "password",
      "cookie",
      "accessToken",
      "refreshToken",
      "idToken",
    ].map((k) => String(k).toLowerCase()),
  );

  const isLikelySecretKey = (key) => {
    const k = String(key ?? "").trim().toLowerCase();
    if (!k) return false;
    if (exactSecretKeys.has(k)) return true;
    if (k.includes("token")) return true;
    if (k.includes("secret")) return true;
    if (k.includes("password")) return true;
    if (k.includes("cookie")) return true;
    if (k === "key" || k.endsWith("_key") || k.endsWith("key")) return true;
    return false;
  };

  const seen = new WeakSet();
  const walk = (v) => {
    if (!v || typeof v !== "object") return v;
    if (seen.has(v)) return "[circular]";
    seen.add(v);

    if (Array.isArray(v)) return v.map((item) => walk(item));

    const out = {};
    for (const [k, child] of Object.entries(v)) {
      if (isLikelySecretKey(k) && typeof child === "string") {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = walk(child);
    }
    return out;
  };

  return walk(value);
}

function openChromeUserDataDirForUrl({ url, userDataDir, profileDirectory, spawnImpl = spawnSync }) {
  const u = String(url ?? "").trim();
  const dir = String(userDataDir ?? "").trim();
  const profile = normalizeChromeProfileDirectory(profileDirectory);
  if (!u) return { ok: false, reason: "missing_url" };
  if (!dir) return { ok: false, reason: "missing_user_data_dir" };
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported_platform" };

  const chromeArgs = [`--user-data-dir=${dir}`];
  if (profile) {
    chromeArgs.push(`--profile-directory=${profile}`);
  }
  const result = spawnImpl(
    "open",
    ["-n", "-a", "Google Chrome", "--args", ...chromeArgs, u],
    { stdio: "ignore" },
  );
  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return { ok: false, reason: "nonzero_exit", status: result.status };
  }
  return { ok: true };
}

function spawnAgentBrowserOpen({ url, profile, session, cwd, spawnImpl = spawnSync }) {
  const resolvedUrl = String(url ?? "").trim();
  const resolvedProfile = String(profile ?? "").trim();
  const resolvedSession = String(session ?? "").trim();
  const resolvedCwd = String(cwd ?? "").trim();
  if (!resolvedUrl) return { ok: false, reason: "missing_url" };
  if (!resolvedProfile) return { ok: false, reason: "missing_agent_browser_profile" };
  if (!resolvedSession) return { ok: false, reason: "missing_agent_browser_session" };
  if (!resolvedCwd) return { ok: false, reason: "missing_launch_cwd" };

  const result = spawnImpl(
    resolveAgentBrowserCommand({ spawnImpl }),
    ["--profile", resolvedProfile, "--session-name", resolvedSession, "--headed", "open", resolvedUrl],
    { stdio: "ignore", cwd: resolvedCwd },
  );
  if (result?.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result?.status !== 0) {
    return { ok: false, reason: "nonzero_exit", status: result.status };
  }
  const activated = activateAgentBrowserApp({ spawnImpl });
  if (!activated.ok) {
    return activated;
  }
  return { ok: true };
}

function resolveOpenclawStateDir({ homeDir }) {
  return path.join(homeDir, ".openclaw");
}

function resolveAimBrowserRootDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "browser");
}

function resolveAimBrowserUserDataDir({ homeDir, label }) {
  return path.join(resolveAimBrowserRootDir({ homeDir }), normalizeLabel(label), "user-data");
}

function resolveAimBrowserLocalStatePath({ homeDir, label }) {
  return path.join(resolveAimBrowserUserDataDir({ homeDir, label }), "Local State");
}

function resolveChromeLocalStatePath(userDataDir) {
  return path.join(String(userDataDir ?? "").trim(), "Local State");
}

function normalizeChromeProfileDirectory(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw;
}

function aimBrowserProfileExists({ homeDir, label }) {
  return fs.existsSync(resolveAimBrowserUserDataDir({ homeDir, label }));
}

function isAbsoluteExistingDirectory(dirPath) {
  const raw = String(dirPath ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) return false;
  try {
    return fs.statSync(raw).isDirectory();
  } catch {
    return false;
  }
}

function openclawAgentExists({ openclawStateDir, agentId }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  const id = String(agentId ?? "").trim();
  if (!baseDir || !id) return false;
  return fs.existsSync(path.join(baseDir, "agents", id, "agent"));
}

function inferOpenclawAgentIdForLabel({ openclawStateDir, label }) {
  const l = String(label ?? "").trim();
  if (!l) return null;

  const candidates = [];
  // Convention: label=boss -> agent_boss
  candidates.push(`agent_${l}`);
  // Allow label=growth-analyst to map to an existing agent_growth_analyst directory.
  const underscore = `agent_${l.replace(/-/g, "_")}`;
  if (underscore !== candidates[0]) candidates.push(underscore);

  for (const agentId of candidates) {
    if (openclawAgentExists({ openclawStateDir, agentId })) {
      return agentId;
    }
  }
  return null;
}

function listDirectories(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function resolveOpenclawBrowserUserDataDir({ openclawStateDir, profileId }) {
  return path.join(openclawStateDir, "browser", profileId, "user-data");
}

function resolveOpenclawBrowserProfileLocalStatePath({ openclawStateDir, profileId }) {
  return path.join(resolveOpenclawBrowserUserDataDir({ openclawStateDir, profileId }), "Local State");
}

function readChromeProfileInfoCacheFromLocalState(localStatePath) {
  const localState = readJsonFile(localStatePath);
  const cache = localState?.profile?.info_cache;
  return isObject(cache) ? cache : null;
}

function readChromeProfileInfoFromLocalState(localStatePath, profileDirectory = "Default") {
  const cache = readChromeProfileInfoCacheFromLocalState(localStatePath);
  if (!cache) return null;
  const entry = cache[profileDirectory];
  return isObject(entry) ? entry : null;
}

function readChromeDefaultProfileInfoFromLocalState(localStatePath) {
  return readChromeProfileInfoFromLocalState(localStatePath, "Default");
}

function buildChromeProfileChoiceLabel(profile) {
  const browserName = String(profile.browserName ?? "").trim() || "Chrome";
  const source = String(profile.source ?? "").trim();
  const sourceId =
    source === "openclaw-browser"
      ? String(profile.profileId ?? "").trim()
      : "";
  const profileNameRaw = String(profile.name ?? "").trim();
  const profileName = sourceId && profileNameRaw === sourceId ? "" : profileNameRaw;
  const userName = String(profile.userName ?? "").trim() || String(profile.gaiaName ?? "").trim();
  const parts = [browserName];
  if (sourceId) parts.push(sourceId);
  if (profileName) parts.push(profileName);
  if (userName) parts.push(userName);
  return parts.join(" · ");
}

function formatChromeBrowserTarget({ userDataDir, profileDirectory, fallback = "the saved Chrome profile" }) {
  const resolvedUserDataDir = String(userDataDir ?? "").trim();
  const resolvedProfileDirectory = normalizeChromeProfileDirectory(profileDirectory);
  if (resolvedUserDataDir && resolvedProfileDirectory) {
    return `Chrome user-data-dir ${resolvedUserDataDir} with profile-directory "${resolvedProfileDirectory}"`;
  }
  if (resolvedUserDataDir) {
    return `Chrome user-data-dir ${resolvedUserDataDir}`;
  }
  if (resolvedProfileDirectory) {
    return `Chrome profile-directory "${resolvedProfileDirectory}"`;
  }
  return fallback;
}

function buildChromeProfileChoiceDetails(profile, { label, prefix = "Will save" } = {}) {
  const normalizedLabel = normalizeLabel(label);
  return [
    `${prefix} ${formatChromeBrowserTarget({
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      fallback: `the chosen Chrome profile for ${normalizedLabel}`,
    })}.`,
    ...(String(profile.source ?? "").trim() === "openclaw-browser" && String(profile.profileId ?? "").trim()
      ? [`This is OpenClaw browser profile "${String(profile.profileId).trim()}".`]
      : []),
    `AIM found it in ${resolveChromeLocalStatePath(profile.userDataDir)}.`,
  ];
}

function normalizeBrowserDiscoveryMatchKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function discoverSelectableChromeBindings({ homeDir, label }) {
  const normalizedLabel = normalizeLabel(label);
  const labelToken = normalizeBrowserDiscoveryMatchKey(normalizedLabel);
  const agentLabelToken = normalizeBrowserDiscoveryMatchKey(`agent-${normalizedLabel}`);
  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const candidates = [
    ...discoverOpenclawBrowserProfiles({ openclawStateDir }).map((profile) => ({
      ...profile,
      source: "openclaw-browser",
      browserName: "OpenClaw browser",
      profileDirectory: null,
    })),
    ...discoverChromeProfiles({ homeDir }).map((profile) => ({
      ...profile,
      source: "host-chrome",
    })),
  ];

  return candidates.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName || a.gaiaName);
    const bSignedIn = Boolean(b.userName || b.gaiaName);
    const aSource = String(a.source ?? "").trim();
    const bSource = String(b.source ?? "").trim();
    const aProfileKey = normalizeBrowserDiscoveryMatchKey(
      aSource === "openclaw-browser" ? a.profileId : a.profileDirectory,
    );
    const bProfileKey = normalizeBrowserDiscoveryMatchKey(
      bSource === "openclaw-browser" ? b.profileId : b.profileDirectory,
    );
    const aRelevant = aProfileKey === labelToken || aProfileKey === agentLabelToken;
    const bRelevant = bProfileKey === labelToken || bProfileKey === agentLabelToken;

    if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;
    if (aSource !== bSource) {
      if (aSource === "openclaw-browser") return -1;
      if (bSource === "openclaw-browser") return 1;
    }
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    const byLabel = buildChromeProfileChoiceLabel(a).localeCompare(buildChromeProfileChoiceLabel(b));
    if (byLabel !== 0) return byLabel;
    return String(a.userDataDir ?? "").localeCompare(String(b.userDataDir ?? ""));
  });
}

function buildChromeSetupOptionDetails({ label, homeDir }) {
  const normalizedLabel = normalizeLabel(label);
  const profiles = discoverSelectableChromeBindings({ homeDir, label: normalizedLabel });
  if (profiles.length === 0) {
    return [
      `Will scan local Chrome and OpenClaw browser homes on this Mac, let you pick a discovered profile if one exists, or let you enter one manually for ${normalizedLabel}.`,
    ];
  }

  const openclawCount = profiles.filter((profile) => String(profile.source ?? "").trim() === "openclaw-browser").length;
  const hostCount = profiles.length - openclawCount;
  const sourceSummary = [
    openclawCount > 0 ? `${openclawCount} OpenClaw browser home${openclawCount === 1 ? "" : "s"}` : null,
    hostCount > 0 ? `${hostCount} host Chrome profile${hostCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  const preview = profiles.slice(0, 3).flatMap((profile, index) => [
    `Option ${index + 1}: ${buildChromeProfileChoiceLabel(profile)}.`,
    `Would save ${formatChromeBrowserTarget({
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      fallback: "the discovered Chrome profile",
    })}.`,
  ]);

  return [
    `Next screen will offer ${profiles.length} discovered Chrome profile${profiles.length === 1 ? "" : "s"} on this Mac and let you pick one.`,
    ...(sourceSummary.length > 0 ? [`Includes ${sourceSummary.join(" and ")}.`] : []),
    ...preview,
    ...(profiles.length > 3 ? [`Plus ${profiles.length - 3} more discovered Chrome profiles.`] : []),
    `If none match, AIM will let you enter another Chrome user-data-dir and profile-directory manually for ${normalizedLabel}.`,
  ];
}

function discoverChromeProfiles({ homeDir }) {
  const baseHome = String(homeDir ?? "").trim();
  if (!baseHome) return [];
  const roots = [
    { browserName: "Google Chrome", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome") },
    { browserName: "Google Chrome Beta", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome Beta") },
    { browserName: "Google Chrome Canary", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome Canary") },
    { browserName: "Chromium", userDataDir: path.join(baseHome, "Library", "Application Support", "Chromium") },
  ];

  const profiles = [];
  for (const root of roots) {
    if (!isAbsoluteExistingDirectory(root.userDataDir)) continue;
    const localStatePath = resolveChromeLocalStatePath(root.userDataDir);
    const cache = readChromeProfileInfoCacheFromLocalState(localStatePath);
    if (!cache) continue;
    for (const [profileDirectory, info] of Object.entries(cache)) {
      if (!isObject(info)) continue;
      if (!isAbsoluteExistingDirectory(path.join(root.userDataDir, profileDirectory))) continue;
      const name = typeof info.name === "string" ? info.name.trim() : "";
      const userName = typeof info.user_name === "string" ? info.user_name.trim() : "";
      const gaiaName = typeof info.gaia_name === "string" ? info.gaia_name.trim() : "";
      profiles.push({
        browserName: root.browserName,
        userDataDir: root.userDataDir,
        profileDirectory,
        name: name || null,
        userName: userName || null,
        gaiaName: gaiaName || null,
      });
    }
  }

  return profiles.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName || a.gaiaName);
    const bSignedIn = Boolean(b.userName || b.gaiaName);
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    const byBrowser = a.browserName.localeCompare(b.browserName);
    if (byBrowser !== 0) return byBrowser;
    const byProfileName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
    if (byProfileName !== 0) return byProfileName;
    return a.profileDirectory.localeCompare(b.profileDirectory);
  });
}

export function discoverOpenclawBrowserProfiles({ openclawStateDir }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  if (!baseDir) return [];

  const browserRoot = path.join(baseDir, "browser");
  const profileIds = listDirectories(browserRoot);

  const profiles = profileIds
    .map((profileId) => {
      const userDataDir = resolveOpenclawBrowserUserDataDir({ openclawStateDir: baseDir, profileId });
      if (!fs.existsSync(userDataDir)) return null;

      const info = readChromeDefaultProfileInfoFromLocalState(
        resolveOpenclawBrowserProfileLocalStatePath({ openclawStateDir: baseDir, profileId }),
      );
      const name = typeof info?.name === "string" ? String(info.name).trim() : "";
      const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
      const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";

      return {
        source: "openclaw-browser",
        browserName: "OpenClaw browser",
        profileId,
        userDataDir,
        name: name || null,
        userName: userName || null,
        gaiaName: gaiaName || null,
      };
    })
    .filter(Boolean);

  return profiles.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName);
    const bSignedIn = Boolean(b.userName);
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    return a.profileId.localeCompare(b.profileId);
  });
}

function readAimBrowserFacts({ homeDir, label }) {
  const userDataDir = resolveAimBrowserUserDataDir({ homeDir, label });
  if (!fs.existsSync(userDataDir)) {
    return {
      label: normalizeLabel(label),
      exists: false,
      userDataDir,
      name: null,
      userName: null,
      gaiaName: null,
    };
  }

  const info = readChromeDefaultProfileInfoFromLocalState(resolveAimBrowserLocalStatePath({ homeDir, label }));
  const name = typeof info?.name === "string" ? String(info.name).trim() : "";
  const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
  const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";

  return {
    label: normalizeLabel(label),
    exists: true,
    userDataDir,
    name: name || null,
    userName: userName || null,
    gaiaName: gaiaName || null,
  };
}

function discoverAimBrowserProfiles({ homeDir }) {
  const browserRoot = resolveAimBrowserRootDir({ homeDir });
  const labels = listDirectories(browserRoot);
  return labels
    .map((labelRaw) => {
      try {
        const label = normalizeLabel(labelRaw);
        return readAimBrowserFacts({ homeDir, label });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

function formatOpenclawBrowserProfileChoice(profile) {
  const parts = [profile.profileId];
  const name = profile.name && profile.name !== profile.profileId ? profile.name : null;
  const email = profile.userName || null;
  const gaia = profile.gaiaName || null;

  if (name) parts.push(name);
  if (email) parts.push(email);
  if (gaia && gaia !== name && gaia !== email) parts.push(gaia);
  return parts.join(" — ");
}

function openclawBrowserProfileExists({ openclawStateDir, profileId }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  const id = String(profileId ?? "").trim();
  if (!baseDir || !id) return false;
  return fs.existsSync(resolveOpenclawBrowserUserDataDir({ openclawStateDir: baseDir, profileId: id }));
}

function resolveOpenclawBrowserProfileFromInput({ input, profiles }) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 1 || idx > profiles.length) return null;
    return profiles[idx - 1].profileId;
  }

  const byLower = new Map();
  for (const profile of profiles) {
    byLower.set(profile.profileId.toLowerCase(), profile.profileId);
  }
  const direct = byLower.get(raw.toLowerCase());
  if (direct) return direct;

  return raw;
}

function normalizeDiscoveryToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function readAgentBrowserConfigFromWorkspace(workspacePath, { agentId, agentName } = {}) {
  const workspace = normalizeAbsolutePath(workspacePath);
  if (!workspace || !fs.existsSync(workspace)) return null;
  const configPath = path.join(workspace, "agent-browser.json");
  if (!fs.existsSync(configPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const session = String(parsed.session ?? "").trim();
  const profile = normalizeAbsolutePath(parsed.profile);
  if (!session || !profile || !isAbsoluteExistingDirectory(profile)) {
    return null;
  }

  return {
    agentId: String(agentId ?? "").trim() || path.basename(workspace),
    agentName: String(agentName ?? "").trim() || null,
    workspace,
    configPath,
    agentBrowserSession: session,
    agentBrowserProfile: profile,
  };
}

function readRepoAgentBrowserConfigs({ repoRoot, agentsList }) {
  const entries = [];
  const seenWorkspaces = new Set();
  const list = Array.isArray(agentsList) ? agentsList : [];

  for (const agent of list) {
    if (!isObject(agent)) continue;
    const candidate = readAgentBrowserConfigFromWorkspace(agent.workspace, {
      agentId: agent.id,
      agentName: agent.name,
    });
    if (!candidate) continue;
    if (seenWorkspaces.has(candidate.workspace)) continue;
    seenWorkspaces.add(candidate.workspace);
    entries.push(candidate);
  }

  const resolvedRepoRoot = resolveAgentsRepoRoot({ repoRoot });
  const agentsDir = path.join(resolvedRepoRoot, "agents");
  for (const dirName of listDirectories(agentsDir)) {
    const workspace = path.join(agentsDir, dirName);
    const candidate = readAgentBrowserConfigFromWorkspace(workspace, {
      agentId: dirName,
    });
    if (!candidate) continue;
    if (seenWorkspaces.has(candidate.workspace)) continue;
    seenWorkspaces.add(candidate.workspace);
    entries.push(candidate);
  }

  return entries;
}

function buildSuggestedAgentBrowserDisplay(candidate) {
  const agentName = String(candidate.agentName ?? "").trim();
  const agentId = String(candidate.agentId ?? "").trim();
  const identity = agentName || agentId || path.basename(String(candidate.workspace ?? "").trim());
  return `agent-browser · ${identity} · session=${candidate.agentBrowserSession}`;
}

function formatAgentBrowserTarget({ session, profile, fallback = "agent-browser" }) {
  const trimmedSession = String(session ?? "").trim();
  const trimmedProfile = String(profile ?? "").trim();
  if (trimmedSession && trimmedProfile) {
    return `agent-browser session "${trimmedSession}" using profile ${trimmedProfile}`;
  }
  if (trimmedSession) {
    return `agent-browser session "${trimmedSession}"`;
  }
  if (trimmedProfile) {
    return `agent-browser profile ${trimmedProfile}`;
  }
  return fallback;
}

function describeSuggestedAgentBrowserSource(candidate, label) {
  const normalizedLabel = normalizeLabel(label);
  const agentId = String(candidate?.agentId ?? "").trim() || "unknown-agent";
  const configPath = String(candidate?.configPath ?? "").trim();
  if (candidate?.source === "openclaw-binding") {
    return `AIM found it from exact OpenClaw binding ${normalizedLabel} -> ${agentId}${configPath ? ` in ${configPath}` : ""}.`;
  }
  if (candidate?.source === "workspace-session-match") {
    return `AIM found it because session "${candidate.agentBrowserSession}" exactly matches ${normalizedLabel}${configPath ? ` in ${configPath}` : ""}.`;
  }
  if (candidate?.source === "workspace-profile-match") {
    return `AIM found it because profile "${path.basename(candidate.agentBrowserProfile)}" exactly matches ${normalizedLabel}${configPath ? ` in ${configPath}` : ""}.`;
  }
  return configPath ? `AIM found it in ${configPath}.` : "AIM found it from repo browser config.";
}

function buildSuggestedAgentBrowserDetails(candidate, { label, prefix = "Will use" } = {}) {
  if (!candidate) return [];
  const target = formatAgentBrowserTarget({
    session: candidate.agentBrowserSession,
    profile: candidate.agentBrowserProfile,
  });
  return [
    `${prefix} ${target}.`,
    describeSuggestedAgentBrowserSource(candidate, label),
  ];
}

export function discoverSuggestedBrowserBindings({
  label,
  repoRoot,
  bindings,
  agentsList,
}) {
  const normalizedLabel = normalizeLabel(label);
  const labelToken = normalizeDiscoveryToken(normalizedLabel);
  const agentPrefixedToken = normalizeDiscoveryToken(`agent-${normalizedLabel}`);
  const bindingList = Array.isArray(bindings) ? bindings : [];
  const agentBrowserConfigs = readRepoAgentBrowserConfigs({ repoRoot, agentsList });
  const matchedBindingsByAgentId = new Map();

  for (const binding of bindingList) {
    if (!isObject(binding)) continue;
    if (String(binding?.match?.channel ?? "").trim() !== "slack") continue;
    const accountId = String(binding?.match?.accountId ?? "").trim();
    const agentId = String(binding?.agentId ?? "").trim();
    if (!agentId) continue;
    if (normalizeDiscoveryToken(accountId) === labelToken) {
      matchedBindingsByAgentId.set(agentId, binding);
    }
  }

  const deduped = new Map();
  for (const candidate of agentBrowserConfigs) {
    const sessionToken = normalizeDiscoveryToken(candidate.agentBrowserSession);
    const profileToken = normalizeDiscoveryToken(path.basename(candidate.agentBrowserProfile));
    let source = null;
    let confidence = null;
    let rank = null;

    if (matchedBindingsByAgentId.has(candidate.agentId)) {
      source = "openclaw-binding";
      confidence = "strong";
      rank = 0;
    } else if (sessionToken === labelToken || sessionToken === agentPrefixedToken) {
      source = "workspace-session-match";
      confidence = "secondary";
      rank = 1;
    } else if (profileToken === labelToken || profileToken === agentPrefixedToken) {
      source = "workspace-profile-match";
      confidence = "secondary";
      rank = 2;
    }

    if (!source) continue;

    const key = `${candidate.agentBrowserProfile}\u0000${candidate.agentBrowserSession}`;
    const existing = deduped.get(key);
    const next = {
      mode: BROWSER_MODE_AGENT_BROWSER,
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      workspace: candidate.workspace,
      configPath: candidate.configPath,
      agentBrowserProfile: candidate.agentBrowserProfile,
      agentBrowserSession: candidate.agentBrowserSession,
      source,
      confidence,
      rank,
      display: buildSuggestedAgentBrowserDisplay(candidate),
    };
    if (!existing || next.rank < existing.rank || (next.rank === existing.rank && next.agentId.localeCompare(existing.agentId) < 0)) {
      deduped.set(key, next);
    }
  }

  return [...deduped.values()].toSorted((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.agentId.localeCompare(b.agentId);
  });
}

function getAccountRecord(state, label, { create = false } = {}) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const existing = state.accounts[normalizedLabel];
  if (isObject(existing)) {
    return existing;
  }
  if (!create) return null;
  state.accounts[normalizedLabel] = {};
  return state.accounts[normalizedLabel];
}

function getAccountBrowserState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  if (create && !isObject(account.browser)) {
    account.browser = {};
  }
  return account.browser;
}

function getAccountReauthState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  return account.reauth;
}

function getAccountPoolState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  return account.pool;
}

function normalizeInteractiveOAuthMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === REAUTH_MODE_BROWSER_MANAGED) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (raw === REAUTH_MODE_MANUAL_CALLBACK) {
    return REAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
}

export function normalizeBrowserBindingMode(value) {
  const raw = String(value ?? "").trim().toLowerCase().replace(/_/g, "-");
  if (!raw) return null;
  if (raw === "1" || raw === BROWSER_MODE_AIM_PROFILE || raw === "aim" || raw === "aim-profile") {
    return BROWSER_MODE_AIM_PROFILE;
  }
  if (raw === "2" || raw === BROWSER_MODE_CHROME_PROFILE || raw === "chrome" || raw === "chrome-profile") {
    return BROWSER_MODE_CHROME_PROFILE;
  }
  if (
    raw === "3"
    || raw === BROWSER_MODE_AGENT_BROWSER
    || raw === "agent"
    || raw === "agent-browser"
    || raw === "agent-browser-profile"
  ) {
    return BROWSER_MODE_AGENT_BROWSER;
  }
  return null;
}

function normalizeAbsolutePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  return path.isAbsolute(resolved) ? resolved : null;
}

function browserBindingNeedsMode(browser) {
  return (
    typeof browser?.seededFromOpenclawProfileId === "string"
    || typeof browser?.seededFrom === "string"
    || typeof browser?.seededAt === "string"
    || typeof browser?.verifiedAt === "string"
    || typeof browser?.conflictReason === "string"
  );
}

function ensureAccountShape(account, { providerHint } = {}) {
  const nextProvider =
    normalizeProviderId(account?.provider ?? providerHint ?? OPENAI_CODEX_PROVIDER) || OPENAI_CODEX_PROVIDER;
  account.provider = nextProvider;
  account.expect = isObject(account.expect) ? account.expect : {};

  const rawBrowser = isObject(account.browser) ? account.browser : null;
  const normalizedMode = normalizeBrowserBindingMode(rawBrowser?.mode)
    || (rawBrowser && browserBindingNeedsMode(rawBrowser) ? BROWSER_MODE_AIM_PROFILE : null);
  const seededFromOpenclawProfileId =
    typeof rawBrowser?.seededFromOpenclawProfileId === "string" && rawBrowser.seededFromOpenclawProfileId.trim()
      ? rawBrowser.seededFromOpenclawProfileId.trim()
      : typeof rawBrowser?.seededFrom === "string" && rawBrowser.seededFrom.trim()
        ? rawBrowser.seededFrom.trim()
        : null;
  const seededAt = typeof rawBrowser?.seededAt === "string" && rawBrowser.seededAt.trim() ? rawBrowser.seededAt.trim() : null;
  const verifiedAt =
    typeof rawBrowser?.verifiedAt === "string" && rawBrowser.verifiedAt.trim() ? rawBrowser.verifiedAt.trim() : null;
  const conflictReason =
    typeof rawBrowser?.conflictReason === "string" && rawBrowser.conflictReason.trim()
      ? rawBrowser.conflictReason.trim()
      : null;
  const userDataDir =
    normalizedMode === BROWSER_MODE_CHROME_PROFILE && typeof rawBrowser?.userDataDir === "string" && rawBrowser.userDataDir.trim()
      ? path.resolve(rawBrowser.userDataDir.trim())
      : null;
  const chromeProfileDirectory =
    normalizedMode === BROWSER_MODE_CHROME_PROFILE
    && typeof rawBrowser?.profileDirectory === "string"
    && rawBrowser.profileDirectory.trim()
      ? rawBrowser.profileDirectory.trim()
      : null;
  const agentBrowserProfile =
    normalizedMode === BROWSER_MODE_AGENT_BROWSER
    && typeof rawBrowser?.agentBrowserProfile === "string"
    && rawBrowser.agentBrowserProfile.trim()
      ? path.resolve(rawBrowser.agentBrowserProfile.trim())
      : null;
  const agentBrowserSession =
    normalizedMode === BROWSER_MODE_AGENT_BROWSER
    && typeof rawBrowser?.agentBrowserSession === "string"
    && rawBrowser.agentBrowserSession.trim()
      ? rawBrowser.agentBrowserSession.trim()
      : null;
  account.browser =
    normalizeInteractiveOAuthMode(account?.reauth?.mode) === REAUTH_MODE_MANUAL_CALLBACK
      ? null
      : normalizedMode || seededFromOpenclawProfileId || seededAt || verifiedAt || conflictReason
        ? {
            ...(normalizedMode ? { mode: normalizedMode } : {}),
            ...(userDataDir ? { userDataDir } : {}),
            ...(chromeProfileDirectory ? { profileDirectory: chromeProfileDirectory } : {}),
            ...(agentBrowserProfile ? { agentBrowserProfile } : {}),
            ...(agentBrowserSession ? { agentBrowserSession } : {}),
            ...(seededFromOpenclawProfileId ? { seededFromOpenclawProfileId } : {}),
            ...(seededAt ? { seededAt } : {}),
            ...(verifiedAt ? { verifiedAt } : {}),
            ...(conflictReason ? { conflictReason } : {}),
          }
        : null;

  const reauth = isObject(account.reauth) ? account.reauth : {};
  const reauthMode = normalizeInteractiveOAuthMode(reauth.mode);
  account.reauth = {
    ...(reauthMode ? { mode: reauthMode } : {}),
    ...(typeof reauth.lastAttemptAt === "string" && reauth.lastAttemptAt.trim()
      ? { lastAttemptAt: reauth.lastAttemptAt.trim() }
      : {}),
    ...(typeof reauth.lastVerifiedAt === "string" && reauth.lastVerifiedAt.trim()
      ? { lastVerifiedAt: reauth.lastVerifiedAt.trim() }
      : {}),
    ...(typeof reauth.blockedReason === "string" && reauth.blockedReason.trim()
      ? { blockedReason: reauth.blockedReason.trim() }
      : {}),
  };

  const pool = isObject(account.pool) ? account.pool : {};
  account.pool = {
    enabled: pool.enabled !== false,
    ...(typeof pool.disabledReason === "string" && pool.disabledReason.trim()
      ? { disabledReason: pool.disabledReason.trim() }
      : {}),
    ...(typeof pool.disabledAt === "string" && pool.disabledAt.trim() ? { disabledAt: pool.disabledAt.trim() } : {}),
  };
}

// Browser substrate is configurable per label, but the binding itself is explicit AIM state.
// Do not infer from agent workspaces, agent ids, or the implicit default agent-browser session.
export function resolveBrowserBinding({ account, homeDir, label }) {
  const normalizedAccount = isObject(account) ? account : {};
  const reauthMode = normalizeInteractiveOAuthMode(normalizedAccount?.reauth?.mode);
  if (reauthMode !== REAUTH_MODE_BROWSER_MANAGED) {
    return null;
  }

  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : null;
  const mode = normalizeBrowserBindingMode(browser?.mode);
  if (!mode) {
    return null;
  }

  if (mode === BROWSER_MODE_AIM_PROFILE) {
    return {
      mode,
      ...(homeDir && label ? { userDataDir: resolveAimBrowserUserDataDir({ homeDir, label }) } : {}),
    };
  }

  if (mode === BROWSER_MODE_CHROME_PROFILE) {
    return {
      mode,
      userDataDir: String(browser?.userDataDir ?? "").trim(),
      ...(normalizeChromeProfileDirectory(browser?.profileDirectory)
        ? { profileDirectory: normalizeChromeProfileDirectory(browser?.profileDirectory) }
        : {}),
    };
  }

  if (mode === BROWSER_MODE_AGENT_BROWSER) {
    return {
      mode,
      agentBrowserProfile: String(browser?.agentBrowserProfile ?? "").trim(),
      agentBrowserSession: String(browser?.agentBrowserSession ?? "").trim(),
    };
  }

  return null;
}

function resolveBrowserBindingDisplay(binding) {
  if (!binding) return null;
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return {
      mode: binding.mode,
      agentBrowserProfile: binding.agentBrowserProfile,
      agentBrowserSession: binding.agentBrowserSession,
    };
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE || binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return {
      mode: binding.mode,
      ...(binding.userDataDir ? { userDataDir: binding.userDataDir } : {}),
      ...(binding.profileDirectory ? { profileDirectory: binding.profileDirectory } : {}),
    };
  }
  return { mode: binding.mode };
}

export function setBrowserBinding({
  state,
  label,
  mode,
  userDataDir,
  profileDirectory,
  agentBrowserProfile,
  agentBrowserSession,
  seedFromOpenclaw,
}) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: account.provider });

  const normalizedMode = String(mode ?? "").trim() === REAUTH_MODE_MANUAL_CALLBACK
    ? REAUTH_MODE_MANUAL_CALLBACK
    : normalizeBrowserBindingMode(mode);
  if (!normalizedMode) {
    throw new Error(
      `Unsupported browser mode for label=${normalizedLabel}: ${String(mode ?? "").trim() || "(missing)"}.`,
    );
  }

  const previous = JSON.stringify({
    reauth: account.reauth,
    browser: account.browser,
  });

  if (normalizedMode === REAUTH_MODE_MANUAL_CALLBACK) {
    account.reauth.mode = REAUTH_MODE_MANUAL_CALLBACK;
    account.browser = null;
    return { label: normalizedLabel, mode: normalizedMode, changed: previous !== JSON.stringify({ reauth: account.reauth, browser: account.browser }), warnings: [] };
  }

  const nextBrowser = { mode: normalizedMode };
  if (normalizedMode === BROWSER_MODE_AIM_PROFILE) {
    if (seedFromOpenclaw) {
      nextBrowser.seededFromOpenclawProfileId = String(seedFromOpenclaw).trim();
    }
  } else if (normalizedMode === BROWSER_MODE_CHROME_PROFILE) {
    const resolvedUserDataDir = normalizeAbsolutePath(userDataDir);
    if (!resolvedUserDataDir || !isAbsoluteExistingDirectory(resolvedUserDataDir)) {
      throw new Error(
        `Mapped Chrome profile for label=${normalizedLabel} requires an existing absolute --user-data-dir (got ${String(userDataDir ?? "").trim() || "(missing)"}).`,
      );
    }
    nextBrowser.userDataDir = resolvedUserDataDir;
    if (normalizeChromeProfileDirectory(profileDirectory)) {
      nextBrowser.profileDirectory = normalizeChromeProfileDirectory(profileDirectory);
    }
  } else if (normalizedMode === BROWSER_MODE_AGENT_BROWSER) {
    const resolvedProfile = normalizeAbsolutePath(agentBrowserProfile);
    const resolvedSession = String(agentBrowserSession ?? "").trim();
    if (!resolvedProfile || !isAbsoluteExistingDirectory(resolvedProfile)) {
      throw new Error(
        `Mapped agent-browser profile for label=${normalizedLabel} requires an existing absolute --profile (got ${String(agentBrowserProfile ?? "").trim() || "(missing)"}).`,
      );
    }
    if (!resolvedSession) {
      throw new Error(`Mapped agent-browser profile for label=${normalizedLabel} requires --session.`);
    }
    nextBrowser.agentBrowserProfile = resolvedProfile;
    nextBrowser.agentBrowserSession = resolvedSession;
  }

  if (typeof account.browser?.verifiedAt === "string" && account.browser.verifiedAt.trim()) {
    nextBrowser.verifiedAt = account.browser.verifiedAt.trim();
  }
  if (typeof account.browser?.seededAt === "string" && account.browser.seededAt.trim()) {
    nextBrowser.seededAt = account.browser.seededAt.trim();
  }
  if (typeof account.browser?.conflictReason === "string" && account.browser.conflictReason.trim()) {
    nextBrowser.conflictReason = account.browser.conflictReason.trim();
  }
  if (
    normalizedMode === BROWSER_MODE_AIM_PROFILE
    && !nextBrowser.seededFromOpenclawProfileId
    && typeof account.browser?.seededFromOpenclawProfileId === "string"
    && account.browser.seededFromOpenclawProfileId.trim()
  ) {
    nextBrowser.seededFromOpenclawProfileId = account.browser.seededFromOpenclawProfileId.trim();
  }

  account.reauth.mode = REAUTH_MODE_BROWSER_MANAGED;
  account.browser = nextBrowser;
  ensureAccountShape(account, { providerHint: account.provider });
  return {
    label: normalizedLabel,
    mode: normalizedMode,
    changed: previous !== JSON.stringify({ reauth: account.reauth, browser: account.browser }),
    warnings: [],
  };
}

export function showBrowserBinding({ state, label, homeDir }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel);
  if (!account) {
    throw new Error(`Unknown label: ${normalizedLabel}.`);
  }
  const reauthMode = normalizeInteractiveOAuthMode(account?.reauth?.mode);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const warnings = [];
  if (reauthMode === REAUTH_MODE_BROWSER_MANAGED && !binding) {
    warnings.push({ reason: "binding_missing_for_future_reauth" });
  }
  return {
    label: normalizedLabel,
    reauthMode: reauthMode ?? null,
    binding: binding
      ? (binding.mode === BROWSER_MODE_AGENT_BROWSER
        ? {
            mode: binding.mode,
            profile: binding.agentBrowserProfile,
            session: binding.agentBrowserSession,
          }
        : {
            mode: binding.mode,
            ...(binding.userDataDir ? { userDataDir: binding.userDataDir } : {}),
            ...(binding.profileDirectory ? { profileDirectory: binding.profileDirectory } : {}),
          })
      : null,
    resolvedPaths:
      binding?.mode === BROWSER_MODE_AGENT_BROWSER
        ? {
            agentBrowserProfile: binding.agentBrowserProfile,
          }
        : binding?.userDataDir
          ? { userDataDir: binding.userDataDir }
          : null,
    warnings,
  };
}

function resolveBrowserFactsPath(binding) {
  if (!binding) return null;
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return String(binding.agentBrowserProfile ?? "").trim() || null;
  }
  if (binding.mode === BROWSER_MODE_AIM_PROFILE || binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    return String(binding.userDataDir ?? "").trim() || null;
  }
  return null;
}

function readBrowserFacts({ account, homeDir, label }) {
  const normalizedLabel = normalizeLabel(label);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const browserPath = resolveBrowserFactsPath(binding);
  if (!binding || !browserPath) {
    return {
      label: normalizedLabel,
      bindingPresent: false,
      exists: false,
      mode: null,
      userDataDir: null,
      name: null,
      userName: null,
      gaiaName: null,
    };
  }

  if (!fs.existsSync(browserPath)) {
    return {
      label: normalizedLabel,
      bindingPresent: true,
      exists: false,
      mode: binding.mode,
      userDataDir: browserPath,
      ...(binding.mode === BROWSER_MODE_CHROME_PROFILE && binding.profileDirectory
        ? { profileDirectory: binding.profileDirectory }
        : {}),
      name: null,
      userName: null,
      gaiaName: null,
      ...(binding.mode === BROWSER_MODE_AGENT_BROWSER
        ? { agentBrowserSession: binding.agentBrowserSession || null }
        : {}),
    };
  }

  const info =
    binding.mode === BROWSER_MODE_CHROME_PROFILE
      ? readChromeProfileInfoFromLocalState(
          resolveChromeLocalStatePath(browserPath),
          normalizeChromeProfileDirectory(binding.profileDirectory) || "Default",
        )
      : readChromeDefaultProfileInfoFromLocalState(resolveChromeLocalStatePath(browserPath));
  const name = typeof info?.name === "string" ? String(info.name).trim() : "";
  const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
  const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";
  return {
    label: normalizedLabel,
    bindingPresent: true,
    exists: true,
    mode: binding.mode,
    userDataDir: browserPath,
    ...(binding.mode === BROWSER_MODE_CHROME_PROFILE && binding.profileDirectory
      ? { profileDirectory: binding.profileDirectory }
      : {}),
    name: name || null,
    userName: userName || null,
    gaiaName: gaiaName || null,
    ...(binding.mode === BROWSER_MODE_AGENT_BROWSER
      ? { agentBrowserSession: binding.agentBrowserSession || null }
      : {}),
  };
}

export function launchBrowserBindingForUrl({ binding, url, homeDir, spawnImpl = spawnSync }) {
  const resolvedBinding = isObject(binding) ? binding : null;
  if (!resolvedBinding) {
    return { ok: false, reason: "missing_binding" };
  }
  if (resolvedBinding.mode === BROWSER_MODE_AIM_PROFILE || resolvedBinding.mode === BROWSER_MODE_CHROME_PROFILE) {
    const userDataDir = String(resolvedBinding.userDataDir ?? "").trim();
    const profileDirectory = normalizeChromeProfileDirectory(resolvedBinding.profileDirectory);
    if (!userDataDir) {
      return { ok: false, reason: "missing_user_data_dir" };
    }
    if (!fs.existsSync(userDataDir)) {
      return { ok: false, reason: "missing_browser_path", path: userDataDir };
    }
    return openChromeUserDataDirForUrl({ url, userDataDir, profileDirectory, spawnImpl });
  }
  if (resolvedBinding.mode === BROWSER_MODE_AGENT_BROWSER) {
    const profile = String(resolvedBinding.agentBrowserProfile ?? "").trim();
    const session = String(resolvedBinding.agentBrowserSession ?? "").trim();
    if (!profile) {
      return { ok: false, reason: "missing_agent_browser_profile" };
    }
    if (!fs.existsSync(profile)) {
      return { ok: false, reason: "missing_browser_path", path: profile };
    }
    if (!session) {
      return { ok: false, reason: "missing_agent_browser_session" };
    }
    return spawnAgentBrowserOpen({
      url,
      profile,
      session,
      cwd: homeDir,
      spawnImpl,
    });
  }
  return { ok: false, reason: "unsupported_binding_mode" };
}

async function promptLine(message, { defaultValue } = {}) {
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot prompt for input (stdin is not a TTY). Needed: ${message}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await rl.question(`${message.trim()} `);
      const value = String(answer ?? "").trim();
      if (value.length > 0) return value;
      if (defaultValue !== undefined) return String(defaultValue);
    }
  } finally {
    rl.close();
  }
}

async function promptRequiredLine(message) {
  if (!process.stdin.isTTY) {
    throw new Error(`Cannot prompt for input (stdin is not a TTY). Needed: ${message}`);
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await rl.question(`${message.trim()} `);
      const value = String(answer ?? "").trim();
      if (value.length > 0) return value;
    }
  } finally {
    rl.close();
  }
}

function formatMenuPromptSuffix(options) {
  const keys = (Array.isArray(options) ? options : [])
    .map((option) => String(option?.key ?? "").trim())
    .filter(Boolean);
  if (keys.length === 0) return "";
  const numeric = keys.every((key) => /^\d+$/.test(key));
  if (!numeric) {
    return ` (${keys.join("/")})`;
  }
  const sorted = keys.map((key) => Number(key)).toSorted((a, b) => a - b);
  const contiguous = sorted.every((value, index) => index === 0 || value === sorted[index - 1] + 1);
  if (contiguous) {
    return ` (${sorted[0]}-${sorted[sorted.length - 1]})`;
  }
  return ` (${sorted.join("/")})`;
}

async function promptMenuChoice({ title, options, prompt = "Choose:", promptLineImpl = promptLine }) {
  const normalizedOptions = Array.isArray(options) ? options.filter(Boolean) : [];
  if (title) {
    process.stdout.write(`${title}\n`);
  }
  for (const option of normalizedOptions) {
    process.stdout.write(`  ${option.key}. ${option.label}\n`);
    const details = Array.isArray(option.details)
      ? option.details
      : typeof option.details === "string" && option.details.trim()
        ? [option.details.trim()]
        : [];
    for (const detail of details) {
      process.stdout.write(`     ${detail}\n`);
    }
  }
  process.stdout.write("\n");

  const validKeys = new Set(normalizedOptions.map((option) => String(option.key)));
  const suffix = formatMenuPromptSuffix(normalizedOptions);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const answer = await promptLineImpl(`${prompt}${suffix}`);
    const choice = String(answer ?? "").trim();
    if (validKeys.has(choice)) {
      return choice;
    }
    process.stdout.write(`Invalid choice: "${choice}". Try again.\n`);
  }
}

function resolveOpenAICodexInteractiveLoginModeFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw === "1") return REAUTH_MODE_BROWSER_MANAGED;
  if (raw === "2") return REAUTH_MODE_MANUAL_CALLBACK;

  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (
    normalized === "browser" ||
    normalized === "browser-managed" ||
    normalized === "aim" ||
    normalized === "aim-browser" ||
    normalized === "aim-browser-profile" ||
    normalized === "openclaw" ||
    normalized === "openclaw-browser" ||
    normalized === "openclaw-browser-profile"
  ) {
    return REAUTH_MODE_BROWSER_MANAGED;
  }
  if (
    normalized === "manual" ||
    normalized === "callback" ||
    normalized === "manual-callback" ||
    normalized === "external-browser"
  ) {
    return REAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
}

function resolveBrowserModeSelectionFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw === "1") return BROWSER_MODE_AIM_PROFILE;
  if (raw === "2") return BROWSER_MODE_CHROME_PROFILE;
  if (raw === "3") return BROWSER_MODE_AGENT_BROWSER;
  return normalizeBrowserBindingMode(raw);
}

function resolveSupportedProviderFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (raw === "1") return OPENAI_CODEX_PROVIDER;
  if (raw === "2") return ANTHROPIC_PROVIDER;

  const normalized = normalizeProviderId(raw);
  if (normalized === "codex") return OPENAI_CODEX_PROVIDER;
  if (normalized === "claude") return ANTHROPIC_PROVIDER;

  return SUPPORTED_OAUTH_PROVIDERS.has(normalized) ? normalized : null;
}

async function ensureProviderConfiguredForLabel({ state, label, promptLineImpl = promptLine }) {
  ensureStateShape(state);
  const existing = state.accounts[label];
  const raw = typeof existing?.provider === "string" ? existing.provider.trim() : "";
  const normalized = raw ? normalizeProviderId(raw) : "";
  if (normalized && SUPPORTED_OAUTH_PROVIDERS.has(normalized)) {
    return normalized;
  }

  process.stdout.write(`No provider configured for label "${label}" yet.\n`);
  process.stdout.write("Pick provider:\n");
  process.stdout.write(`  1) ${OPENAI_CODEX_PROVIDER} — ${SUPPORTED_OAUTH_PROVIDERS.get(OPENAI_CODEX_PROVIDER).name}\n`);
  process.stdout.write(`  2) ${ANTHROPIC_PROVIDER} — ${SUPPORTED_OAUTH_PROVIDERS.get(ANTHROPIC_PROVIDER).name}\n`);
  process.stdout.write("\n");

  // Default to OpenAI Codex to preserve the common fast path: "aim boss" → press Enter → continue.
  // If you want Claude Max, type "2" or "anthropic".
  const answer = await promptLineImpl(`Provider for "${label}" (1-2 or id) [1]:`, { defaultValue: "1" });
  const provider = resolveSupportedProviderFromInput(answer);
  if (!provider) {
    throw new Error(`Unsupported provider selection: ${answer}`);
  }

  state.accounts[label] = {
    ...(isObject(existing) ? existing : {}),
    provider,
  };

  return provider;
}

export function parseAnthropicAuthorizationPaste(input) {
  const raw = String(input ?? "").trim();
  if (!raw) {
    throw new Error("Missing Anthropic callback input.");
  }

  // Accept a full callback URL (preferred UX).
  try {
    const url = new URL(raw);
    const code = url.searchParams.get("code");
    const state = url.searchParams.get("state");
    if (code && state) return `${code}#${state}`;
  } catch {
    // not a URL
  }

  // Accept the raw library format.
  if (raw.includes("#")) {
    const [code, state] = raw.split("#", 2);
    if (code && state) return `${code}#${state}`;
  }

  // Accept "code=...&state=..." (or "?code=...&state=...").
  if (raw.includes("code=") && raw.includes("state=")) {
    const query = raw.startsWith("?") ? raw.slice(1) : raw;
    const params = new URLSearchParams(query);
    const code = params.get("code");
    const state = params.get("state");
    if (code && state) return `${code}#${state}`;
  }

  throw new Error(
    "Invalid Anthropic callback input. Paste the full callback URL from your browser address bar " +
      '(looks like "https://console.anthropic.com/oauth/code/callback?code=...&state=..."), or paste "code#state".',
  );
}

function ensureStateShape(state) {
  // Durable SSOT lives on account records plus the pooled target blocks below.
  state.schemaVersion = SCHEMA_VERSION;
  state.accounts = isObject(state.accounts) ? state.accounts : {};
  state.credentials = isObject(state.credentials) ? state.credentials : {};
  state.credentials[OPENAI_CODEX_PROVIDER] = isObject(state.credentials[OPENAI_CODEX_PROVIDER])
    ? state.credentials[OPENAI_CODEX_PROVIDER]
    : {};
  state.credentials[ANTHROPIC_PROVIDER] = isObject(state.credentials[ANTHROPIC_PROVIDER])
    ? state.credentials[ANTHROPIC_PROVIDER]
    : {};
  state.imports = isObject(state.imports) ? state.imports : {};
  state.imports.authority = isObject(state.imports.authority) ? state.imports.authority : {};
  state.imports.authority.codex = isObject(state.imports.authority.codex) ? state.imports.authority.codex : {};
  state.pool = isObject(state.pool) ? state.pool : {};
  state.pool.openaiCodex = isObject(state.pool.openaiCodex) ? state.pool.openaiCodex : {};
  state.pool.openaiCodex.history = pruneOpenaiCodexHistory(state.pool.openaiCodex.history);
  state.pool.openaiCodex.agentDemand = pruneOpenaiCodexAgentDemand(state.pool.openaiCodex.agentDemand);
  state.targets = isObject(state.targets) ? state.targets : {};
  state.targets.openclaw = isObject(state.targets.openclaw) ? state.targets.openclaw : {};
  state.targets.openclaw.assignments = isObject(state.targets.openclaw.assignments)
    ? state.targets.openclaw.assignments
    : {};
  state.targets.openclaw.exclusions = isObject(state.targets.openclaw.exclusions)
    ? state.targets.openclaw.exclusions
    : {};
  state.targets.codexCli = isObject(state.targets.codexCli) ? state.targets.codexCli : {};

  const legacyPins = isObject(state.pins?.openclaw) ? state.pins.openclaw : null;
  if (legacyPins) {
    for (const [agentId, label] of Object.entries(legacyPins)) {
      if (typeof label !== "string") continue;
      if (!Object.hasOwn(state.targets.openclaw.assignments, agentId)) {
        state.targets.openclaw.assignments[agentId] = label;
      }
    }
  }
  if (Object.hasOwn(state, "pins")) {
    delete state.pins;
  }

  const legacyAssignments = isObject(state.targets.openclaw.pins) ? state.targets.openclaw.pins : {};
  for (const [agentId, label] of Object.entries(legacyAssignments)) {
    if (typeof label !== "string") continue;
    if (!Object.hasOwn(state.targets.openclaw.assignments, agentId)) {
      state.targets.openclaw.assignments[agentId] = normalizeLabel(label);
    }
  }

  const legacyBrowserProfiles = isObject(state.targets.openclaw.browserProfiles) ? state.targets.openclaw.browserProfiles : {};
  const legacyBindings = isObject(state.targets.interactiveOAuth?.bindings) ? state.targets.interactiveOAuth.bindings : {};

  for (const [label, account] of Object.entries(state.accounts)) {
    if (!isObject(account)) continue;
    const browserProfile =
      typeof account.openclawBrowserProfile === "string" ? account.openclawBrowserProfile.trim() : "";
    const legacyBinding = legacyBindings[label];
    const legacyBindingMode = normalizeInteractiveOAuthMode(legacyBinding?.mode);
    const legacyBindingProfileId =
      typeof legacyBinding?.profileId === "string" ? legacyBinding.profileId.trim() : "";
    const legacyChromeProfileDirectory =
      typeof account.chromeProfileDirectory === "string" ? account.chromeProfileDirectory.trim() : "";
    const existingReauthRaw = String(account?.reauth?.mode ?? "").trim().toLowerCase();
    const existingReauthMode = normalizeInteractiveOAuthMode(existingReauthRaw);

    if (!isObject(account.browser)) {
      account.browser = account.browser === null ? null : {};
    }
    if (!isObject(account.reauth)) {
      account.reauth = {};
    }
    if (!isObject(account.pool)) {
      account.pool = {};
    }

    const migrationSource =
      browserProfile
      || (typeof legacyBrowserProfiles[label] === "string" ? legacyBrowserProfiles[label].trim() : "")
      || legacyBindingProfileId;
    if (!isObject(account.browser) && (migrationSource || legacyChromeProfileDirectory || existingReauthRaw)) {
      account.browser = {};
    }
    if (migrationSource && !account.browser.seededFromOpenclawProfileId) {
      account.browser.seededFromOpenclawProfileId = migrationSource;
    }
    if (legacyChromeProfileDirectory && !account.browser.userDataDir) {
      account.browser.userDataDir = legacyChromeProfileDirectory;
    }
    if (
      isObject(account.browser)
      && !account.browser.mode
      && (
        legacyChromeProfileDirectory
        || migrationSource
        || existingReauthRaw === LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE
        || existingReauthRaw === LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE
      )
    ) {
      account.browser.mode = legacyChromeProfileDirectory ? BROWSER_MODE_CHROME_PROFILE : BROWSER_MODE_AIM_PROFILE;
    }
    if (!account.reauth.mode && (legacyBindingMode || migrationSource || legacyChromeProfileDirectory)) {
      account.reauth.mode =
        legacyBindingMode === REAUTH_MODE_MANUAL_CALLBACK
          ? REAUTH_MODE_MANUAL_CALLBACK
          : REAUTH_MODE_BROWSER_MANAGED;
    } else if (existingReauthMode) {
      account.reauth.mode = existingReauthMode;
    }
    ensureAccountShape(account, { providerHint: account.provider });

    if (Object.hasOwn(account, "openclawBrowserProfile")) {
      delete account.openclawBrowserProfile;
    }
    if (Object.hasOwn(account, "chromeProfileDirectory")) {
      delete account.chromeProfileDirectory;
    }
  }
  if (Object.hasOwn(state.targets.openclaw, "pins")) {
    delete state.targets.openclaw.pins;
  }
  if (Object.hasOwn(state.targets.openclaw, "browserProfiles")) {
    delete state.targets.openclaw.browserProfiles;
  }
  if (isObject(state.targets.interactiveOAuth)) {
    delete state.targets.interactiveOAuth;
  }

  if (Object.hasOwn(state.targets.codexCli, "storeMode")) {
    delete state.targets.codexCli.storeMode;
  }
  if (Object.hasOwn(state.targets.codexCli, "lastReadback")) {
    delete state.targets.codexCli.lastReadback;
  }
}

function getAuthorityCodexImport(state) {
  ensureStateShape(state);
  return state.imports.authority.codex;
}

function getOpenclawTargetState(state) {
  ensureStateShape(state);
  return state.targets.openclaw;
}

function getOpenclawAgentDemandState(state) {
  ensureStateShape(state);
  return state.pool.openaiCodex.agentDemand;
}

function getOpenclawAssignments(state) {
  return getOpenclawTargetState(state).assignments;
}

function getOpenclawPins(state) {
  return getOpenclawAssignments(state);
}

function getOpenclawExclusions(state) {
  return getOpenclawTargetState(state).exclusions;
}

function discoverStatusConfiguredOpenclawCodexAgents(state) {
  const exclusions = getOpenclawExclusions(state);
  const demandAgents = Object.keys(getOpenclawAgentDemandState(state) ?? {});
  const assignmentAgents = Object.entries(getOpenclawAssignments(state) ?? {})
    .filter(([, labelRaw]) => {
      if (typeof labelRaw !== "string") return false;
      const label = normalizeLabel(labelRaw);
      return normalizeProviderId(getAccountRecord(state, label)?.provider) === OPENAI_CODEX_PROVIDER;
    })
    .map(([agentIdRaw]) => normalizeAgentId(agentIdRaw));

  return [...new Set([...demandAgents, ...assignmentAgents])]
    .filter((agentId) => !(typeof exclusions?.[agentId] === "string" && exclusions[agentId].trim()))
    .toSorted((a, b) => a.localeCompare(b));
}

export function getInteractiveOAuthBindingForLabel(state, label) {
  ensureStateShape(state);
  const reauth = getAccountReauthState(state, label);
  if (!reauth) return null;
  const mode = normalizeInteractiveOAuthMode(reauth.mode);
  const account = getAccountRecord(state, label);
  const browserBinding = resolveBrowserBinding({ account, label });
  return {
    ...(mode ? { mode } : {}),
    ...(browserBinding ? { binding: browserBinding } : {}),
  };
}

function setInteractiveOAuthBindingForLabel(state, label, binding) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const mode = normalizeInteractiveOAuthMode(binding?.mode);
  if (!mode) {
    throw new Error(`Unsupported interactive OAuth mode for label=${normalizedLabel}.`);
  }
  const reauth = getAccountReauthState(state, normalizedLabel, { create: true });
  reauth.mode = mode;
  if (mode === REAUTH_MODE_MANUAL_CALLBACK) {
    state.accounts[normalizedLabel].browser = null;
  }
}

function getCodexTargetState(state) {
  ensureStateShape(state);
  return state.targets.codexCli;
}

function isLikelyJwt(value) {
  const raw = String(value ?? "").trim();
  const parts = raw.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function getImportedCodexLabels(state) {
  const imported = getAuthorityCodexImport(state);
  const labels = Array.isArray(imported.labels) ? imported.labels : [];
  const normalized = [];
  for (const label of labels) {
    try {
      normalized.push(normalizeLabel(label));
    } catch {
      // Ignore malformed imported labels in status surfaces; import paths validate strictly.
    }
  }
  return [...new Set(normalized)].toSorted((a, b) => a.localeCompare(b));
}

function hasImportedCodexReplica(state) {
  return getImportedCodexLabels(state).length > 0;
}

function resolveManagedCodexHomeDir({ homeDir }) {
  const override = String(process.env.CODEX_HOME ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(homeDir, ".codex");
}

function resolveCodexAuthFilePath(codexHome) {
  return path.join(codexHome, "auth.json");
}

function resolveCodexConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

function normalizeCodexStoreMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === CODEX_AUTH_STORE_MODE_FILE) return CODEX_AUTH_STORE_MODE_FILE;
  if (raw === CODEX_AUTH_STORE_MODE_KEYRING) return CODEX_AUTH_STORE_MODE_KEYRING;
  if (raw === CODEX_AUTH_STORE_MODE_AUTO) return CODEX_AUTH_STORE_MODE_AUTO;
  return null;
}

function readCodexCliStoreMode({ codexHome }) {
  const configPath = resolveCodexConfigPath(codexHome);
  if (!fs.existsSync(configPath)) {
    return { storeMode: CODEX_AUTH_STORE_MODE_FILE, source: "default", configPath };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/);
    if (!match) continue;
    const storeMode = normalizeCodexStoreMode(match[1]);
    if (!storeMode) {
      throw new Error(`Unsupported cli_auth_credentials_store value in ${configPath}: ${match[1]}`);
    }
    return { storeMode, source: "config", configPath };
  }

  return { storeMode: CODEX_AUTH_STORE_MODE_FILE, source: "default", configPath };
}

function ensureFileBackedCodexHome({ codexHome }) {
  const { storeMode, source, configPath } = readCodexCliStoreMode({ codexHome });
  if (storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    throw new Error(
      `Refusing to manage Codex home ${codexHome}: cli_auth_credentials_store=${storeMode} ` +
        `(${source === "config" ? configPath : "default"}). ` +
        "Managed Codex activation requires file-backed auth storage.",
    );
  }
  return { storeMode, source, configPath };
}

function readCodexAuthFile({ codexHome }) {
  const authPath = resolveCodexAuthFilePath(codexHome);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const tokens = isObject(parsed?.tokens) ? parsed.tokens : null;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath,
      accountId: accountId || null,
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath,
      error: String(err?.message ?? err),
    };
  }
}

// Codex and Paperclip both inherit this managed file-backed auth target on the host.
// If AIM cannot pick an eligible pool account, the old file and active-target metadata
// must be cleared so the previous machine account cannot survive as a hidden fallback.
function clearManagedCodexCliActivation({ state, homeDir }) {
  ensureStateShape(state);
  const codexHome = resolveManagedCodexHomeDir({ homeDir });
  const authPath = resolveCodexAuthFilePath(codexHome);
  fs.rmSync(authPath, { force: true });

  const target = getCodexTargetState(state);
  delete target.homeDir;
  delete target.activeLabel;
  delete target.expectedAccountId;
  delete target.lastAppliedAt;
}

function assertCodexCredentialShape({ label, credential, requireFresh }) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) {
    throw new Error(`Missing openai-codex credentials for label=${label}.`);
  }
  if (typeof cred.access !== "string" || !cred.access.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.access is missing.`);
  }
  if (typeof cred.refresh !== "string" || !cred.refresh.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.refresh is missing.`);
  }
  if (typeof cred.accountId !== "string" || !cred.accountId.trim()) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.accountId is missing.`);
  }
  const expiresMs = parseExpiresAtToMs(cred.expiresAt);
  if (!expiresMs) {
    throw new Error(`credentials.${OPENAI_CODEX_PROVIDER}.${label}.expiresAt is missing/invalid.`);
  }
  if (requireFresh && expiresMs <= Date.now()) {
    throw new Error(`Refusing expired openai-codex credentials for label=${label}. Sync or refresh the authority first.`);
  }
  return cred;
}

function resolveCodexIdTokenForCredential(credential) {
  const explicit = typeof credential?.idToken === "string" ? credential.idToken.trim() : "";
  if (explicit) {
    if (!isLikelyJwt(explicit)) {
      throw new Error("Stored idToken is not a JWT.");
    }
    return explicit;
  }

  const access = typeof credential?.access === "string" ? credential.access.trim() : "";
  if (isLikelyJwt(access)) {
    // `@mariozechner/pi-ai` currently gives AIM only access/refresh/accountId for OpenAI Codex.
    // Codex auth.json still requires a JWT-shaped `id_token`, and Codex preserves the existing
    // id_token on refreshes that do not return a new one, so v1 seeds that field from the same
    // access JWT claims carrier instead of inventing a second credential source.
    return access;
  }

  throw new Error(
    "Refusing to build Codex auth.json without a JWT-capable id token source. " +
      "Current AIM credentials only include access/refresh data for this label.",
  );
}

function buildCodexAuthDotJson({ credential, lastRefreshAt }) {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: resolveCodexIdTokenForCredential(credential),
      access_token: credential.access,
      refresh_token: credential.refresh,
      account_id: credential.accountId,
    },
    last_refresh: String(lastRefreshAt ?? new Date().toISOString()),
  };
}

function findCodexLabelByAccountId(state, accountId) {
  ensureStateShape(state);
  const targetAccountId = String(accountId ?? "").trim();
  if (!targetAccountId) return null;
  for (const [label, cred] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    if (!isObject(cred)) continue;
    if (String(cred.accountId ?? "").trim() === targetAccountId) {
      return label;
    }
  }
  return null;
}

function shellQuoteSingle(value) {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

function escapeDoubleQuotedShellFragment(value) {
  return String(value ?? "").replace(/(["\\`$])/g, "\\$1");
}

function normalizeRemoteAuthorityPath(rawPath) {
  const input = String(rawPath ?? "").trim();
  if (!input) {
    throw new Error("Authority ssh locator is missing a remote state path.");
  }
  if (input === "~") return "$HOME";
  if (input.startsWith("/~/")) return `$HOME/${input.slice(3)}`;
  if (input.startsWith("~/")) return `$HOME/${input.slice(2)}`;
  return input;
}

function buildRemoteCatCommand(remotePath) {
  if (remotePath === "$HOME") {
    return 'cat -- "$HOME"';
  }
  if (remotePath.startsWith("$HOME/")) {
    return `cat -- "$HOME/${escapeDoubleQuotedShellFragment(remotePath.slice("$HOME/".length))}"`;
  }
  return `cat -- ${shellQuoteSingle(remotePath)}`;
}

export function resolveAuthorityLocator(locator) {
  const raw = String(locator ?? "").trim();
  if (!raw) {
    throw new Error("Missing authority locator. Use: aim sync codex --from agents@amirs-mac-studio");
  }

  if (raw.startsWith("ssh://")) {
    const parsed = new URL(raw);
    if (!parsed.hostname) {
      throw new Error(`Invalid ssh authority locator: ${raw}`);
    }
    const remotePath =
      parsed.pathname && parsed.pathname !== "/"
        ? normalizeRemoteAuthorityPath(decodeURIComponent(parsed.pathname))
        : DEFAULT_AUTHORITY_STATE_REMOTE_PATH;
    return {
      kind: "ssh",
      target: parsed.username ? `${parsed.username}@${parsed.hostname}` : parsed.hostname,
      port: parsed.port ? String(parsed.port) : null,
      remotePath,
      display: raw,
    };
  }

  const bareSshTarget = raw.match(/^[^/:\s]+@[^/:\s]+$/);
  if (bareSshTarget) {
    return {
      kind: "ssh",
      target: raw,
      port: null,
      remotePath: DEFAULT_AUTHORITY_STATE_REMOTE_PATH,
      display: raw,
    };
  }

  const scpLike = raw.match(/^([^/:\s]+(?:@[^/:\s]+)?):(.+)$/);
  if (scpLike) {
    return {
      kind: "ssh",
      target: scpLike[1],
      port: null,
      remotePath: normalizeRemoteAuthorityPath(scpLike[2]),
      display: raw,
    };
  }

  return {
    kind: "file",
    path: path.resolve(raw),
    display: path.resolve(raw),
  };
}

function loadAuthorityState(locator) {
  const source = resolveAuthorityLocator(locator);
  if (source.kind === "file") {
    if (!fs.existsSync(source.path)) {
      throw new Error(`Authority AIM state file not found: ${source.path}`);
    }
    return { source, state: loadAimgrState(source.path) };
  }

  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteCatCommand(source.remotePath));
  const result = spawnSync("ssh", args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error) {
    throw new Error(`Failed to read authority AIM state via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `ssh authority read failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Authority AIM state is not valid JSON (${source.display}): ${String(err?.message ?? err)}`);
  }
  return { source, state: loadAimgrStateFromJsonValue(parsed, source.display) };
}

function buildPortableCodexCredential({ label, credential }) {
  const cred = assertCodexCredentialShape({ label, credential, requireFresh: false });
  const next = {
    access: cred.access,
    refresh: cred.refresh,
    expiresAt: cred.expiresAt,
    accountId: cred.accountId,
  };
  if (typeof cred.idToken === "string" && cred.idToken.trim()) {
    next.idToken = cred.idToken.trim();
  }
  return next;
}

function importCodexFromAuthority({ from, state, homeDir }) {
  ensureStateShape(state);
  const { source, state: authorityState } = loadAuthorityState(from);
  ensureStateShape(authorityState);

  const incomingLabels = [];
  const incomingByLabel = new Map();
  for (const [label, account] of Object.entries(authorityState.accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) continue;
    const credential = getCodexCredential(authorityState, label);
    if (!credential) {
      throw new Error(`Authority state has openai-codex label=${label} without credentials.`);
    }
    incomingLabels.push(label);
    incomingByLabel.set(label, {
      account: structuredClone(account),
      credential: buildPortableCodexCredential({ label, credential }),
    });
  }

  if (incomingLabels.length === 0) {
    throw new Error(`Authority ${source.display} has no importable ${OPENAI_CODEX_PROVIDER} labels.`);
  }

  const previousImported = new Set(getImportedCodexLabels(state));
  for (const [label, incoming] of incomingByLabel.entries()) {
    const existingAccount = state.accounts[label];
    const existingCred = getCodexCredential(state, label);
    if (!previousImported.has(label)) {
      if (isObject(existingAccount) && normalizeProviderId(existingAccount.provider) !== OPENAI_CODEX_PROVIDER) {
        throw new Error(`Refusing to overwrite non-codex label=${label} during authority import.`);
      }
      if (
        isObject(existingCred) &&
        typeof existingCred.accountId === "string" &&
        existingCred.accountId.trim() &&
        existingCred.accountId !== incoming.credential.accountId
      ) {
        throw new Error(
          `Refusing to overwrite local openai-codex label=${label} with authority accountId=${incoming.credential.accountId}.`,
        );
      }
    }
  }

  const removedLabels = [];
  for (const label of previousImported) {
    if (incomingByLabel.has(label)) continue;
    const currentTarget = readCodexCliTargetStatus({ state, homeDir });
    const removedLabelWasLiveTarget = currentTarget.activeLabel === label || currentTarget.inferredLabel === label;
    delete state.accounts[label];
    delete state.credentials[OPENAI_CODEX_PROVIDER][label];
    if (removedLabelWasLiveTarget) {
      clearManagedCodexCliActivation({ state, homeDir });
      delete state.targets.codexCli.lastSelectionReceipt;
    }
    removedLabels.push(label);
  }

  for (const [label, incoming] of incomingByLabel.entries()) {
    const existingLocal = isObject(state.accounts[label]) ? state.accounts[label] : {};
    const incomingExpect = isObject(incoming.account.expect) ? structuredClone(incoming.account.expect) : null;
    const incomingPool = isObject(incoming.account.pool) ? structuredClone(incoming.account.pool) : null;
    const incomingReauthMode = normalizeInteractiveOAuthMode(incoming.account?.reauth?.mode);
    const existingBrowser =
      existingLocal.browser === null
        ? null
        : isObject(existingLocal.browser)
          ? structuredClone(existingLocal.browser)
          : undefined;
    state.accounts[label] = {
      ...(isObject(existingLocal.reauth) ? { reauth: structuredClone(existingLocal.reauth) } : {}),
      provider: OPENAI_CODEX_PROVIDER,
      ...(existingBrowser !== undefined ? { browser: existingBrowser } : {}),
      ...(incomingExpect ? { expect: incomingExpect } : isObject(existingLocal.expect) ? { expect: structuredClone(existingLocal.expect) } : {}),
      ...(incomingPool ? { pool: incomingPool } : isObject(existingLocal.pool) ? { pool: structuredClone(existingLocal.pool) } : {}),
    };
    ensureAccountShape(state.accounts[label], { providerHint: OPENAI_CODEX_PROVIDER });
    if (incomingReauthMode) {
      state.accounts[label].reauth.mode = incomingReauthMode;
      ensureAccountShape(state.accounts[label], { providerHint: OPENAI_CODEX_PROVIDER });
    }
    state.credentials[OPENAI_CODEX_PROVIDER][label] = incoming.credential;
    assertNoCodexAccountIdCollisions(state, label, incoming.credential.accountId);
  }

  const importedAt = new Date().toISOString();
  state.imports.authority.codex = {
    source: source.display,
    importedAt,
    labels: incomingLabels.toSorted((a, b) => a.localeCompare(b)),
  };

  return {
    source: source.display,
    importedAt,
    importedLabels: incomingLabels.toSorted((a, b) => a.localeCompare(b)),
    removedLabels: removedLabels.toSorted((a, b) => a.localeCompare(b)),
  };
}

function getCodexCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

function getAnthropicCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[ANTHROPIC_PROVIDER];
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

function assertNoCodexAccountIdCollisions(state, label, accountId) {
  ensureStateShape(state);
  const byLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  for (const [otherLabel, otherCred] of Object.entries(byLabel)) {
    if (otherLabel === label) continue;
    if (!isObject(otherCred)) continue;
    if (String(otherCred.accountId ?? "") === String(accountId)) {
      throw new Error(
        `Refusing to clobber: accountId=${accountId} is already assigned to label=${otherLabel}. ` +
          `This usually means Chrome profile selection is wrong.`,
      );
    }
  }
}

function resolveOpenclawProfileIdForCodexLabel(label) {
  return resolveOpenclawProfileIdForProviderLabel(OPENAI_CODEX_PROVIDER, label);
}

function resolveOpenclawProfileIdForProviderLabel(provider, label) {
  const p = normalizeProviderId(provider);
  if (!p) {
    throw new Error("resolveOpenclawProfileIdForProviderLabel requires provider.");
  }
  return `${p}:${normalizeLabel(label)}`;
}

function parseExpiresAtToMs(expiresAt) {
  const raw = String(expiresAt ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

function toIsoFromExpiresMs(expiresMs) {
  if (!Number.isFinite(Number(expiresMs))) return null;
  return new Date(Number(expiresMs)).toISOString();
}

export function seedAimBrowserProfileFromOpenclaw({ state, label, homeDir, profileId }) {
  const normalizedLabel = normalizeLabel(label);
  const selectedProfileId = String(profileId ?? "").trim();
  if (!selectedProfileId) {
    throw new Error(`Cannot seed AIM browser profile for label=${normalizedLabel} without an OpenClaw profile id.`);
  }

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const sourceUserDataDir = resolveOpenclawBrowserUserDataDir({
    openclawStateDir,
    profileId: selectedProfileId,
  });
  if (!fs.existsSync(sourceUserDataDir)) {
    throw new Error(
      `Cannot seed AIM browser profile for label=${normalizedLabel}: ` +
        `OpenClaw profile "${selectedProfileId}" does not exist under ${path.join(openclawStateDir, "browser")}.`,
    );
  }

  const targetUserDataDir = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  if (fs.existsSync(targetUserDataDir)) {
    return { status: "skipped", label: normalizedLabel, profileId: selectedProfileId, userDataDir: targetUserDataDir };
  }

  fs.mkdirSync(path.dirname(targetUserDataDir), { recursive: true });
  fs.cpSync(sourceUserDataDir, targetUserDataDir, {
    recursive: true,
    force: false,
    errorOnExist: true,
  });

  const browser = getAccountBrowserState(state, normalizedLabel, { create: true });
  browser.mode = BROWSER_MODE_AIM_PROFILE;
  browser.seededFromOpenclawProfileId = selectedProfileId;
  browser.seededAt = new Date().toISOString();
  if (Object.hasOwn(browser, "conflictReason")) {
    delete browser.conflictReason;
  }

  return { status: "seeded", label: normalizedLabel, profileId: selectedProfileId, userDataDir: targetUserDataDir };
}

async function ensureAimBrowserProfileBinding({ state, label, homeDir }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const existing = state.accounts[normalizedLabel];
  if (existing && !isObject(existing)) {
    throw new Error(`accounts.${normalizedLabel} must be an object (got ${typeof existing})`);
  }

  const providerRaw = typeof existing?.provider === "string" ? existing.provider.trim() : "";
  const provider = normalizeProviderId(providerRaw || OPENAI_CODEX_PROVIDER);
  if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
    throw new Error(
      `accounts.${normalizedLabel}.provider=${providerRaw || "(missing)"} is not supported. ` +
        `Supported: ${Array.from(SUPPORTED_OAUTH_PROVIDERS.keys()).join(", ")}`,
    );
  }

  state.accounts[normalizedLabel] = {
    ...(existing ? existing : {}),
    provider,
  };
  ensureAccountShape(state.accounts[normalizedLabel], { providerHint: provider });

  const browser = getAccountBrowserState(state, normalizedLabel, { create: true });
  browser.mode = BROWSER_MODE_AIM_PROFILE;
  const targetUserDataDir = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  if (typeof browser.conflictReason === "string" && browser.conflictReason.trim()) {
    throw new Error(
      `AIM browser profile for label=${normalizedLabel} is blocked by conflict: ${browser.conflictReason}. ` +
        "Fix the browser/account mismatch before retrying.",
    );
  }
  if (fs.existsSync(targetUserDataDir)) {
    return targetUserDataDir;
  }

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const storedSeedSource =
    typeof browser.seededFromOpenclawProfileId === "string" ? browser.seededFromOpenclawProfileId.trim() : "";
  if (storedSeedSource) {
    if (openclawBrowserProfileExists({ openclawStateDir, profileId: storedSeedSource })) {
      seedAimBrowserProfileFromOpenclaw({ state, label: normalizedLabel, homeDir, profileId: storedSeedSource });
      return targetUserDataDir;
    }
    process.stdout.write(
      `Stored migration source "${storedSeedSource}" for label "${normalizedLabel}" was not found under:\n` +
        `  ${path.join(openclawStateDir, "browser")}\n` +
        "Pick a valid OpenClaw browser profile to seed the AIM-owned browser dir.\n\n",
    );
  }

  if (!fs.existsSync(openclawStateDir)) {
    throw new Error(
      "AIM browser profile is missing and no OpenClaw migration source is available on this host. " +
        `Expected OpenClaw state under: ${openclawStateDir}. ` +
        "Run on the Mac host or create the AIM-owned browser dir before retrying.",
    );
  }

  const profiles = discoverOpenclawBrowserProfiles({ openclawStateDir });
  if (profiles.length > 0) {
    process.stdout.write(`OpenClaw browser profiles available for one-time AIM seeding (from ${path.join(openclawStateDir, "browser")}):\n`);
    profiles.forEach((profile, idx) => {
      process.stdout.write(`  ${idx + 1}) ${formatOpenclawBrowserProfileChoice(profile)}\n`);
    });
    process.stdout.write("\n");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await promptRequiredLine(
        `Pick OpenClaw browser profile to seed AIM label "${normalizedLabel}" (number 1-${profiles.length}, or type the profile id):`,
      );
      const profileId = resolveOpenclawBrowserProfileFromInput({ input: answer, profiles });
      if (!profileId) {
        process.stdout.write(`Invalid choice: "${answer}". Try again.\n`);
        continue;
      }
      if (!openclawBrowserProfileExists({ openclawStateDir, profileId })) {
        process.stdout.write(
          `That profile doesn't exist under ${path.join(openclawStateDir, "browser")} (${profileId}). ` +
            "Refusing to guess; try again.\n",
        );
        continue;
      }

      seedAimBrowserProfileFromOpenclaw({ state, label: normalizedLabel, homeDir, profileId });
      return targetUserDataDir;
    }
  }

  if (profiles.length === 0) {
    throw new Error(
      "No OpenClaw browser profiles discovered to seed the AIM-owned browser dir. " +
        `Expected at least one profile under: ${path.join(openclawStateDir, "browser")}. ` +
        "Start OpenClaw browser management to create profiles, or use manual-callback mode for this label.",
    );
  }

  // Unreachable: either we select from discovered profiles or we throw.
}

function getRepairBindingCommand(label) {
  return `aim browser set ${label} --mode ...`;
}

function getMissingBindingActionForLabel(label) {
  return {
    actionRequired: "run_aim_browser_set",
    repairCommand: getRepairBindingCommand(label),
  };
}

function getMissingBrowserActionForBinding({ label, bindingMode }) {
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return {
      actionRequired: "run_aim_label",
      repairCommand: `aim ${label}`,
    };
  }
  return getMissingBindingActionForLabel(label);
}

function assertMappedBrowserBindingExists({ label, binding }) {
  if (!binding) {
    throw new Error(
      `Browser-managed reauth for label=${label} requires an explicit browser binding. ` +
        `Repair it with \`${getRepairBindingCommand(label)}\`.`,
    );
  }

  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    if (!binding.userDataDir) {
      throw new Error(
        `Mapped Chrome binding for label=${label} is incomplete. Repair it with ` +
          `\`aim browser set ${label} --mode chrome-profile --user-data-dir <abs-path>\`.`,
      );
    }
    if (!fs.existsSync(binding.userDataDir)) {
      throw new Error(
        `Mapped Chrome profile for label=${label} is missing: ${binding.userDataDir}. ` +
          `Repair it with \`aim browser set ${label} --mode chrome-profile --user-data-dir <abs-path>\`.`,
      );
    }
    return binding;
  }

  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    if (!binding.agentBrowserProfile || !binding.agentBrowserSession) {
      throw new Error(
        `Mapped agent-browser binding for label=${label} is incomplete. Repair it with ` +
          `\`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
      );
    }
    if (!fs.existsSync(binding.agentBrowserProfile)) {
      throw new Error(
        `Mapped agent-browser profile for label=${label} is missing: ${binding.agentBrowserProfile}. ` +
          `Repair it with \`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
      );
    }
    return binding;
  }

  return binding;
}

async function ensureInteractiveLoginBindingForProvider({
  state,
  label,
  homeDir,
  provider,
  promptLineImpl = promptLine,
}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: provider });
  const existing = getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  const existingMode = normalizeInteractiveOAuthMode(existing?.mode);

  if (existingMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  if (existingMode === REAUTH_MODE_BROWSER_MANAGED) {
    const existingBinding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
    if (!existingBinding) {
      process.stdout.write(`Label "${normalizedLabel}" is browser-managed but has no explicit browser binding yet.\n`);
    } else if (existingBinding?.mode === BROWSER_MODE_AIM_PROFILE) {
      await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    } else {
      assertMappedBrowserBindingExists({ label: normalizedLabel, binding: existingBinding });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    }
  }

  if (!existingMode) {
    process.stdout.write(`No interactive login mode configured for label "${normalizedLabel}" yet.\n`);
    process.stdout.write("Choose login mode:\n");
    process.stdout.write("  1) browser-managed\n");
    process.stdout.write("  2) manual-callback\n\n");
    const answer = await promptLineImpl(`Login mode for "${normalizedLabel}" (1-2 or id) [1]:`, {
      defaultValue: "1",
    });
    const selectedReauthMode = resolveOpenAICodexInteractiveLoginModeFromInput(answer);
    if (!selectedReauthMode) {
      throw new Error(`Unsupported login mode selection for label=${normalizedLabel}: ${answer}`);
    }

    if (selectedReauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
      setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    }
  }

  process.stdout.write(`Browser mode for "${normalizedLabel}"?\n`);
  process.stdout.write("  1) AIM-managed profile\n");
  process.stdout.write("  2) mapped Chrome profile\n");
  process.stdout.write("  3) mapped agent-browser profile\n\n");
  const browserModeAnswer = await promptLineImpl(`Browser mode for "${normalizedLabel}" (1-3 or id) [1]:`, {
    defaultValue: "1",
  });
  const browserMode = resolveBrowserModeSelectionFromInput(browserModeAnswer);
  if (!browserMode) {
    throw new Error(`Unsupported browser mode selection for label=${normalizedLabel}: ${browserModeAnswer}`);
  }

  if (browserMode === BROWSER_MODE_AIM_PROFILE) {
    setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE });
    await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir });
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  if (browserMode === BROWSER_MODE_CHROME_PROFILE) {
    const userDataDir = await promptLineImpl(`Chrome user-data-dir for "${normalizedLabel}" (absolute path):`);
    setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_CHROME_PROFILE, userDataDir });
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  const agentBrowserProfile = await promptLineImpl(`agent-browser profile path for "${normalizedLabel}" (absolute path):`);
  const agentBrowserSession = await promptLineImpl(`agent-browser session for "${normalizedLabel}":`);
  setBrowserBinding({
    state,
    label: normalizedLabel,
    mode: BROWSER_MODE_AGENT_BROWSER,
    agentBrowserProfile,
    agentBrowserSession,
  });
  return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
}

export async function ensureOpenAICodexInteractiveLoginBinding({
  state,
  label,
  homeDir,
  promptLineImpl = promptLine,
}) {
  return ensureInteractiveLoginBindingForProvider({
    state,
    label,
    homeDir,
    provider: OPENAI_CODEX_PROVIDER,
    promptLineImpl,
  });
}

export async function refreshOrLoginCodex({
  state,
  label,
  homeDir,
  interactiveBinding,
  loginImpl = loginOpenAICodex,
  refreshImpl = refreshOpenAICodexToken,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  }) {
  const existing = getCodexCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const existingAccountId = existing && typeof existing.accountId === "string" ? existing.accountId : null;
  const binding = interactiveBinding ?? getInteractiveOAuthBindingForLabel(state, label);
  const bindingMode = normalizeInteractiveOAuthMode(binding?.mode);
  const browserBinding =
    bindingMode === REAUTH_MODE_BROWSER_MANAGED
      ? (() => {
          const resolved = resolveBrowserBinding({ account: getAccountRecord(state, label), homeDir, label });
          if (resolved?.mode === BROWSER_MODE_AIM_PROFILE) {
            return { ...resolved, userDataDir: resolveAimBrowserUserDataDir({ homeDir, label }) };
          }
          return assertMappedBrowserBindingExists({ label, binding: resolved });
        })()
      : null;

  // Try refresh first (fast + no browser).
  if (existingRefresh) {
    try {
      const updated = await refreshImpl(existingRefresh);
      const accountId = typeof updated?.accountId === "string" ? updated.accountId : "";
      if (!accountId) {
        throw new Error("refresh returned no accountId");
      }
      if (existingAccountId && existingAccountId !== accountId) {
        throw new Error(`refresh produced different accountId (${accountId}) than existing (${existingAccountId})`);
      }
      const expiresAt = toIsoFromExpiresMs(updated.expires);
      if (!expiresAt) {
        throw new Error("refresh returned no expires");
      }

      assertNoCodexAccountIdCollisions(state, label, accountId);

      return {
        access: updated.access,
        refresh: updated.refresh,
        expiresAt,
        accountId,
        idToken: updated.access,
      };
    } catch (err) {
      process.stdout.write(`Refresh failed for ${label}; falling back to OAuth login (${String(err?.message ?? err)}).\n`);
    }
  }

  const manualCallbackPrompt = async () =>
    await promptImpl(
      'Paste the full callback URL from your browser address bar (looks like "http://localhost:1455/auth/callback?code=...&state=..."):',
    );

  // Full OAuth login.
  const creds = await loginImpl({
    onAuth: ({ url }) => {
      process.stdout.write(`OAuth URL:\n${url}\n\n`);

      if (bindingMode === REAUTH_MODE_MANUAL_CALLBACK) {
        process.stdout.write(
          [
            "Open this URL in the browser on your laptop and complete login there.",
            "When the browser lands on the localhost callback page, copy the full URL from the address bar and paste it here.",
            "",
          ].join("\n"),
        );
        return;
      }

      if (!browserBinding) {
        throw new Error(`Missing browser binding for label=${label}.`);
      }

      const opened = openUrlImpl({ binding: browserBinding, url, homeDir });
      if (opened.ok) {
        return;
      }

      if (opened.reason === "missing_browser_path") {
        throw new Error(
          `Configured browser binding for label=${label} is missing on disk: ${opened.path}. ` +
            `Repair it with \`${getRepairBindingCommand(label)}\`.`,
        );
      }

      if (opened.reason === "missing_agent_browser_session") {
        throw new Error(
          `Configured agent-browser binding for label=${label} is missing its session. ` +
            `Repair it with \`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
        );
      }

      if (opened.reason === "missing_user_data_dir") {
        throw new Error(
          `Configured Chrome binding for label=${label} is incomplete. ` +
            `Repair it with \`${getRepairBindingCommand(label)}\`.`,
        );
      }

      process.stdout.write(
        [
          `Failed to auto-open configured browser binding (${formatBrowserLaunchFailure(opened)}).`,
          "Open the URL manually in the exact configured browser identity:",
          ...(browserBinding.mode === BROWSER_MODE_AGENT_BROWSER
            ? [
                `  agent-browser profile: ${browserBinding.agentBrowserProfile}`,
                `  agent-browser session: ${browserBinding.agentBrowserSession}`,
              ]
            : [`  user-data dir: ${browserBinding.userDataDir}`]),
          "",
        ].join("\n") + "\n",
      );
    },
    ...(bindingMode === REAUTH_MODE_MANUAL_CALLBACK
      ? {
          onManualCodeInput: manualCallbackPrompt,
          onPrompt: manualCallbackPrompt,
        }
      : {
          onPrompt: async () => {
            throw new Error(
              "Manual redirect-url paste flow is not supported for browser-managed labels. " +
                "Run on the Mac host with the configured browser binding so the localhost callback can complete.",
            );
          },
        }),
    originator: "aimgr",
  });

  const accountId = typeof creds?.accountId === "string" ? creds.accountId : "";
  if (!accountId) {
    throw new Error("OAuth succeeded but no accountId was returned. Refusing to store ambiguous credentials.");
  }
  const expiresAt = toIsoFromExpiresMs(creds.expires);
  if (!expiresAt) {
    throw new Error("OAuth succeeded but no expires was returned. Refusing to store ambiguous credentials.");
  }

  assertNoCodexAccountIdCollisions(state, label, accountId);

  return {
    access: creds.access,
    refresh: creds.refresh,
    expiresAt,
    accountId,
    idToken: creds.access,
  };
}

async function refreshOrLoginAnthropic({
  state,
  label,
  homeDir,
  interactiveBinding,
  loginImpl = loginAnthropic,
  refreshImpl = refreshAnthropicToken,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
}) {
  const existing = getAnthropicCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const binding = interactiveBinding ?? getInteractiveOAuthBindingForLabel(state, label);
  const bindingMode = normalizeInteractiveOAuthMode(binding?.mode);
  const browserBinding =
    bindingMode === REAUTH_MODE_BROWSER_MANAGED
      ? (() => {
          const resolved = resolveBrowserBinding({ account: getAccountRecord(state, label), homeDir, label });
          if (resolved?.mode === BROWSER_MODE_AIM_PROFILE) {
            return { ...resolved, userDataDir: resolveAimBrowserUserDataDir({ homeDir, label }) };
          }
          return assertMappedBrowserBindingExists({ label, binding: resolved });
        })()
      : null;

  // Try refresh first (fast + no browser).
  if (existingRefresh) {
    try {
      const updated = await refreshImpl(existingRefresh);
      const expiresAt = toIsoFromExpiresMs(updated.expires);
      if (!expiresAt) {
        throw new Error("refresh returned no expires");
      }

      return {
        access: updated.access,
        refresh: updated.refresh,
        expiresAt,
      };
    } catch (err) {
      process.stdout.write(`Refresh failed for ${label}; falling back to OAuth login (${String(err?.message ?? err)}).\n`);
    }
  }

  const manualCallbackPrompt = async () =>
    await promptImpl(
      'Paste the callback URL from your browser (looks like "https://console.anthropic.com/oauth/code/callback?code=...&state=..."):',
    );

  const creds = await loginImpl(
    (url) => {
      process.stdout.write(`OAuth URL:\n${url}\n\n`);
      if (bindingMode === REAUTH_MODE_MANUAL_CALLBACK) {
        process.stdout.write(
          [
            "Open this URL in the browser on your laptop and complete login there.",
            "When the browser lands on the Anthropic callback page, copy the full callback URL and paste it here.",
            "",
          ].join("\n"),
        );
        return;
      }

      if (!browserBinding) {
        throw new Error(`Missing browser binding for label=${label}.`);
      }

      const opened = openUrlImpl({ binding: browserBinding, url, homeDir });
      if (opened.ok) {
        return;
      }
      if (opened.reason === "missing_browser_path") {
        throw new Error(
          `Configured browser binding for label=${label} is missing on disk: ${opened.path}. ` +
            `Repair it with \`${getRepairBindingCommand(label)}\`.`,
        );
      }

      process.stdout.write(
        [
          `Failed to auto-open configured browser binding (${formatBrowserLaunchFailure(opened)}).`,
          "Open the URL manually in the exact configured browser identity and paste the callback URL here:",
          ...(browserBinding.mode === BROWSER_MODE_AGENT_BROWSER
            ? [
                `  agent-browser profile: ${browserBinding.agentBrowserProfile}`,
                `  agent-browser session: ${browserBinding.agentBrowserSession}`,
              ]
            : [`  user-data dir: ${browserBinding.userDataDir}`]),
          "",
        ].join("\n") + "\n",
      );
    },
    async () => parseAnthropicAuthorizationPaste(await manualCallbackPrompt()),
  );

  const expiresAt = toIsoFromExpiresMs(creds.expires);
  if (!expiresAt) {
    throw new Error("OAuth succeeded but no expires was returned. Refusing to store ambiguous credentials.");
  }

  return {
    access: creds.access,
    refresh: creds.refresh,
    expiresAt,
  };
}

function recordAccountMaintenanceAttempt(state, label) {
  const observedAt = new Date().toISOString();
  const reauth = getAccountReauthState(state, label, { create: true });
  reauth.lastAttemptAt = observedAt;
  return observedAt;
}

function recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt }) {
  const verifiedAt = String(observedAt ?? new Date().toISOString());
  const reauth = getAccountReauthState(state, label, { create: true });
  reauth.lastAttemptAt = verifiedAt;
  reauth.lastVerifiedAt = verifiedAt;
  if (Object.hasOwn(reauth, "blockedReason")) {
    delete reauth.blockedReason;
  }

  const browser = getAccountBrowserState(state, label, { create: true });
  if (browser && browser.conflictReason) {
    delete browser.conflictReason;
  }
  const binding = resolveBrowserBinding({ account: getAccountRecord(state, label), homeDir, label });
  if (browser && binding) {
    browser.verifiedAt = verifiedAt;
  }
}

function recordAccountMaintenanceFailure(state, label, { observedAt, blockedReason } = {}) {
  const failedAt = String(observedAt ?? new Date().toISOString());
  const reauth = getAccountReauthState(state, label, { create: true });
  reauth.lastAttemptAt = failedAt;
  if (typeof blockedReason === "string" && blockedReason.trim()) {
    reauth.blockedReason = blockedReason.trim();
  }
}

function clampPercent(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return 0;
  return Math.max(0, Math.min(100, num));
}

async function fetchJsonWithTimeout(url, init, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchCodexUsageSnapshot({ accessToken, accountId, timeoutMs }) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };

  const res = await fetchJsonWithTimeout(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
  );

  if (!res.ok) {
    return {
      provider: OPENAI_CODEX_PROVIDER,
      ok: false,
      status: res.status,
      tokenExpired: res.status === 401 || res.status === 403,
    };
  }

  const data = await res.json();
  const windows = [];

  const primary = data?.rate_limit?.primary_window;
  if (primary) {
    const windowHours = Math.round(((primary.limit_window_seconds || 10800) * 1.0) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(primary.used_percent || 0),
      resetAt: primary.reset_at ? primary.reset_at * 1000 : undefined,
    });
  }

  const secondary = data?.rate_limit?.secondary_window;
  if (secondary) {
    const windowHours = Math.round(((secondary.limit_window_seconds || 86400) * 1.0) / 3600);
    const label = windowHours >= 168 ? "Week" : windowHours >= 24 ? "Day" : `${windowHours}h`;
    windows.push({
      label,
      usedPercent: clampPercent(secondary.used_percent || 0),
      resetAt: secondary.reset_at ? secondary.reset_at * 1000 : undefined,
    });
  }

  let plan = data?.plan_type;
  const balanceRaw = data?.credits?.balance;
  if (balanceRaw !== undefined && balanceRaw !== null) {
    const balance = typeof balanceRaw === "number" ? balanceRaw : parseFloat(balanceRaw) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: OPENAI_CODEX_PROVIDER,
    ok: true,
    windows,
    plan,
  };
}

function buildClaudeUsageWindows(data) {
  const windows = [];

  if (data?.five_hour?.utilization !== undefined) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day?.utilization !== undefined) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day_sonnet?.utilization !== undefined) {
    windows.push({
      label: "Sonnet",
      usedPercent: clampPercent(data.seven_day_sonnet.utilization),
      resetAt: data.seven_day_sonnet.resets_at ? new Date(data.seven_day_sonnet.resets_at).getTime() : undefined,
    });
  }

  if (data?.seven_day_opus?.utilization !== undefined) {
    windows.push({
      label: "Opus",
      usedPercent: clampPercent(data.seven_day_opus.utilization),
      resetAt: data.seven_day_opus.resets_at ? new Date(data.seven_day_opus.resets_at).getTime() : undefined,
    });
  }

  return windows;
}

function resolveClaudeWebSessionKey() {
  const direct = process.env.CLAUDE_AI_SESSION_KEY?.trim() ?? process.env.CLAUDE_WEB_SESSION_KEY?.trim();
  if (direct?.startsWith("sk-ant-")) {
    return direct;
  }

  const cookieHeader = process.env.CLAUDE_WEB_COOKIE?.trim();
  if (!cookieHeader) {
    return undefined;
  }
  const stripped = cookieHeader.replace(/^cookie:\s*/i, "");
  const match = stripped.match(/(?:^|;\s*)sessionKey=([^;\s]+)/i);
  const value = match?.[1]?.trim();
  return value?.startsWith("sk-ant-") ? value : undefined;
}

async function fetchClaudeWebUsage({ sessionKey, timeoutMs }) {
  const headers = {
    Cookie: `sessionKey=${sessionKey}`,
    Accept: "application/json",
  };

  const orgRes = await fetchJsonWithTimeout(
    "https://claude.ai/api/organizations",
    { method: "GET", headers },
    timeoutMs,
  );
  if (!orgRes.ok) {
    return null;
  }

  const orgs = await orgRes.json();
  const orgId = typeof orgs?.[0]?.uuid === "string" ? orgs[0].uuid.trim() : "";
  if (!orgId) {
    return null;
  }

  const usageRes = await fetchJsonWithTimeout(
    `https://claude.ai/api/organizations/${orgId}/usage`,
    { method: "GET", headers },
    timeoutMs,
  );
  if (!usageRes.ok) {
    return null;
  }

  const data = await usageRes.json();
  const windows = buildClaudeUsageWindows(data);
  if (windows.length === 0) {
    return null;
  }

  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows,
  };
}

async function fetchClaudeUsageSnapshot({ accessToken, timeoutMs }) {
  const res = await fetchJsonWithTimeout(
    "https://api.anthropic.com/api/oauth/usage",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "aimgr",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
  );

  if (!res.ok) {
    let message;
    try {
      const data = await res.json();
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    const missingScope = res.status === 403 && message?.includes("scope requirement user:profile");
    if (missingScope) {
      const sessionKey = resolveClaudeWebSessionKey();
      if (sessionKey) {
        const web = await fetchClaudeWebUsage({ sessionKey, timeoutMs });
        if (web) {
          return web;
        }
      }
    }

    return {
      provider: ANTHROPIC_PROVIDER,
      ok: false,
      status: res.status,
      ...(message ? { error: message } : {}),
      ...(missingScope ? { missingScope: true } : {}),
      ...(!missingScope && (res.status === 401 || res.status === 403) ? { tokenExpired: true } : {}),
    };
  }

  const data = await res.json();
  const windows = buildClaudeUsageWindows(data);
  const opusUnavailable =
    Object.hasOwn(data ?? {}, "seven_day_opus") && (data?.seven_day_opus === null || data?.seven_day_opus === undefined);

  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows,
    ...(opusUnavailable ? { opusUnavailable: true } : {}),
  };
}

function formatDurationRough(ms) {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const minutes = Math.round(abs / 60000);
  if (minutes < 60) return `${sign}${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${sign}${hours}h`;
  const days = Math.round(hours / 24);
  return `${sign}${days}d`;
}

function formatExpiresIn(expiresAt) {
  const ms = parseExpiresAtToMs(expiresAt);
  if (!ms) return "unknown";
  const delta = ms - Date.now();
  if (delta <= 0) return `expired (${formatDurationRough(delta)})`;
  return formatDurationRough(delta);
}

function formatAgeSince(isoTimestamp) {
  const ms = parseExpiresAtToMs(isoTimestamp);
  if (!ms) return "unknown";
  return formatDurationRough(Date.now() - ms);
}

function formatResetAtForStatus(resetAt) {
  if (resetAt === undefined || resetAt === null) return null;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  return STATUS_RESET_FORMATTER.format(new Date(ms));
}

function formatHoursUntilReset(resetAt) {
  if (resetAt === undefined || resetAt === null) return null;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  const deltaHours = (ms - Date.now()) / 3600000;
  const roundedHours = Math.abs(Math.round(deltaHours * 10) / 10).toFixed(1);
  if (deltaHours <= 0) return `${roundedHours}h ago`;
  return `${roundedHours}h left`;
}

function formatUsageWindowSummary(window) {
  const used = `${window.label} ${Math.round(window.usedPercent)}% used`;
  const resetAt = formatResetAtForStatus(window.resetAt);
  const hoursUntilReset = formatHoursUntilReset(window.resetAt);
  if (!resetAt) return used;
  if (!hoursUntilReset) return `${used} (resets ${resetAt})`;
  return `${used} (resets ${resetAt}, ${hoursUntilReset})`;
}

function formatCodexUsageSummary(snapshot) {
  if (!snapshot) return "unknown";
  if (snapshot.ok !== true) {
    if (snapshot.tokenExpired) return "expired";
    if (snapshot.status) return `error:${snapshot.status}`;
    return "error";
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return "ok";
  return windows.map((w) => formatUsageWindowSummary(w)).join(" · ");
}

function formatClaudeUsageSummary(snapshot) {
  if (!snapshot) return "unknown";
  if (snapshot.ok !== true) {
    if (snapshot.tokenExpired) return "expired";
    if (snapshot.missingScope) return "missing-scope";
    if (snapshot.status) return `error:${snapshot.status}`;
    return "error";
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return "ok";
  return windows.map((w) => formatUsageWindowSummary(w)).join(" · ");
}

function getCodexUsagePercents(snapshot) {
  if (!snapshot || snapshot.ok !== true) {
    return { primaryUsedPct: 100, secondaryUsedPct: 100 };
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  return {
    primaryUsedPct: clampPercent(windows[0]?.usedPercent ?? 0),
    secondaryUsedPct: clampPercent(windows[1]?.usedPercent ?? 0),
  };
}

async function probeUsageSnapshotsByProvider(state) {
  ensureStateShape(state);
  const usageByProvider = {
    [OPENAI_CODEX_PROVIDER]: {},
    [ANTHROPIC_PROVIDER]: {},
  };
  const probes = [];

  for (const [label, cred] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        const accountId = typeof cred.accountId === "string" ? cred.accountId.trim() : null;
        try {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = await fetchCodexUsageSnapshot({
            accessToken: cred.access,
            accountId,
            timeoutMs: 8000,
          });
        } catch (err) {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = {
            provider: OPENAI_CODEX_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  for (const [label, cred] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        try {
          usageByProvider[ANTHROPIC_PROVIDER][label] = await fetchClaudeUsageSnapshot({
            accessToken: cred.access,
            timeoutMs: 8000,
          });
        } catch (err) {
          usageByProvider[ANTHROPIC_PROVIDER][label] = {
            provider: ANTHROPIC_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  await Promise.all(probes);
  return usageByProvider;
}

export function derivePoolAccountStatus({ account, label, credentials, browserFacts, now }) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedAccount = isObject(account) ? account : {};
  const reauth = isObject(normalizedAccount.reauth) ? normalizedAccount.reauth : {};
  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : {};
  const provider = normalizeProviderId(normalizedAccount.provider);
  const browserMode = normalizeInteractiveOAuthMode(reauth.mode);
  const bindingMode = normalizeBrowserBindingMode(browser.mode);
  const blockedReason = typeof reauth.blockedReason === "string" ? reauth.blockedReason.trim() : "";
  const conflictReason = typeof browser.conflictReason === "string" ? browser.conflictReason.trim() : "";
  const expectedEmail =
    typeof normalizedAccount.expect?.email === "string" ? normalizedAccount.expect.email.trim().toLowerCase() : "";
  const browserEmail =
    typeof browserFacts?.userName === "string" ? browserFacts.userName.trim().toLowerCase() : "";
  const credential = isObject(credentials) ? credentials : null;
  const expiresMs = parseExpiresAtToMs(credential?.expiresAt);
  const hasFreshCredentials =
    credential
    && typeof credential.access === "string"
    && credential.access.trim()
    && typeof credential.refresh === "string"
    && credential.refresh.trim()
    && expiresMs !== null
    && expiresMs > snapshotNow
    && (provider !== OPENAI_CODEX_PROVIDER || typeof credential.accountId === "string" && credential.accountId.trim());

  if (conflictReason) {
    return {
      operatorStatus: "blocked",
      detailReason: "conflict",
      eligible: false,
      actionRequired: "fix_conflict",
      reason: conflictReason,
    };
  }
  if (expectedEmail && browserEmail && expectedEmail !== browserEmail) {
    return {
      operatorStatus: "blocked",
      detailReason: "conflict",
      eligible: false,
      actionRequired: "fix_conflict",
      reason: `Browser identity ${browserEmail} does not match expected ${expectedEmail}.`,
    };
  }
  if (blockedReason) {
    return {
      operatorStatus: "blocked",
      eligible: false,
      actionRequired: "fix_blocker",
      reason: blockedReason,
    };
  }

  if (browserMode === REAUTH_MODE_BROWSER_MANAGED && browserFacts?.bindingPresent !== true) {
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "binding_missing_for_future_reauth",
        eligible: true,
        actionRequired: "run_aim_browser_set",
        reason:
          "Credentials are still usable now; set an explicit browser binding before the next browser-managed reauth.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "binding_missing_for_future_reauth",
      eligible: false,
      actionRequired: "run_aim_browser_set",
      reason: "No explicit browser binding is configured for this browser-managed label.",
    };
  }

  if (
    browserMode === REAUTH_MODE_BROWSER_MANAGED
    && browserFacts?.bindingPresent === true
    && browserFacts?.exists !== true
  ) {
    const missingAction = getMissingBrowserActionForBinding({
      label: normalizeLabel(label),
      bindingMode,
    });
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "missing_browser",
        eligible: true,
        actionRequired: missingAction.actionRequired,
        reason:
          bindingMode === BROWSER_MODE_AIM_PROFILE
            ? "Credentials are still usable now; run `aim <label>` later to recreate the missing AIM-managed browser profile."
            : "Credentials are still usable now; repair the missing mapped browser binding before the next browser-managed reauth.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "missing_browser",
      eligible: false,
      actionRequired: missingAction.actionRequired,
      reason:
        bindingMode === BROWSER_MODE_AIM_PROFILE
          ? "AIM-managed browser profile is missing for this label."
          : "Configured browser binding cannot be resolved on disk.",
    };
  }

  if (
    browserMode === REAUTH_MODE_BROWSER_MANAGED
    && bindingMode === BROWSER_MODE_AIM_PROFILE
    && typeof browser.seededAt === "string"
    && browser.seededAt.trim()
    && !(typeof browser.verifiedAt === "string" && browser.verifiedAt.trim())
  ) {
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "seeded_unverified",
        eligible: true,
        actionRequired: "run_aim_label",
        reason:
          "Credentials are still usable now; run `aim <label>` later to verify the seeded AIM-owned browser profile.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "seeded_unverified",
      eligible: false,
      actionRequired: "run_aim_label",
      reason: "AIM browser profile was seeded but not yet verified by a successful AIM-managed login or refresh.",
    };
  }

  if (!hasFreshCredentials) {
    return {
      operatorStatus: "reauth",
      detailReason: "missing_credentials",
      eligible: false,
      actionRequired: "run_aim_label",
      reason:
        expiresMs !== null && expiresMs <= snapshotNow
          ? "Credentials are expired."
          : "No currently usable credentials are stored for this label.",
    };
  }

  if (browserMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return {
      operatorStatus: "ready",
      detailReason: "manual_mode",
      eligible: true,
      actionRequired: null,
      reason: "Ready; recovery path uses manual callback/SSO when needed.",
    };
  }

  return {
    operatorStatus: "ready",
    eligible: true,
    actionRequired: null,
    reason: "Ready for selection and rebalance.",
  };
}

function isUsageSnapshotExhausted(snapshot) {
  if (!snapshot) return false;
  if (snapshot.ok !== true) {
    return snapshot.status === 429 || snapshot.status === 409 || /rate limit|exhaust/i.test(String(snapshot.error ?? ""));
  }
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  return primaryUsedPct >= 95 || secondaryUsedPct >= 95;
}

function getCodexPoolLabels(state) {
  ensureStateShape(state);
  return Object.entries(state.accounts)
    .filter(([, account]) => isObject(account))
    .filter(([, account]) => normalizeProviderId(account.provider) === OPENAI_CODEX_PROVIDER)
    .filter(([label]) => getAccountPoolState(state, label)?.enabled !== false)
    .map(([label]) => normalizeLabel(label))
    .toSorted((a, b) => a.localeCompare(b));
}

function collectCodexPoolStatus({ state, homeDir, usageByLabel, now }) {
  const labels = getCodexPoolLabels(state);
  const byLabel = {};
  const eligibleLabels = [];

  for (const label of labels) {
    const account = state.accounts[label];
    const browserFacts = readBrowserFacts({ account, homeDir, label });
    const status = derivePoolAccountStatus({
      account,
      label,
      credentials: getCodexCredential(state, label),
      browserFacts,
      now,
    });
    const usage = usageByLabel[label] ?? null;
    const usageOk = usage?.ok === true && Array.isArray(usage.windows) && usage.windows.length > 0;
    const eligible = status.eligible && usageOk && !isUsageSnapshotExhausted(usage);
    byLabel[label] = {
      ...status,
      label,
      browserFacts,
      usage,
      eligible,
      poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
      usageReason: usageOk ? null : "usage_unavailable",
    };
    if (eligible) {
      eligibleLabels.push(label);
    }
  }

  return { labels, byLabel, eligibleLabels };
}

export function rankPoolCandidates({
  labels,
  usage,
  currentLabel,
  assignedCounts,
  currentAssignments,
  configuredAgents,
  agentDemand,
  lastApplyReceipt,
  selectionDemandWeight,
  now,
}) {
  const normalizedLabels = [...new Set((Array.isArray(labels) ? labels : []).map((label) => normalizeLabel(label)))];
  const current = typeof currentLabel === "string" ? normalizeLabel(currentLabel) : null;
  const counts = isObject(assignedCounts) ? assignedCounts : {};
  const demandByAgent = buildStatusDemandByAgent({ configuredAgents, agentDemand });
  const { assignedDemandByLabel, assignedCountsByLabel } = buildAssignedDemandByLabel({
    eligibleLabels: normalizedLabels,
    configuredAgents,
    currentAssignments,
    demandByAgent,
  });
  const bucketWeights = deriveDemandBucketWeights(demandByAgent);
  const effectiveSelectionDemandWeight = roundDemandWeight(
    Math.max(
      MIN_AGENT_DEMAND_WEIGHT,
      normalizeDemandWeight(selectionDemandWeight, bucketWeights.mediumWeight),
    ),
  );
  const totalDemandWeight = Object.values(demandByAgent).reduce(
    (sum, entry) => sum + normalizeDemandWeight(entry?.demandWeight, 0),
    0,
  );
  const supply = buildWeightedRebalanceSupply({ labels: normalizedLabels, usage });
  const targetUnitsTotal = normalizedLabels.reduce(
    (sum, label) => sum + normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0),
    0,
  );
  const effectiveTotalDemandWeight = Math.max(effectiveSelectionDemandWeight, totalDemandWeight);
  const targetDemandByLabel = Object.fromEntries(
    normalizedLabels.map((label) => [
      label,
      targetUnitsTotal <= 0
        ? 0
        : (normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0) / targetUnitsTotal) * effectiveTotalDemandWeight,
    ]),
  );
  for (const label of normalizedLabels) {
    if (!isObject(supply.byLabel[label])) continue;
    supply.byLabel[label].capacityBudgetWeight = roundDemandWeight(targetDemandByLabel[label]);
  }
  const receiptTargets = new Map();
  for (const entry of Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : []) {
    if (!isObject(entry) || typeof entry.label !== "string") continue;
    receiptTargets.set(
      normalizeLabel(entry.label),
      roundDemandWeight(
        Math.max(
          0,
          normalizeDemandWeight(
            entry.capacityBudgetWeight,
            normalizeDemandWeight(entry.targetDemandWeight, normalizeDemandWeight(entry.carriedDemandWeight, 0)),
          ),
        ),
      ),
    );
  }
  const observedAt = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const candidates = normalizedLabels.map((label) => {
    const snapshot = usage?.[label] ?? null;
    const capacity = buildLabelCapacityInfo(snapshot);
    const targetDemandWeight = receiptTargets.has(label)
      ? receiptTargets.get(label)
      : roundDemandWeight(targetDemandByLabel[label]);
    const candidate = buildWeightedRebalanceCandidate({
      label,
      supply: {
        ...supply.byLabel[label],
        targetDemandWeight,
        capacityBudgetWeight: targetDemandWeight,
      },
      assignedDemandByLabel,
      assignedCounts: {
        ...assignedCountsByLabel,
        [label]: Number.isFinite(Number(assignedCountsByLabel[label]))
          ? Number(assignedCountsByLabel[label])
          : (Number.isFinite(Number(counts[label])) ? Number(counts[label]) : 0),
      },
      agentWeight: effectiveSelectionDemandWeight,
    });
    return {
      ...candidate,
      accountId: null,
      primaryUsedPct: capacity.primaryUsedPct,
      secondaryUsedPct: capacity.secondaryUsedPct,
      observedAt,
    };
  });

  candidates.sort((a, b) => {
    if (a.overflowWeight !== b.overflowWeight) return a.overflowWeight - b.overflowWeight;
    if (a.projectedDemandRatio !== b.projectedDemandRatio) return a.projectedDemandRatio - b.projectedDemandRatio;
    if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
    if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
    if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
    return a.label.localeCompare(b.label);
  });

  if (current) {
    const best = candidates[0] ?? null;
    const currentCandidate = candidates.find((candidate) => candidate.label === current) ?? null;
    if (
      best
      && currentCandidate
      && shouldKeepCurrentWeightedAssignment({
        currentCandidate,
        bestCandidate: best,
        agentWeight: effectiveSelectionDemandWeight,
      })
    ) {
      currentCandidate.keptCurrent = true;
      currentCandidate.reasons.push("within_weighted_hysteresis");
      candidates.splice(candidates.indexOf(currentCandidate), 1);
      candidates.unshift(currentCandidate);
    }
  }

  return candidates;
}

export function pickNextBestPoolLabel({ rankedCandidates }) {
  const candidates = Array.isArray(rankedCandidates) ? rankedCandidates : [];
  return candidates[0] ?? null;
}

function buildLabelCapacityInfo(snapshot) {
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const secondaryRemainingPct = windows.length > 1 ? clampPercent(100 - secondaryUsedPct) : clampPercent(100 - primaryUsedPct);
  const primaryRemainingPct = clampPercent(100 - primaryUsedPct);
  const planningUsedPct = windows.length > 1 ? secondaryUsedPct : primaryUsedPct;
  const planningRemainingPct = windows.length > 1 ? secondaryRemainingPct : primaryRemainingPct;
  const bottleneckUsedPct = Math.max(primaryUsedPct, windows.length > 1 ? secondaryUsedPct : primaryUsedPct);
  return {
    primaryUsedPct,
    secondaryUsedPct,
    primaryRemainingPct,
    secondaryRemainingPct,
    planningUsedPct,
    planningRemainingPct,
    bottleneckUsedPct,
    remainingPct: planningRemainingPct,
  };
}

export function readOpenclawAgentTokenUsage({
  homeDir,
  agentId,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
}) {
  const normalizedAgentId = normalizeAgentId(agentId);
  const storePath = resolveOpenclawSessionsStorePath(homeDir, normalizedAgentId);
  const existing = readJsonFile(storePath);
  if (!existing) {
    return {
      agentId: normalizedAgentId,
      storePath,
      exists: false,
      sessionsTotal: 0,
      sessionsConsidered: 0,
      sessionsWithTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      latestSessionAt: null,
    };
  }
  if (!isObject(existing)) {
    throw new Error(`OpenClaw sessions store is not an object map: ${storePath}`);
  }

  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = snapshotNow - Math.max(1, Number(lookbackDays)) * 24 * 60 * 60 * 1000;
  let inputTokens = 0;
  let outputTokens = 0;
  let totalTokens = 0;
  let sessionsConsidered = 0;
  let sessionsWithTokens = 0;
  let latestSessionAtMs = null;

  for (const entry of Object.values(existing)) {
    if (!isObject(entry)) continue;
    const updatedAtMs = parseTimestampLikeToMs(entry.updatedAt);
    if (updatedAtMs === null || updatedAtMs < cutoffMs) continue;
    sessionsConsidered += 1;

    const entryInputTokens = normalizeDemandWeight(entry.inputTokens, 0);
    const entryOutputTokens = normalizeDemandWeight(entry.outputTokens, 0);
    const rawTotalTokens = Number(entry.totalTokens);
    const entryTotalTokens =
      Number.isFinite(rawTotalTokens) && rawTotalTokens >= 0 ? rawTotalTokens : entryInputTokens + entryOutputTokens;
    if (entryInputTokens <= 0 && entryOutputTokens <= 0 && entryTotalTokens <= 0) {
      continue;
    }

    inputTokens += entryInputTokens;
    outputTokens += entryOutputTokens;
    totalTokens += entryTotalTokens;
    sessionsWithTokens += 1;
    if (latestSessionAtMs === null || updatedAtMs > latestSessionAtMs) {
      latestSessionAtMs = updatedAtMs;
    }
  }

  return {
    agentId: normalizedAgentId,
    storePath,
    exists: true,
    sessionsTotal: Object.keys(existing).length,
    sessionsConsidered,
    sessionsWithTokens,
    inputTokens: roundDemandWeight(inputTokens),
    outputTokens: roundDemandWeight(outputTokens),
    totalTokens: roundDemandWeight(totalTokens),
    latestSessionAt: latestSessionAtMs !== null ? new Date(latestSessionAtMs).toISOString() : null,
  };
}

export function refreshOpenclawAgentDemandLedger({
  state,
  homeDir,
  configuredAgents,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
}) {
  // AIM owns the durable demand ledger; OpenClaw session stores are read-only inputs.
  // Do not rebalance directly from raw session files in multiple places or the allocator will drift.
  ensureStateShape(state);
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const agentIds = [...new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ledger = getOpenclawAgentDemandState(state);
  const usageByAgent = new Map();
  const observedWeights = [];

  for (const agentId of agentIds) {
    const usage = readOpenclawAgentTokenUsage({
      homeDir,
      agentId,
      now: snapshotNow,
      lookbackDays: normalizedLookbackDays,
    });
    usageByAgent.set(agentId, usage);
    if (usage.totalTokens > 0) {
      observedWeights.push(usage.totalTokens);
    }
  }

  const fallbackDemandWeight = Math.max(
    MIN_AGENT_DEMAND_WEIGHT,
    observedWeights.length > 0
      ? observedWeights.reduce((sum, weight) => sum + weight, 0) / observedWeights.length
      : MIN_AGENT_DEMAND_WEIGHT,
  );
  const allocationMode = observedWeights.length > 0 ? "demand_weighted" : "cold_start_equal_share";
  const updatedAt = new Date(snapshotNow).toISOString();

  for (const agentId of agentIds) {
    const usage = usageByAgent.get(agentId);
    const source = usage && usage.totalTokens > 0 ? "openclaw-session-tokens" : "cold-start-equal-share";
    ledger[agentId] = {
      updatedAt,
      lookbackDays: normalizedLookbackDays,
      source,
      inputTokens: roundDemandWeight(usage?.inputTokens ?? 0),
      outputTokens: roundDemandWeight(usage?.outputTokens ?? 0),
      totalTokens: roundDemandWeight(usage?.totalTokens ?? 0),
      demandWeight: roundDemandWeight(source === "openclaw-session-tokens" ? usage.totalTokens : fallbackDemandWeight),
    };
  }

  return {
    allocationMode,
    lookbackDays: normalizedLookbackDays,
    observedAgentCount: observedWeights.length,
    coldStartAgentCount: agentIds.length - observedWeights.length,
    demandByAgent: Object.fromEntries(agentIds.map((agentId) => [agentId, ledger[agentId]])),
  };
}

function discoverConfiguredOpenclawCodexAgents({ agentsList, exclusions }) {
  const excluded = isObject(exclusions) ? exclusions : {};
  return (Array.isArray(agentsList) ? agentsList : [])
    .map((entry) => {
      const id = typeof entry?.id === "string" ? entry.id.trim() : "";
      if (!id) return null;
      const normalizedId = normalizeAgentId(id);
      if (typeof excluded[normalizedId] === "string" && excluded[normalizedId].trim()) {
        return null;
      }
      const currentPrimary = extractOpenclawConfigAgentModelPrimary(entry?.model);
      if (!currentPrimary) return normalizedId;
      const parsed = parseProviderModelRef(currentPrimary);
      if (parsed?.provider === ANTHROPIC_PROVIDER) return null;
      return normalizedId;
    })
    .filter(Boolean)
    .toSorted((a, b) => a.localeCompare(b));
}

function buildWeightedRebalanceSupply({ labels, usage }) {
  const normalizedLabels = [...new Set((Array.isArray(labels) ? labels : []).map((label) => normalizeLabel(label)))];
  const byLabel = {};

  // Weekly remaining headroom is the allocator SSOT.
  // Do not derive target capacity from current assignments or repeat rebalances will churn.
  for (const label of normalizedLabels) {
    const capacity = buildLabelCapacityInfo(usage?.[label] ?? null);
    byLabel[label] = {
      ...capacity,
      capacityBudgetWeight: null,
      targetUnits: Math.max(0, capacity.remainingPct),
    };
  }

  return {
    byLabel,
    budgetingEnabled: true,
  };
}

function buildWeightedRebalanceCandidate({
  label,
  supply,
  assignedDemandByLabel,
  assignedCounts,
  agentWeight,
}) {
  const currentAssignedDemand = normalizeDemandWeight(assignedDemandByLabel[label], 0);
  const targetDemandWeight = normalizeDemandWeight(supply.targetDemandWeight, 0);
  const projectedDemandWeight = currentAssignedDemand + agentWeight;
  const overflowWeight = Math.max(0, projectedDemandWeight - targetDemandWeight);
  const projectedDemandRatio =
    targetDemandWeight > 0 ? projectedDemandWeight / targetDemandWeight : (projectedDemandWeight > 0 ? Number.POSITIVE_INFINITY : 0);
  const remainingBudgetWeight =
    supply.capacityBudgetWeight === null ? Number.POSITIVE_INFINITY : Math.max(0, supply.capacityBudgetWeight - currentAssignedDemand);

  return {
    label,
    assignedCount: Number.isFinite(Number(assignedCounts[label])) ? Number(assignedCounts[label]) : 0,
    currentAssignedDemandWeight: roundDemandWeight(currentAssignedDemand),
    targetDemandWeight: roundDemandWeight(targetDemandWeight),
    projectedDemandWeight: roundDemandWeight(projectedDemandWeight),
    overflowWeight: roundDemandWeight(overflowWeight),
    projectedDemandRatio,
    remainingBudgetWeight: Number.isFinite(remainingBudgetWeight) ? roundDemandWeight(remainingBudgetWeight) : null,
    capacityBudgetWeight: supply.capacityBudgetWeight,
    primaryRemainingPct: supply.primaryRemainingPct,
    secondaryRemainingPct: supply.secondaryRemainingPct,
    keptCurrent: false,
    reasons: [],
  };
}

function shouldKeepCurrentWeightedAssignment({ currentCandidate, bestCandidate, agentWeight }) {
  if (!currentCandidate || !bestCandidate) return false;
  return (
    currentCandidate.overflowWeight <= bestCandidate.overflowWeight + agentWeight * KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR
    && currentCandidate.projectedDemandRatio <= bestCandidate.projectedDemandRatio + KEEP_CURRENT_DEMAND_RATIO_THRESHOLD
  );
}

function buildWeightedPerAccountLoad({ labels, assignments, assignedDemandByLabel, targetDemandByLabel, supplyByLabel }) {
  const agentsByLabel = Object.fromEntries((Array.isArray(labels) ? labels : []).map((label) => [label, []]));
  for (const [agentIdRaw, labelRaw] of Object.entries(isObject(assignments) ? assignments : {})) {
    const label = normalizeLabel(labelRaw);
    if (!Object.hasOwn(agentsByLabel, label)) continue;
    agentsByLabel[label].push(normalizeAgentId(agentIdRaw));
  }

  return Object.entries(agentsByLabel)
    .map(([label, agentIds]) => {
      const supply = supplyByLabel[label] ?? {};
      return {
        label,
        assignedAgents: agentIds.toSorted((a, b) => a.localeCompare(b)),
        carriedAgentCount: agentIds.length,
        carriedDemandWeight: roundDemandWeight(assignedDemandByLabel[label] ?? 0),
        targetDemandWeight: roundDemandWeight(targetDemandByLabel[label] ?? 0),
        ...(supply.capacityBudgetWeight !== null ? { capacityBudgetWeight: roundDemandWeight(supply.capacityBudgetWeight ?? 0) } : {}),
        primaryRemainingPct: supply.primaryRemainingPct ?? 0,
        secondaryRemainingPct: supply.secondaryRemainingPct ?? 0,
      };
    })
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function planWeightedOpenclawRebalance({ configuredAgents, currentAssignments, eligibleLabels, usage, agentDemand, now }) {
  // This is intentionally not the same primitive as Codex "next best label".
  // Rebalance is many-to-one demand allocation across remaining account headroom, with low-churn hysteresis.
  const agentIds = [...new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const existingAssignments = isObject(currentAssignments) ? currentAssignments : {};
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const nextAssignments = {};
  const moved = [];
  const unchanged = [];
  const skipped = [];
  const blockers = [];
  const assignedCounts = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignedDemandByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const demandLedger = isObject(agentDemand) ? agentDemand : {};
  const allocationMode = Object.values(demandLedger).some((entry) => entry?.source === "openclaw-session-tokens")
    ? "demand_weighted"
    : "cold_start_equal_share";

  if (labels.length === 0) {
    for (const agentId of agentIds) {
      skipped.push({ agentId, reason: "no_eligible_pool_account" });
    }
    blockers.push({ reason: "no_eligible_pool_account" });
    return {
      assignments: nextAssignments,
      moved,
      unchanged,
      skipped,
      blockers,
      status: "blocked",
      allocationMode,
      perAccountLoad: [],
    };
  }

  const demandByAgent = Object.fromEntries(
    agentIds.map((agentId) => {
      const entry = isObject(demandLedger[agentId]) ? demandLedger[agentId] : {};
      return [
        agentId,
        {
          source:
            entry.source === "openclaw-session-tokens" || entry.source === "cold-start-equal-share"
              ? entry.source
              : "cold-start-equal-share",
          demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(entry.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
        },
      ];
    }),
  );
  const totalDemandWeight = agentIds.reduce((sum, agentId) => sum + demandByAgent[agentId].demandWeight, 0);
  const supply = buildWeightedRebalanceSupply({
    labels,
    usage,
  });
  const targetUnitsTotal = labels.reduce((sum, label) => sum + normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0), 0);
  if (targetUnitsTotal <= 0) {
    for (const agentId of agentIds) {
      const demand = demandByAgent[agentId];
      skipped.push({
        agentId,
        reason: "projected_demand_exceeds_eligible_supply",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
      });
    }
    blockers.push({ reason: "projected_demand_exceeds_eligible_supply" });
    return {
      assignments: nextAssignments,
      moved,
      unchanged,
      skipped,
      blockers,
      status: "blocked",
      allocationMode,
      perAccountLoad: [],
    };
  }

  const targetDemandByLabel = Object.fromEntries(
    labels.map((label) => [
      label,
      totalDemandWeight <= 0
        ? 0
        : (normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0) / targetUnitsTotal) * totalDemandWeight,
    ]),
  );
  for (const label of labels) {
    if (!isObject(supply.byLabel[label])) continue;
    supply.byLabel[label].capacityBudgetWeight = roundDemandWeight(targetDemandByLabel[label]);
  }
  const agentIdsByDemand = [...agentIds].sort((a, b) => {
    const aDemand = demandByAgent[a].demandWeight;
    const bDemand = demandByAgent[b].demandWeight;
    if (aDemand !== bDemand) return bDemand - aDemand;
    const aCurrent = typeof existingAssignments[a] === "string" && labels.includes(normalizeLabel(existingAssignments[a])) ? 1 : 0;
    const bCurrent = typeof existingAssignments[b] === "string" && labels.includes(normalizeLabel(existingAssignments[b])) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return a.localeCompare(b);
  });

  for (const agentId of agentIdsByDemand) {
    const currentLabelRaw = typeof existingAssignments[agentId] === "string" ? existingAssignments[agentId] : null;
    const normalizedCurrentLabel = currentLabelRaw ? normalizeLabel(currentLabelRaw) : null;
    const currentLabel = normalizedCurrentLabel && labels.includes(normalizedCurrentLabel) ? normalizedCurrentLabel : null;
    const demand = demandByAgent[agentId];
    const candidates = labels
      .map((label) =>
        buildWeightedRebalanceCandidate({
          label,
          supply: {
            ...supply.byLabel[label],
            targetDemandWeight: targetDemandByLabel[label],
          },
          assignedDemandByLabel,
          assignedCounts,
          agentWeight: demand.demandWeight,
        }),
      )
      .toSorted((a, b) => {
        if (a.overflowWeight !== b.overflowWeight) return a.overflowWeight - b.overflowWeight;
        if (a.projectedDemandRatio !== b.projectedDemandRatio) return a.projectedDemandRatio - b.projectedDemandRatio;
        if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
        if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
        if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
        return a.label.localeCompare(b.label);
      });
    const bestCandidate = candidates[0] ?? null;
    const currentCandidate = candidates.find((candidate) => candidate.label === currentLabel) ?? null;
    let selection = bestCandidate;
    if (shouldKeepCurrentWeightedAssignment({ currentCandidate, bestCandidate, agentWeight: demand.demandWeight })) {
      currentCandidate.keptCurrent = true;
      currentCandidate.reasons.push("within_weighted_hysteresis");
      selection = currentCandidate;
    }

    if (!selection) {
      skipped.push({
        agentId,
        reason: "projected_demand_exceeds_eligible_supply",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
      });
      continue;
    }

    nextAssignments[agentId] = selection.label;
    assignedCounts[selection.label] = (assignedCounts[selection.label] ?? 0) + 1;
    assignedDemandByLabel[selection.label] = roundDemandWeight(
      normalizeDemandWeight(assignedDemandByLabel[selection.label], 0) + demand.demandWeight,
    );

    if (currentLabel === selection.label) {
      unchanged.push({
        agentId,
        label: selection.label,
        reason: selection.keptCurrent ? "kept_current_hysteresis" : "weighted_best_fit",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
        targetDemandWeight: selection.targetDemandWeight,
        projectedDemandWeight: selection.projectedDemandWeight,
      });
    } else {
      moved.push({
        agentId,
        from: normalizedCurrentLabel ?? null,
        to: selection.label,
        reason: selection.keptCurrent ? "kept_current_hysteresis" : "weighted_best_fit",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
        targetDemandWeight: selection.targetDemandWeight,
        projectedDemandWeight: selection.projectedDemandWeight,
      });
    }
  }

  let status = "applied";
  if (agentIds.length === 0) {
    status = "noop";
  } else if (skipped.length > 0 && skipped.length === agentIds.length) {
    const blockedReason = skipped.every((entry) => entry.reason === "projected_demand_exceeds_eligible_supply")
      ? "projected_demand_exceeds_eligible_supply"
      : "no_eligible_pool_account";
    blockers.push({ reason: blockedReason });
    status = "blocked";
  } else if (agentIds.length > 0 && moved.length === 0 && skipped.length === 0) {
    status = "noop";
  } else if (skipped.length > 0) {
    status = "applied_with_warnings";
  }

  return {
    assignments: nextAssignments,
    moved,
    unchanged,
    skipped,
    blockers,
    status,
    allocationMode,
    perAccountLoad: buildWeightedPerAccountLoad({
      labels,
      assignments: nextAssignments,
      assignedDemandByLabel,
      targetDemandByLabel,
      supplyByLabel: supply.byLabel,
    }),
  };
}

export function planOpenclawRebalance(params) {
  return planWeightedOpenclawRebalance(params);
}

function appendOpenaiCodexHistory(state, entries) {
  ensureStateShape(state);
  const current = Array.isArray(state.pool.openaiCodex.history) ? state.pool.openaiCodex.history : [];
  const additions = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry));
  state.pool.openaiCodex.history = pruneOpenaiCodexHistory([...current, ...additions]);
}

function buildExhaustionHistoryEntries({ state, usage, eligibleLabels, observedAt }) {
  const eligible = new Set(Array.isArray(eligibleLabels) ? eligibleLabels : []);
  const entries = [];

  for (const [label, snapshot] of Object.entries(isObject(usage) ? usage : {})) {
    if (!isUsageSnapshotExhausted(snapshot)) continue;
    const cred = getCodexCredential(state, label);
    entries.push({
      observedAt,
      kind: "exhaustion",
      label,
      ...(typeof cred?.accountId === "string" && cred.accountId.trim() ? { accountId: cred.accountId.trim() } : {}),
      hadSpareEligibleCapacity: Array.from(eligible).some((candidate) => candidate !== label),
      reason: snapshot?.ok === true ? "usage_window_95" : `provider_status_${snapshot?.status ?? "error"}`,
    });
  }

  return entries;
}

export function projectPoolCapacity({
  history,
  liveUsage,
  agentDemand,
  lastApplyReceipt,
  horizonDays = 7,
  lookbackDays = 14,
  now,
}) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = snapshotNow - Number(lookbackDays) * 24 * 60 * 60 * 1000;
  const events = (Array.isArray(history) ? history : []).filter((entry) => {
    if (!isObject(entry)) return false;
    const observedAtMs = parseExpiresAtToMs(entry.observedAt);
    return observedAtMs !== null && observedAtMs >= cutoffMs;
  });

  const blockedNoEligible = events.filter((entry) => entry.status === "blocked" && entry.reason === "no_eligible_pool_account").length;
  const demandOverflowReceipts = events.filter((entry) => entry.reason === "projected_demand_exceeds_eligible_supply").length;
  const warningReceipts = events.filter((entry) => typeof entry.status === "string" && entry.status.endsWith("_with_warnings")).length;
  const spareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === true).length;
  const noSpareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === false).length;
  const currentHighUtilizationLabels = Object.entries(isObject(liveUsage) ? liveUsage : {})
    .filter(([, snapshot]) => isUsageSnapshotExhausted(snapshot))
    .map(([label]) => label)
    .toSorted((a, b) => a.localeCompare(b));
  const agentDemandEntries = Object.values(isObject(agentDemand) ? agentDemand : {});
  const knownAgentDemandCount = agentDemandEntries.filter((entry) => entry?.source === "openclaw-session-tokens").length;
  const coldStartAgentCount = agentDemandEntries.filter((entry) => entry?.source === "cold-start-equal-share").length;
  const perAccountLoad = Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : [];
  const byAccountPressure = perAccountLoad
    .map((entry) => {
      if (!isObject(entry) || typeof entry.label !== "string") return null;
      const label = normalizeLabel(entry.label);
      const carriedDemandWeight = roundDemandWeight(entry.carriedDemandWeight);
      const targetDemandWeight = roundDemandWeight(entry.targetDemandWeight);
      const pressureRatio =
        targetDemandWeight > 0 ? roundDemandWeight(carriedDemandWeight / targetDemandWeight) : null;
      const capacity = buildLabelCapacityInfo(liveUsage?.[label] ?? null);
      return {
        label,
        carriedAgentCount: Math.max(0, Math.round(normalizeDemandWeight(entry.carriedAgentCount, 0))),
        carriedDemandWeight,
        targetDemandWeight,
        ...(typeof entry.capacityBudgetWeight === "number"
          ? { capacityBudgetWeight: roundDemandWeight(entry.capacityBudgetWeight) }
          : {}),
        pressureRatio,
        overTargetDemandWeight: roundDemandWeight(Math.max(0, carriedDemandWeight - targetDemandWeight)),
        primaryRemainingPct: capacity.primaryRemainingPct,
        secondaryRemainingPct: capacity.secondaryRemainingPct,
      };
    })
    .filter(Boolean)
    .toSorted((a, b) => {
      const aRatio = Number.isFinite(a.pressureRatio) ? a.pressureRatio : -1;
      const bRatio = Number.isFinite(b.pressureRatio) ? b.pressureRatio : -1;
      if (aRatio !== bRatio) return bRatio - aRatio;
      return a.label.localeCompare(b.label);
    });

  const needMoreAccounts = blockedNoEligible >= 1 || noSpareExhaustions >= 2 || demandOverflowReceipts >= 1;
  let riskLevel = "low";
  if (needMoreAccounts) {
    riskLevel = "high";
  } else if (spareExhaustions >= 1 || warningReceipts >= 2) {
    riskLevel = "medium";
  }

  const reasons = [];
  if (blockedNoEligible > 0) reasons.push(`${blockedNoEligible} blocked receipt(s) reported no eligible pool account.`);
  if (demandOverflowReceipts > 0) reasons.push(`${demandOverflowReceipts} recent rebalance receipt(s) overflowed projected demand beyond eligible supply.`);
  if (noSpareExhaustions > 0) reasons.push(`${noSpareExhaustions} exhaustion event(s) occurred with no spare eligible capacity.`);
  if (spareExhaustions > 0) reasons.push(`${spareExhaustions} exhaustion event(s) occurred but spare eligible capacity existed.`);
  if (warningReceipts > 0) reasons.push(`${warningReceipts} recent receipt(s) completed with warnings.`);
  for (const pressure of byAccountPressure.filter((entry) => entry.overTargetDemandWeight > 0)) {
    reasons.push(
      `${pressure.label} is carrying ${pressure.carriedAgentCount} agent(s) at ${pressure.carriedDemandWeight} demand weight, above its ${pressure.targetDemandWeight} target.`,
    );
  }

  return {
    needMoreAccounts,
    riskLevel,
    reasons,
    basedOn: {
      horizonDays,
      lookbackDays,
      blockedNoEligible,
      demandOverflowReceipts,
      warningReceipts,
      spareExhaustions,
      noSpareExhaustions,
      currentHighUtilizationLabels,
      knownAgentDemandCount,
      coldStartAgentCount,
    },
    ...(byAccountPressure.length > 0 ? { byAccountPressure } : {}),
  };
}

function inferWindowHours(windowLabel) {
  const raw = String(windowLabel ?? "").trim();
  if (!raw) return null;
  const hoursMatch = raw.match(/^(\d+(?:\.\d+)?)h$/i);
  if (hoursMatch) {
    const hours = Number(hoursMatch[1]);
    return Number.isFinite(hours) && hours > 0 ? hours : null;
  }
  if (/^day$/i.test(raw)) return 24;
  if (/^week$/i.test(raw)) return 168;
  return null;
}

function roundMetric(value, decimals = 1) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** decimals;
  return Math.round(number * factor) / factor;
}

function formatMetricValue(value, { decimals = 1, suffix = "", integer = false } = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "--";
  const rendered = integer
    ? String(Math.round(number))
    : number.toFixed(decimals).replace(/\.0+$/, "").replace(/(\.\d*[1-9])0+$/, "$1");
  return `${rendered}${suffix}`;
}

function formatStatusBlockRows(rows) {
  const normalized = (Array.isArray(rows) ? rows : []).map((row) => [
    String(row?.[0] ?? ""),
    String(row?.[1] ?? ""),
    String(row?.[2] ?? ""),
  ]);
  if (normalized.length === 0) return [];
  const keyWidth = normalized.reduce((max, row) => Math.max(max, row[0].length), 0);
  const valueWidth = normalized.reduce((max, row) => Math.max(max, row[1].length), 0);
  return normalized.map(([key, value, extra]) => {
    const base = `${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}`.trimEnd();
    return extra ? `${base}  ${extra}` : base;
  });
}

function buildStatusDemandByAgent({ configuredAgents, agentDemand }) {
  const ids = Array.isArray(configuredAgents) ? configuredAgents : [];
  const ledger = isObject(agentDemand) ? agentDemand : {};
  const observed = ids
    .map((agentId) => normalizeDemandWeight(ledger[normalizeAgentId(agentId)]?.demandWeight, 0))
    .filter((weight) => weight > 0);
  const fallbackDemandWeight = Math.max(
    MIN_AGENT_DEMAND_WEIGHT,
    observed.length > 0 ? observed.reduce((sum, weight) => sum + weight, 0) / observed.length : MIN_AGENT_DEMAND_WEIGHT,
  );
  return Object.fromEntries(
    ids.map((agentIdRaw) => {
      const agentId = normalizeAgentId(agentIdRaw);
      const entry = isObject(ledger[agentId]) ? ledger[agentId] : {};
      return [
        agentId,
        {
          demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(entry.demandWeight, fallbackDemandWeight))),
          source:
            entry.source === "openclaw-session-tokens" || entry.source === "cold-start-equal-share"
              ? entry.source
              : "cold-start-equal-share",
        },
      ];
    }),
  );
}

function deriveDemandBucketWeights(demandByAgent) {
  const weights = Object.values(isObject(demandByAgent) ? demandByAgent : {})
    .map((entry) => normalizeDemandWeight(entry?.demandWeight, 0))
    .filter((weight) => weight > 0)
    .sort((a, b) => a - b);
  if (weights.length === 0) {
    return { lightWeight: 1, mediumWeight: 2, heavyWeight: 4 };
  }
  const pick = (fraction) => {
    const index = Math.max(0, Math.min(weights.length - 1, Math.floor((weights.length - 1) * fraction)));
    return weights[index];
  };
  const lightWeight = roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, pick(0.25)));
  const mediumWeight = roundDemandWeight(Math.max(lightWeight, pick(0.5)));
  const heavyWeight = roundDemandWeight(Math.max(mediumWeight, pick(0.75)));
  return { lightWeight, mediumWeight, heavyWeight };
}

function buildStatusLabelWeights({ eligibleLabels, liveUsage, demandByAgent, lastApplyReceipt }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  if (labels.length === 0) return {};

  const receiptEntries = new Map();
  for (const entry of Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : []) {
    if (!isObject(entry) || typeof entry.label !== "string") continue;
    const label = normalizeLabel(entry.label);
    receiptEntries.set(
      label,
      roundDemandWeight(
        Math.max(
          0,
          normalizeDemandWeight(entry.capacityBudgetWeight, normalizeDemandWeight(entry.targetDemandWeight, normalizeDemandWeight(entry.carriedDemandWeight, 0))),
        ),
      ),
    );
  }

  const totalDemandWeight = Object.values(isObject(demandByAgent) ? demandByAgent : {}).reduce(
    (sum, entry) => sum + normalizeDemandWeight(entry?.demandWeight, 0),
    0,
  );
  const totalRemainingPct = labels.reduce(
    (sum, label) => sum + Math.max(0, buildLabelCapacityInfo(liveUsage?.[label] ?? null).planningRemainingPct),
    0,
  );

  return Object.fromEntries(
    labels.map((label) => {
      const fromReceipt = receiptEntries.get(label);
      const fallbackWeight =
        totalDemandWeight > 0 && totalRemainingPct > 0
          ? (Math.max(0, buildLabelCapacityInfo(liveUsage?.[label] ?? null).planningRemainingPct) / totalRemainingPct) * totalDemandWeight
          : 1;
      return [label, roundDemandWeight(fromReceipt > 0 ? fromReceipt : fallbackWeight)];
    }),
  );
}

function buildAssignedDemandByLabel({ eligibleLabels, configuredAgents, currentAssignments, demandByAgent }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const labelSet = new Set(labels);
  const assignedDemandByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignedCountsByLabel = Object.fromEntries(labels.map((label) => [label, 0]));
  const assignments = isObject(currentAssignments) ? currentAssignments : {};
  const configuredSet = new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)));
  const demand = isObject(demandByAgent) ? demandByAgent : {};

  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    if (!configuredSet.has(agentId)) continue;
    if (typeof labelRaw !== "string") continue;
    const label = normalizeLabel(labelRaw);
    if (!labelSet.has(label)) continue;
    assignedCountsByLabel[label] += 1;
    assignedDemandByLabel[label] = roundDemandWeight(
      normalizeDemandWeight(assignedDemandByLabel[label], 0) + normalizeDemandWeight(demand[agentId]?.demandWeight, MIN_AGENT_DEMAND_WEIGHT),
    );
  }

  return { assignedDemandByLabel, assignedCountsByLabel };
}

function summarizePoolWindow({ eligibleLabels, liveUsage, labelWeights, index, now }) {
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const weights = isObject(labelWeights) ? labelWeights : {};
  let totalWeight = 0;
  let usedWeighted = 0;
  let remainingWeight = 0;
  let rateWeightPerHour = 0;
  let floorPct = null;
  let floorLabel = null;

  for (const label of labels) {
    const snapshot = liveUsage?.[label];
    const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
    const window = windows[index] ?? windows[windows.length - 1] ?? null;
    if (!window) continue;
    const weight = normalizeDemandWeight(weights[label], 0);
    if (weight <= 0) continue;
    const usedPct = clampPercent(window.usedPercent ?? 0);
    const remainingPct = clampPercent(100 - usedPct);
    totalWeight += weight;
    usedWeighted += weight * usedPct;
    remainingWeight += weight * (remainingPct / 100);
    if (floorPct === null || remainingPct < floorPct) {
      floorPct = remainingPct;
      floorLabel = label;
    }

    const totalHours = inferWindowHours(window.label);
    const resetAtMs = typeof window.resetAt === "number" ? window.resetAt : Number(window.resetAt);
    if (!Number.isFinite(totalHours) || totalHours <= 0 || !Number.isFinite(resetAtMs)) continue;
    const hoursRemaining = Math.max(0, Math.min(totalHours, (resetAtMs - now) / 3600000));
    const hoursElapsed = Math.max(0, totalHours - hoursRemaining);
    if (hoursElapsed <= 0 || usedPct <= 0) continue;
    rateWeightPerHour += (weight * (usedPct / 100)) / hoursElapsed;
  }

  const usedPct = totalWeight > 0 ? usedWeighted / totalWeight : 0;
  return {
    usedPct: roundMetric(usedPct, 1) ?? 0,
    remainingWeight: roundDemandWeight(remainingWeight),
    floorPct: roundMetric(floorPct ?? 0, 1) ?? 0,
    floorLabel,
    rateWeightPerHour: roundDemandWeight(rateWeightPerHour),
  };
}

function buildPoolInstrumentSummary({
  state,
  accounts,
  codexPool,
  liveUsage,
  agentDemand,
  currentAssignments,
  lastApplyReceipt,
  configuredCodexAgents,
  now = Date.now(),
}) {
  const poolLabels = getCodexPoolLabels(state).map((label) => normalizeLabel(label)).toSorted((a, b) => a.localeCompare(b));
  const accountMap = new Map((Array.isArray(accounts) ? accounts : []).map((account) => [account.label, account]));
  const readyLabels = poolLabels.filter((label) => accountMap.get(label)?.operator?.status === "ready");
  const observableLabels = readyLabels.filter((label) => {
    const windows = Array.isArray(liveUsage?.[label]?.windows) ? liveUsage[label].windows : [];
    return liveUsage?.[label]?.ok === true && windows.length > 0;
  });
  const receiptPerAccountLoad = Array.isArray(lastApplyReceipt?.perAccountLoad) ? lastApplyReceipt.perAccountLoad : [];
  const readyAccounts = readyLabels.length;
  const totalAccounts = poolLabels.length;
  const totalAgents = Array.isArray(configuredCodexAgents) ? configuredCodexAgents.length : 0;
  const demandByAgent = buildStatusDemandByAgent({ configuredAgents: configuredCodexAgents, agentDemand });
  const labelWeights = buildStatusLabelWeights({
    eligibleLabels: observableLabels,
    liveUsage,
    demandByAgent,
    lastApplyReceipt,
  });
  const { assignedDemandByLabel, assignedCountsByLabel } = buildAssignedDemandByLabel({
    eligibleLabels: poolLabels,
    configuredAgents: configuredCodexAgents,
    currentAssignments,
    demandByAgent,
  });
  const receiptAssignedLoadW = roundDemandWeight(
    receiptPerAccountLoad.reduce((sum, entry) => sum + normalizeDemandWeight(entry?.carriedDemandWeight, 0), 0),
  );
  const receiptActiveAgents = Math.max(
    0,
    Math.round(receiptPerAccountLoad.reduce((sum, entry) => sum + normalizeDemandWeight(entry?.carriedAgentCount, 0), 0)),
  );
  const assignedLoadW = receiptAssignedLoadW > 0
    ? receiptAssignedLoadW
    : roundDemandWeight(
        Object.values(assignedDemandByLabel).reduce((sum, weight) => sum + normalizeDemandWeight(weight, 0), 0),
      );
  const usableCapacityW = roundDemandWeight(
    observableLabels.reduce((sum, label) => sum + normalizeDemandWeight(labelWeights[label], 0), 0),
  );
  const spareW = roundDemandWeight(Math.max(0, usableCapacityW - assignedLoadW));
  const activeAgents = receiptActiveAgents > 0
    ? receiptActiveAgents
    : poolLabels.reduce((sum, label) => sum + Math.max(0, Math.round(normalizeDemandWeight(assignedCountsByLabel[label], 0))), 0);
  const poolLoadPct = usableCapacityW > 0 ? roundMetric((assignedLoadW / usableCapacityW) * 100, 1) ?? 0 : 0;
  const bucketWeights = deriveDemandBucketWeights(demandByAgent);
  const window5 = summarizePoolWindow({ eligibleLabels: observableLabels, liveUsage, labelWeights, index: 0, now });
  const window7 = summarizePoolWindow({ eligibleLabels: observableLabels, liveUsage, labelWeights, index: 1, now });
  const overTargetAccounts = receiptPerAccountLoad.filter((entry) => {
    if (!isObject(entry)) return false;
    return roundDemandWeight(Math.max(0, normalizeDemandWeight(entry.carriedDemandWeight, 0) - normalizeDemandWeight(entry.targetDemandWeight, 0))) > 0;
  }).length;
  const projectionRateWph = window7.rateWeightPerHour > 0 ? window7.rateWeightPerHour : window5.rateWeightPerHour;
  const projectLoadPct = (hours) => (
    usableCapacityW > 0 ? roundMetric(((assignedLoadW + projectionRateWph * hours) / usableCapacityW) * 100, 1) ?? 0 : 0
  );
  const overflowEtaH =
    projectionRateWph > 0
      ? (spareW > 0 ? roundMetric(spareW / projectionRateWph, 1) : 0)
      : null;
  const eta5 = window5.rateWeightPerHour > 0 ? roundMetric(window5.remainingWeight / window5.rateWeightPerHour, 1) : null;
  const eta7 = window7.rateWeightPerHour > 0 ? roundMetric(window7.remainingWeight / window7.rateWeightPerHour, 1) : null;
  const firstConstraint =
    eta5 !== null && (eta7 === null || eta5 <= eta7) ? "5h" : eta7 !== null ? "7d" : null;
  const firstConstraintLabel = firstConstraint === "5h" ? window5.floorLabel : firstConstraint === "7d" ? window7.floorLabel : null;

  return {
    pool_now: {
      ready_accounts: readyAccounts,
      total_accounts: totalAccounts,
      active_agents: activeAgents,
      total_agents: totalAgents,
      assigned_load_w: assignedLoadW,
      usable_capacity_w: usableCapacityW,
      pool_load_pct: poolLoadPct,
      spare_w: spareW,
      spare_heavy: Math.max(0, Math.floor(spareW / bucketWeights.heavyWeight)),
      spare_medium: Math.max(0, Math.floor(spareW / bucketWeights.mediumWeight)),
      spare_light: Math.max(0, Math.floor(spareW / bucketWeights.lightWeight)),
    },
    windows: {
      pool_5h_used_pct: window5.usedPct,
      pool_5h_remaining_w: window5.remainingWeight,
      pool_7d_used_pct: window7.usedPct,
      pool_7d_remaining_w: window7.remainingWeight,
      floor_5h_pct: window5.floorPct,
      floor_5h_label: window5.floorLabel,
      floor_7d_pct: window7.floorPct,
      floor_7d_label: window7.floorLabel,
    },
    pressure: {
      recent_overflows_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.demandOverflowReceipts, 0))),
      rebalances_blocked_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.blockedNoEligible, 0))),
      rebalances_warn_14d: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.warningReceipts, 0))),
      cold_start_agents: Math.max(0, Math.round(normalizeDemandWeight(codexPool?.capacityProjection?.basedOn?.coldStartAgentCount, 0))),
      over_target_accounts: overTargetAccounts,
    },
    projection: {
      load_pct_6h: projectLoadPct(6),
      load_pct_24h: projectLoadPct(24),
      load_pct_72h: projectLoadPct(72),
      load_pct_7d: projectLoadPct(24 * 7),
      overflow_eta_h: overflowEtaH,
      first_constraint: firstConstraint,
      first_constraint_label: firstConstraintLabel,
    },
  };
}

function readCodexCliTargetStatus({ state, homeDir }) {
  ensureStateShape(state);
  const importMeta = getAuthorityCodexImport(state);
  const target = getCodexTargetState(state);
  const codexHome = resolveManagedCodexHomeDir({ homeDir });
  let store = null;
  let storeError = null;

  try {
    store = readCodexCliStoreMode({ codexHome });
  } catch (err) {
    storeError = String(err?.message ?? err);
  }

  const readback = readCodexAuthFile({ codexHome });
  const activeLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const expectedAccountId = typeof target.expectedAccountId === "string" ? target.expectedAccountId.trim() : "";
  const actualAccountId = readback.ok ? readback.accountId : null;
  const inferredLabel = actualAccountId ? findCodexLabelByAccountId(state, actualAccountId) : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedCodexLabels(state),
    homeDir: codexHome,
    authPath: resolveCodexAuthFilePath(codexHome),
    storeMode: store?.storeMode ?? null,
    storeSource: store?.source ?? null,
    storeConfigPath: store?.configPath ?? resolveCodexConfigPath(codexHome),
    storeError,
    activeLabel: activeLabel || null,
    activeAccountPresent: activeLabel ? isObject(state.accounts[activeLabel]) : false,
    activeCredentialPresent: activeLabel ? isObject(getCodexCredential(state, activeLabel)) : false,
    expectedAccountId: expectedAccountId || null,
    actualAccountId: actualAccountId || null,
    inferredLabel: inferredLabel || null,
    readback,
    lastSelectionReceipt: isObject(target.lastSelectionReceipt) ? target.lastSelectionReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
  };
}

function buildWarningsFromCodexTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (status.storeError) {
    warnings.push({
      kind: "codex_target_config_invalid",
      system: "codex-cli",
      status: status.storeError,
    });
  } else if (status.storeMode && status.storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    warnings.push({
      kind: "codex_target_store_mode_unsupported",
      system: "codex-cli",
      status: status.storeMode,
    });
  }

  if (!status.importedLabels?.length && status.activeLabel) {
    warnings.push({
      kind: "codex_import_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "codex_target_label_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "codex_target_credentials_missing",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.readback.exists) {
    warnings.push({
      kind: "codex_target_missing_auth_file",
      system: "codex-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "codex_target_auth_unreadable",
      system: "codex-cli",
      status: status.readback.error,
    });
  }

  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    warnings.push({
      kind: "codex_target_account_mismatch",
      system: "codex-cli",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }

  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    warnings.push({
      kind: "codex_target_label_mismatch",
      system: "codex-cli",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return warnings;
}

function applyCodexCliFromState({ label, homeDir }, state) {
  ensureStateShape(state);
  if (!hasImportedCodexReplica(state) && getCodexPoolLabels(state).length === 0) {
    throw new Error(
      "No imported Codex replica is available on this machine yet. " +
        "Run `aim sync codex --from agents@amirs-mac-studio` first.",
    );
  }

  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown imported label: ${normalizedLabel}. Run \`aim status\` to inspect the imported pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"}.`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const codexHome = resolveManagedCodexHomeDir({ homeDir });
  const store = ensureFileBackedCodexHome({ codexHome });
  const appliedAt = new Date().toISOString();
  const authPayload = buildCodexAuthDotJson({ credential, lastRefreshAt: appliedAt });
  const writeResult = writeJsonFileIfChanged(resolveCodexAuthFilePath(codexHome), authPayload, { mode: 0o600 });
  const readback = readCodexAuthFile({ codexHome });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back managed Codex auth file: ${readback.error || "unknown error"}`);
  }
  if (readback.accountId !== credential.accountId) {
    throw new Error(
      `Codex readback mismatch after apply: expected accountId=${credential.accountId}, got ${readback.accountId || "none"}.`,
    );
  }

  const target = getCodexTargetState(state);
  target.homeDir = codexHome;
  target.activeLabel = normalizedLabel;
  target.expectedAccountId = credential.accountId;
  target.lastAppliedAt = appliedAt;

  return {
    label: normalizedLabel,
    accountId: credential.accountId,
    codexHome,
    authPath: readback.authPath,
    storeMode: store.storeMode,
    wrote: writeResult.wrote,
  };
}

function buildWarningsFromState(state) {
  const warnings = [];

  ensureStateShape(state);
  const accounts = isObject(state.accounts) ? state.accounts : {};
  const codexCredsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  const anthropicCredsByLabel = state.credentials[ANTHROPIC_PROVIDER];

  // Missing creds
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    if (provider === OPENAI_CODEX_PROVIDER && !isObject(codexCredsByLabel[label])) {
      warnings.push({ kind: "missing_credentials", provider: OPENAI_CODEX_PROVIDER, label });
    }
    if (provider === ANTHROPIC_PROVIDER && !isObject(anthropicCredsByLabel[label])) {
      warnings.push({ kind: "missing_credentials", provider: ANTHROPIC_PROVIDER, label });
    }
  }

  // Collisions (accountId -> multiple labels)
  const byAccountId = new Map();
  for (const [label, cred] of Object.entries(codexCredsByLabel)) {
    if (!isObject(cred)) continue;
    const accountId = typeof cred.accountId === "string" ? cred.accountId : null;
    if (!accountId) continue;
    const list = byAccountId.get(accountId) ?? [];
    list.push(label);
    byAccountId.set(accountId, list);
  }
  for (const [accountId, labels] of byAccountId.entries()) {
    if (labels.length > 1) {
      warnings.push({ kind: "account_id_collision", provider: OPENAI_CODEX_PROVIDER, accountId, labels });
    }
  }

  // Stored assignments pointing to missing labels/creds
  const assignments = getOpenclawAssignments(state);
  for (const [agentId, label] of Object.entries(assignments)) {
    if (typeof label !== "string") continue;
    if (!isObject(accounts[label])) {
      warnings.push({ kind: "assignment_points_to_missing_account", system: "openclaw", agentId, label });
      continue;
    }
    const provider = normalizeProviderId(accounts[label]?.provider);
    if (provider === OPENAI_CODEX_PROVIDER) {
      if (!isObject(codexCredsByLabel[label])) {
        warnings.push({ kind: "assignment_points_to_missing_credentials", system: "openclaw", agentId, label });
      }
      continue;
    }
    if (provider === ANTHROPIC_PROVIDER) {
      if (!isObject(anthropicCredsByLabel[label])) {
        warnings.push({
          kind: "assignment_points_to_missing_credentials",
          system: "openclaw",
          agentId,
          label,
          provider,
        });
      }
      continue;
    }

    warnings.push({ kind: "assignment_points_to_unsupported_provider", system: "openclaw", agentId, label, provider });
  }

  return warnings;
}

function buildWarningsFromStatusAccounts(accounts) {
  const warnings = [];
  const now = Date.now();

  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account) continue;
    const provider = normalizeProviderId(account.provider);
    const label = typeof account.label === "string" ? account.label : null;
    if (!label) continue;

    const expiresAt =
      account.credentials && typeof account.credentials.expiresAt === "string" ? account.credentials.expiresAt : null;
    const expiresMs = expiresAt ? parseExpiresAtToMs(expiresAt) : null;
    if (expiresMs !== null && expiresMs <= now) {
      warnings.push({
        kind: "credentials_expired",
        provider: provider || "unknown",
        label,
        expiresAt,
      });
    }

    const usage = account.usage;
    if (isObject(usage) && usage.ok !== true && usage.tokenExpired) {
      warnings.push({
        kind: "token_invalid_or_expired",
        provider: provider || "unknown",
        label,
        ...(usage.status ? { status: usage.status } : {}),
      });
    }

    if (provider === ANTHROPIC_PROVIDER && isObject(usage) && usage.ok === true && usage.opusUnavailable) {
      warnings.push({
        kind: "anthropic_opus_usage_unavailable",
        provider: ANTHROPIC_PROVIDER,
        label,
      });
    }
  }

  return warnings;
}

function buildInteractiveLoginStatus({ state, label }) {
  const binding = getInteractiveOAuthBindingForLabel(state, label);
  const mode = normalizeInteractiveOAuthMode(binding?.mode);
  return mode
    ? {
        mode,
        bindingPresent: Boolean(binding?.binding),
        ...(binding?.binding ? { binding: resolveBrowserBindingDisplay(binding.binding) } : {}),
      }
    : null;
}

async function buildStatusView({ statePath, state, homeDir }) {
  ensureStateShape(state);
  const usageByProvider = await probeUsageSnapshotsByProvider(state);
  const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
  const codexPool = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel: usageByProvider[OPENAI_CODEX_PROVIDER],
    now: Date.now(),
  });
  const accounts = [];

  for (const [label, account] of Object.entries(state.accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    const expectEmail = typeof account.expect?.email === "string" ? account.expect.email : null;
    const browserFacts = homeDir
      ? readBrowserFacts({ account, homeDir, label })
      : { exists: false, bindingPresent: false, mode: null };
    const login = buildInteractiveLoginStatus({ state, label });
    const cred =
      provider === OPENAI_CODEX_PROVIDER
        ? getCodexCredential(state, label)
        : provider === ANTHROPIC_PROVIDER
          ? getAnthropicCredential(state, label)
          : null;
    const expiresAt = cred && typeof cred.expiresAt === "string" ? cred.expiresAt : null;
    const accountId = cred && typeof cred.accountId === "string" ? cred.accountId : null;
    const usage = usageByProvider[provider]?.[label] ?? { provider, ok: false, status: cred ? "unknown" : "n/a" };
    const operator =
      provider === OPENAI_CODEX_PROVIDER
        ? (codexPool.byLabel[label]
          ?? {
            ...derivePoolAccountStatus({ account, label, credentials: cred, browserFacts, now: Date.now() }),
            eligible: false,
            poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
          })
        : derivePoolAccountStatus({ account, label, credentials: cred, browserFacts, now: Date.now() });

    accounts.push({
      label,
      provider: provider || "unknown",
      operator: {
        status: operator?.operatorStatus ?? "blocked",
        detailReason: operator?.detailReason ?? null,
        eligible: operator?.eligible === true,
        actionRequired: operator?.actionRequired ?? null,
        reason: operator?.reason ?? "Unknown account state.",
      },
      ...(login ? { login } : {}),
      browser: {
        bindingPresent: browserFacts.bindingPresent === true,
        exists: browserFacts.exists === true,
        ...(normalizeBrowserBindingMode(account.browser?.mode) ? { mode: normalizeBrowserBindingMode(account.browser?.mode) } : {}),
        ...(typeof account.browser?.seededFromOpenclawProfileId === "string" && account.browser.seededFromOpenclawProfileId.trim()
          ? { seededFromOpenclawProfileId: account.browser.seededFromOpenclawProfileId.trim() }
          : {}),
        ...(typeof account.browser?.seededAt === "string" && account.browser.seededAt.trim()
          ? { seededAt: account.browser.seededAt.trim() }
          : {}),
        ...(typeof account.browser?.verifiedAt === "string" && account.browser.verifiedAt.trim()
          ? { verifiedAt: account.browser.verifiedAt.trim() }
          : {}),
        ...(browserFacts.userDataDir ? { resolvedPath: browserFacts.userDataDir } : {}),
        ...(browserFacts.mode ? { resolvedMode: browserFacts.mode } : {}),
      },
      identity: {
        ...(expectEmail ? { expectEmail } : {}),
        ...(accountId ? { accountId } : {}),
        ...(browserFacts.userName ? { browserUserName: browserFacts.userName } : {}),
        ...(browserFacts.gaiaName ? { browserGaiaName: browserFacts.gaiaName } : {}),
      },
      credentials: {
        status: cred ? "ok" : "missing",
        ...(expiresAt ? { expiresAt } : {}),
        ...(expiresAt ? { expiresIn: formatExpiresIn(expiresAt) } : {}),
      },
      usage,
    });
  }

  const codexCli = readCodexCliTargetStatus({ state, homeDir });
  const openclawTarget = getOpenclawTargetState(state);
  const nextBestCandidate = pickNextBestPoolLabel({
    rankedCandidates: rankPoolCandidates({
      labels: codexPool.eligibleLabels,
      usage: usageByProvider[OPENAI_CODEX_PROVIDER],
      currentLabel: codexCli.activeLabel,
      currentAssignments: getOpenclawAssignments(state),
      configuredAgents: configuredCodexAgents,
      agentDemand: state.pool.openaiCodex.agentDemand,
      lastApplyReceipt: openclawTarget.lastApplyReceipt ?? null,
      now: Date.now(),
    }),
  });
  const capacity = projectPoolCapacity({
    history: state.pool.openaiCodex.history,
    liveUsage: usageByProvider[OPENAI_CODEX_PROVIDER],
    agentDemand: state.pool.openaiCodex.agentDemand,
    lastApplyReceipt: openclawTarget.lastApplyReceipt ?? null,
    now: Date.now(),
  });
  codexPool.capacityProjection = capacity;
  const poolInstrument = buildPoolInstrumentSummary({
    state,
    accounts,
    codexPool,
    liveUsage: usageByProvider[OPENAI_CODEX_PROVIDER],
    agentDemand: state.pool.openaiCodex.agentDemand,
    currentAssignments: getOpenclawAssignments(state),
    lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
    configuredCodexAgents,
    now: Date.now(),
  });

  const statusRank = { blocked: 0, reauth: 1, ready: 2 };
  const sortedAccounts = accounts.toSorted((a, b) => {
    const aRank = statusRank[a.operator?.status] ?? 99;
    const bRank = statusRank[b.operator?.status] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAt: new Date().toISOString(),
    statePath,
    accounts: sortedAccounts,
    openclaw: {
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      exclusions: sanitizeForStatus(getOpenclawExclusions(state)),
      lastApplyReceipt: sanitizeForStatus(getOpenclawTargetState(state).lastApplyReceipt ?? null),
      lastRebalancedAt:
        typeof getOpenclawTargetState(state).lastRebalancedAt === "string"
          ? getOpenclawTargetState(state).lastRebalancedAt
          : null,
    },
    nextBestCandidate: sanitizeForStatus(nextBestCandidate),
    pool_now: sanitizeForStatus(poolInstrument.pool_now),
    windows: sanitizeForStatus(poolInstrument.windows),
    pressure: sanitizeForStatus(poolInstrument.pressure),
    projection: sanitizeForStatus(poolInstrument.projection),
    capacity: sanitizeForStatus(capacity),
    imports: { authority: { codex: sanitizeForStatus(getAuthorityCodexImport(state)) } },
    codexCli: sanitizeForStatus(codexCli),
    warnings: [
      ...buildWarningsFromState(state),
      ...buildWarningsFromStatusAccounts(sortedAccounts),
      ...buildWarningsFromCodexTargetStatus(codexCli),
    ],
  };
}

function formatInteractiveLoginSummary(login) {
  const mode = normalizeInteractiveOAuthMode(login?.mode);
  if (mode === REAUTH_MODE_MANUAL_CALLBACK) {
    return "manual-callback";
  }
  const bindingMode = normalizeBrowserBindingMode(login?.binding?.mode);
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return "aim-profile";
  }
  if (bindingMode === BROWSER_MODE_CHROME_PROFILE) {
    return "chrome-profile";
  }
  if (bindingMode === BROWSER_MODE_AGENT_BROWSER) {
    const session = String(login?.binding?.agentBrowserSession ?? "").trim();
    return session ? `agent-browser:${session}` : "agent-browser";
  }
  if (mode === REAUTH_MODE_BROWSER_MANAGED) {
    return "browser-managed";
  }
  return null;
}

function formatStatusAccountExpiryCell(expiresIn) {
  const raw = String(expiresIn ?? "").trim();
  if (!raw || raw === "unknown") return "--";
  const expiredMatch = raw.match(/^expired \((.+)\)$/i);
  if (expiredMatch?.[1]) {
    return expiredMatch[1].trim();
  }
  return raw;
}

function formatStatusAccountUsedCell(usage, index) {
  if (!usage || usage.ok !== true) return "--";
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const usedPercent = windows[index]?.usedPercent;
  if (!Number.isFinite(Number(usedPercent))) return "--";
  return `${Math.round(Number(usedPercent))}%`;
}

function formatStatusAccountResetCell(usage, index) {
  if (!usage || usage.ok !== true) return "--";
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const resetAt = windows[index]?.resetAt;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return "--";
  const deltaHours = (ms - Date.now()) / 3600000;
  if (deltaHours <= 0) return "0h";
  if (deltaHours >= 48) {
    return `${(deltaHours / 24).toFixed(1)}d`;
  }
  return `${deltaHours.toFixed(1)}h`;
}

function buildStatusAccountFlags(account) {
  const flags = [];
  const detailReason = String(account?.operator?.detailReason ?? "").trim();
  if (detailReason === "missing_browser" || detailReason === "binding_missing_for_future_reauth") {
    flags.push("missing_browser");
  } else if (detailReason && detailReason !== "manual_mode") {
    flags.push(detailReason);
  }

  if (account?.usage?.ok === true) {
    const windows = Array.isArray(account.usage.windows) ? account.usage.windows : [];
    if (Number(windows[0]?.usedPercent) >= 100) {
      flags.push("5h_full");
    }
    if (Number(windows[1]?.usedPercent) >= 100) {
      flags.push("week_full");
    }
  }

  return flags.length > 0 ? flags.join(",") : "-";
}

function formatStatusTable(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (normalizedRows.length === 0) return [];
  const widths = normalizedRows[0].map((header, index) => (
    normalizedRows.reduce((max, row) => Math.max(max, String(row[index] ?? "").length), String(header ?? "").length)
  ));
  return normalizedRows.map((row) => (
    row
      .map((value, index) => String(value ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd()
  ));
}

function renderStatusCompactText(view) {
  const load = formatMetricValue(view.pool_now?.pool_load_pct, { decimals: 1, suffix: "%" });
  const spare = formatMetricValue(view.pool_now?.spare_w, { integer: true, suffix: "w" });
  const floor5 = formatMetricValue(view.windows?.floor_5h_pct, { decimals: 1, suffix: "%" });
  const floor7 = formatMetricValue(view.windows?.floor_7d_pct, { decimals: 1, suffix: "%" });
  const eta = formatMetricValue(view.projection?.overflow_eta_h, { decimals: 1, suffix: "h" });
  const floor5Label = typeof view.windows?.floor_5h_label === "string" && view.windows.floor_5h_label.trim() ? view.windows.floor_5h_label.trim() : "none";
  const floor7Label = typeof view.windows?.floor_7d_label === "string" && view.windows.floor_7d_label.trim() ? view.windows.floor_7d_label.trim() : "none";
  return `load=${load}  spare=${spare}  5h_floor=${floor5}(${floor5Label})  7d_floor=${floor7}(${floor7Label})  eta=${eta}\n`;
}

function resolveCurrentConfiguredCodexLabel(view) {
  const activeLabel = typeof view.codexCli?.activeLabel === "string" ? normalizeLabel(view.codexCli.activeLabel) : "";
  if (activeLabel) return activeLabel;
  const inferredLabel = typeof view.codexCli?.inferredLabel === "string" ? normalizeLabel(view.codexCli.inferredLabel) : "";
  return inferredLabel || "";
}

function renderCurrentCodexUsageText(view) {
  const label = resolveCurrentConfiguredCodexLabel(view) || "none";
  const account = Array.isArray(view.accounts) ? view.accounts.find((entry) => entry?.label === label) ?? null : null;
  return (
    `label=${label}` +
    `  5h_used=${formatStatusAccountUsedCell(account?.usage, 0)}` +
    `  5h_in=${formatStatusAccountResetCell(account?.usage, 0)}` +
    `  wk_used=${formatStatusAccountUsedCell(account?.usage, 1)}` +
    `  wk_in=${formatStatusAccountResetCell(account?.usage, 1)}\n`
  );
}

function renderStatusText(view, { showAssignments = false, showAccounts = true } = {}) {
  const lines = [];
  lines.push(`aim SSOT: ${view.statePath}`);

  const authoritySource =
    typeof view.imports?.authority?.codex?.source === "string" ? view.imports.authority.codex.source.trim() : "";
  const authorityImportedAt =
    typeof view.imports?.authority?.codex?.importedAt === "string" ? view.imports.authority.codex.importedAt.trim() : "";
  const importedLabels = Array.isArray(view.codexCli?.importedLabels) ? view.codexCli.importedLabels : [];
  if (authoritySource || importedLabels.length > 0) {
    lines.push(`Authority import: source=${authoritySource || "none"} labels=${importedLabels.length}`);
    if (authorityImportedAt) {
      lines.push(`Authority import age: ${formatAgeSince(authorityImportedAt)}`);
    }
  }
  lines.push("");

  lines.push("POOL NOW");
  lines.push(
    ...formatStatusBlockRows([
      ["ready_accounts", `${view.pool_now?.ready_accounts ?? 0}/${view.pool_now?.total_accounts ?? 0}`],
      ["active_agents", `${view.pool_now?.active_agents ?? 0}/${view.pool_now?.total_agents ?? 0}`],
      ["assigned_load_w", formatMetricValue(view.pool_now?.assigned_load_w, { integer: true })],
      ["usable_capacity_w", formatMetricValue(view.pool_now?.usable_capacity_w, { integer: true })],
      ["pool_load_pct", formatMetricValue(view.pool_now?.pool_load_pct, { decimals: 1 })],
      ["spare_w", formatMetricValue(view.pool_now?.spare_w, { integer: true })],
      ["spare_heavy", formatMetricValue(view.pool_now?.spare_heavy, { integer: true })],
      ["spare_medium", formatMetricValue(view.pool_now?.spare_medium, { integer: true })],
      ["spare_light", formatMetricValue(view.pool_now?.spare_light, { integer: true })],
    ]),
  );

  lines.push("");
  lines.push("WINDOWS");
  lines.push(
    ...formatStatusBlockRows([
      ["pool_5h_used_pct", formatMetricValue(view.windows?.pool_5h_used_pct, { decimals: 1 })],
      ["pool_5h_remaining_w", formatMetricValue(view.windows?.pool_5h_remaining_w, { integer: true })],
      ["pool_7d_used_pct", formatMetricValue(view.windows?.pool_7d_used_pct, { decimals: 1 })],
      ["pool_7d_remaining_w", formatMetricValue(view.windows?.pool_7d_remaining_w, { integer: true })],
      ["floor_5h_pct", formatMetricValue(view.windows?.floor_5h_pct, { decimals: 1 }), view.windows?.floor_5h_label ? `label=${view.windows.floor_5h_label}` : ""],
      ["floor_7d_pct", formatMetricValue(view.windows?.floor_7d_pct, { decimals: 1 }), view.windows?.floor_7d_label ? `label=${view.windows.floor_7d_label}` : ""],
    ]),
  );

  lines.push("");
  lines.push("PRESSURE");
  lines.push(
    ...formatStatusBlockRows([
      ["recent_overflows_14d", formatMetricValue(view.pressure?.recent_overflows_14d, { integer: true })],
      ["rebalances_blocked_14d", formatMetricValue(view.pressure?.rebalances_blocked_14d, { integer: true })],
      ["rebalances_warn_14d", formatMetricValue(view.pressure?.rebalances_warn_14d, { integer: true })],
      ["cold_start_agents", formatMetricValue(view.pressure?.cold_start_agents, { integer: true })],
      ["over_target_accounts", formatMetricValue(view.pressure?.over_target_accounts, { integer: true })],
    ]),
  );

  lines.push("");
  lines.push("PROJECTION @ CURRENT RATE");
  lines.push(
    ...formatStatusBlockRows([
      ["load_pct_6h", formatMetricValue(view.projection?.load_pct_6h, { decimals: 1 })],
      ["load_pct_24h", formatMetricValue(view.projection?.load_pct_24h, { decimals: 1 })],
      ["load_pct_72h", formatMetricValue(view.projection?.load_pct_72h, { decimals: 1 })],
      ["load_pct_7d", formatMetricValue(view.projection?.load_pct_7d, { decimals: 1 })],
      ["overflow_eta_h", formatMetricValue(view.projection?.overflow_eta_h, { decimals: 1 })],
      ["first_constraint", view.projection?.first_constraint || "--"],
      ["first_constraint_label", view.projection?.first_constraint_label || "--"],
    ]),
  );

  if (showAccounts) {
    lines.push("");
    lines.push(`ACCOUNTS (${view.accounts.length})`);
    const accountRows = [
      ["label", "st", "login", "exp", "5h_used", "5h_in", "wk_used", "wk_in", "provider", "flags"],
      ...view.accounts.map((account) => [
        account.label,
        account.operator?.status || "unknown",
        formatInteractiveLoginSummary(account.login) || "--",
        formatStatusAccountExpiryCell(account.credentials?.expiresIn),
        formatStatusAccountUsedCell(account.usage, 0),
        formatStatusAccountResetCell(account.usage, 0),
        formatStatusAccountUsedCell(account.usage, 1),
        formatStatusAccountResetCell(account.usage, 1),
        account.provider || "unknown",
        buildStatusAccountFlags(account),
      ]),
    ];
    lines.push(...formatStatusTable(accountRows));
  }

  const assignments = isObject(view.openclaw?.assignments) ? view.openclaw.assignments : {};
  const assignmentEntries = Object.entries(assignments);
  if (showAssignments && assignmentEntries.length > 0) {
    lines.push("");
    lines.push("OpenClaw assignments");
    for (const [agentId, label] of assignmentEntries.toSorted((x, y) => x[0].localeCompare(y[0]))) {
      lines.push(`- ${agentId} -> ${label}`);
    }
  }

  if (view.openclaw?.lastApplyReceipt?.status) {
    lines.push("");
    lines.push("LAST REBALANCE");
    lines.push(
      ...formatStatusBlockRows([
        ["status", view.openclaw.lastApplyReceipt.status || "--"],
        ["observed_at", view.openclaw.lastApplyReceipt.observedAt || "--"],
        ["allocation_mode", view.openclaw.lastApplyReceipt.allocationMode || "--"],
        ["moved_agents", formatMetricValue(view.openclaw.lastApplyReceipt.moved?.length ?? 0, { integer: true })],
      ]),
    );
    const perAccountLoad = Array.isArray(view.openclaw?.lastApplyReceipt?.perAccountLoad)
      ? view.openclaw.lastApplyReceipt.perAccountLoad
      : [];
    if (perAccountLoad.length > 0) {
      const spread = perAccountLoad
        .map((entry) => `${entry.label}=${entry.carriedAgentCount} agent(s)/${entry.carriedDemandWeight}w`)
        .join(", ");
      lines.push(`Spread: ${spread}`);
    }
  }

  if (view.codexCli) {
    lines.push("");
    lines.push("CODEX");
    lines.push(
      ...formatStatusBlockRows([
        ["active_label", view.codexCli.activeLabel || "none"],
        ["account_id", view.codexCli.actualAccountId || "--"],
        ["store", view.codexCli.storeMode || "unknown"],
        ["synced_age", view.codexCli.importedAt ? formatAgeSince(view.codexCli.importedAt.trim()) : "--"],
      ]),
    );
  }

  if (view.nextBestCandidate?.label) {
    lines.push("");
    lines.push("NEXT BEST CODEX");
    lines.push(
      ...formatStatusBlockRows([
        ["label", view.nextBestCandidate.label],
        ["primary_used_pct", formatMetricValue(view.nextBestCandidate.primaryUsedPct, { integer: true })],
        ["secondary_used_pct", formatMetricValue(view.nextBestCandidate.secondaryUsedPct, { integer: true })],
      ]),
    );
  }

  lines.push("");
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  lines.push(`WARNINGS (${warnings.length})`);
  for (const w of warnings.slice(0, 50)) {
    const parts = [`- ${w.kind}`];
    if (w.label) parts.push(`label=${w.label}`);
    if (w.provider) parts.push(`provider=${w.provider}`);
    if (w.agentId) parts.push(`agent=${w.agentId}`);
    if (w.accountId) parts.push(`accountId=${w.accountId}`);
    if (w.expectedAccountId) parts.push(`expectedAccountId=${w.expectedAccountId}`);
    if (w.actualLabel) parts.push(`actualLabel=${w.actualLabel}`);
    if (w.status) parts.push(`status=${w.status}`);
    lines.push(parts.join(" "));
  }

  lines.push("");
  lines.push(renderCurrentCodexUsageText(view).trimEnd());

  return `${lines.join("\n")}\n`;
}

function resolveProviderPanelLabel(provider) {
  if (provider === OPENAI_CODEX_PROVIDER) return "ChatGPT login";
  if (provider === ANTHROPIC_PROVIDER) return "Claude login";
  return "Login";
}

function resolveProviderHomeUrl(provider) {
  if (provider === OPENAI_CODEX_PROVIDER) return "https://chatgpt.com";
  if (provider === ANTHROPIC_PROVIDER) return "https://claude.ai";
  return null;
}

function resolveCredentialHealth(credential) {
  if (!isObject(credential)) return "unknown";
  const expiresAt = parseExpiresAtToMs(credential.expiresAt);
  if (!expiresAt) return "unknown";
  if (expiresAt <= Date.now()) return "expired";
  return "valid";
}

function summarizeBrowserBindingForPanel({ binding, reauthMode }) {
  if (reauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return "manual callback";
  }
  if (!binding) {
    return "not configured";
  }
  if (binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return "AIM browser";
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    const profileDirectory = normalizeChromeProfileDirectory(binding.profileDirectory);
    return profileDirectory ? `Chrome profile / ${profileDirectory}` : "Chrome profile";
  }
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    const session = String(binding.agentBrowserSession ?? "").trim();
    return session ? `agent-browser / ${session}` : "agent-browser";
  }
  return binding.mode;
}

function describeConcreteBrowserTarget(binding) {
  if (!binding) return "no configured browser binding";
  if (binding.mode === BROWSER_MODE_AIM_PROFILE) {
    return binding.userDataDir
      ? `AIM browser path ${binding.userDataDir}`
      : "the AIM browser path for this label";
  }
  if (binding.mode === BROWSER_MODE_CHROME_PROFILE) {
    return formatChromeBrowserTarget({
      userDataDir: binding.userDataDir,
      profileDirectory: binding.profileDirectory,
      fallback: "the saved Chrome profile",
    });
  }
  if (binding.mode === BROWSER_MODE_AGENT_BROWSER) {
    return formatAgentBrowserTarget({
      session: binding.agentBrowserSession,
      profile: binding.agentBrowserProfile,
      fallback: "the saved agent-browser binding",
    });
  }
  return `browser mode ${binding.mode}`;
}

function buildBrowserSetupMenuOptions({ label, homeDir, suggestions, discoveryWarning }) {
  const normalizedLabel = normalizeLabel(label);
  const suggested = Array.isArray(suggestions) ? suggestions : [];
  const topSuggestion = suggested[0] ?? null;
  const aimPath = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  const agentBrowserOption = topSuggestion
    ? {
        key: "1",
        action: "setup_agent_browser",
        label: "Use the likely agent browser",
        details: buildSuggestedAgentBrowserDetails(topSuggestion, {
          label: normalizedLabel,
          prefix: "Next screen will offer",
        }),
      }
    : {
        key: "1",
        action: "setup_agent_browser",
        label: "Use an agent-browser profile",
        details: [
          `Will ask for an explicit agent-browser profile path and session, then save them for ${normalizedLabel}.`,
          ...(discoveryWarning
            ? [`AIM could not prefill a likely match because suggestion lookup failed: ${discoveryWarning}`]
            : []),
        ],
      };

  return [
    agentBrowserOption,
    {
      key: "2",
      action: "setup_aim_profile",
      label: "Use an AIM browser",
      details: [`Will save AIM browser path ${aimPath} and then start login for ${normalizedLabel}.`],
    },
    {
      key: "3",
      action: "setup_chrome_profile",
      label: "Use another Chrome profile",
      details: buildChromeSetupOptionDetails({ label: normalizedLabel, homeDir }),
    },
    {
      key: "4",
      action: "setup_manual_callback",
      label: "Manual callback login",
      details: [
        `Will not use a local browser for ${normalizedLabel}.`,
        "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
      ],
    },
    {
      key: "5",
      action: "show_details",
      label: "Show advanced details",
      details: [`Will print the raw provider, credential, and browser-binding JSON for ${normalizedLabel}.`],
    },
    {
      key: "0",
      action: "done",
      label: "Cancel",
      details: ["Makes no changes."],
    },
  ];
}

function buildLabelControlPanelState({ state, label, homeDir }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: account.provider });

  const provider = normalizeProviderId(account.provider);
  const credential =
    provider === OPENAI_CODEX_PROVIDER
      ? getCodexCredential(state, normalizedLabel)
      : provider === ANTHROPIC_PROVIDER
        ? getAnthropicCredential(state, normalizedLabel)
        : null;
  const browserFacts = readBrowserFacts({ account, homeDir, label: normalizedLabel });
  const operator = derivePoolAccountStatus({
    account,
    label: normalizedLabel,
    credentials: credential,
    browserFacts,
    now: Date.now(),
  });
  const reauthMode = normalizeInteractiveOAuthMode(account?.reauth?.mode);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const credentialHealth = resolveCredentialHealth(credential);
  const needsSetup =
    !reauthMode
    || (reauthMode === REAUTH_MODE_BROWSER_MANAGED && !binding && credentialHealth !== "valid");

  let panelKind = "ready";
  if (needsSetup) {
    panelKind = "setup";
  } else if (operator?.operatorStatus === "blocked") {
    panelKind = "blocked";
  } else if (operator?.operatorStatus === "reauth") {
    panelKind = "reauth";
  }

  let reason = null;
  if (panelKind === "setup") {
    reason = !reauthMode
      ? "No login mode is configured yet."
      : operator?.reason ?? "Finish browser/login setup for this label.";
  } else if (typeof operator?.reason === "string" && operator.reason.trim()) {
    reason = operator.reason.trim();
  }

  return {
    label: normalizedLabel,
    provider,
    providerLabel: resolveProviderPanelLabel(provider),
    credentialHealth,
    reauthMode,
    binding,
    browserFacts,
    operator,
    panelKind,
    reason,
    browserSummary: summarizeBrowserBindingForPanel({ binding, reauthMode }),
  };
}

function renderLabelControlPanel(panelState) {
  const lines = [];
  const provider = panelState.provider || "provider-not-set";
  lines.push(`${panelState.label} · ${provider}`);
  lines.push(`Status: ${panelState.panelKind === "setup" ? "setup needed" : panelState.panelKind}`);
  if (panelState.reason) {
    lines.push(`Why: ${panelState.reason}`);
  }
  lines.push(`${panelState.providerLabel}: ${panelState.credentialHealth}`);
  lines.push(`Browser: ${panelState.browserSummary}`);
  process.stdout.write(`${lines.join("\n")}\n\n`);
}

function buildLabelPanelActions(panelState, { homeDir, suggestions, discoveryWarning } = {}) {
  if (panelState.panelKind === "setup") {
    return buildBrowserSetupMenuOptions({
      label: panelState.label,
      homeDir,
      suggestions,
      discoveryWarning,
    });
  }

  const actions = [];
  const canReauth = panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK || Boolean(panelState.binding);
  const providerUrl = resolveProviderHomeUrl(panelState.provider);
  const browserTarget = describeConcreteBrowserTarget(panelState.binding);
  if (panelState.panelKind === "reauth" && canReauth) {
    actions.push({
      key: "1",
      action: "reauth_now",
      label: "Reauth now",
      details:
        panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK
          ? [
              "Will try token refresh first.",
              "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
            ]
          : [
              "Will try token refresh first.",
              `If refresh is not enough, AIM will open ${providerUrl || "the provider login page"} using ${browserTarget}.`,
            ],
    });
  }
  if (panelState.binding) {
    actions.push({
      key: String(actions.length + 1),
      action: "open_browser",
      label: "Open browser",
      details: [`Will open ${providerUrl || "the provider home page"} using ${browserTarget}.`],
    });
  }
  if (panelState.panelKind !== "reauth" && canReauth) {
    actions.push({
      key: String(actions.length + 1),
      action: "reauth_now",
      label: "Reauth / refresh login",
      details:
        panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK
          ? [
              "Will try token refresh first.",
              "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
            ]
          : [
              "Will try token refresh first.",
              `If refresh is not enough, AIM will open ${providerUrl || "the provider login page"} using ${browserTarget}.`,
            ],
    });
  }
  actions.push({
    key: String(actions.length + 1),
    action: "change_browser_setup",
    label: "Change browser setup",
    details: panelState.binding
      ? [
          `Current browser binding: ${browserTarget}.`,
          `Will reopen setup and only save a different binding for ${panelState.label} if you confirm it.`,
        ]
      : [`Will reopen setup and save a browser/login path for ${panelState.label}.`],
  });
  actions.push({
    key: String(actions.length + 1),
    action: "show_details",
    label: "Show details",
    details: [`Will print the raw provider, credential, and browser-binding JSON for ${panelState.label}.`],
  });
  actions.push({
    key: "0",
    action: "done",
    label: "Done",
    details: ["Makes no changes."],
  });
  return actions;
}

function showLabelAdvancedDetails({ state, label, homeDir }) {
  const details = showBrowserBinding({ state, label, homeDir });
  process.stdout.write(`${JSON.stringify(sanitizeForStatus(details), null, 2)}\n\n`);
}

async function promptMappedChromeBinding({ state, label, promptLineImpl = promptLine }) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userDataDir = await promptLineImpl(`Chrome user-data-dir for "${label}" (absolute path):`);
    const profileDirectory = await promptLineImpl(
      `Chrome profile-directory for "${label}" (blank for Default):`,
      { defaultValue: "" },
    );
    try {
      const updated = setBrowserBinding({
        state,
        label,
        mode: BROWSER_MODE_CHROME_PROFILE,
        userDataDir,
        profileDirectory: String(profileDirectory ?? "").trim() || null,
      });
      return { configured: true, updated };
    } catch (err) {
      process.stdout.write(`${String(err?.message ?? err)}\n`);
    }
  }
}

async function chooseDiscoveredChromeBinding({
  state,
  label,
  candidates,
  promptLineImpl = promptLine,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return promptMappedChromeBinding({ state, label, promptLineImpl });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const options = candidates.map((candidate, index) => ({
      key: String(index + 1),
      label: buildChromeProfileChoiceLabel(candidate),
      details: buildChromeProfileChoiceDetails(candidate, {
        label,
        prefix: "Will save",
      }),
    }));
    const manualKey = String(candidates.length + 1);
    options.push({
      key: manualKey,
      label: "Enter another Chrome user-data-dir/profile-directory",
      details: [
        `Will ask for an absolute Chrome user-data-dir and optional profile-directory, then save them for ${label}.`,
      ],
    });
    options.push({ key: "0", label: "Back", details: ["Makes no changes."] });
    const choice = await promptMenuChoice({
      title: `Discovered Chrome profiles for ${label}`,
      options,
      promptLineImpl,
    });
    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === manualKey) {
      return promptMappedChromeBinding({ state, label, promptLineImpl });
    }

    const candidate = candidates[Number(choice) - 1];
    const confirm = await promptMenuChoice({
      title: `Use this Chrome profile for ${label}?`,
      options: [
        {
          key: "1",
          label: "Yes, save it",
          details: buildChromeProfileChoiceDetails(candidate, {
            label,
            prefix: "Will save",
          }),
        },
        { key: "0", label: "Back", details: ["Makes no changes."] },
      ],
      promptLineImpl,
    });
    if (confirm !== "1") {
      continue;
    }

    const updated = setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_CHROME_PROFILE,
      userDataDir: candidate.userDataDir,
      profileDirectory: candidate.profileDirectory,
    });
    return { configured: true, updated, candidate };
  }
}

async function promptManualAgentBrowserBinding({ state, label, promptLineImpl = promptLine }) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const agentBrowserProfile = await promptLineImpl(`agent-browser profile path for "${label}" (absolute path):`);
    const agentBrowserSession = await promptLineImpl(`agent-browser session for "${label}":`);
    try {
      const updated = setBrowserBinding({
        state,
        label,
        mode: BROWSER_MODE_AGENT_BROWSER,
        agentBrowserProfile,
        agentBrowserSession,
      });
      return { configured: true, updated };
    } catch (err) {
      process.stdout.write(`${String(err?.message ?? err)}\n`);
    }
  }
}

async function chooseSuggestedAgentBrowserBinding({
  state,
  label,
  candidates,
  promptLineImpl = promptLine,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return promptManualAgentBrowserBinding({ state, label, promptLineImpl });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const options = candidates.map((candidate, index) => ({
      key: String(index + 1),
      label: candidate.display,
      details: buildSuggestedAgentBrowserDetails(candidate, {
        label,
        prefix: "Will save",
      }),
    }));
    const manualKey = String(candidates.length + 1);
    options.push({
      key: manualKey,
      label: "Enter another agent-browser profile/session",
      details: [`Will ask for an explicit profile path and session, then save them for ${label}.`],
    });
    options.push({ key: "0", label: "Back", details: ["Makes no changes."] });
    const choice = await promptMenuChoice({
      title: `Suggested browser bindings for ${label}`,
      options,
      promptLineImpl,
    });
    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === manualKey) {
      return promptManualAgentBrowserBinding({ state, label, promptLineImpl });
    }

    const candidate = candidates[Number(choice) - 1];
    const confirm = await promptMenuChoice({
      title: `Use this browser binding for ${label}?`,
      options: [
        {
          key: "1",
          label: "Yes, save it",
          details: buildSuggestedAgentBrowserDetails(candidate, {
            label,
            prefix: "Will save",
          }),
        },
        { key: "0", label: "Back", details: ["Makes no changes."] },
      ],
      promptLineImpl,
    });
    if (confirm !== "1") {
      continue;
    }

    const updated = setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_AGENT_BROWSER,
      agentBrowserProfile: candidate.agentBrowserProfile,
      agentBrowserSession: candidate.agentBrowserSession,
    });
    return { configured: true, updated, candidate };
  }
}

function loadSuggestedBrowserBindings({
  label,
  repoRoot,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
}) {
  try {
    return {
      suggestions: discoverSuggestedBrowserBindings({
        label,
        repoRoot,
        bindings: readOpenclawBindingsFromConfigImpl(),
        agentsList: readOpenclawAgentsListFromConfigImpl(),
      }),
      discoveryWarning: null,
    };
  } catch (err) {
    return {
      suggestions: [],
      discoveryWarning: String(err?.message ?? err),
    };
  }
}

async function runBrowserBindingWizard({
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
}) {
  const normalizedLabel = normalizeLabel(label);
  let { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
    label: normalizedLabel,
    repoRoot,
    readOpenclawBindingsFromConfigImpl,
    readOpenclawAgentsListFromConfigImpl,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (discoveryWarning) {
      process.stdout.write(`Suggestion lookup unavailable: ${discoveryWarning}\n`);
      discoveryWarning = null;
    }

    const choice = await promptMenuChoice({
      title: "What do you want to do?",
      options: buildBrowserSetupMenuOptions({
        label: normalizedLabel,
        homeDir,
        suggestions,
        discoveryWarning,
      }).map(({ key, label: optionLabel, details }) => ({ key, label: optionLabel, details })),
      promptLineImpl,
    });

    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === "5") {
      showLabelAdvancedDetails({ state, label: normalizedLabel, homeDir });
      continue;
    }
    if (choice === "4") {
      const updated = setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK });
      return { configured: true, updated };
    }
    if (choice === "2") {
      const updated = setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE });
      return { configured: true, updated };
    }
    if (choice === "3") {
      return chooseDiscoveredChromeBinding({
        state,
        label: normalizedLabel,
        candidates: discoverSelectableChromeBindings({ homeDir, label: normalizedLabel }),
        promptLineImpl,
      });
    }

    const result = await chooseSuggestedAgentBrowserBinding({
      state,
      label: normalizedLabel,
      candidates: suggestions,
      promptLineImpl,
    });
    if (!result.cancelled) {
      return result;
    }
  }
}

async function performLabelMaintenance({
  state,
  label,
  homeDir,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  loginAnthropicImpl = loginAnthropic,
  refreshAnthropicImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: normalizedLabel,
    promptLineImpl,
  });
  const attemptedAt = recordAccountMaintenanceAttempt(state, normalizedLabel);

  try {
    if (provider === OPENAI_CODEX_PROVIDER) {
      const interactiveBinding = await ensureOpenAICodexInteractiveLoginBinding({
        state,
        label: normalizedLabel,
        homeDir,
        promptLineImpl,
      });
      const cred = await refreshOrLoginCodex({
        state,
        label: normalizedLabel,
        homeDir,
        interactiveBinding,
        loginImpl: loginOpenAICodexImpl,
        refreshImpl: refreshOpenAICodexImpl,
        promptImpl,
        openUrlImpl,
      });
      state.credentials[OPENAI_CODEX_PROVIDER][normalizedLabel] = cred;
    } else if (provider === ANTHROPIC_PROVIDER) {
      const interactiveBinding = await ensureInteractiveLoginBindingForProvider({
        state,
        label: normalizedLabel,
        homeDir,
        provider: ANTHROPIC_PROVIDER,
        promptLineImpl,
      });
      const cred = await refreshOrLoginAnthropic({
        state,
        label: normalizedLabel,
        homeDir,
        interactiveBinding,
        loginImpl: loginAnthropicImpl,
        refreshImpl: refreshAnthropicImpl,
        promptImpl,
        openUrlImpl,
      });
      state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = cred;
    } else {
      throw new Error(`Provider not supported: ${provider}`);
    }

    recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
    state.schemaVersion = SCHEMA_VERSION;
    return {
      ok: true,
      label: normalizedLabel,
      provider,
      maintenance: {
        status: "ready",
        observedAt: attemptedAt,
      },
    };
  } catch (err) {
    const message = String(err?.message ?? err);
    recordAccountMaintenanceFailure(state, normalizedLabel, {
      observedAt: attemptedAt,
      ...(message.match(/conflict|does not match|unsupported/i) ? { blockedReason: message } : {}),
    });
    state.schemaVersion = SCHEMA_VERSION;
    throw err;
  }
}

function reportPanelActionError(err) {
  process.stdout.write(`${String(err?.message ?? err)}\n\n`);
}

async function runLabelPanelAction({
  action,
  statePath,
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  loginAnthropicImpl = loginAnthropic,
  refreshAnthropicImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  if (action === "done") {
    return { done: true };
  }

  if (action === "show_details") {
    showLabelAdvancedDetails({ state, label: normalizedLabel, homeDir });
    return { done: false };
  }

  if (action === "open_browser") {
    const account = getAccountRecord(state, normalizedLabel, { create: true });
    const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
    if (!binding) {
      process.stdout.write(`No browser binding is configured for ${normalizedLabel}.\n\n`);
      return { done: false };
    }
    const provider = normalizeProviderId(account.provider);
    const url = resolveProviderHomeUrl(provider);
    if (!url) {
      process.stdout.write(`No browser home URL is configured for provider=${provider || "unknown"}.\n\n`);
      return { done: false };
    }
    const opened = openUrlImpl({ binding, url, homeDir });
    if (!opened.ok) {
      if (opened.reason === "missing_browser_path") {
        process.stdout.write(`Configured browser path is missing: ${opened.path}\n\n`);
      } else {
        process.stdout.write(`Failed to open browser (${formatBrowserLaunchFailure(opened)}).\n\n`);
      }
      return { done: false };
    }
    process.stdout.write(`Opened ${normalizedLabel} in ${summarizeBrowserBindingForPanel({ binding, reauthMode: account?.reauth?.mode })}.\n\n`);
    return { done: false };
  }

  if (
    action === "setup_agent_browser"
    || action === "setup_aim_profile"
    || action === "setup_chrome_profile"
    || action === "setup_manual_callback"
    || action === "change_browser_setup"
  ) {
    try {
      let configured = null;
      if (action === "setup_aim_profile") {
        configured = { configured: true, updated: setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE }) };
      } else if (action === "setup_chrome_profile") {
        configured = await chooseDiscoveredChromeBinding({
          state,
          label: normalizedLabel,
          candidates: discoverSelectableChromeBindings({ homeDir, label: normalizedLabel }),
          promptLineImpl,
        });
      } else if (action === "setup_manual_callback") {
        configured = { configured: true, updated: setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK }) };
      } else if (action === "setup_agent_browser") {
        const { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
          label: normalizedLabel,
          repoRoot,
          readOpenclawBindingsFromConfigImpl,
          readOpenclawAgentsListFromConfigImpl,
        });
        if (discoveryWarning) {
          process.stdout.write(`Suggestion lookup unavailable: ${discoveryWarning}\n`);
        }
        configured = await chooseSuggestedAgentBrowserBinding({
          state,
          label: normalizedLabel,
          candidates: suggestions,
          promptLineImpl,
        });
      } else {
        configured = await runBrowserBindingWizard({
          state,
          label: normalizedLabel,
          homeDir,
          repoRoot,
          promptLineImpl,
          readOpenclawBindingsFromConfigImpl,
          readOpenclawAgentsListFromConfigImpl,
        });
      }

      if (!configured?.configured) {
        process.stdout.write("Browser setup unchanged.\n\n");
        return { done: false };
      }

      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`Saved browser setup for ${normalizedLabel}.\n\n`);

      if (action !== "change_browser_setup") {
        try {
          await performLabelMaintenance({
            state,
            label: normalizedLabel,
            homeDir,
            promptLineImpl,
            promptImpl,
            openUrlImpl,
            loginOpenAICodexImpl,
            refreshOpenAICodexImpl,
            loginAnthropicImpl,
            refreshAnthropicImpl,
          });
          writeJsonFileWithBackup(statePath, state);
          process.stdout.write(`${normalizedLabel} is ready.\n\n`);
        } catch (err) {
          writeJsonFileWithBackup(statePath, state);
          reportPanelActionError(err);
        }
      }
      return { done: false };
    } catch (err) {
      reportPanelActionError(err);
      return { done: false };
    }
  }

  if (action === "reauth_now") {
    try {
      await performLabelMaintenance({
        state,
        label: normalizedLabel,
        homeDir,
        promptLineImpl,
        promptImpl,
        openUrlImpl,
        loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        loginAnthropicImpl,
        refreshAnthropicImpl,
      });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${normalizedLabel} is ready.\n\n`);
    } catch (err) {
      writeJsonFileWithBackup(statePath, state);
      reportPanelActionError(err);
    }
    return { done: false };
  }

  throw new Error(`Unsupported panel action: ${action}`);
}

export async function runLabelControlPanel({
  statePath,
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  loginAnthropicImpl = loginAnthropic,
  refreshAnthropicImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  const beforeProvider = getAccountRecord(state, normalizedLabel)?.provider ?? null;
  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: normalizedLabel,
    promptLineImpl,
  });
  if (provider && provider !== beforeProvider) {
    writeJsonFileWithBackup(statePath, state);
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
      label: normalizedLabel,
      repoRoot,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
    });
    const panelState = buildLabelControlPanelState({
      state,
      label: normalizedLabel,
      homeDir,
    });
    renderLabelControlPanel(panelState);
    const actions = buildLabelPanelActions(panelState, {
      homeDir,
      suggestions,
      discoveryWarning,
    });
    const choice = await promptMenuChoice({
      title: "What do you want to do?",
      options: actions.map(({ key, label: actionLabel, details }) => ({ key, label: actionLabel, details })),
      promptLineImpl,
    });
    const selected = actions.find((action) => action.key === choice);
    const result = await runLabelPanelAction({
      action: selected?.action,
      statePath,
      state,
      label: normalizedLabel,
      homeDir,
      repoRoot,
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      loginAnthropicImpl,
      refreshAnthropicImpl,
    });
    if (result?.done) {
      return {
        ok: true,
        label: normalizedLabel,
      };
    }
  }
}

function assertNoUnexpectedBrowserSetOptions(mode, opts) {
  if (mode === REAUTH_MODE_MANUAL_CALLBACK) {
    if (opts.seedFromOpenclaw || opts.userDataDir || opts.profileDirectory || opts.profile || opts.session) {
      throw new Error("`aim browser set --mode manual-callback` does not accept browser path/session flags.");
    }
    return;
  }
  if (mode === BROWSER_MODE_AIM_PROFILE) {
    if (opts.userDataDir || opts.profileDirectory || opts.profile || opts.session) {
      throw new Error("`aim browser set --mode aim-profile` only supports optional --seed-from-openclaw <profileId>.");
    }
    return;
  }
  if (mode === BROWSER_MODE_CHROME_PROFILE) {
    if (opts.seedFromOpenclaw || opts.profile || opts.session) {
      throw new Error(
        "`aim browser set --mode chrome-profile` only supports --user-data-dir <abs-path> and optional --profile-directory <name>.",
      );
    }
    return;
  }
  if (mode === BROWSER_MODE_AGENT_BROWSER && (opts.seedFromOpenclaw || opts.userDataDir)) {
    throw new Error("`aim browser set --mode agent-browser` requires --profile <abs-path> and --session <name> only.");
  }
}

function setBrowserBindingFromCli({ state, label, opts }) {
  const requestedModeRaw = String(opts.mode ?? "").trim();
  if (!requestedModeRaw) {
    throw new Error(
      "Missing --mode for `aim browser set`. Supported: aim-profile, chrome-profile, agent-browser, manual-callback.",
    );
  }

  if (requestedModeRaw === "generic-chrome") {
    throw new Error(
      "Unsupported browser mode: generic-chrome. Use `--mode chrome-profile --user-data-dir <abs-path>` instead.",
    );
  }

  const requestedReauthMode = normalizeInteractiveOAuthMode(requestedModeRaw);
  if (requestedReauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
    assertNoUnexpectedBrowserSetOptions(REAUTH_MODE_MANUAL_CALLBACK, opts);
    return setBrowserBinding({ state, label, mode: REAUTH_MODE_MANUAL_CALLBACK });
  }

  const bindingMode = normalizeBrowserBindingMode(requestedModeRaw);
  if (!bindingMode) {
    throw new Error(
      `Unsupported browser mode: ${requestedModeRaw}. Supported: aim-profile, chrome-profile, agent-browser, manual-callback.`,
    );
  }

  assertNoUnexpectedBrowserSetOptions(bindingMode, opts);
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_AIM_PROFILE,
      seedFromOpenclaw: opts.seedFromOpenclaw,
    });
  }
  if (bindingMode === BROWSER_MODE_CHROME_PROFILE) {
    if (!opts.userDataDir) {
      throw new Error("`aim browser set --mode chrome-profile` requires --user-data-dir <abs-path>.");
    }
    return setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_CHROME_PROFILE,
      userDataDir: opts.userDataDir,
      profileDirectory: opts.profileDirectory,
    });
  }
  if (!opts.profile || !opts.session) {
    throw new Error("`aim browser set --mode agent-browser` requires --profile <abs-path> and --session <name>.");
  }
  return setBrowserBinding({
    state,
    label,
    mode: BROWSER_MODE_AGENT_BROWSER,
    agentBrowserProfile: opts.profile,
    agentBrowserSession: opts.session,
  });
}

function applyOpenclawFromState(params, state, { pinsOverride, managedAgentIds } = {}) {
  const homeDir = resolveHomeDir(params.home);
  ensureStateShape(state);

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const supportedProviders = [OPENAI_CODEX_PROVIDER, ANTHROPIC_PROVIDER];
  const supportedProviderSet = new Set(supportedProviders);
  const assignments = isObject(pinsOverride) ? pinsOverride : getOpenclawPins(state);
  const managedAgentIdSet = new Set(
    (Array.isArray(managedAgentIds) ? managedAgentIds : []).map((agentId) => normalizeAgentId(agentId)),
  );
  const assignedLabelsByProvider = new Map(supportedProviders.map((provider) => [provider, new Set()]));
  const assignedLabelByAgentId = new Map();

  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const account = accounts[label];
    if (!isObject(account)) {
      throw new Error(`OpenClaw assignment references missing account: agent=${agentId} label=${label}`);
    }
    const provider = normalizeProviderId(account.provider);
    if (!supportedProviderSet.has(provider)) {
      throw new Error(`OpenClaw assignment references unsupported provider: agent=${agentId} label=${label} provider=${provider}`);
    }
    const credsByLabel = state.credentials[provider];
    if (!isObject(credsByLabel?.[label])) {
      throw new Error(`OpenClaw assignment references label with missing credentials: agent=${agentId} label=${label} provider=${provider}`);
    }
    assignedLabelsByProvider.get(provider).add(label);
    assignedLabelByAgentId.set(agentId, label);
  }

  // Build desired OpenClaw oauth credential records.
  const desiredProfiles = {};

  for (const provider of supportedProviders) {
    const labels = Array.from(assignedLabelsByProvider.get(provider)).toSorted((a, b) => a.localeCompare(b));
    const credsByLabel = state.credentials[provider];
    for (const label of labels) {
      const cred = credsByLabel[label];
      const expiresMs = parseExpiresAtToMs(cred.expiresAt);
      if (!expiresMs) {
        throw new Error(`credentials.${provider}.${label}.expiresAt is missing/invalid.`);
      }
      const expectEmail = typeof accounts[label]?.expect?.email === "string" ? accounts[label].expect.email : null;

      const profileId = resolveOpenclawProfileIdForProviderLabel(provider, label);
      const oauth = {
        type: "oauth",
        provider,
        access: cred.access,
        refresh: cred.refresh,
        expires: expiresMs,
        ...(expectEmail ? { email: expectEmail } : {}),
        ...(provider === OPENAI_CODEX_PROVIDER ? { accountId: cred.accountId } : {}),
      };
      desiredProfiles[profileId] = oauth;
    }
  }

  // Managed OpenClaw auth materializes the current assignment map only; unassigned
  // pool labels must not remain consumable through hidden defaults or stale per-agent stores.
  const mainStorePath = resolveOpenclawAuthStorePath(homeDir, "main");
  const mainRaw = readJsonFile(mainStorePath) ?? { version: 1, profiles: {} };
  if (!isObject(mainRaw) || !isObject(mainRaw.profiles)) {
    throw new Error(`OpenClaw auth store is missing profiles object: ${mainStorePath}`);
  }
  const nextMain = structuredClone(mainRaw);
  nextMain.version = Number(nextMain.version ?? 1);
  nextMain.profiles = isObject(nextMain.profiles) ? nextMain.profiles : {};

  for (const [profileId, existingCred] of Object.entries(nextMain.profiles)) {
    if (!isObject(existingCred)) continue;
    const provider = normalizeProviderId(existingCred.provider);
    if (!supportedProviderSet.has(provider)) continue;
    delete nextMain.profiles[profileId];
  }
  for (const [profileId, oauthCred] of Object.entries(desiredProfiles)) {
    nextMain.profiles[profileId] = oauthCred;
  }
  nextMain.order = isObject(nextMain.order) ? nextMain.order : {};
  nextMain.lastGood = isObject(nextMain.lastGood) ? nextMain.lastGood : {};
  for (const provider of supportedProviders) {
    if (Object.hasOwn(nextMain.order, provider)) {
      delete nextMain.order[provider];
    }
    if (Object.hasOwn(nextMain.lastGood, provider)) {
      delete nextMain.lastGood[provider];
    }
  }

  const wrote = [];
  if (writeJsonFileWithBackupIfChanged(mainStorePath, nextMain).wrote) {
    wrote.push(mainStorePath);
  }

  // Per-agent stores are assignment-only overrides. Anything not assigned must have
  // managed-provider order/lastGood removed so assignments stay the sole steady-state truth.
  const allAgentIds = new Set([
    ...discoverOpenclawAgentIdsWithAuthStores(homeDir),
    ...Array.from(managedAgentIdSet),
    ...Array.from(assignedLabelByAgentId.keys()),
  ]);
  for (const agentId of Array.from(allAgentIds).toSorted((a, b) => a.localeCompare(b))) {
    if (agentId === "main") continue;
    const isManagedAgent = managedAgentIdSet.has(agentId);
    const assignedLabel = assignedLabelByAgentId.get(agentId) ?? null;
    const account = assignedLabel ? accounts[assignedLabel] : null;
    const provider = assignedLabel ? normalizeProviderId(account?.provider) : null;
    const profileId = assignedLabel ? resolveOpenclawProfileIdForProviderLabel(provider, assignedLabel) : null;

    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath);
    if (!existing && !assignedLabel && !isManagedAgent) {
      continue;
    }
    const base = existing ?? { version: 1, profiles: {} };
    if (!isObject(base) || !isObject(base.profiles)) {
      throw new Error(`OpenClaw auth store is missing profiles object: ${storePath}`);
    }
    const next = structuredClone(base);
    next.version = Number(next.version ?? 1);
    next.profiles = isObject(next.profiles) ? next.profiles : {};

    for (const [pid, c] of Object.entries(next.profiles)) {
      if (!isObject(c)) continue;
      if (!supportedProviderSet.has(normalizeProviderId(c.provider))) continue;
      delete next.profiles[pid];
    }

    next.order = isObject(next.order) ? next.order : {};
    next.lastGood = isObject(next.lastGood) ? next.lastGood : {};
    for (const managedProvider of supportedProviders) {
      if (assignedLabel && managedProvider === provider) {
        next.order[managedProvider] = [profileId];
        next.lastGood[managedProvider] = profileId;
        continue;
      }
      if (isManagedAgent && managedProvider === OPENAI_CODEX_PROVIDER) {
        next.order[managedProvider] = [];
      } else if (Object.hasOwn(next.order, managedProvider)) {
        delete next.order[managedProvider];
      }
      if (Object.hasOwn(next.lastGood, managedProvider)) {
        delete next.lastGood[managedProvider];
      }
    }

    if (writeJsonFileWithBackupIfChanged(storePath, next).wrote) {
      wrote.push(storePath);
    }
  }

  return { wrote };
}

async function syncOpenclawFromState(params, state) {
  let agentsList = null;
  let activeAssignments = getOpenclawPins(state);
  let staleAssignmentWarnings = [];
  let configuredCodexAgentIds = [];

  if (!params.home) {
    agentsList = readOpenclawAgentsListFromConfig();
    const partition = partitionOpenclawPinsByConfiguredAgents({
      pinsByAgentId: getOpenclawPins(state),
      agentsList,
    });
    activeAssignments = partition.activePins;
    staleAssignmentWarnings = partition.stalePins.map(({ agentId, label }) => ({
      kind: "assignment_points_to_missing_config_agent",
      system: "openclaw",
      agentId,
      label,
    }));
    configuredCodexAgentIds = discoverConfiguredOpenclawCodexAgents({
      agentsList,
      exclusions: getOpenclawExclusions(state),
    });
  }

  const auth = applyOpenclawFromState(params, state, {
    pinsOverride: activeAssignments,
    managedAgentIds: configuredCodexAgentIds,
  });

  // Config/model sync is intentionally skipped in sandbox mode to keep `--home`
  // as a safe dev/test escape hatch (and to avoid requiring `openclaw` in CI).
  if (params.home) {
    return {
      auth,
      models: { skipped: true, reason: "home_override" },
      sessions: { skipped: true, reason: "home_override" },
      restart: { skipped: true, reason: "home_override" },
      warnings: staleAssignmentWarnings,
    };
  }

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const assignments = activeAssignments;
  const assignedAgentIds = Object.keys(assignments);
  const desiredModelRefByAgentId = {};
  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const account = accounts[label];
    if (!isObject(account)) {
      throw new Error(`Assignment references missing account: agent=${agentId} label=${label}`);
    }
    const provider = normalizeProviderId(account.provider);
    if (provider === OPENAI_CODEX_PROVIDER) {
      desiredModelRefByAgentId[agentId] = OPENCLAW_ENFORCED_CODEX_MODEL;
      continue;
    }
    if (provider === ANTHROPIC_PROVIDER) {
      desiredModelRefByAgentId[agentId] = OPENCLAW_ENFORCED_ANTHROPIC_MODEL;
      continue;
    }
    throw new Error(`Assignment references unsupported provider: agent=${agentId} label=${label} provider=${provider}`);
  }

  const ops =
    assignedAgentIds.length > 0
      ? buildOpenclawModelSyncOps({ agentsList, pinnedAgentIds: assignedAgentIds, modelRefByAgentId: desiredModelRefByAgentId })
      : [];
  const applied = ops.length > 0 ? applyOpenclawModelSyncOps(ops) : [];

  const homeDir = resolveHomeDir(params.home);
  const perAgentScan = [];
  const patchOps = [];
  const desiredSessionByAgentId = {};
  const agentIndexById = buildOpenclawAgentIndexById(agentsList);

  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const desiredModelRef = typeof desiredModelRefByAgentId[agentId] === "string" ? desiredModelRefByAgentId[agentId] : "";
    if (!desiredModelRef) {
      throw new Error(`Missing desired modelRef for assigned agent: ${agentId}`);
    }
    const parsedDesired = parseProviderModelRef(desiredModelRef);
    if (!parsedDesired?.provider || !parsedDesired?.model) {
      throw new Error(`Invalid desired model ref for agent=${agentId}: ${desiredModelRef}`);
    }
    desiredSessionByAgentId[agentId] = {
      ...parsedDesired,
      modelRef: desiredModelRef,
      desiredAuthProfileId: resolveOpenclawProfileIdForProviderLabel(parsedDesired.provider, label),
    };
  }

  for (const agentIdRaw of configuredCodexAgentIds) {
    const agentId = normalizeAgentId(agentIdRaw);
    if (desiredSessionByAgentId[agentId]) continue;
    const configIdx = agentIndexById.get(agentId);
    const currentModelRef =
      configIdx === undefined ? null : extractOpenclawConfigAgentModelPrimary(agentsList[configIdx]?.model);
    const parsedCurrent = currentModelRef ? parseProviderModelRef(currentModelRef) : null;
    desiredSessionByAgentId[agentId] = {
      ...(parsedCurrent?.provider && parsedCurrent?.model
        ? {
            provider: parsedCurrent.provider,
            model: parsedCurrent.model,
            modelRef: currentModelRef,
          }
        : {}),
      desiredAuthProfileId: null,
      clearManagedAuthProfile: true,
    };
  }

  const sessionAgentIds = [...new Set([
    ...Object.keys(desiredSessionByAgentId),
    ...discoverOpenclawAgentIdsWithSessionStores(homeDir),
  ])].toSorted((a, b) => a.localeCompare(b));

  for (const agentIdRaw of sessionAgentIds) {
    const agentId = normalizeAgentId(agentIdRaw);
    const desired = desiredSessionByAgentId[agentId];
    if (!desired) continue;

    const storePath = resolveOpenclawSessionsStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath);

    if (!existing) {
      perAgentScan.push({
        agentId,
        storePath,
        exists: false,
        sessionsTotal: 0,
        sessionsWouldChange: 0,
      });
      continue;
    }
    if (!isObject(existing)) {
      throw new Error(`OpenClaw sessions store is not an object map: ${storePath}`);
    }

    const keys = scanOpenclawSessionsStoreForKeysNeedingModelReset({
      store: existing,
      desiredProvider: desired.provider,
      desiredModel: desired.model,
      desiredAuthProfileId: desired.desiredAuthProfileId,
      clearManagedAuthProfile: desired.clearManagedAuthProfile,
    });

    perAgentScan.push({
      agentId,
      storePath,
      exists: true,
      sessionsTotal: Object.keys(existing).length,
      sessionsWouldChange: keys.length,
    });

    for (const key of keys) {
      if (typeof desired.modelRef === "string" && desired.modelRef.trim()) {
        patchOps.push({ key, modelRef: desired.modelRef, agentId });
      }
    }
  }

  const totalSessionsWouldChange = perAgentScan.reduce(
    (sum, scan) => sum + (Number.isFinite(Number(scan.sessionsWouldChange)) ? Number(scan.sessionsWouldChange) : 0),
    0,
  );
  if (totalSessionsWouldChange === 0) {
    const restartNeeded = auth.wrote.length > 0 || applied.length > 0;
    const restart =
      restartNeeded
        ? restartOpenclawGateway({ timeoutMs: 30000 })
        : { skipped: true, reason: "no_runtime_changes" };
    if (restart.ok === false) {
      throw new Error(
        `openclaw gateway restart failed (${restart.reason})` +
          `${restart.status ? ` exit=${restart.status}` : ""}` +
          `${restart.stderr ? `: ${restart.stderr}` : restart.error ? `: ${restart.error}` : ""}`,
      );
    }
    return {
      auth,
      models:
        assignedAgentIds.length > 0
          ? { desiredByAgentId: desiredModelRefByAgentId, ops: applied }
          : { skipped: true, reason: "no_assignments" },
      sessions: { skipped: true, reason: "no_session_changes_needed" },
      restart,
      warnings: staleAssignmentWarnings,
    };
  }

  const gateway =
    patchOps.length > 0
      ? { attempted: false, ok: false, reason: "restart_applies_runtime" }
      : { attempted: false, ok: false, reason: "no_model_patch_ops" };

  // Restart is the live apply mechanism; patch disk first so the fresh gateway reads the canonical session state.
  const perAgentDisk = [];
  let filesChanged = 0;
  let sessionsChanged = 0;
  for (const scan of perAgentScan) {
    if (!scan.sessionsWouldChange) continue;
    const agentId = normalizeAgentId(scan.agentId);
    const desired = desiredSessionByAgentId[agentId];
    if (!desired) continue;
    const result = applyOpenclawSessionsDiskResets({
      homeDir,
      agentId,
      desiredProvider: desired.provider,
      desiredModel: desired.model,
      desiredAuthProfileId: desired.desiredAuthProfileId,
      clearManagedAuthProfile: desired.clearManagedAuthProfile,
    });
    perAgentDisk.push({ agentId, ...result });
    if (result.sessionsChanged > 0) {
      filesChanged += 1;
      sessionsChanged += result.sessionsChanged;
    }
  }

  const restart = restartOpenclawGateway({ timeoutMs: 30000 });
  if (restart.ok === false) {
    throw new Error(
      `openclaw gateway restart failed (${restart.reason})` +
        `${restart.status ? ` exit=${restart.status}` : ""}` +
        `${restart.stderr ? `: ${restart.stderr}` : restart.error ? `: ${restart.error}` : ""}`,
    );
  }

  return {
    auth,
    models:
      assignedAgentIds.length > 0
        ? { desiredByAgentId: desiredModelRefByAgentId, ops: applied }
        : { skipped: true, reason: "no_assignments" },
    sessions: {
      mode: "disk",
      gateway,
      filesChanged,
      sessionsChanged,
      sessionsWouldChange: totalSessionsWouldChange,
      perAgent: perAgentDisk.filter((p) => p.sessionsWouldChange > 0),
    },
    restart,
    warnings: staleAssignmentWarnings,
  };
}

async function activateCodexPoolSelection({ state, homeDir }) {
  ensureStateShape(state);
  // Structural target validation comes first: if this machine's Codex home is not
  // AIM-manageable, fail loud before doing pool selection or usage probing.
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir }) });
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProvider(state);
  const usageByLabel = usageByProvider[OPENAI_CODEX_PROVIDER];
  const poolStatus = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });

  appendOpenaiCodexHistory(
    state,
    buildExhaustionHistoryEntries({
      state,
      usage: usageByLabel,
      eligibleLabels: poolStatus.eligibleLabels,
      observedAt,
    }),
  );

  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Codex pool labels are available on this machine yet. " +
        "Run `aim sync codex --from agents@amirs-mac-studio` first.",
    );
  }

  const target = getCodexTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readCodexCliTargetStatus({ state, homeDir });
    clearManagedCodexCliActivation({ state, homeDir });
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      warnings: [],
      blockers: [{ reason: "no_eligible_pool_account" }],
      reasons: [],
      wroteAuthJson: false,
    };
    target.lastSelectionReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "selection",
        status: "blocked",
        reason: "no_eligible_pool_account",
        hadSpareEligibleCapacity: false,
      },
    ]);
    return { status: "blocked", receipt, wrote: false };
  }

  const currentTarget = readCodexCliTargetStatus({ state, homeDir });
  const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
  const currentAssignments = getOpenclawAssignments(state);
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel: currentTarget.activeLabel,
    currentAssignments,
    configuredAgents: configuredCodexAgents,
    agentDemand: state.pool.openaiCodex.agentDemand,
    lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
    now: Date.parse(observedAt),
  });
  const selection = pickNextBestPoolLabel({ rankedCandidates });
  if (!selection) {
    throw new Error("Failed to select a next-best Codex pool label.");
  }

  const activated = applyCodexCliFromState({ label: selection.label, homeDir }, state);
  const postStatus = readCodexCliTargetStatus({ state, homeDir });
  const warnings = buildWarningsFromCodexTargetStatus(postStatus);
  const status =
    !activated.wrote && currentTarget.activeLabel === selection.label && currentTarget.expectedAccountId === activated.accountId
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "codex_use",
    status,
    observedAt,
    previousLabel: currentTarget.activeLabel ?? undefined,
    label: selection.label,
    accountId: activated.accountId,
    keptCurrent: Boolean(selection.keptCurrent),
    reasons: Array.isArray(selection.reasons) ? selection.reasons : [],
    authPath: activated.authPath,
    wroteAuthJson: Boolean(activated.wrote),
    warnings,
    blockers: [],
  };
  target.lastSelectionReceipt = receipt;
  appendOpenaiCodexHistory(state, [
    {
      observedAt,
      kind: "selection",
      status,
      label: selection.label,
      accountId: activated.accountId,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason: selection.keptCurrent ? "kept_current" : "next_best",
    },
  ]);

  return { status, receipt, wrote: Boolean(activated.wrote) };
}

export async function rebalanceOpenclawPool(
  params,
  state,
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
    syncOpenclawFromStateImpl = syncOpenclawFromState,
  } = {},
) {
  ensureStateShape(state);
  const homeDir = resolveHomeDir(params.home);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state);
  const usageByLabel = usageByProvider[OPENAI_CODEX_PROVIDER];
  const poolStatus = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });

  appendOpenaiCodexHistory(
    state,
    buildExhaustionHistoryEntries({
      state,
      usage: usageByLabel,
      eligibleLabels: poolStatus.eligibleLabels,
      observedAt,
    }),
  );

  const target = getOpenclawTargetState(state);
  const agentsList = readOpenclawAgentsListFromConfigImpl();
  const currentAssignments = getOpenclawAssignments(state);
  const configuredAgentIds = new Set(
    (Array.isArray(agentsList) ? agentsList : [])
      .map((entry) => (typeof entry?.id === "string" ? normalizeAgentId(entry.id) : ""))
      .filter(Boolean),
  );
  const configuredAgents = discoverConfiguredOpenclawCodexAgents({
    agentsList,
    exclusions: getOpenclawExclusions(state),
  });
  const codexManagedAgentIds = new Set(configuredAgents.map((agentId) => normalizeAgentId(agentId)));
  const exclusions = getOpenclawExclusions(state);
  const preservedAssignments = Object.fromEntries(
    Object.entries(currentAssignments).filter(([agentIdRaw]) => {
      const agentId = normalizeAgentId(agentIdRaw);
      if (codexManagedAgentIds.has(agentId)) {
        return false;
      }
      if (typeof exclusions?.[agentId] === "string" && exclusions[agentId].trim()) {
        return true;
      }
      return configuredAgentIds.has(agentId);
    }),
  );
  const demandRefresh = refreshOpenclawAgentDemandLedger({
    state,
    homeDir,
    configuredAgents,
    now: Date.parse(observedAt),
    lookbackDays: DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
  });
  const plan = planWeightedOpenclawRebalance({
    configuredAgents,
    currentAssignments,
    eligibleLabels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    agentDemand: demandRefresh.demandByAgent,
    now: Date.parse(observedAt),
  });
  const nextAssignments = { ...preservedAssignments, ...plan.assignments };

  target.lastRebalancedAt = observedAt;

  if (plan.status === "blocked") {
    const blockerReason = typeof plan.blockers?.[0]?.reason === "string" ? plan.blockers[0].reason : "no_eligible_pool_account";
    const receipt = {
      action: "rebalance_openclaw",
      status: "blocked",
      observedAt,
      cleanupMode: null,
      allocationMode: plan.allocationMode,
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      moved: [],
      unchanged: [],
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: [],
      blockers: plan.blockers,
    };
    target.lastApplyReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "rebalance",
        status: "blocked",
        reason: blockerReason,
        hadSpareEligibleCapacity: false,
      },
    ]);
    return { status: "blocked", receipt };
  }

  target.assignments = nextAssignments;
  const synced = await syncOpenclawFromStateImpl(params, state);
  const warnings = Array.isArray(synced.warnings) ? synced.warnings : [];
  let status = "applied";
  if (plan.status === "noop") {
    status = warnings.length > 0 ? "applied_with_warnings" : "noop";
  } else if (plan.status === "applied_with_warnings" || warnings.length > 0) {
    status = "applied_with_warnings";
  }

  const receipt = {
    action: "rebalance_openclaw",
    status,
    observedAt,
    allocationMode: plan.allocationMode,
    cleanupMode:
      typeof synced.sessions?.mode === "string"
        ? synced.sessions.mode
        : typeof synced.sessions?.reason === "string"
          ? synced.sessions.reason
          : null,
    assignments: sanitizeForStatus(nextAssignments),
    moved: plan.moved,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
    perAccountLoad: plan.perAccountLoad,
    warnings,
    blockers: [],
  };
  target.lastApplyReceipt = receipt;
  appendOpenaiCodexHistory(state, [
    {
      observedAt,
      kind: "rebalance",
      status,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason:
        plan.skipped.some((entry) => entry.reason === "projected_demand_exceeds_eligible_supply")
          ? "projected_demand_exceeds_eligible_supply"
          : status === "noop"
            ? "unchanged_assignments"
            : "rebalanced",
    },
  ]);

  return { status, receipt, synced };
}

export async function main(argv, deps = {}) {
  const {
    stdin = process.stdin,
    stdout = process.stdout,
    repoRoot,
    promptLineImpl = promptLine,
    promptImpl = promptRequiredLine,
    openUrlImpl = launchBrowserBindingForUrl,
    readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
    readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
    runLabelControlPanelImpl = runLabelControlPanel,
    loginOpenAICodexImpl = loginOpenAICodex,
    refreshOpenAICodexImpl = refreshOpenAICodexToken,
    loginAnthropicImpl = loginAnthropic,
    refreshAnthropicImpl = refreshAnthropicToken,
  } = deps;
  const { opts, positional } = parseArgs(argv);
  const knownCmds = new Set(["status", "login", "pin", "autopin", "rebalance", "apply", "sync", "codex", "browser"]);
  let cmd = positional[0];
  let shorthandLabel = null;

  if (opts.help || !cmd) {
    printHelp();
    return;
  }
  if (!knownCmds.has(cmd)) {
    shorthandLabel = cmd;
    cmd = "login";
  }

  const statePath = resolveAimgrStatePath(opts);
  const homeDir = resolveHomeDir(opts.home);

  if (cmd === "status") {
    const state = loadAimgrState(statePath);
    const view = await buildStatusView({ statePath, state, homeDir });
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(sanitizeForStatus(view), null, 2)}\n`);
      return;
    }
    if (opts.compact) {
      process.stdout.write(renderStatusCompactText(view));
      return;
    }
    process.stdout.write(
      renderStatusText(view, {
        showAssignments: opts.assignments === true,
        ...(opts.accounts === true ? { showAccounts: true } : {}),
      }),
    );
    return;
  }

  if (cmd === "login") {
    const label = normalizeLabel(shorthandLabel ?? positional[1]);
    const state = loadAimgrState(statePath);
    ensureStateShape(state);
    if (shorthandLabel && isInteractiveTerminal({ stdin, stdout })) {
      await runLabelControlPanelImpl({
        statePath,
        state,
        label,
        homeDir,
        repoRoot: resolveAgentsRepoRoot({ repoRoot }),
        promptLineImpl,
        promptImpl,
        openUrlImpl,
        readOpenclawBindingsFromConfigImpl,
        readOpenclawAgentsListFromConfigImpl,
        loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        loginAnthropicImpl,
        refreshAnthropicImpl,
      });
      return;
    }

    try {
      const result = await performLabelMaintenance({
        state,
        label,
        homeDir,
        promptLineImpl,
        promptImpl,
        openUrlImpl,
        loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        loginAnthropicImpl,
        refreshAnthropicImpl,
      });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(
        `${JSON.stringify(
          sanitizeForStatus(result),
          null,
          2,
        )}\n`,
      );
      return;
    } catch (err) {
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
  }

  if (cmd === "browser") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing browser subcommand. Usage: aim browser show <label> | aim browser set <label> --mode ...");
    }
    const label = normalizeLabel(positional[2]);
    const state = loadAimgrState(statePath);
    if (subcmd === "show") {
      const shown = showBrowserBinding({ state, label, homeDir });
      process.stdout.write(`${JSON.stringify(sanitizeForStatus(shown), null, 2)}\n`);
      return;
    }
    if (subcmd === "set") {
      const updated = setBrowserBindingFromCli({ state, label, opts });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            browser: {
              label,
              updated,
              current: showBrowserBinding({ state, label, homeDir }),
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    }
    throw new Error(`Unsupported browser subcommand: ${subcmd} (supported: show, set).`);
  }

  if (cmd === "pin") {
    throw new Error("`aim pin` was removed. Use `aim rebalance openclaw` for selection and `aim apply` only to materialize stored assignments.");
  }

  if (cmd === "autopin") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error('Missing autopin target. `aim autopin openclaw` was removed; use `aim rebalance openclaw`.');
    }
    throw new Error("`aim autopin openclaw` was removed. Use `aim rebalance openclaw`.");
  }

  if (cmd === "rebalance") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error("Missing rebalance target. Usage: aim rebalance openclaw");
    }
    if (system !== "openclaw") {
      throw new Error(`Unsupported rebalance target: ${system} (supported: openclaw).`);
    }
    const state = loadAimgrState(statePath);
    const rebalanced = await rebalanceOpenclawPool(opts, state);
    writeJsonFileWithBackup(statePath, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
    if (rebalanced.status === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "apply") {
    const state = loadAimgrState(statePath);
    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
    return;
  }

  if (cmd === "sync") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error("Missing sync target. Usage: aim sync openclaw | aim sync codex --from agents@amirs-mac-studio");
    }
    const state = loadAimgrState(statePath);
    if (system === "openclaw") {
      const synced = await syncOpenclawFromState(opts, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
      return;
    }
    if (system === "codex") {
      const imported = importCodexFromAuthority({ from: opts.from, state, homeDir });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, imported }), null, 2)}\n`);
      return;
    }
    throw new Error(`Unsupported sync target: ${system} (supported: openclaw, codex).`);
  }

  if (cmd === "codex") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing codex subcommand. Usage: aim codex use");
    }
    if (subcmd !== "use") {
      throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use).`);
    }
    const state = loadAimgrState(statePath);
    if (String(positional[2] ?? "").trim()) {
      throw new Error("`aim codex use <label>` was removed. Use `aim codex use` for next-best selection or `aim <label>` if the account needs reauth.");
    }
    const activated = await activateCodexPoolSelection({ state, homeDir });
    writeJsonFileWithBackup(statePath, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
    if (activated.status === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}
