import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { loginOpenAICodex, refreshAnthropicToken, refreshOpenAICodexToken } from "@mariozechner/pi-ai";

const SCHEMA_VERSION = "0.2";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENCLAW_ENFORCED_CODEX_MODEL = "openai-codex/gpt-5.4";
const OPENCLAW_ENFORCED_ANTHROPIC_MODEL = "anthropic/claude-opus-4-6";
const DEFAULT_ANTHROPIC_OAUTH_SCOPES = ["org:create_api_key", "user:profile", "user:inference"];
const INFERRED_ANTHROPIC_SUBSCRIPTION_MAX = "claude_max";
const INFERRED_ANTHROPIC_SUBSCRIPTION_PRO = "claude_pro";
const INFERRED_ANTHROPIC_RATE_LIMIT_TIER_MAX = "oauth_claude_max_inferred";
const INFERRED_ANTHROPIC_RATE_LIMIT_TIER_PRO = "oauth_claude_pro_inferred";
const CODEX_AUTH_STORE_MODE_FILE = "file";
const CODEX_AUTH_STORE_MODE_KEYRING = "keyring";
const CODEX_AUTH_STORE_MODE_AUTO = "auto";
const DEFAULT_AUTHORITY_STATE_REMOTE_PATH = "$HOME/.aimgr/secrets.json";
const REAUTH_MODE_BROWSER_MANAGED = "browser-managed";
const REAUTH_MODE_MANUAL_CALLBACK = "manual-callback";
const REAUTH_MODE_NATIVE_CLAUDE = "native-claude";
const LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE = "aim-browser-profile";
const LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE = "openclaw-browser-profile";
const BROWSER_MODE_AIM_PROFILE = "aim-profile";
const BROWSER_MODE_CHROME_PROFILE = "chrome-profile";
const BROWSER_MODE_AGENT_BROWSER = "agent-browser";
const CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION = 1;
const DEFAULT_AGENTS_REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "..");
const HERMES_AUTH_STORE_VERSION = 1;
const HERMES_CODEX_BASE_URL = "https://chatgpt.com/backend-api/codex";
const STATUS_RESET_TIMEZONE = "America/Chicago";
const DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS = 7;
const MIN_AGENT_DEMAND_WEIGHT = 1;
const KEEP_CURRENT_DEMAND_RATIO_THRESHOLD = 0.15;
const KEEP_CURRENT_OVERFLOW_WEIGHT_FACTOR = 0.25;
const LOCAL_CLI_MIN_PRIMARY_REMAINING_PCT = 80;
const DEFAULT_CODEX_WATCH_INTERVAL_SECONDS = 300;
const DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT = 20;
const HERMES_SESSION_DEMAND_SOURCE = "hermes-session-tokens";
const OPENCLAW_SESSION_DEMAND_SOURCE = "openclaw-session-tokens";
const COLD_START_EQUAL_SHARE_DEMAND_SOURCE = "cold-start-equal-share";
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

function resolveSqlite3Command({ homeDir, spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "sqlite3";
  }
  const effectiveHomeDir = String(homeDir ?? process.env.HOME ?? "").trim();
  const extraSearchPaths = [
    effectiveHomeDir ? path.join(effectiveHomeDir, "Library", "Android", "sdk", "platform-tools") : "",
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
  ].filter(Boolean);
  return resolveExecutableOnPath("sqlite3", { extraSearchPaths }) || "sqlite3";
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
    "promote",
    "hermes",
    "codex",
    "browser",
    "internal",
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

function normalizeHermesHomeId(input) {
  const homeId = String(input ?? "").trim();
  if (!homeId) {
    throw new Error("Missing Hermes home id.");
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(homeId)) {
    throw new Error(`Invalid Hermes home id: ${homeId}`);
  }
  return homeId;
}

function parseArgs(argv) {
  const opts = {
    home: undefined,
    state: undefined,
    from: undefined,
    to: undefined,
    mode: undefined,
    seedFromOpenclaw: undefined,
    userDataDir: undefined,
    profile: undefined,
    session: undefined,
    authFile: undefined,
    inFile: undefined,
    outFile: undefined,
    sourceHome: undefined,
    discardDirty: false,
    json: false,
    compact: false,
    accounts: false,
    help: false,
    once: false,
    intervalSeconds: undefined,
    rotateBelow5hRemainingPct: undefined,
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
    if (arg === "--to") {
      opts.to = argv[i + 1];
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
    if (arg === "--auth-file") {
      opts.authFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--in") {
      opts.inFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--out") {
      opts.outFile = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--source-home") {
      opts.sourceHome = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--discard-dirty") {
      opts.discardDirty = true;
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
    if (arg === "--once") {
      opts.once = true;
      continue;
    }
    if (arg === "--interval-seconds") {
      opts.intervalSeconds = argv[i + 1];
      i += 1;
      continue;
    }
    if (arg === "--rotate-below-5h-remaining-pct") {
      opts.rotateBelow5hRemainingPct = argv[i + 1];
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readTextFromStream(stream) {
  let text = "";
  for await (const chunk of stream) {
    text += typeof chunk === "string" ? chunk : chunk.toString("utf8");
  }
  return text;
}

function parseIntegerOption(rawValue, { name, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    throw new Error(`Missing value for ${name}.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: ${raw}. Expected an integer.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${raw}. Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function resolveCodexWatchIntervalSeconds(rawValue) {
  if (rawValue === undefined) return DEFAULT_CODEX_WATCH_INTERVAL_SECONDS;
  return parseIntegerOption(rawValue, {
    name: "--interval-seconds",
    minimum: 1,
    maximum: 86400,
  });
}

function resolveCodexWatchThresholdPct(rawValue) {
  if (rawValue === undefined) return DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT;
  return parseIntegerOption(rawValue, {
    name: "--rotate-below-5h-remaining-pct",
    minimum: 0,
    maximum: 100,
  });
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
    "  aim rebalance hermes   # choose pooled Codex assignments for live Hermes homes",
    "  aim apply             # advanced: materialize stored OpenClaw assignments from ~/.aimgr/secrets.json",
    "  aim sync openclaw     # explicit alias for apply",
    "  aim sync codex --from <authority>  # import/refresh openai-codex labels from an authority AIM state",
    "  aim promote codex --to <authority> <label> [<label>...]  # publish refreshed imported openai-codex labels back to the authority",
    "  aim sync claude --from <authority>  # import/refresh Claude labels from an authority AIM state",
    "  aim promote claude --to <authority> <label> [<label>...]  # publish refreshed imported Claude labels back to the authority",
    "  aim auth write hermes <label> --auth-file <abs-path>  # write Hermes auth.json only",
    "  aim codex use         # activate the next-best pooled openai-codex label for local Codex CLI",
    "  aim codex watch [--once] [--interval-seconds <sec>] [--rotate-below-5h-remaining-pct <pct>]",
    "  aim hermes watch [--once] [--interval-seconds <sec>] [--rotate-below-5h-remaining-pct <pct>]",
    "  aim claude use [label]  # activate the next-best pooled Claude label, or explicitly switch a chosen label",
    "  aim claude capture-native <label> [--source-home <dir>]",
    "  aim claude export-live --out <file> [--source-home <dir>]",
    "  aim claude import-native <label> --in <file>",
    "  aim pi use            # activate the next-best pooled openai-codex label for local Pi CLI",
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
    "  - `aim pin`, `aim autopin openclaw`, and label-first `aim codex use` / `aim pi use` are removed; use `aim rebalance openclaw`, `aim apply`, `aim codex use`, `aim claude use [label]`, and `aim pi use`.",
    "  - Codex target management is file-backed only in v1; keyring/auto homes fail loud.",
    `  - \`aim codex watch --once\` is the scheduler-safe one-shot; foreground watch loops default to ${DEFAULT_CODEX_WATCH_INTERVAL_SECONDS}s and rotate below ${DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT}% 5h remaining.`,
    `  - \`aim hermes watch --once\` is the Hermes scheduler-safe one-shot and always delegates writes through \`aim rebalance hermes\`.`,
    "",
    "Developer options (rare):",
    "  --home <dir>    Run against an alternate HOME (dev/test; e.g. /tmp/aimgr-home).",
    "  --state <path>  Override SSOT file path (default: <home>/.aimgr/secrets.json).",
    "  --from <src>    Authority source for `aim sync codex` / `aim sync claude`.",
    "                  Examples: agents@amirs-mac-studio  |  ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json",
    "  --to <dst>      Authority destination for `aim promote codex` / `aim promote claude`.",
    "                  Examples: agents@amirs-mac-studio  |  ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json",
    "  --mode <id>     Browser binding mode for `aim browser set`.",
    "  --seed-from-openclaw <profileId>  Optional one-time OpenClaw seed source for `--mode aim-profile`.",
    "  --user-data-dir <abs-path>        Required for `--mode chrome-profile`.",
    "  --profile-directory <name>        Optional specific Chrome profile inside `--user-data-dir`.",
    "  --profile <abs-path>              Required for `--mode agent-browser`.",
    "  --session <name>                  Required for `--mode agent-browser`.",
    "  --auth-file <abs-path>            Required for `aim auth write hermes`; must point at Hermes auth.json.",
    "  --in <file>                       Required for `aim claude import-native`.",
    "  --out <file>                      Required for `aim claude export-live`.",
    "  --source-home <dir>               Optional source HOME for native Claude capture/export on the same host.",
    "  --discard-dirty                   Allow `aim sync codex` / `aim sync claude` to overwrite locally refreshed imported labels that were not promoted.",
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

function expandHomeShorthandPath(rawPath, { homeDir }) {
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

function resolveCliPath(rawPath, { homeDir, optionName }) {
  const raw = String(rawPath ?? "").trim();
  if (!raw) {
    throw new Error(`Missing value for ${optionName}.`);
  }
  return path.resolve(expandHomeShorthandPath(raw, { homeDir }));
}

function resolveOptionalSourceHome(rawPath, { homeDir }) {
  if (rawPath === undefined) return homeDir;
  return resolveCliPath(rawPath, { homeDir, optionName: "--source-home" });
}

function resolveAimgrStatePath(params) {
  const homeDir = resolveHomeDir(params.home);
  if (params.state) {
    return path.resolve(expandHomeShorthandPath(params.state, { homeDir }));
  }
  return path.join(homeDir, ".aimgr", "secrets.json");
}

function resolveAimgrStateDir({ homeDir }) {
  return path.join(homeDir, ".aimgr");
}

function resolveHermesProfilesRoot(homeDir) {
  return path.join(homeDir, ".hermes", "profiles");
}

function resolveHermesHomePath(homeDir, homeId) {
  return path.join(resolveHermesProfilesRoot(homeDir), homeId);
}

function resolveHermesStateDbPath(homeDir, homeId) {
  return path.join(resolveHermesHomePath(homeDir, homeId), "state.db");
}

function resolveOpenclawAuthStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
}

function resolveExplicitHermesAuthFilePath(value) {
  const authPath = normalizeAbsolutePath(value);
  if (!authPath) {
    throw new Error("Missing Hermes auth target. Usage: aim auth write hermes <label> --auth-file <abs-path>.");
  }
  if (path.basename(authPath) !== "auth.json") {
    throw new Error(`Refusing Hermes auth write to non-auth.json path: ${authPath}`);
  }
  return authPath;
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

function ensureDirectoryMode(dirPath, mode = 0o700) {
  fs.mkdirSync(dirPath, { recursive: true, mode });
  try {
    fs.chmodSync(dirPath, mode);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
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
        codex: {
          labels: [],
          labelsByName: {},
        },
        anthropic: {
          labels: [],
          labelsByName: {},
        },
      },
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
      },
      anthropic: {
        history: [],
      },
    },
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
      claudeCli: {},
      piCli: {},
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

function getCodexCredentialFromStateUnsafe(state, label) {
  const byLabel = isObject(state?.credentials?.[OPENAI_CODEX_PROVIDER]) ? state.credentials[OPENAI_CODEX_PROVIDER] : {};
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

function getAnthropicCredentialFromStateUnsafe(state, label) {
  const byLabel = isObject(state?.credentials?.[ANTHROPIC_PROVIDER]) ? state.credentials[ANTHROPIC_PROVIDER] : {};
  return isObject(byLabel?.[label]) ? byLabel[label] : null;
}

export function buildCodexCredentialFingerprint(credential) {
  const cred = assertCodexCredentialShape({
    label: "<fingerprint>",
    credential,
    requireFresh: false,
  });
  const normalized = {
    access: String(cred.access).trim(),
    refresh: String(cred.refresh).trim(),
    expiresAt: String(cred.expiresAt).trim(),
    accountId: String(cred.accountId).trim(),
    ...(typeof cred.idToken === "string" && cred.idToken.trim() ? { idToken: cred.idToken.trim() } : {}),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function tryBuildCodexCredentialFingerprint(credential) {
  try {
    return buildCodexCredentialFingerprint(credential);
  } catch {
    return null;
  }
}

export function buildAnthropicCredentialFingerprint(credential) {
  const cred = assertAnthropicCredentialShape({
    label: "<fingerprint>",
    credential,
    requireFresh: false,
    requireClaudeNativeBundle: false,
  });
  const normalized = {
    access: String(cred.access).trim(),
    refresh: String(cred.refresh).trim(),
    expiresAt: String(cred.expiresAt).trim(),
    ...(typeof cred.subscriptionType === "string" && cred.subscriptionType.trim()
      ? { subscriptionType: cred.subscriptionType.trim() }
      : {}),
    ...(typeof cred.rateLimitTier === "string" && cred.rateLimitTier.trim()
      ? { rateLimitTier: cred.rateLimitTier.trim() }
      : {}),
    ...(Array.isArray(cred.scopes) && normalizeNonEmptyStringArray(cred.scopes).length > 0
      ? { scopes: normalizeNonEmptyStringArray(cred.scopes) }
      : {}),
    ...(typeof cred.emailAddress === "string" && cred.emailAddress.trim()
      ? { emailAddress: cred.emailAddress.trim().toLowerCase() }
      : {}),
    ...(typeof cred.organizationName === "string" && cred.organizationName.trim()
      ? { organizationName: cred.organizationName.trim() }
      : {}),
    ...(typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()
      ? { organizationUuid: cred.organizationUuid.trim() }
      : {}),
    ...(isObject(cred.nativeClaudeBundle)
      ? {
          nativeClaudeBundle: buildClaudeNativeBundle(cred.nativeClaudeBundle) ?? cloneJsonObject(cred.nativeClaudeBundle),
        }
      : {}),
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(normalized)).digest("hex")}`;
}

function tryBuildAnthropicCredentialFingerprint(credential) {
  try {
    return buildAnthropicCredentialFingerprint(credential);
  } catch {
    return null;
  }
}

function normalizeAuthorityCodexImportMetadata(state) {
  const importMeta = isObject(state.imports?.authority?.codex) ? state.imports.authority.codex : {};
  const labelSet = new Set();
  const rawLabels = Array.isArray(importMeta.labels) ? importMeta.labels : [];
  const rawLabelsByName = isObject(importMeta.labelsByName) ? importMeta.labelsByName : {};
  for (const labelRaw of [...rawLabels, ...Object.keys(rawLabelsByName)]) {
    try {
      labelSet.add(normalizeLabel(labelRaw));
    } catch {
      // Ignore malformed imported labels in state normalization; import paths validate strictly.
    }
  }

  const importedAtFallback =
    typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? importMeta.importedAt.trim() : null;
  const nextLabels = [...labelSet].toSorted((a, b) => a.localeCompare(b));
  const nextLabelsByName = {};

  for (const label of nextLabels) {
    const existing = isObject(rawLabelsByName[label]) ? rawLabelsByName[label] : {};
    const credential = getCodexCredentialFromStateUnsafe(state, label);
    const currentFingerprint = tryBuildCodexCredentialFingerprint(credential);
    const currentAccountId =
      typeof credential?.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
    const importedAt =
      typeof existing.importedAt === "string" && existing.importedAt.trim()
        ? existing.importedAt.trim()
        : importedAtFallback;
    const baseAccountId =
      typeof existing.baseAccountId === "string" && existing.baseAccountId.trim()
        ? existing.baseAccountId.trim()
        : currentAccountId;
    const baseCredentialFingerprint =
      typeof existing.baseCredentialFingerprint === "string" && existing.baseCredentialFingerprint.trim()
        ? existing.baseCredentialFingerprint.trim()
        : currentFingerprint;
    const dirtyObservedAt =
      typeof existing.dirtyObservedAt === "string" && existing.dirtyObservedAt.trim()
        ? existing.dirtyObservedAt.trim()
        : null;
    const lastPromotedAt =
      typeof existing.lastPromotedAt === "string" && existing.lastPromotedAt.trim()
        ? existing.lastPromotedAt.trim()
        : null;

    nextLabelsByName[label] = {
      ...(importedAt ? { importedAt } : {}),
      ...(baseAccountId ? { baseAccountId } : {}),
      ...(baseCredentialFingerprint ? { baseCredentialFingerprint } : {}),
      dirtyLocal: existing.dirtyLocal === true,
      ...(dirtyObservedAt ? { dirtyObservedAt } : {}),
      ...(lastPromotedAt ? { lastPromotedAt } : {}),
    };
  }

  importMeta.labels = nextLabels;
  importMeta.labelsByName = nextLabelsByName;
  state.imports.authority.codex = importMeta;
}

function buildAnthropicAuthorityIdentityFromCredential(credential) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) return null;
  const bundle = getClaudeNativeBundle(cred);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  const oauthAccount = isObject(bundle?.oauthAccount) ? bundle.oauthAccount : null;
  const accountUuid =
    typeof oauthAccount?.accountUuid === "string" && oauthAccount.accountUuid.trim()
      ? oauthAccount.accountUuid.trim()
      : null;
  const emailAddress =
    typeof cred.emailAddress === "string" && cred.emailAddress.trim()
      ? cred.emailAddress.trim().toLowerCase()
      : summary?.emailAddress || null;
  const organizationUuid =
    typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()
      ? cred.organizationUuid.trim()
      : summary?.organizationUuid || null;
  if (!accountUuid && !(emailAddress && organizationUuid)) {
    return null;
  }
  return {
    ...(accountUuid ? { accountUuid } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  };
}

function normalizeAnthropicAuthorityIdentityRecord(value) {
  if (!isObject(value)) return null;
  const accountUuid =
    typeof value.accountUuid === "string" && value.accountUuid.trim() ? value.accountUuid.trim() : null;
  const emailAddress =
    typeof value.emailAddress === "string" && value.emailAddress.trim()
      ? value.emailAddress.trim().toLowerCase()
      : null;
  const organizationUuid =
    typeof value.organizationUuid === "string" && value.organizationUuid.trim()
      ? value.organizationUuid.trim()
      : null;
  if (!accountUuid && !(emailAddress && organizationUuid)) {
    return null;
  }
  return {
    ...(accountUuid ? { accountUuid } : {}),
    ...(emailAddress ? { emailAddress } : {}),
    ...(organizationUuid ? { organizationUuid } : {}),
  };
}

function doAnthropicAuthorityIdentitiesMatch(left, right) {
  const leftIdentity = normalizeAnthropicAuthorityIdentityRecord(left);
  const rightIdentity = normalizeAnthropicAuthorityIdentityRecord(right);
  if (!leftIdentity || !rightIdentity) {
    return false;
  }
  if (leftIdentity.accountUuid && rightIdentity.accountUuid) {
    return leftIdentity.accountUuid === rightIdentity.accountUuid;
  }
  if (
    leftIdentity.emailAddress
    && rightIdentity.emailAddress
    && leftIdentity.organizationUuid
    && rightIdentity.organizationUuid
  ) {
    return (
      leftIdentity.emailAddress === rightIdentity.emailAddress
      && leftIdentity.organizationUuid === rightIdentity.organizationUuid
    );
  }
  return false;
}

function normalizeAuthorityAnthropicImportMetadata(state) {
  const importMeta = isObject(state.imports?.authority?.anthropic) ? state.imports.authority.anthropic : {};
  const labelSet = new Set();
  const rawLabels = Array.isArray(importMeta.labels) ? importMeta.labels : [];
  const rawLabelsByName = isObject(importMeta.labelsByName) ? importMeta.labelsByName : {};
  for (const labelRaw of [...rawLabels, ...Object.keys(rawLabelsByName)]) {
    try {
      labelSet.add(normalizeLabel(labelRaw));
    } catch {
      // Ignore malformed imported labels in state normalization; import paths validate strictly.
    }
  }

  const importedAtFallback =
    typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? importMeta.importedAt.trim() : null;
  const nextLabels = [...labelSet].toSorted((a, b) => a.localeCompare(b));
  const nextLabelsByName = {};

  for (const label of nextLabels) {
    const existing = isObject(rawLabelsByName[label]) ? rawLabelsByName[label] : {};
    const credential = getAnthropicCredentialFromStateUnsafe(state, label);
    const currentFingerprint = tryBuildAnthropicCredentialFingerprint(credential);
    const currentIdentity = buildAnthropicAuthorityIdentityFromCredential(credential);
    const importedAt =
      typeof existing.importedAt === "string" && existing.importedAt.trim()
        ? existing.importedAt.trim()
        : importedAtFallback;
    const baseCredentialFingerprint =
      typeof existing.baseCredentialFingerprint === "string" && existing.baseCredentialFingerprint.trim()
        ? existing.baseCredentialFingerprint.trim()
        : currentFingerprint;
    const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(existing.baseIdentity) ?? currentIdentity;
    const dirtyObservedAt =
      typeof existing.dirtyObservedAt === "string" && existing.dirtyObservedAt.trim()
        ? existing.dirtyObservedAt.trim()
        : null;
    const lastPromotedAt =
      typeof existing.lastPromotedAt === "string" && existing.lastPromotedAt.trim()
        ? existing.lastPromotedAt.trim()
        : null;

    nextLabelsByName[label] = {
      ...(importedAt ? { importedAt } : {}),
      ...(baseCredentialFingerprint ? { baseCredentialFingerprint } : {}),
      ...(baseIdentity ? { baseIdentity } : {}),
      dirtyLocal: existing.dirtyLocal === true,
      ...(dirtyObservedAt ? { dirtyObservedAt } : {}),
      ...(lastPromotedAt ? { lastPromotedAt } : {}),
    };
  }

  importMeta.labels = nextLabels;
  importMeta.labelsByName = nextLabelsByName;
  state.imports.authority.anthropic = importMeta;
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

function pruneHermesFleetDemand(homeDemand) {
  const entries = isObject(homeDemand) ? homeDemand : {};
  const next = {};
  for (const [homeIdRaw, entry] of Object.entries(entries)) {
    try {
      const homeId = normalizeHermesHomeId(homeIdRaw);
      const current = isObject(entry) ? entry : {};
      const updatedAtMs = parseTimestampLikeToMs(current.updatedAt);
      const lookbackDays = Math.max(1, Math.round(normalizeDemandWeight(current.lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
      const source =
        current.source === HERMES_SESSION_DEMAND_SOURCE || current.source === COLD_START_EQUAL_SHARE_DEMAND_SOURCE
          ? current.source
          : COLD_START_EQUAL_SHARE_DEMAND_SOURCE;
      const inputTokens = roundDemandWeight(current.inputTokens);
      const outputTokens = roundDemandWeight(current.outputTokens);
      const cacheReadTokens = roundDemandWeight(current.cacheReadTokens);
      const cacheWriteTokens = roundDemandWeight(current.cacheWriteTokens);
      const reasoningTokens = roundDemandWeight(current.reasoningTokens);
      next[homeId] = {
        updatedAt: updatedAtMs !== null ? new Date(updatedAtMs).toISOString() : new Date(0).toISOString(),
        lookbackDays,
        source,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        totalTokens: roundDemandWeight(
          Math.max(
            0,
            normalizeDemandWeight(
              current.totalTokens,
              inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens,
            ),
          ),
        ),
        demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(current.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
      };
    } catch {
      // Ignore malformed Hermes demand entries; the next refresh will repopulate them from live homes.
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
    if (k.includes("fingerprint")) return true;
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
  if (create && !isObject(account.reauth)) {
    account.reauth = {};
  }
  return account.reauth;
}

function getAccountPoolState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  if (create && !isObject(account.pool)) {
    account.pool = {};
  }
  return account.pool;
}

function normalizeInteractiveOAuthMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === REAUTH_MODE_NATIVE_CLAUDE) {
    return REAUTH_MODE_NATIVE_CLAUDE;
  }
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
  const reauthMode = normalizeInteractiveOAuthMode(account?.reauth?.mode);
  account.browser =
    reauthMode === REAUTH_MODE_MANUAL_CALLBACK || reauthMode === REAUTH_MODE_NATIVE_CLAUDE
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
  const normalizedReauthMode = normalizeInteractiveOAuthMode(reauth.mode);
  account.reauth = {
    ...(normalizedReauthMode ? { mode: normalizedReauthMode } : {}),
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
  const provider = normalizeProviderId(account.provider);
  if (provider === ANTHROPIC_PROVIDER) {
    throw new Error(
      `Claude labels do not use browser bindings anymore. Use \`aim claude capture-native ${normalizedLabel}\`, ` +
        `\`aim claude import-native ${normalizedLabel} --in <file>\`, or \`aim ${normalizedLabel}\`.`,
    );
  }

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
  state.imports.authority.anthropic = isObject(state.imports.authority.anthropic) ? state.imports.authority.anthropic : {};
  state.pool = isObject(state.pool) ? state.pool : {};
  state.pool.openaiCodex = isObject(state.pool.openaiCodex) ? state.pool.openaiCodex : {};
  state.pool.openaiCodex.history = pruneOpenaiCodexHistory(state.pool.openaiCodex.history);
  state.pool.openaiCodex.agentDemand = pruneOpenaiCodexAgentDemand(state.pool.openaiCodex.agentDemand);
  state.pool.openaiCodex.hermesFleet = isObject(state.pool.openaiCodex.hermesFleet) ? state.pool.openaiCodex.hermesFleet : {};
  state.pool.openaiCodex.hermesFleet.demandByHome = pruneHermesFleetDemand(state.pool.openaiCodex.hermesFleet.demandByHome);
  state.pool.anthropic = isObject(state.pool.anthropic) ? state.pool.anthropic : {};
  state.pool.anthropic.history = pruneOpenaiCodexHistory(state.pool.anthropic.history);
  state.targets = isObject(state.targets) ? state.targets : {};
  state.targets.openclaw = isObject(state.targets.openclaw) ? state.targets.openclaw : {};
  state.targets.openclaw.assignments = isObject(state.targets.openclaw.assignments)
    ? state.targets.openclaw.assignments
    : {};
  state.targets.openclaw.exclusions = isObject(state.targets.openclaw.exclusions)
    ? state.targets.openclaw.exclusions
    : {};
  state.targets.codexCli = isObject(state.targets.codexCli) ? state.targets.codexCli : {};
  state.targets.claudeCli = isObject(state.targets.claudeCli) ? state.targets.claudeCli : {};
  state.targets.piCli = isObject(state.targets.piCli) ? state.targets.piCli : {};
  if (Object.hasOwn(state.targets, "hermes")) {
    delete state.targets.hermes;
  }
  if (Object.hasOwn(state.targets, "productGrowthHermes")) {
    delete state.targets.productGrowthHermes;
  }
  if (Object.hasOwn(state.targets, "growthAnalystHermes")) {
    delete state.targets.growthAnalystHermes;
  }

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
    if (normalizeProviderId(account.provider) === ANTHROPIC_PROVIDER) {
      account.reauth = {
        ...account.reauth,
        mode: REAUTH_MODE_NATIVE_CLAUDE,
      };
      account.browser = null;
    }

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
  if (Object.hasOwn(state.targets.claudeCli, "lastReadback")) {
    delete state.targets.claudeCli.lastReadback;
  }
  if (Object.hasOwn(state.targets.piCli, "lastReadback")) {
    delete state.targets.piCli.lastReadback;
  }

  normalizeAuthorityCodexImportMetadata(state);
  normalizeAuthorityAnthropicImportMetadata(state);
}

function getAuthorityCodexImport(state) {
  ensureStateShape(state);
  return state.imports.authority.codex;
}

function getAuthorityCodexImportLabelMeta(state, label) {
  const normalizedLabel = normalizeLabel(label);
  const labelsByName = getAuthorityCodexImport(state).labelsByName;
  return isObject(labelsByName?.[normalizedLabel]) ? labelsByName[normalizedLabel] : null;
}

function isImportedCodexLabel(state, label) {
  const normalizedLabel = normalizeLabel(label);
  return getImportedCodexLabels(state).includes(normalizedLabel);
}

function getAuthorityCodexImportLabelStatus(state, label) {
  const normalizedLabel = normalizeLabel(label);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return {
      imported: false,
      dirty: false,
      meta: null,
      currentFingerprint: null,
      baseFingerprint: null,
      currentAccountId: null,
      baseAccountId: null,
    };
  }

  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  const credential = getCodexCredential(state, normalizedLabel);
  const currentFingerprint = tryBuildCodexCredentialFingerprint(credential);
  const currentAccountId =
    typeof credential?.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
  const baseFingerprint =
    typeof meta?.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
      ? meta.baseCredentialFingerprint.trim()
      : null;
  const baseAccountId =
    typeof meta?.baseAccountId === "string" && meta.baseAccountId.trim() ? meta.baseAccountId.trim() : null;
  const dirty =
    meta?.dirtyLocal === true
    || Boolean(currentFingerprint && baseFingerprint && currentFingerprint !== baseFingerprint)
    || Boolean(currentAccountId && baseAccountId && currentAccountId !== baseAccountId);

  return {
    imported: true,
    dirty,
    meta,
    currentFingerprint,
    baseFingerprint,
    currentAccountId,
    baseAccountId,
  };
}

function markImportedCodexLabelDirtyState(state, label, { observedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return { imported: false, dirty: false };
  }

  const status = getAuthorityCodexImportLabelStatus(state, normalizedLabel);
  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  if (!meta) {
    return { imported: true, dirty: status.dirty };
  }
  if (status.dirty) {
    meta.dirtyLocal = true;
    if (!(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim())) {
      meta.dirtyObservedAt = String(observedAt ?? new Date().toISOString());
    }
  } else {
    meta.dirtyLocal = false;
    if (Object.hasOwn(meta, "dirtyObservedAt")) {
      delete meta.dirtyObservedAt;
    }
  }
  return { imported: true, dirty: meta.dirtyLocal === true };
}

function markImportedCodexLabelPromoted(state, label, { promotedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedCodexLabel(state, normalizedLabel)) {
    return { imported: false };
  }
  const credential = getCodexCredential(state, normalizedLabel);
  const meta = getAuthorityCodexImportLabelMeta(state, normalizedLabel);
  if (!meta || !credential) {
    return { imported: true };
  }
  const fingerprint = tryBuildCodexCredentialFingerprint(credential);
  const accountId = typeof credential.accountId === "string" && credential.accountId.trim() ? credential.accountId.trim() : null;
  if (fingerprint) {
    meta.baseCredentialFingerprint = fingerprint;
  }
  if (accountId) {
    meta.baseAccountId = accountId;
  }
  meta.dirtyLocal = false;
  if (Object.hasOwn(meta, "dirtyObservedAt")) {
    delete meta.dirtyObservedAt;
  }
  meta.lastPromotedAt = String(promotedAt ?? new Date().toISOString());
  return { imported: true };
}

function getAuthorityAnthropicImport(state) {
  ensureStateShape(state);
  return state.imports.authority.anthropic;
}

function getAuthorityAnthropicImportLabelMeta(state, label) {
  const normalizedLabel = normalizeLabel(label);
  const labelsByName = getAuthorityAnthropicImport(state).labelsByName;
  return isObject(labelsByName?.[normalizedLabel]) ? labelsByName[normalizedLabel] : null;
}

function getImportedAnthropicLabels(state) {
  const imported = getAuthorityAnthropicImport(state);
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

function isImportedAnthropicLabel(state, label) {
  const normalizedLabel = normalizeLabel(label);
  return getImportedAnthropicLabels(state).includes(normalizedLabel);
}

function getAuthorityAnthropicImportLabelStatus(state, label) {
  const normalizedLabel = normalizeLabel(label);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return {
      imported: false,
      dirty: false,
      meta: null,
      currentFingerprint: null,
      baseFingerprint: null,
      currentIdentity: null,
      baseIdentity: null,
    };
  }

  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
  const credential = getAnthropicCredential(state, normalizedLabel);
  const currentFingerprint = tryBuildAnthropicCredentialFingerprint(credential);
  const currentIdentity = buildAnthropicAuthorityIdentityFromCredential(credential);
  const baseFingerprint =
    typeof meta?.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
      ? meta.baseCredentialFingerprint.trim()
      : null;
  const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(meta?.baseIdentity);
  const dirty =
    meta?.dirtyLocal === true
    || currentFingerprint !== baseFingerprint
    || Boolean(currentIdentity && baseIdentity && !doAnthropicAuthorityIdentitiesMatch(currentIdentity, baseIdentity));

  return {
    imported: true,
    dirty,
    meta,
    currentFingerprint,
    baseFingerprint,
    currentIdentity,
    baseIdentity,
  };
}

function markImportedAnthropicLabelDirtyState(state, label, { observedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return { imported: false, dirty: false };
  }

  const status = getAuthorityAnthropicImportLabelStatus(state, normalizedLabel);
  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
  if (!meta) {
    return { imported: true, dirty: status.dirty };
  }
  if (status.dirty) {
    meta.dirtyLocal = true;
    if (!(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim())) {
      meta.dirtyObservedAt = String(observedAt ?? new Date().toISOString());
    }
  } else {
    meta.dirtyLocal = false;
    if (Object.hasOwn(meta, "dirtyObservedAt")) {
      delete meta.dirtyObservedAt;
    }
  }
  return { imported: true, dirty: meta.dirtyLocal === true };
}

function markImportedAnthropicLabelPromoted(state, label, { promotedAt } = {}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  if (!isImportedAnthropicLabel(state, normalizedLabel)) {
    return { imported: false };
  }
  const credential = getAnthropicCredential(state, normalizedLabel);
  const meta = getAuthorityAnthropicImportLabelMeta(state, normalizedLabel);
  if (!meta) {
    return { imported: true };
  }
  const fingerprint = tryBuildAnthropicCredentialFingerprint(credential);
  const identity = buildAnthropicAuthorityIdentityFromCredential(credential);
  if (fingerprint) {
    meta.baseCredentialFingerprint = fingerprint;
  } else if (Object.hasOwn(meta, "baseCredentialFingerprint")) {
    delete meta.baseCredentialFingerprint;
  }
  if (identity) {
    meta.baseIdentity = identity;
  } else if (Object.hasOwn(meta, "baseIdentity")) {
    delete meta.baseIdentity;
  }
  meta.dirtyLocal = false;
  if (Object.hasOwn(meta, "dirtyObservedAt")) {
    delete meta.dirtyObservedAt;
  }
  meta.lastPromotedAt = String(promotedAt ?? new Date().toISOString());
  return { imported: true };
}

function getOpenclawTargetState(state) {
  ensureStateShape(state);
  return state.targets.openclaw;
}

function getOpenclawAgentDemandState(state) {
  ensureStateShape(state);
  return state.pool.openaiCodex.agentDemand;
}

function getHermesFleetState(state) {
  ensureStateShape(state);
  return state.pool.openaiCodex.hermesFleet;
}

function getHermesFleetDemandState(state) {
  return getHermesFleetState(state).demandByHome;
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
  if (mode === REAUTH_MODE_MANUAL_CALLBACK || mode === REAUTH_MODE_NATIVE_CLAUDE) {
    state.accounts[normalizedLabel].browser = null;
  }
}

function getCodexTargetState(state) {
  ensureStateShape(state);
  return state.targets.codexCli;
}

function getClaudeTargetState(state) {
  ensureStateShape(state);
  return state.targets.claudeCli;
}

function getPiTargetState(state) {
  ensureStateShape(state);
  return state.targets.piCli;
}

function isLikelyJwt(value) {
  const raw = String(value ?? "").trim();
  const parts = raw.split(".");
  return parts.length === 3 && parts.every((part) => part.length > 0);
}

function decodeJwtPayload(token) {
  const raw = String(token ?? "").trim();
  if (!isLikelyJwt(raw)) return null;
  const [, payloadSegment] = raw.split(".");
  try {
    const normalized = payloadSegment.replace(/-/g, "+").replace(/_/g, "/");
    const padded = normalized.padEnd(normalized.length + ((4 - (normalized.length % 4)) % 4), "=");
    const decoded = Buffer.from(padded, "base64").toString("utf8");
    const parsed = JSON.parse(decoded);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function extractOpenAICodexAccountIdFromClaims(claims) {
  if (!isObject(claims)) return null;
  const authClaims = isObject(claims["https://api.openai.com/auth"]) ? claims["https://api.openai.com/auth"] : null;
  const candidates = [
    authClaims?.chatgpt_account_id,
    claims["https://api.openai.com/auth.chatgpt_account_id"],
    claims.chatgpt_account_id,
    claims.account_id,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

function extractOpenAICodexAccountIdFromToken(token) {
  return extractOpenAICodexAccountIdFromClaims(decodeJwtPayload(token));
}

function extractJwtIdentityLabel(token, fallback = "device_code") {
  const claims = decodeJwtPayload(token);
  if (isObject(claims)) {
    for (const key of ["email", "preferred_username", "upn"]) {
      const value = claims[key];
      if (typeof value === "string" && value.trim()) {
        return value.trim();
      }
    }
  }
  return fallback;
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

function resolveManagedPiAgentDir({ homeDir }) {
  const override = String(process.env.PI_CODING_AGENT_DIR ?? "").trim();
  if (override) {
    return path.resolve(override);
  }
  return path.join(homeDir, ".pi", "agent");
}

function resolveManagedClaudeDir({ homeDir }) {
  return path.join(homeDir, ".claude");
}

function resolveClaudeAppStatePath({ homeDir }) {
  return path.join(homeDir, ".claude.json");
}

function resolveCodexAuthFilePath(codexHome) {
  return path.join(codexHome, "auth.json");
}

function resolveClaudeAuthFilePath(claudeDir) {
  return path.join(claudeDir, ".credentials.json");
}

function resolvePiAuthFilePath(agentDir) {
  return path.join(agentDir, "auth.json");
}

function resolveCodexConfigPath(codexHome) {
  return path.join(codexHome, "config.toml");
}

function resolveClaudeCommand({ homeDir, spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "claude";
  }
  return resolveExecutableOnPath("claude", {
    extraSearchPaths: homeDir ? [path.join(homeDir, ".local", "bin")] : [],
  });
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

function readPiAuthFile({ agentDir }) {
  const authPath = resolvePiAuthFilePath(agentDir);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Pi auth.json is not a JSON object.");
    }
    const providerEntry = isObject(parsed?.[OPENAI_CODEX_PROVIDER]) ? parsed[OPENAI_CODEX_PROVIDER] : null;
    const accountId = typeof providerEntry?.accountId === "string" ? providerEntry.accountId.trim() : null;
    const providerEntryType = typeof providerEntry?.type === "string" ? providerEntry.type.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath,
      accountId: accountId || null,
      providerEntryPresent: Boolean(providerEntry),
      providerEntryType: providerEntryType || null,
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

function normalizeNonEmptyStringArray(value) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((entry) => String(entry ?? "").trim()).filter(Boolean))];
}

function cloneJsonObject(value) {
  return isObject(value) ? structuredClone(value) : null;
}

function getClaudeNativeBundle(source) {
  if (isObject(source?.nativeClaudeBundle)) {
    return source.nativeClaudeBundle;
  }
  if (isObject(source?.claudeAiOauth) && isObject(source?.oauthAccount)) {
    return source;
  }
  return null;
}

function buildClaudeNativeBundle(source) {
  const oauth = cloneJsonObject(source?.claudeAiOauth);
  const account = cloneJsonObject(source?.oauthAccount);
  if (!oauth || !account) return null;
  const expiresAt = parseTimestampLikeToMs(oauth.expiresAt);
  if (expiresAt) {
    oauth.expiresAt = expiresAt;
  }
  if (Array.isArray(oauth.scopes)) {
    oauth.scopes = normalizeNonEmptyStringArray(oauth.scopes);
  }
  return {
    claudeAiOauth: oauth,
    oauthAccount: account,
  };
}

function buildClaudeCredentialSummaryFromBundle(source) {
  const bundle = getClaudeNativeBundle(source);
  if (!bundle) return null;
  const claudeAiOauth = isObject(bundle.claudeAiOauth) ? bundle.claudeAiOauth : null;
  const oauthAccount = isObject(bundle.oauthAccount) ? bundle.oauthAccount : null;
  if (!claudeAiOauth || !oauthAccount) return null;

  const access = typeof claudeAiOauth.accessToken === "string" ? claudeAiOauth.accessToken.trim() : "";
  const refresh = typeof claudeAiOauth.refreshToken === "string" ? claudeAiOauth.refreshToken.trim() : "";
  const expiresAt = toIsoFromExpiresMs(parseTimestampLikeToMs(claudeAiOauth.expiresAt));
  const subscriptionType =
    typeof claudeAiOauth.subscriptionType === "string" ? claudeAiOauth.subscriptionType.trim() : "";
  const rateLimitTier =
    typeof claudeAiOauth.rateLimitTier === "string" ? claudeAiOauth.rateLimitTier.trim() : "";
  const scopes = normalizeNonEmptyStringArray(claudeAiOauth.scopes);
  const emailAddress =
    typeof oauthAccount.emailAddress === "string" ? oauthAccount.emailAddress.trim().toLowerCase() : "";
  const organizationName =
    typeof oauthAccount.organizationName === "string" ? oauthAccount.organizationName.trim() : "";
  const organizationUuid =
    typeof oauthAccount.organizationUuid === "string" ? oauthAccount.organizationUuid.trim() : "";

  return {
    access,
    refresh,
    expiresAt: expiresAt || null,
    subscriptionType,
    rateLimitTier,
    scopes,
    emailAddress,
    organizationName,
    organizationUuid,
  };
}

function hasCompleteClaudeNativeBundle(source) {
  const bundle = getClaudeNativeBundle(source);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  return Boolean(
    bundle
    && isObject(bundle.claudeAiOauth)
    && isObject(bundle.oauthAccount)
    && summary
    && summary.access
    && summary.refresh
    && summary.expiresAt
    && summary.subscriptionType
    && summary.rateLimitTier
    && summary.scopes.length > 0
    && summary.emailAddress
    && summary.organizationName
    && summary.organizationUuid
  );
}

function readClaudeAuthFile({ claudeDir }) {
  const authPath = resolveClaudeAuthFilePath(claudeDir);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Claude .credentials.json is not a JSON object.");
    }
    const claudeAiOauth = isObject(parsed?.claudeAiOauth) ? parsed.claudeAiOauth : null;
    const accessToken = typeof claudeAiOauth?.accessToken === "string" ? claudeAiOauth.accessToken.trim() : null;
    const refreshToken = typeof claudeAiOauth?.refreshToken === "string" ? claudeAiOauth.refreshToken.trim() : null;
    const expiresAtMs = parseTimestampLikeToMs(claudeAiOauth?.expiresAt);
    const subscriptionType =
      typeof claudeAiOauth?.subscriptionType === "string" ? claudeAiOauth.subscriptionType.trim() : "";
    const rateLimitTier =
      typeof claudeAiOauth?.rateLimitTier === "string" ? claudeAiOauth.rateLimitTier.trim() : "";
    const scopes = normalizeNonEmptyStringArray(claudeAiOauth?.scopes);
    return {
      exists: true,
      ok: true,
      authPath,
      claudeAiOauthPresent: Boolean(claudeAiOauth),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      expiresAt: expiresAtMs,
      subscriptionType: subscriptionType || null,
      rateLimitTier: rateLimitTier || null,
      scopes,
      claudeAiOauth: cloneJsonObject(claudeAiOauth),
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

function readClaudeAppStateFile({ homeDir }) {
  const appStatePath = resolveClaudeAppStatePath({ homeDir });
  if (!fs.existsSync(appStatePath)) {
    return { exists: false, appStatePath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(appStatePath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Claude .claude.json is not a JSON object.");
    }
    const oauthAccount = isObject(parsed?.oauthAccount) ? parsed.oauthAccount : null;
    const emailAddress =
      typeof oauthAccount?.emailAddress === "string" ? oauthAccount.emailAddress.trim().toLowerCase() : null;
    const organizationName =
      typeof oauthAccount?.organizationName === "string" ? oauthAccount.organizationName.trim() : null;
    const organizationUuid =
      typeof oauthAccount?.organizationUuid === "string" ? oauthAccount.organizationUuid.trim() : null;
    return {
      exists: true,
      ok: true,
      appStatePath,
      oauthAccountPresent: Boolean(oauthAccount),
      emailAddress: emailAddress || null,
      organizationName: organizationName || null,
      organizationUuid: organizationUuid || null,
      oauthAccount: cloneJsonObject(oauthAccount),
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      appStatePath,
      error: String(err?.message ?? err),
    };
  }
}

function readClaudeNativeBundle({ homeDir }) {
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const credentials = readClaudeAuthFile({ claudeDir });
  const appState = readClaudeAppStateFile({ homeDir });
  const nativeClaudeBundle =
    credentials.ok === true
    && credentials.claudeAiOauthPresent === true
    && appState.ok === true
    && appState.oauthAccountPresent === true
      ? buildClaudeNativeBundle({
          claudeAiOauth: credentials.claudeAiOauth,
          oauthAccount: appState.oauthAccount,
        })
      : null;
  const summary = buildClaudeCredentialSummaryFromBundle(nativeClaudeBundle);
  return {
    exists: credentials.exists || appState.exists,
    ok: (credentials.exists ? credentials.ok === true : true) && (appState.exists ? appState.ok === true : true),
    credentialsPath: credentials.authPath ?? resolveClaudeAuthFilePath(claudeDir),
    appStatePath: appState.appStatePath ?? resolveClaudeAppStatePath({ homeDir }),
    credentials,
    appState,
    nativeClaudeBundle,
    summary,
  };
}

function deriveAnthropicCredentialFromClaudeBundle({ existingCredential, nativeClaudeBundle }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error("Refusing to store an incomplete native Claude bundle.");
  }
  const next = {
    ...(isObject(existingCredential) ? existingCredential : {}),
    nativeClaudeBundle: bundle,
    access: summary.access,
    refresh: summary.refresh,
    expiresAt: summary.expiresAt,
    subscriptionType: summary.subscriptionType,
    rateLimitTier: summary.rateLimitTier,
    scopes: summary.scopes,
    emailAddress: summary.emailAddress,
    organizationName: summary.organizationName,
    organizationUuid: summary.organizationUuid,
  };
  return next;
}

function updateClaudeBundleTokenFields({ nativeClaudeBundle, access, refresh, expiresAt }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  if (!bundle) {
    throw new Error("Cannot refresh Claude bundle tokens without an existing native Claude bundle.");
  }
  const expiresAtMs = parseExpiresAtToMs(expiresAt);
  if (!expiresAtMs) {
    throw new Error("Cannot refresh Claude bundle tokens without a valid expiresAt.");
  }
  bundle.claudeAiOauth.accessToken = access;
  bundle.claudeAiOauth.refreshToken = refresh;
  bundle.claudeAiOauth.expiresAt = expiresAtMs;
  return bundle;
}

function captureClaudeNativeBundleFromHome({
  homeDir,
  label,
  expectedAccessToken = null,
  expectedRefreshToken = null,
}) {
  const readback = readClaudeNativeBundle({ homeDir });
  const normalizedLabel = normalizeLabel(label);
  if (readback.credentials.exists !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.credentialsPath} is missing. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (readback.credentials.ok !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: could not read ${readback.credentialsPath} ` +
        `(${readback.credentials.error || "unknown error"}).`,
    );
  }
  if (readback.credentials.claudeAiOauthPresent !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.credentialsPath} is missing claudeAiOauth.`,
    );
  }
  if (readback.appState.exists !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.appStatePath} is missing. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (readback.appState.ok !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: could not read ${readback.appStatePath} ` +
        `(${readback.appState.error || "unknown error"}).`,
    );
  }
  if (readback.appState.oauthAccountPresent !== true) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: ${readback.appStatePath} is missing oauthAccount. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: the local Claude auth files are incomplete for native switching.`,
    );
  }
  const expectedAccess = typeof expectedAccessToken === "string" ? expectedAccessToken.trim() : "";
  const expectedRefresh = typeof expectedRefreshToken === "string" ? expectedRefreshToken.trim() : "";
  if (
    (expectedAccess && readback.summary.access !== expectedAccess)
    || (expectedRefresh && readback.summary.refresh !== expectedRefresh)
  ) {
    throw new Error(
      `Native Claude bundle capture failed for label=${normalizedLabel}: the current Claude auth files do not match the freshly authed AIM tokens. ` +
        `Log this account into Claude on this machine, then rerun \`aim ${normalizedLabel}\`.`,
    );
  }
  return {
    nativeClaudeBundle: readback.nativeClaudeBundle,
    summary: readback.summary,
    readback,
  };
}

function getClaudeNativeBundleIdentity(source) {
  const bundle = getClaudeNativeBundle(source);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  const oauthAccount = isObject(bundle?.oauthAccount) ? bundle.oauthAccount : null;
  const accountUuid =
    typeof oauthAccount?.accountUuid === "string" && oauthAccount.accountUuid.trim()
      ? oauthAccount.accountUuid.trim()
      : null;
  return {
    accountUuid,
    emailAddress: summary?.emailAddress || null,
    organizationUuid: summary?.organizationUuid || null,
    refreshToken: summary?.refresh || null,
  };
}

function doClaudeNativeBundleIdentitiesMatch(left, right) {
  const leftIdentity = getClaudeNativeBundleIdentity(left);
  const rightIdentity = getClaudeNativeBundleIdentity(right);
  if (leftIdentity.accountUuid && rightIdentity.accountUuid) {
    return leftIdentity.accountUuid === rightIdentity.accountUuid;
  }
  if (
    leftIdentity.emailAddress
    && rightIdentity.emailAddress
    && leftIdentity.organizationUuid
    && rightIdentity.organizationUuid
  ) {
    return (
      leftIdentity.emailAddress === rightIdentity.emailAddress
      && leftIdentity.organizationUuid === rightIdentity.organizationUuid
    );
  }
  if (leftIdentity.refreshToken && rightIdentity.refreshToken) {
    return leftIdentity.refreshToken === rightIdentity.refreshToken;
  }
  return false;
}

function findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle, excludeLabel } = {}) {
  ensureStateShape(state);
  const excluded = excludeLabel ? normalizeLabel(excludeLabel) : null;
  for (const [label, credential] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (excluded && normalizeLabel(label) === excluded) continue;
    if (!hasCompleteClaudeNativeBundle(credential)) continue;
    if (doClaudeNativeBundleIdentitiesMatch(credential, nativeClaudeBundle)) {
      return normalizeLabel(label);
    }
  }
  return null;
}

function ensureAnthropicLabelConfigured(state, label) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  const provider = normalizeProviderId(account?.provider);
  if (provider && provider !== ANTHROPIC_PROVIDER) {
    throw new Error(
      `Refusing to store native Claude auth on non-Anthropic label=${normalizedLabel} provider=${provider}.`,
    );
  }
  account.provider = ANTHROPIC_PROVIDER;
  ensureAccountShape(account, { providerHint: ANTHROPIC_PROVIDER });
  account.reauth = {
    ...account.reauth,
    mode: REAUTH_MODE_NATIVE_CLAUDE,
  };
  account.browser = null;
  return account;
}

function validateAnthropicNativeBundleForLabel({ state, label, nativeClaudeBundle }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error(
      `Refusing to store an incomplete native Claude bundle for label=${normalizedLabel}.`,
    );
  }

  const account = ensureAnthropicLabelConfigured(state, normalizedLabel);
  const expectedEmail =
    typeof account.expect?.email === "string" ? account.expect.email.trim().toLowerCase() : "";
  if (expectedEmail && summary.emailAddress !== expectedEmail) {
    throw new Error(
      `Native Claude login for label=${normalizedLabel} is ${summary.emailAddress}, but AIM expects ${expectedEmail}.`,
    );
  }

  const duplicateLabel = findAnthropicLabelByNativeClaudeBundle(state, {
    nativeClaudeBundle: bundle,
    excludeLabel: normalizedLabel,
  });
  if (duplicateLabel) {
    throw new Error(
      `That native Claude login is already stored on label=${duplicateLabel}. Refusing duplicate Anthropic bundle capture/import.`,
    );
  }

  return {
    bundle,
    summary,
  };
}

function persistAnthropicNativeBundleForLabel({ state, label, nativeClaudeBundle }) {
  const normalizedLabel = normalizeLabel(label);
  const { bundle, summary } = validateAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle,
  });
  const existingCredential = getAnthropicCredential(state, normalizedLabel);
  const credential = deriveAnthropicCredentialFromClaudeBundle({
    existingCredential,
    nativeClaudeBundle: bundle,
  });
  state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = credential;
  return {
    label: normalizedLabel,
    credential,
    summary,
  };
}

function buildClaudeNativeBundleExportPayload({ nativeClaudeBundle, labelHint = null, sourceHome = null }) {
  const bundle = buildClaudeNativeBundle(nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(bundle);
  if (!bundle || !hasCompleteClaudeNativeBundle(bundle) || !summary) {
    throw new Error("Refusing to export an incomplete native Claude bundle.");
  }
  return {
    version: CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION,
    provider: ANTHROPIC_PROVIDER,
    exportedAt: new Date().toISOString(),
    ...(sourceHome ? { sourceHome: path.resolve(sourceHome) } : {}),
    ...(labelHint ? { labelHint: normalizeLabel(labelHint) } : {}),
    nativeClaudeBundle: bundle,
  };
}

function readClaudeNativeBundleExportFile({ filePath }) {
  const resolvedPath = path.resolve(filePath);
  if (!fs.existsSync(resolvedPath)) {
    throw new Error(`Native Claude bundle file does not exist: ${resolvedPath}`);
  }
  const parsed = readJsonFile(resolvedPath);
  if (!isObject(parsed)) {
    throw new Error(`Native Claude bundle file is not a JSON object: ${resolvedPath}`);
  }
  if (parsed.version !== CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION) {
    throw new Error(
      `Unsupported native Claude bundle file version in ${resolvedPath}: ${String(parsed.version ?? "(missing)")}.`,
    );
  }
  if (normalizeProviderId(parsed.provider) !== ANTHROPIC_PROVIDER) {
    throw new Error(
      `Unsupported provider in native Claude bundle file ${resolvedPath}: ${String(parsed.provider ?? "(missing)")}.`,
    );
  }
  const nativeClaudeBundle = buildClaudeNativeBundle(parsed.nativeClaudeBundle);
  const summary = buildClaudeCredentialSummaryFromBundle(nativeClaudeBundle);
  if (!nativeClaudeBundle || !hasCompleteClaudeNativeBundle(nativeClaudeBundle) || !summary) {
    throw new Error(`Native Claude bundle file is incomplete: ${resolvedPath}`);
  }
  const payload = {
    version: CLAUDE_NATIVE_BUNDLE_EXPORT_VERSION,
    provider: ANTHROPIC_PROVIDER,
    exportedAt:
      typeof parsed.exportedAt === "string" && parsed.exportedAt.trim() ? parsed.exportedAt.trim() : new Date().toISOString(),
    ...(typeof parsed.sourceHome === "string" && parsed.sourceHome.trim()
      ? { sourceHome: path.resolve(parsed.sourceHome.trim()) }
      : {}),
    ...(typeof parsed.labelHint === "string" && parsed.labelHint.trim()
      ? { labelHint: normalizeLabel(parsed.labelHint) }
      : {}),
    nativeClaudeBundle,
  };
  return {
    filePath: resolvedPath,
    payload,
    summary,
  };
}

function writeClaudeNativeBundleExportFile({ filePath, nativeClaudeBundle, labelHint = null, sourceHome = null }) {
  const resolvedPath = path.resolve(filePath);
  const payload = buildClaudeNativeBundleExportPayload({
    nativeClaudeBundle,
    labelHint,
    sourceHome,
  });
  const writeResult = writeJsonFileIfChanged(resolvedPath, payload, { mode: 0o600 });
  return {
    filePath: resolvedPath,
    wrote: writeResult.wrote,
    payload,
    summary: buildClaudeCredentialSummaryFromBundle(payload.nativeClaudeBundle),
  };
}

function captureAnthropicNativeBundleForLabel({ state, label, sourceHome }) {
  const normalizedLabel = normalizeLabel(label);
  const source = resolveHomeDir(sourceHome);
  const captured = captureClaudeNativeBundleFromHome({
    homeDir: source,
    label: normalizedLabel,
  });
  const persisted = persistAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle: captured.nativeClaudeBundle,
  });
  return {
    label: normalizedLabel,
    sourceHome: source,
    readback: captured.readback,
    summary: persisted.summary,
    credential: persisted.credential,
  };
}

function importAnthropicNativeBundleForLabel({ state, label, filePath }) {
  const normalizedLabel = normalizeLabel(label);
  const imported = readClaudeNativeBundleExportFile({ filePath });
  const persisted = persistAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    nativeClaudeBundle: imported.payload.nativeClaudeBundle,
  });
  return {
    label: normalizedLabel,
    filePath: imported.filePath,
    summary: persisted.summary,
    credential: persisted.credential,
    exportedAt: imported.payload.exportedAt,
    labelHint: imported.payload.labelHint ?? null,
    sourceHome: imported.payload.sourceHome ?? null,
  };
}

function exportLiveClaudeNativeBundle({ filePath, sourceHome, labelHint = null }) {
  const source = resolveHomeDir(sourceHome);
  const readback = readClaudeNativeBundle({ homeDir: source });
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error(
      `No complete native Claude login is available under ${source}. Run native Claude login there first.`,
    );
  }
  const exported = writeClaudeNativeBundleExportFile({
    filePath,
    nativeClaudeBundle: readback.nativeClaudeBundle,
    labelHint,
    sourceHome: source,
  });
  return {
    sourceHome: source,
    readback,
    ...exported,
  };
}

function readHermesAuthFile({ authPath }) {
  const resolvedAuthPath = resolveExplicitHermesAuthFilePath(authPath);
  if (!fs.existsSync(resolvedAuthPath)) {
    return { exists: false, authPath: resolvedAuthPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedAuthPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Hermes auth.json is not a JSON object.");
    }
    const providers = isObject(parsed.providers) ? parsed.providers : {};
    const providerEntry = isObject(providers[OPENAI_CODEX_PROVIDER]) ? providers[OPENAI_CODEX_PROVIDER] : null;
    const tokens = isObject(providerEntry?.tokens) ? providerEntry.tokens : null;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : null;
    const refreshToken = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : null;
    const credentialPool = isObject(parsed.credential_pool) ? parsed.credential_pool : {};
    const rawProviderPoolEntries = Array.isArray(credentialPool[OPENAI_CODEX_PROVIDER])
      ? credentialPool[OPENAI_CODEX_PROVIDER].filter((entry) => isObject(entry))
      : [];
    const deviceCodePoolEntry =
      rawProviderPoolEntries.find((entry) => {
        const source = typeof entry?.source === "string" ? entry.source.trim().toLowerCase().replace(/-/g, "_") : "";
        return source === "device_code";
      })
      ?? (rawProviderPoolEntries.length === 1 ? rawProviderPoolEntries[0] : null);
    const poolAccessToken = typeof deviceCodePoolEntry?.access_token === "string" ? deviceCodePoolEntry.access_token.trim() : null;
    const poolRefreshToken = typeof deviceCodePoolEntry?.refresh_token === "string" ? deviceCodePoolEntry.refresh_token.trim() : null;
    const activeProvider = typeof parsed.active_provider === "string" ? parsed.active_provider.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath: resolvedAuthPath,
      activeProvider: activeProvider || null,
      providerEntryPresent: Boolean(providerEntry),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      accountId: extractOpenAICodexAccountIdFromToken(accessToken) || null,
      providerPoolEntryCount: rawProviderPoolEntries.length,
      deviceCodePoolEntryPresent: Boolean(deviceCodePoolEntry),
      poolAccessToken: poolAccessToken || null,
      poolRefreshToken: poolRefreshToken || null,
      poolAccountId: extractOpenAICodexAccountIdFromToken(poolAccessToken) || null,
      lastRefresh: typeof providerEntry?.last_refresh === "string" ? providerEntry.last_refresh.trim() : null,
      authMode: typeof providerEntry?.auth_mode === "string" ? providerEntry.auth_mode.trim() : null,
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath: resolvedAuthPath,
      error: String(err?.message ?? err),
    };
  }
}

function generateHermesPoolEntryId(updatedAt) {
  const timestamp = Date.parse(String(updatedAt ?? "").trim());
  const basis = Number.isFinite(timestamp) ? timestamp : Date.now();
  return Math.abs(basis).toString(16).slice(-6).padStart(6, "0");
}

function buildHermesCodexPoolEntry({ existing, credential, updatedAt }) {
  const existingEntries =
    Array.isArray(existing?.credential_pool?.[OPENAI_CODEX_PROVIDER]) ? existing.credential_pool[OPENAI_CODEX_PROVIDER] : [];
  const existingDeviceCodeEntry =
    existingEntries.find((entry) => {
      const source = typeof entry?.source === "string" ? entry.source.trim().toLowerCase().replace(/-/g, "_") : "";
      return source === "device_code";
    })
    ?? (existingEntries.length === 1 ? existingEntries[0] : null);
  const id =
    typeof existingDeviceCodeEntry?.id === "string" && existingDeviceCodeEntry.id.trim()
      ? existingDeviceCodeEntry.id.trim()
      : generateHermesPoolEntryId(updatedAt);
  return {
    id,
    label: extractJwtIdentityLabel(credential.access, "device_code"),
    auth_type: "oauth",
    priority: 0,
    source: "device_code",
    access_token: credential.access,
    refresh_token: credential.refresh,
    last_status: null,
    last_status_at: null,
    last_error_code: null,
    base_url: HERMES_CODEX_BASE_URL,
    last_refresh: updatedAt.replace("+00:00", "Z"),
    request_count: 0,
  };
}

function buildHermesAuthDotJson({ existing, credential, updatedAt }) {
  const next = isObject(existing) ? structuredClone(existing) : {};
  next.version = HERMES_AUTH_STORE_VERSION;
  next.updated_at = updatedAt;
  next.providers = isObject(next.providers) ? next.providers : {};
  next.providers[OPENAI_CODEX_PROVIDER] = {
    tokens: {
      access_token: credential.access,
      refresh_token: credential.refresh,
    },
    last_refresh: updatedAt.replace("+00:00", "Z"),
    auth_mode: "chatgpt",
  };
  next.credential_pool = isObject(next.credential_pool) ? next.credential_pool : {};
  next.credential_pool[OPENAI_CODEX_PROVIDER] = [
    buildHermesCodexPoolEntry({
      existing,
      credential,
      updatedAt,
    }),
  ];
  next.active_provider = OPENAI_CODEX_PROVIDER;
  return next;
}

// AIM owns only Hermes auth material. The caller must provide the exact native
// auth.json path; runtime config, cwd, env, service state, and home routing all
// live outside AIM.
function writeHermesAuthFromState({ label, authPath }, state) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown Hermes label: ${normalizedLabel}. Run \`aim status\` to inspect the pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"} for Hermes.`);
  }

  const resolvedAuthPath = resolveExplicitHermesAuthFilePath(authPath);
  const parentDir = path.dirname(resolvedAuthPath);
  if (!fs.existsSync(parentDir)) {
    throw new Error(`Hermes auth parent directory does not exist: ${parentDir}`);
  }
  if (!fs.statSync(parentDir).isDirectory()) {
    throw new Error(`Hermes auth parent is not a directory: ${parentDir}`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const authRead = readHermesAuthFile({ authPath: resolvedAuthPath });
  if (authRead.exists === true && authRead.ok !== true) {
    throw new Error(`Failed to read current Hermes auth.json before write: ${authRead.error || "unknown error"}`);
  }

  const appliedAt = new Date().toISOString();
  const authPayload = buildHermesAuthDotJson({
    existing: authRead.ok === true ? authRead.json : {},
    credential,
    updatedAt: appliedAt,
  });
  const authWrite = writeJsonFileIfChanged(resolvedAuthPath, authPayload, { mode: 0o600 });
  const readback = readHermesAuthFile({ authPath: resolvedAuthPath });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back Hermes auth.json after write: ${readback.error || "unknown error"}`);
  }
  if (readback.activeProvider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(
      `Hermes auth mismatch after write: expected active_provider=${OPENAI_CODEX_PROVIDER}, got ${readback.activeProvider || "none"}.`,
    );
  }
  const inferredLabel = findCodexLabelByTokenPair(state, {
    accessToken: readback.accessToken,
    refreshToken: readback.refreshToken,
  });
  if (inferredLabel && inferredLabel !== normalizedLabel) {
    throw new Error(`Hermes readback mismatch after write: expected label=${normalizedLabel}, got ${inferredLabel}.`);
  }
  if (
    readback.providerPoolEntryCount !== 1
    || readback.deviceCodePoolEntryPresent !== true
    || !doesHermesPoolMatchCodexCredential(readback, credential)
  ) {
    throw new Error(`Hermes auth pool mismatch after write: expected a single coherent ${OPENAI_CODEX_PROVIDER} device_code entry.`);
  }

  return {
    status: authWrite.wrote ? "applied" : "noop",
    label: normalizedLabel,
    authPath: resolvedAuthPath,
    wrote: {
      auth: authWrite.wrote,
    },
    inferredLabel: inferredLabel || normalizedLabel,
  };
}

function inferClaudeAuthMethodFromOverrideEnv(envNames) {
  const names = Array.isArray(envNames) ? envNames : [];
  if (names.includes("CLAUDE_CODE_OAUTH_TOKEN")) return "oauth_token";
  if (names.includes("ANTHROPIC_AUTH_TOKEN") || names.includes("ANTHROPIC_API_KEY")) return "api_key";
  if (names.includes("CLAUDE_CODE_USE_BEDROCK")) return "bedrock";
  if (names.includes("CLAUDE_CODE_USE_VERTEX")) return "vertex";
  if (names.includes("CLAUDE_CODE_USE_FOUNDRY")) return "foundry";
  return "env_override";
}

function readClaudeAuthStatus({ homeDir, spawnImpl = spawnSync } = {}) {
  const commandPath = resolveClaudeCommand({ homeDir, spawnImpl });
  if (!commandPath) {
    return {
      available: false,
      commandPath: null,
    };
  }

  const overrideEnv = readClaudeAuthOverrideEnv();
  if (overrideEnv.length > 0) {
    return {
      available: true,
      commandPath,
      ok: true,
      loggedIn: true,
      authMethod: inferClaudeAuthMethodFromOverrideEnv(overrideEnv),
      apiProvider: "override",
      email: null,
      orgId: null,
      orgName: null,
      subscriptionType: null,
    };
  }

  // Do not shell out to `claude auth status --json` here. On current Claude
  // builds that command is not reliably read-only and can rewrite
  // `~/.claude/.credentials.json` with a sparse payload, which then breaks
  // native-bundle capture. AIM must treat Claude auth status as a file/env
  // readback problem, not an external CLI status problem.
  const readback = readClaudeNativeBundle({ homeDir });
  if (readback.ok !== true) {
    return {
      available: true,
      ok: false,
      commandPath,
      error:
        readback.credentials?.ok === false
          ? String(readback.credentials.error || `Could not read ${readback.credentialsPath}.`)
          : readback.appState?.ok === false
            ? String(readback.appState.error || `Could not read ${readback.appStatePath}.`)
            : "Claude auth files are unreadable.",
    };
  }

  const hasTokens =
    readback.credentials?.claudeAiOauthPresent === true
    && typeof readback.credentials?.accessToken === "string"
    && readback.credentials.accessToken.trim()
    && typeof readback.credentials?.refreshToken === "string"
    && readback.credentials.refreshToken.trim()
    && Number.isFinite(Number(readback.credentials?.expiresAt));
  const hasIdentity = readback.appState?.oauthAccountPresent === true;
  const loggedIn = Boolean(hasTokens && hasIdentity);

  return {
    available: true,
    ok: true,
    commandPath,
    loggedIn,
    authMethod: loggedIn ? "claude.ai" : "none",
    apiProvider: loggedIn ? "firstParty" : "none",
    email:
      typeof readback.appState?.emailAddress === "string" && readback.appState.emailAddress.trim()
        ? readback.appState.emailAddress.trim().toLowerCase()
        : null,
    orgId:
      typeof readback.appState?.organizationUuid === "string" && readback.appState.organizationUuid.trim()
        ? readback.appState.organizationUuid.trim()
        : null,
    orgName:
      typeof readback.appState?.organizationName === "string" && readback.appState.organizationName.trim()
        ? readback.appState.organizationName.trim()
        : null,
    subscriptionType:
      typeof readback.credentials?.subscriptionType === "string" && readback.credentials.subscriptionType.trim()
        ? readback.credentials.subscriptionType.trim()
        : null,
  };
}

function readClaudeAuthOverrideEnv() {
  return [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].filter((name) => String(process.env[name] ?? "").trim());
}

function getAnthropicCredentialMatchLabel(state, { accessToken, refreshToken }) {
  ensureStateShape(state);
  const access = typeof accessToken === "string" ? accessToken.trim() : "";
  const refresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  const refreshMatches = [];
  const accessMatches = [];

  for (const [label, credential] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (!isObject(credential)) continue;
    const summary = buildClaudeCredentialSummaryFromBundle(credential);
    const credentialRefresh = summary?.refresh || String(credential.refresh ?? "").trim();
    const credentialAccess = summary?.access || String(credential.access ?? "").trim();
    if (refresh && credentialRefresh === refresh) {
      refreshMatches.push(label);
    }
    if (access && credentialAccess === access) {
      accessMatches.push(label);
    }
  }

  if (refreshMatches.length === 1) return refreshMatches[0];
  if (refreshMatches.length > 1) return null;
  if (accessMatches.length === 1) return accessMatches[0];
  return null;
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

// Pi auth.json is a multi-provider store. AIM owns only the `openai-codex` entry there,
// so clearing managed Pi activation must preserve any unrelated Pi providers.
function clearManagedPiCliActivation({ state, homeDir }) {
  ensureStateShape(state);
  const agentDir = resolveManagedPiAgentDir({ homeDir });
  const authPath = resolvePiAuthFilePath(agentDir);
  if (fs.existsSync(authPath)) {
    const current = readPiAuthFile({ agentDir });
    if (current.ok !== true) {
      throw new Error(`Refusing to mutate unreadable Pi auth file: ${current.error || authPath}`);
    }
    if (isObject(current.json) && Object.hasOwn(current.json, OPENAI_CODEX_PROVIDER)) {
      const next = { ...current.json };
      delete next[OPENAI_CODEX_PROVIDER];
      writeJsonFileIfChanged(authPath, next, { mode: 0o600 });
    }
  }

  const target = getPiTargetState(state);
  delete target.agentDir;
  delete target.authPath;
  delete target.activeLabel;
  delete target.expectedAccountId;
  delete target.lastAppliedAt;
}

function clearManagedClaudeCliAuthFiles({ homeDir }) {
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const authPath = resolveClaudeAuthFilePath(claudeDir);
  fs.rmSync(authPath, { force: true });
  const appStatePath = resolveClaudeAppStatePath({ homeDir });
  if (fs.existsSync(appStatePath)) {
    const current = readClaudeAppStateFile({ homeDir });
    if (current.ok !== true) {
      throw new Error(`Refusing to mutate unreadable Claude app state file: ${current.error || appStatePath}`);
    }
    if (isObject(current.json) && Object.hasOwn(current.json, "oauthAccount")) {
      const next = { ...current.json };
      delete next.oauthAccount;
      if (Object.keys(next).length === 0) {
        fs.rmSync(appStatePath, { force: true });
      } else {
        writeJsonFileIfChanged(appStatePath, next, { mode: 0o600 });
      }
    }
  }
}

function clearManagedClaudeCliTargetState(state) {
  ensureStateShape(state);
  const target = getClaudeTargetState(state);
  delete target.claudeDir;
  delete target.authPath;
  delete target.credentialsPath;
  delete target.appStatePath;
  delete target.activeLabel;
  delete target.expectedSubscriptionType;
  delete target.lastAppliedAt;
}

function clearManagedClaudeCliActivation({ state, homeDir }) {
  clearManagedClaudeCliAuthFiles({ homeDir });
  clearManagedClaudeCliTargetState(state);
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

function assertAnthropicCredentialShape({ label, credential, requireFresh, requireClaudeNativeBundle = false }) {
  const cred = isObject(credential) ? credential : null;
  if (!cred) {
    throw new Error(`Missing anthropic credentials for label=${label}.`);
  }
  if (typeof cred.access !== "string" || !cred.access.trim()) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.access is missing.`);
  }
  if (typeof cred.refresh !== "string" || !cred.refresh.trim()) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.refresh is missing.`);
  }
  const expiresMs = parseExpiresAtToMs(cred.expiresAt);
  if (!expiresMs) {
    throw new Error(`credentials.${ANTHROPIC_PROVIDER}.${label}.expiresAt is missing/invalid.`);
  }
  if (requireFresh && expiresMs <= Date.now()) {
    throw new Error(`Refusing expired anthropic credentials for label=${label}. Reauth that label with \`aim ${label}\` first.`);
  }
  if (requireClaudeNativeBundle && !hasCompleteClaudeNativeBundle(cred)) {
    throw new Error(
      `credentials.${ANTHROPIC_PROVIDER}.${label}.nativeClaudeBundle is missing or incomplete. ` +
        `Capture/import a native Claude login with \`aim claude capture-native ${label}\` or ` +
        `\`aim claude import-native ${label} --in <file>\`.`,
    );
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

function buildPiAuthEntry({ credential }) {
  const expiresMs = parseExpiresAtToMs(credential?.expiresAt);
  if (!expiresMs) {
    throw new Error("Refusing to build Pi auth.json without a valid expiresAt timestamp.");
  }
  return {
    type: "oauth",
    access: credential.access,
    refresh: credential.refresh,
    expires: expiresMs,
    accountId: credential.accountId,
  };
}

function buildClaudeAuthDotJson({ credential }) {
  const bundle = getClaudeNativeBundle(credential);
  const oauth = cloneJsonObject(bundle?.claudeAiOauth);
  if (!oauth) {
    throw new Error("Refusing to build Claude .credentials.json without a native Claude bundle.");
  }
  const expiresAt = parseTimestampLikeToMs(oauth.expiresAt);
  if (!expiresAt) {
    throw new Error("Refusing to build Claude .credentials.json without a valid expiresAt timestamp.");
  }
  oauth.expiresAt = expiresAt;
  oauth.scopes = normalizeNonEmptyStringArray(oauth.scopes);
  return {
    claudeAiOauth: oauth,
  };
}

// `.claude.json` is a mixed Claude app-state file. AIM owns only the
// `oauthAccount` key there and must preserve unrelated settings exactly.
function writeClaudeAppStateOauthAccount({ homeDir, credential }) {
  const bundle = getClaudeNativeBundle(credential);
  const oauthAccount = cloneJsonObject(bundle?.oauthAccount);
  if (!oauthAccount) {
    throw new Error("Refusing to write Claude app state without a native Claude oauthAccount bundle.");
  }
  const current = readClaudeAppStateFile({ homeDir });
  if (current.exists === true && current.ok !== true) {
    throw new Error(`Refusing to mutate unreadable Claude app state file: ${current.error || current.appStatePath}`);
  }
  const next = {
    ...(current.ok === true && isObject(current.json) ? current.json : {}),
    oauthAccount,
  };
  return writeJsonFileIfChanged(resolveClaudeAppStatePath({ homeDir }), next, { mode: 0o600 });
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

function findCodexLabelByTokenPair(state, { accessToken, refreshToken }) {
  ensureStateShape(state);
  const targetAccess = typeof accessToken === "string" ? accessToken.trim() : "";
  const targetRefresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  if (!targetAccess || !targetRefresh) return null;
  for (const [label, cred] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    if (!isObject(cred)) continue;
    if (String(cred.access ?? "").trim() === targetAccess && String(cred.refresh ?? "").trim() === targetRefresh) {
      return label;
    }
  }
  return null;
}

function doesHermesReadbackMatchCodexCredential(readback, credential) {
  if (!readback || !credential) return false;
  return (
    String(readback.accessToken ?? "").trim() === String(credential.access ?? "").trim()
    && String(readback.refreshToken ?? "").trim() === String(credential.refresh ?? "").trim()
  );
}

function doesHermesPoolMatchCodexCredential(readback, credential) {
  if (!readback || !credential) return false;
  if (Math.max(0, Math.round(Number(readback.providerPoolEntryCount ?? 0))) === 0) {
    return true;
  }
  return (
    readback.deviceCodePoolEntryPresent === true
    && Math.max(0, Math.round(Number(readback.providerPoolEntryCount ?? 0))) === 1
    && String(readback.poolAccessToken ?? "").trim() === String(credential.access ?? "").trim()
    && String(readback.poolRefreshToken ?? "").trim() === String(credential.refresh ?? "").trim()
  );
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

function buildRemoteStateArg(remotePath) {
  if (!remotePath || remotePath === DEFAULT_AUTHORITY_STATE_REMOTE_PATH) {
    return "";
  }
  if (remotePath === "$HOME") {
    return '--state "$HOME"';
  }
  if (remotePath.startsWith("$HOME/")) {
    return `--state "$HOME/${escapeDoubleQuotedShellFragment(remotePath.slice("$HOME/".length))}"`;
  }
  return `--state ${shellQuoteSingle(remotePath)}`;
}

function buildRemoteAimInternalApplyCommand({ remotePath, subcmd = "apply-codex-promotion" }) {
  const stateArg = buildRemoteStateArg(remotePath);
  return ["aim", "internal", subcmd, stateArg].filter(Boolean).join(" ");
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

function buildAuthorityLocatorKey(locator) {
  const resolved = typeof locator === "string" ? resolveAuthorityLocator(locator) : locator;
  if (resolved.kind === "ssh") {
    return `ssh:${resolved.target}:${resolved.port || ""}:${resolved.remotePath}`;
  }
  return `file:${resolved.path}`;
}

function authorityLocatorsMatch(a, b) {
  try {
    return buildAuthorityLocatorKey(a) === buildAuthorityLocatorKey(b);
  } catch {
    return String(a ?? "").trim() === String(b ?? "").trim();
  }
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

function clonePortableAnthropicCredential(credential) {
  const cred = isObject(credential) ? structuredClone(credential) : null;
  if (!cred) {
    return null;
  }
  const bundle = buildClaudeNativeBundle(cred.nativeClaudeBundle);
  if (bundle) {
    cred.nativeClaudeBundle = bundle;
  }
  const expiresAt = toIsoFromExpiresMs(parseTimestampLikeToMs(cred.expiresAt));
  if (expiresAt) {
    cred.expiresAt = expiresAt;
  }
  if (Array.isArray(cred.scopes)) {
    cred.scopes = normalizeNonEmptyStringArray(cred.scopes);
  }
  if (typeof cred.emailAddress === "string" && cred.emailAddress.trim()) {
    cred.emailAddress = cred.emailAddress.trim().toLowerCase();
  }
  if (typeof cred.organizationName === "string" && cred.organizationName.trim()) {
    cred.organizationName = cred.organizationName.trim();
  }
  if (typeof cred.organizationUuid === "string" && cred.organizationUuid.trim()) {
    cred.organizationUuid = cred.organizationUuid.trim();
  }
  if (typeof cred.subscriptionType === "string" && cred.subscriptionType.trim()) {
    cred.subscriptionType = cred.subscriptionType.trim();
  }
  if (typeof cred.rateLimitTier === "string" && cred.rateLimitTier.trim()) {
    cred.rateLimitTier = cred.rateLimitTier.trim();
  }
  return cred;
}

function buildPortableAnthropicCredential({ label, credential }) {
  const cred = assertAnthropicCredentialShape({
    label,
    credential,
    requireFresh: false,
    requireClaudeNativeBundle: true,
  });
  return clonePortableAnthropicCredential(cred);
}

function normalizeRequestedCodexLabels(labels, { context }) {
  const normalized = [];
  const seen = new Set();
  for (const labelRaw of Array.isArray(labels) ? labels : []) {
    const label = normalizeLabel(labelRaw);
    if (seen.has(label)) continue;
    seen.add(label);
    normalized.push(label);
  }
  if (normalized.length === 0) {
    throw new Error(`Missing label list for ${context}.`);
  }
  return normalized;
}

function normalizeRequestedAnthropicLabels(labels, { context }) {
  const normalized = [];
  const seen = new Set();
  for (const labelRaw of Array.isArray(labels) ? labels : []) {
    const label = normalizeLabel(labelRaw);
    if (seen.has(label)) continue;
    seen.add(label);
    normalized.push(label);
  }
  if (normalized.length === 0) {
    throw new Error(`Missing label list for ${context}.`);
  }
  return normalized;
}

function buildDirtyImportedCodexLabels(state) {
  return getImportedCodexLabels(state)
    .filter((label) => getAuthorityCodexImportLabelStatus(state, label).dirty)
    .toSorted((a, b) => a.localeCompare(b));
}

function buildDirtyImportedAnthropicLabels(state) {
  return getImportedAnthropicLabels(state)
    .filter((label) => getAuthorityAnthropicImportLabelStatus(state, label).dirty)
    .toSorted((a, b) => a.localeCompare(b));
}

function buildAuthorityCodexImportStatus(state) {
  const importMeta = getAuthorityCodexImport(state);
  const labels = getImportedCodexLabels(state);
  const labelsByName = {};
  const dirtyLabels = [];
  for (const label of labels) {
    const status = getAuthorityCodexImportLabelStatus(state, label);
    const meta = status.meta ?? {};
    labelsByName[label] = {
      ...(typeof meta.importedAt === "string" && meta.importedAt.trim() ? { importedAt: meta.importedAt.trim() } : {}),
      ...(typeof meta.baseAccountId === "string" && meta.baseAccountId.trim() ? { baseAccountId: meta.baseAccountId.trim() } : {}),
      dirtyLocal: status.dirty,
      ...(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim() ? { dirtyObservedAt: meta.dirtyObservedAt.trim() } : {}),
      ...(typeof meta.lastPromotedAt === "string" && meta.lastPromotedAt.trim() ? { lastPromotedAt: meta.lastPromotedAt.trim() } : {}),
    };
    if (status.dirty) {
      dirtyLabels.push(label);
    }
  }
  return {
    ...(typeof importMeta.source === "string" && importMeta.source.trim() ? { source: importMeta.source.trim() } : {}),
    ...(typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? { importedAt: importMeta.importedAt.trim() } : {}),
    labels,
    labelsByName,
    dirtyLabels,
  };
}

function buildAuthorityAnthropicImportStatus(state) {
  const importMeta = getAuthorityAnthropicImport(state);
  const labels = getImportedAnthropicLabels(state);
  const labelsByName = {};
  const dirtyLabels = [];
  for (const label of labels) {
    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    const meta = status.meta ?? {};
    labelsByName[label] = {
      ...(typeof meta.importedAt === "string" && meta.importedAt.trim() ? { importedAt: meta.importedAt.trim() } : {}),
      ...(typeof meta.baseCredentialFingerprint === "string" && meta.baseCredentialFingerprint.trim()
        ? { baseCredentialFingerprint: meta.baseCredentialFingerprint.trim() }
        : {}),
      ...(normalizeAnthropicAuthorityIdentityRecord(meta.baseIdentity)
        ? { baseIdentity: normalizeAnthropicAuthorityIdentityRecord(meta.baseIdentity) }
        : {}),
      dirtyLocal: status.dirty,
      ...(typeof meta.dirtyObservedAt === "string" && meta.dirtyObservedAt.trim() ? { dirtyObservedAt: meta.dirtyObservedAt.trim() } : {}),
      ...(typeof meta.lastPromotedAt === "string" && meta.lastPromotedAt.trim() ? { lastPromotedAt: meta.lastPromotedAt.trim() } : {}),
    };
    if (status.dirty) {
      dirtyLabels.push(label);
    }
  }
  return {
    ...(typeof importMeta.source === "string" && importMeta.source.trim() ? { source: importMeta.source.trim() } : {}),
    ...(typeof importMeta.importedAt === "string" && importMeta.importedAt.trim() ? { importedAt: importMeta.importedAt.trim() } : {}),
    labels,
    labelsByName,
    dirtyLabels,
  };
}

function formatDirtyImportedCodexSyncError({ authoritySource, labels }) {
  const joined = normalizeRequestedCodexLabels(labels, { context: "dirty imported labels" }).join(", ");
  return [
    `Authority import would discard locally refreshed imported labels: ${joined}.`,
    `Publish them first with \`aim promote codex --to ${authoritySource || "<authority>"} ${joined}\`,`,
    "or rerun the import with `--discard-dirty` if you want to overwrite the local changes.",
  ].join(" ");
}

function formatDirtyImportedAnthropicSyncError({ authoritySource, labels }) {
  const joined = normalizeRequestedAnthropicLabels(labels, { context: "dirty imported labels" }).join(", ");
  return [
    `Authority import would discard locally refreshed imported Claude labels: ${joined}.`,
    `Publish them first with \`aim promote claude --to ${authoritySource || "<authority>"} ${joined}\`,`,
    "or rerun the import with `--discard-dirty` if you want to overwrite the local changes.",
  ].join(" ");
}

function buildDirtyImportedCodexSyncConflicts({ state, incomingByLabel }) {
  const conflicts = [];
  for (const label of getImportedCodexLabels(state)) {
    const status = getAuthorityCodexImportLabelStatus(state, label);
    if (!status.dirty) continue;
    const incoming = incomingByLabel.get(label);
    if (!incoming) {
      conflicts.push({ label, reason: "removed_from_authority" });
      continue;
    }
    const incomingFingerprint = tryBuildCodexCredentialFingerprint(incoming.credential);
    if (status.currentFingerprint && incomingFingerprint && status.currentFingerprint === incomingFingerprint) {
      continue;
    }
    conflicts.push({ label, reason: "authority_would_overwrite_local_update" });
  }
  return conflicts;
}

function buildDirtyImportedAnthropicSyncConflicts({ state, incomingByLabel }) {
  const conflicts = [];
  for (const label of getImportedAnthropicLabels(state)) {
    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    if (!status.dirty) continue;
    const incoming = incomingByLabel.get(label);
    if (!incoming) {
      conflicts.push({ label, reason: "removed_from_authority" });
      continue;
    }
    const incomingFingerprint = tryBuildAnthropicCredentialFingerprint(incoming.credential);
    if (status.currentFingerprint === incomingFingerprint) {
      continue;
    }
    conflicts.push({ label, reason: "authority_would_overwrite_local_update" });
  }
  return conflicts;
}

function buildCodexPromotionPayload({ state, to, labels }) {
  ensureStateShape(state);
  const authorityImport = getAuthorityCodexImport(state);
  const requestedLabels = normalizeRequestedCodexLabels(labels, { context: "aim promote codex" });
  const targetDisplay = typeof to === "string" ? resolveAuthorityLocator(to).display : to.display;
  if (!(typeof authorityImport.source === "string" && authorityImport.source.trim())) {
    throw new Error("No authority source is recorded for the local imported Codex replica. Run `aim sync codex --from <authority>` first.");
  }
  if (!authorityLocatorsMatch(authorityImport.source, to)) {
    throw new Error(
      `Refusing to promote imported labels to a different authority. ` +
        `Imported source=${authorityImport.source}; requested target=${targetDisplay}.`,
    );
  }

  const payloadLabels = {};
  for (const label of requestedLabels) {
    if (!isImportedCodexLabel(state, label)) {
      throw new Error(`Refusing to promote non-imported label=${label}. Pull it from the authority first.`);
    }
    const account = getAccountRecord(state, label);
    if (!isObject(account) || normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing to promote non-Codex label=${label}.`);
    }

    const status = getAuthorityCodexImportLabelStatus(state, label);
    const credential = assertCodexCredentialShape({
      label,
      credential: getCodexCredential(state, label),
      requireFresh: true,
    });
    if (status.baseAccountId && status.currentAccountId && status.baseAccountId !== status.currentAccountId) {
      throw new Error(
        `Refusing to promote label=${label}: local accountId=${status.currentAccountId} ` +
          `does not match imported authority accountId=${status.baseAccountId}.`,
      );
    }
    if (!(typeof status.baseFingerprint === "string" && status.baseFingerprint.trim())) {
      throw new Error(`Missing authority base fingerprint for imported label=${label}. Re-run \`aim sync codex --from ${authorityImport.source}\`.`);
    }

    payloadLabels[label] = {
      provider: OPENAI_CODEX_PROVIDER,
      accountId: credential.accountId,
      credential: buildPortableCodexCredential({ label, credential }),
      base: {
        accountId: status.baseAccountId ?? credential.accountId,
        credentialFingerprint: status.baseFingerprint,
      },
    };
  }

  return {
    kind: "aimgr.codexPromotion.v1",
    sentAt: new Date().toISOString(),
    sourceAuthority: authorityImport.source.trim(),
    labels: payloadLabels,
  };
}

function applyCodexPromotionPayloadToState({ state, payload, authorityDisplay, observedAt = new Date().toISOString() }) {
  ensureStateShape(state);
  if (!isObject(payload) || payload.kind !== "aimgr.codexPromotion.v1") {
    throw new Error("Invalid codex promotion payload.");
  }
  const labelEntries = Object.entries(isObject(payload.labels) ? payload.labels : {});
  if (labelEntries.length === 0) {
    throw new Error("Codex promotion payload is empty.");
  }

  const validations = [];
  let requiresWrite = false;
  for (const [labelRaw, entry] of labelEntries) {
    const label = normalizeLabel(labelRaw);
    if (!isObject(entry)) {
      throw new Error(`Invalid codex promotion entry for label=${label}.`);
    }
    if (normalizeProviderId(entry.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing codex promotion for label=${label}: provider must be ${OPENAI_CODEX_PROVIDER}.`);
    }

    const account = getAccountRecord(state, label);
    if (!isObject(account)) {
      throw new Error(`Refusing codex promotion for unknown authority label=${label}.`);
    }
    if (normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing codex promotion for label=${label}: authority provider is not ${OPENAI_CODEX_PROVIDER}.`);
    }

    const authorityCredential = assertCodexCredentialShape({
      label,
      credential: getCodexCredential(state, label),
      requireFresh: false,
    });
    const incomingCredential = assertCodexCredentialShape({
      label,
      credential: entry.credential,
      requireFresh: true,
    });
    const authorityFingerprint = buildCodexCredentialFingerprint(authorityCredential);
    const incomingFingerprint = buildCodexCredentialFingerprint(incomingCredential);
    const baseFingerprint =
      typeof entry.base?.credentialFingerprint === "string" ? entry.base.credentialFingerprint.trim() : "";
    const baseAccountId = typeof entry.base?.accountId === "string" ? entry.base.accountId.trim() : "";

    if (!baseFingerprint) {
      throw new Error(`Refusing codex promotion for label=${label}: missing base fingerprint.`);
    }
    if (authorityFingerprint !== baseFingerprint) {
      throw new Error(
        `Refusing codex promotion for label=${label}: authority credentials changed since the consumer imported them.`,
      );
    }
    if (baseAccountId && authorityCredential.accountId.trim() !== baseAccountId) {
      throw new Error(
        `Refusing codex promotion for label=${label}: authority accountId=${authorityCredential.accountId} ` +
          `does not match expected imported accountId=${baseAccountId}.`,
      );
    }
    if (authorityCredential.accountId.trim() !== incomingCredential.accountId.trim()) {
      throw new Error(
        `Refusing codex promotion for label=${label}: local accountId=${incomingCredential.accountId} ` +
          `does not match authority accountId=${authorityCredential.accountId}.`,
      );
    }

    const blockedReason =
      typeof account.reauth?.blockedReason === "string" && account.reauth.blockedReason.trim()
        ? account.reauth.blockedReason.trim()
        : "";
    const needsCredentialWrite = authorityFingerprint !== incomingFingerprint;
    const needsCleanup = Boolean(blockedReason);
    if (needsCredentialWrite || needsCleanup) {
      requiresWrite = true;
    }
    validations.push({
      label,
      incomingCredential,
      needsCredentialWrite,
      needsCleanup,
    });
  }

  if (!requiresWrite) {
    return {
      status: "noop",
      observedAt,
      target: authorityDisplay,
      labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
    };
  }

  for (const validation of validations) {
    state.credentials[OPENAI_CODEX_PROVIDER][validation.label] = validation.incomingCredential;
    const reauth = getAccountReauthState(state, validation.label, { create: true });
    reauth.lastAttemptAt = observedAt;
    reauth.lastVerifiedAt = observedAt;
    if (Object.hasOwn(reauth, "blockedReason")) {
      delete reauth.blockedReason;
    }
  }

  return {
    status: "applied",
    observedAt,
    target: authorityDisplay,
    labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
  };
}

function applyCodexPromotionToFileAuthority({ source, payload }) {
  if (!fs.existsSync(source.path)) {
    throw new Error(`Authority AIM state file not found: ${source.path}`);
  }
  const state = loadAimgrState(source.path);
  const receipt = applyCodexPromotionPayloadToState({
    state,
    payload,
    authorityDisplay: source.display,
  });
  if (receipt.status === "applied") {
    writeJsonFileWithBackup(source.path, state);
  }
  return receipt;
}

function invokeCodexPromotionOnRemoteAuthority({ source, payload, spawnImpl = spawnSync }) {
  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteAimInternalApplyCommand({ remotePath: source.remotePath }));
  const result = spawnImpl("ssh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: `${JSON.stringify(payload)}\n`,
  });
  if (result?.error) {
    throw new Error(`Failed to promote codex credentials via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `ssh codex promotion failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Failed to parse codex promotion receipt from ${source.display}: ${String(err?.message ?? err)}`);
  }
  const receipt = isObject(parsed?.applied) ? parsed.applied : parsed;
  if (!isObject(receipt) || typeof receipt.status !== "string") {
    throw new Error(`Remote codex promotion receipt from ${source.display} is missing status.`);
  }
  return receipt;
}

export function promoteCodexToAuthority({ to, labels, state }, { spawnImpl = spawnSync } = {}) {
  ensureStateShape(state);
  if (!String(to ?? "").trim()) {
    throw new Error("Missing authority locator. Use: aim promote codex --to agents@amirs-mac-studio <label> [<label>...]");
  }
  const source = resolveAuthorityLocator(to);
  const payload = buildCodexPromotionPayload({ state, to: source, labels });
  const receipt =
    source.kind === "file"
      ? applyCodexPromotionToFileAuthority({ source, payload })
      : invokeCodexPromotionOnRemoteAuthority({ source, payload, spawnImpl });

  const promotedAt = typeof receipt.observedAt === "string" && receipt.observedAt.trim()
    ? receipt.observedAt.trim()
    : new Date().toISOString();
  for (const label of normalizeRequestedCodexLabels(labels, { context: "aim promote codex" })) {
    markImportedCodexLabelPromoted(state, label, { promotedAt });
  }

  return {
    action: "promote_codex",
    status: receipt.status,
    observedAt: promotedAt,
    target: source.display,
    labels: normalizeRequestedCodexLabels(labels, { context: "aim promote codex" }),
  };
}

function buildClaudePromotionPayload({ state, to, labels }) {
  ensureStateShape(state);
  const authorityImport = getAuthorityAnthropicImport(state);
  const requestedLabels = normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" });
  const targetDisplay = typeof to === "string" ? resolveAuthorityLocator(to).display : to.display;
  if (!(typeof authorityImport.source === "string" && authorityImport.source.trim())) {
    throw new Error("No authority source is recorded for the local imported Claude replica. Run `aim sync claude --from <authority>` first.");
  }
  if (!authorityLocatorsMatch(authorityImport.source, to)) {
    throw new Error(
      `Refusing to promote imported Claude labels to a different authority. ` +
        `Imported source=${authorityImport.source}; requested target=${targetDisplay}.`,
    );
  }

  const payloadLabels = {};
  for (const label of requestedLabels) {
    if (!isImportedAnthropicLabel(state, label)) {
      throw new Error(`Refusing to promote non-imported Claude label=${label}. Pull it from the authority first.`);
    }
    const account = getAccountRecord(state, label);
    if (!isObject(account) || normalizeProviderId(account.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing to promote non-Claude label=${label}.`);
    }

    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    const credential = assertAnthropicCredentialShape({
      label,
      credential: getAnthropicCredential(state, label),
      requireFresh: true,
      requireClaudeNativeBundle: true,
    });
    if (status.baseIdentity && status.currentIdentity && !doAnthropicAuthorityIdentitiesMatch(status.currentIdentity, status.baseIdentity)) {
      throw new Error(
        `Refusing to promote label=${label}: local Claude identity does not match the imported authority identity.`,
      );
    }

    payloadLabels[label] = {
      provider: ANTHROPIC_PROVIDER,
      credential: buildPortableAnthropicCredential({ label, credential }),
      base: {
        credentialFingerprint: status.baseFingerprint ?? null,
        identity: status.baseIdentity ?? null,
      },
    };
  }

  return {
    kind: "aimgr.claudePromotion.v1",
    sentAt: new Date().toISOString(),
    sourceAuthority: authorityImport.source.trim(),
    labels: payloadLabels,
  };
}

function applyClaudePromotionPayloadToState({ state, payload, authorityDisplay, observedAt = new Date().toISOString() }) {
  ensureStateShape(state);
  if (!isObject(payload) || payload.kind !== "aimgr.claudePromotion.v1") {
    throw new Error("Invalid Claude promotion payload.");
  }
  const labelEntries = Object.entries(isObject(payload.labels) ? payload.labels : {});
  if (labelEntries.length === 0) {
    throw new Error("Claude promotion payload is empty.");
  }

  const validations = [];
  let requiresWrite = false;
  for (const [labelRaw, entry] of labelEntries) {
    const label = normalizeLabel(labelRaw);
    if (!isObject(entry)) {
      throw new Error(`Invalid Claude promotion entry for label=${label}.`);
    }
    if (normalizeProviderId(entry.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing Claude promotion for label=${label}: provider must be ${ANTHROPIC_PROVIDER}.`);
    }

    const account = getAccountRecord(state, label);
    if (!isObject(account)) {
      throw new Error(`Refusing Claude promotion for unknown authority label=${label}.`);
    }
    if (normalizeProviderId(account.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing Claude promotion for label=${label}: authority provider is not ${ANTHROPIC_PROVIDER}.`);
    }

    const authorityCredential = getAnthropicCredential(state, label);
    const incomingCredential = assertAnthropicCredentialShape({
      label,
      credential: entry.credential,
      requireFresh: true,
      requireClaudeNativeBundle: true,
    });
    const authorityFingerprint = tryBuildAnthropicCredentialFingerprint(authorityCredential);
    const incomingFingerprint = buildAnthropicCredentialFingerprint(incomingCredential);
    const baseFingerprint =
      typeof entry.base?.credentialFingerprint === "string" && entry.base.credentialFingerprint.trim()
        ? entry.base.credentialFingerprint.trim()
        : null;
    const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(entry.base?.identity);
    const authorityIdentity = buildAnthropicAuthorityIdentityFromCredential(authorityCredential);
    const incomingIdentity = buildAnthropicAuthorityIdentityFromCredential(incomingCredential);

    if (authorityFingerprint !== baseFingerprint) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: authority credentials changed since the consumer imported them.`,
      );
    }
    if (baseIdentity && incomingIdentity && !doAnthropicAuthorityIdentitiesMatch(incomingIdentity, baseIdentity)) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: local Claude identity does not match the imported authority identity.`,
      );
    }
    if (baseIdentity && authorityIdentity && !doAnthropicAuthorityIdentitiesMatch(authorityIdentity, baseIdentity)) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: authority Claude identity no longer matches the imported authority identity.`,
      );
    }

    const blockedReason =
      typeof account.reauth?.blockedReason === "string" && account.reauth.blockedReason.trim()
        ? account.reauth.blockedReason.trim()
        : "";
    const needsCredentialWrite = authorityFingerprint !== incomingFingerprint;
    const needsCleanup = Boolean(blockedReason);
    if (needsCredentialWrite || needsCleanup) {
      requiresWrite = true;
    }
    validations.push({
      label,
      incomingCredential,
    });
  }

  if (!requiresWrite) {
    return {
      status: "noop",
      observedAt,
      target: authorityDisplay,
      labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
    };
  }

  for (const validation of validations) {
    const account = getAccountRecord(state, validation.label, { create: true });
    account.provider = ANTHROPIC_PROVIDER;
    ensureAccountShape(account, { providerHint: ANTHROPIC_PROVIDER });
    account.browser = null;
    state.credentials[ANTHROPIC_PROVIDER][validation.label] = clonePortableAnthropicCredential(validation.incomingCredential);
    const reauth = getAccountReauthState(state, validation.label, { create: true });
    reauth.mode = REAUTH_MODE_NATIVE_CLAUDE;
    reauth.lastAttemptAt = observedAt;
    reauth.lastVerifiedAt = observedAt;
    if (Object.hasOwn(reauth, "blockedReason")) {
      delete reauth.blockedReason;
    }
  }

  return {
    status: "applied",
    observedAt,
    target: authorityDisplay,
    labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
  };
}

function applyClaudePromotionToFileAuthority({ source, payload }) {
  if (!fs.existsSync(source.path)) {
    throw new Error(`Authority AIM state file not found: ${source.path}`);
  }
  const state = loadAimgrState(source.path);
  const receipt = applyClaudePromotionPayloadToState({
    state,
    payload,
    authorityDisplay: source.display,
  });
  if (receipt.status === "applied") {
    writeJsonFileWithBackup(source.path, state);
  }
  return receipt;
}

function invokeClaudePromotionOnRemoteAuthority({ source, payload, spawnImpl = spawnSync }) {
  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteAimInternalApplyCommand({
    remotePath: source.remotePath,
    subcmd: "apply-claude-promotion",
  }));
  const result = spawnImpl("ssh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: `${JSON.stringify(payload)}\n`,
  });
  if (result?.error) {
    throw new Error(`Failed to promote Claude credentials via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `ssh Claude promotion failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Failed to parse Claude promotion receipt from ${source.display}: ${String(err?.message ?? err)}`);
  }
  const receipt = isObject(parsed?.applied) ? parsed.applied : parsed;
  if (!isObject(receipt) || typeof receipt.status !== "string") {
    throw new Error(`Remote Claude promotion receipt from ${source.display} is missing status.`);
  }
  return receipt;
}

export function promoteClaudeToAuthority({ to, labels, state }, { spawnImpl = spawnSync } = {}) {
  ensureStateShape(state);
  if (!String(to ?? "").trim()) {
    throw new Error("Missing authority locator. Use: aim promote claude --to agents@amirs-mac-studio <label> [<label>...]");
  }
  const source = resolveAuthorityLocator(to);
  const payload = buildClaudePromotionPayload({ state, to: source, labels });
  const receipt =
    source.kind === "file"
      ? applyClaudePromotionToFileAuthority({ source, payload })
      : invokeClaudePromotionOnRemoteAuthority({ source, payload, spawnImpl });

  const promotedAt = typeof receipt.observedAt === "string" && receipt.observedAt.trim()
    ? receipt.observedAt.trim()
    : new Date().toISOString();
  for (const label of normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" })) {
    markImportedAnthropicLabelPromoted(state, label, { promotedAt });
  }

  return {
    action: "promote_claude",
    status: receipt.status,
    observedAt: promotedAt,
    target: source.display,
    labels: normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" }),
  };
}

function importCodexFromAuthority({ from, state, homeDir, discardDirty = false }) {
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

  const dirtyConflicts = buildDirtyImportedCodexSyncConflicts({ state, incomingByLabel });
  if (dirtyConflicts.length > 0 && discardDirty !== true) {
    throw new Error(
      formatDirtyImportedCodexSyncError({
        authoritySource: source.display,
        labels: dirtyConflicts.map((entry) => entry.label),
      }),
    );
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
    const currentPiTarget = readPiCliTargetStatus({ state, homeDir });
    const removedLabelWasLiveTarget = currentTarget.activeLabel === label || currentTarget.inferredLabel === label;
    const removedLabelWasLivePiTarget = currentPiTarget.activeLabel === label || currentPiTarget.inferredLabel === label;
    delete state.accounts[label];
    delete state.credentials[OPENAI_CODEX_PROVIDER][label];
    if (removedLabelWasLiveTarget) {
      clearManagedCodexCliActivation({ state, homeDir });
      delete state.targets.codexCli.lastSelectionReceipt;
      delete state.targets.codexCli.lastWatchReceipt;
    }
    if (removedLabelWasLivePiTarget) {
      clearManagedPiCliActivation({ state, homeDir });
      delete state.targets.piCli.lastSelectionReceipt;
    }
    if (isObject(state.imports.authority.codex.labelsByName)) {
      delete state.imports.authority.codex.labelsByName[label];
    }
    removedLabels.push(label);
  }

  const importedAt = new Date().toISOString();
  const existingImportMeta = getAuthorityCodexImport(state);
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
    const previousMeta = isObject(existingImportMeta.labelsByName?.[label]) ? existingImportMeta.labelsByName[label] : {};
    existingImportMeta.labelsByName[label] = {
      importedAt,
      baseAccountId: incoming.credential.accountId,
      baseCredentialFingerprint: buildCodexCredentialFingerprint(incoming.credential),
      dirtyLocal: false,
      ...(typeof previousMeta.lastPromotedAt === "string" && previousMeta.lastPromotedAt.trim()
        ? { lastPromotedAt: previousMeta.lastPromotedAt.trim() }
        : {}),
    };
  }
  existingImportMeta.source = source.display;
  existingImportMeta.importedAt = importedAt;
  existingImportMeta.labels = incomingLabels.toSorted((a, b) => a.localeCompare(b));
  state.imports.authority.codex = existingImportMeta;

  return {
    source: source.display,
    importedAt,
    importedLabels: incomingLabels.toSorted((a, b) => a.localeCompare(b)),
    removedLabels: removedLabels.toSorted((a, b) => a.localeCompare(b)),
  };
}

function importAnthropicFromAuthority({ from, state, homeDir, discardDirty = false }) {
  ensureStateShape(state);
  if (!String(from ?? "").trim()) {
    throw new Error("Missing authority locator. Use: aim sync claude --from agents@amirs-mac-studio");
  }
  const { source, state: authorityState } = loadAuthorityState(from);
  ensureStateShape(authorityState);

  const incomingLabels = [];
  const incomingByLabel = new Map();
  for (const [label, account] of Object.entries(authorityState.accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) !== ANTHROPIC_PROVIDER) continue;
    const credential = getAnthropicCredential(authorityState, label);
    incomingLabels.push(label);
    incomingByLabel.set(label, {
      account: structuredClone(account),
      credential: clonePortableAnthropicCredential(credential),
    });
  }

  if (incomingLabels.length === 0) {
    throw new Error(`Authority ${source.display} has no importable ${ANTHROPIC_PROVIDER} labels.`);
  }

  const dirtyConflicts = buildDirtyImportedAnthropicSyncConflicts({ state, incomingByLabel });
  if (dirtyConflicts.length > 0 && discardDirty !== true) {
    throw new Error(
      formatDirtyImportedAnthropicSyncError({
        authoritySource: source.display,
        labels: dirtyConflicts.map((entry) => entry.label),
      }),
    );
  }

  const previousImported = new Set(getImportedAnthropicLabels(state));
  for (const [label, incoming] of incomingByLabel.entries()) {
    const existingAccount = state.accounts[label];
    const existingCred = getAnthropicCredential(state, label);
    if (!previousImported.has(label)) {
      if (isObject(existingAccount) && normalizeProviderId(existingAccount.provider) !== ANTHROPIC_PROVIDER) {
        throw new Error(`Refusing to overwrite non-Claude label=${label} during authority import.`);
      }
      if (isObject(existingCred) && !incoming.credential) {
        throw new Error(
          `Refusing to overwrite local Claude label=${label} with an authority label that has no stored credentials.`,
        );
      }
      const existingIdentity = buildAnthropicAuthorityIdentityFromCredential(existingCred);
      const incomingIdentity = buildAnthropicAuthorityIdentityFromCredential(incoming.credential);
      if (
        existingIdentity
        && incomingIdentity
        && !doAnthropicAuthorityIdentitiesMatch(existingIdentity, incomingIdentity)
      ) {
        throw new Error(
          `Refusing to overwrite local Claude label=${label} with a different authority Claude identity.`,
        );
      }
    }
  }

  const removedLabels = [];
  for (const label of previousImported) {
    if (incomingByLabel.has(label)) continue;
    const currentTarget = readClaudeCliTargetStatus({ state, homeDir });
    const removedLabelWasConfiguredTarget = currentTarget.activeLabel === label;
    const removedLabelStillOwnsLiveFiles = currentTarget.inferredLabel === label;
    delete state.accounts[label];
    delete state.credentials[ANTHROPIC_PROVIDER][label];
    if (removedLabelStillOwnsLiveFiles) {
      clearManagedClaudeCliAuthFiles({ homeDir });
    }
    if (removedLabelWasConfiguredTarget || removedLabelStillOwnsLiveFiles) {
      clearManagedClaudeCliTargetState(state);
      delete state.targets.claudeCli.lastSelectionReceipt;
    }
    if (isObject(state.imports.authority.anthropic.labelsByName)) {
      delete state.imports.authority.anthropic.labelsByName[label];
    }
    removedLabels.push(label);
  }

  const importedAt = new Date().toISOString();
  const existingImportMeta = getAuthorityAnthropicImport(state);
  for (const [label, incoming] of incomingByLabel.entries()) {
    const existingLocal = isObject(state.accounts[label]) ? state.accounts[label] : {};
    const incomingExpect = isObject(incoming.account.expect) ? structuredClone(incoming.account.expect) : null;
    const incomingPool = isObject(incoming.account.pool) ? structuredClone(incoming.account.pool) : null;
    const previousMeta = isObject(existingImportMeta.labelsByName?.[label]) ? existingImportMeta.labelsByName[label] : {};
    state.accounts[label] = {
      ...(incomingExpect ? { expect: incomingExpect } : isObject(existingLocal.expect) ? { expect: structuredClone(existingLocal.expect) } : {}),
      ...(incomingPool ? { pool: incomingPool } : isObject(existingLocal.pool) ? { pool: structuredClone(existingLocal.pool) } : {}),
      provider: ANTHROPIC_PROVIDER,
      reauth: {
        ...(isObject(existingLocal.reauth) ? structuredClone(existingLocal.reauth) : {}),
        mode: REAUTH_MODE_NATIVE_CLAUDE,
      },
      browser: null,
    };
    ensureAccountShape(state.accounts[label], { providerHint: ANTHROPIC_PROVIDER });
    if (incoming.credential) {
      state.credentials[ANTHROPIC_PROVIDER][label] = incoming.credential;
    } else {
      delete state.credentials[ANTHROPIC_PROVIDER][label];
    }
    existingImportMeta.labelsByName[label] = {
      importedAt,
      dirtyLocal: false,
      ...(tryBuildAnthropicCredentialFingerprint(incoming.credential)
        ? { baseCredentialFingerprint: tryBuildAnthropicCredentialFingerprint(incoming.credential) }
        : {}),
      ...(buildAnthropicAuthorityIdentityFromCredential(incoming.credential)
        ? { baseIdentity: buildAnthropicAuthorityIdentityFromCredential(incoming.credential) }
        : {}),
      ...(typeof previousMeta.lastPromotedAt === "string" && previousMeta.lastPromotedAt.trim()
        ? { lastPromotedAt: previousMeta.lastPromotedAt.trim() }
        : {}),
    };
  }
  existingImportMeta.source = source.display;
  existingImportMeta.importedAt = importedAt;
  existingImportMeta.labels = incomingLabels.toSorted((a, b) => a.localeCompare(b));
  state.imports.authority.anthropic = existingImportMeta;

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
  if (normalizeProviderId(provider) === ANTHROPIC_PROVIDER) {
    throw new Error(
      `Claude labels now use native Claude bundle capture/import only. ` +
        `Use \`aim claude capture-native ${normalizeLabel(label)}\`, \`aim claude import-native ${normalizeLabel(label)} --in <file>\`, or \`aim ${normalizeLabel(label)}\`.`,
    );
  }
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

async function refreshAnthropicNativeBundleCredential({
  state,
  label,
  refreshImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  const existing = assertAnthropicCredentialShape({
    label: normalizedLabel,
    credential: getAnthropicCredential(state, normalizedLabel),
    requireFresh: false,
    requireClaudeNativeBundle: true,
  });
  try {
    const updated = await refreshImpl(existing.refresh);
    const expiresAt = toIsoFromExpiresMs(updated.expires);
    if (!expiresAt) {
      throw new Error("refresh returned no expires");
    }
    return deriveAnthropicCredentialFromClaudeBundle({
      existingCredential: {
        ...existing,
        access: updated.access,
        refresh: updated.refresh,
        expiresAt,
      },
      nativeClaudeBundle: updateClaudeBundleTokenFields({
        nativeClaudeBundle: getClaudeNativeBundle(existing),
        access: updated.access,
        refresh: updated.refresh,
        expiresAt,
      }),
    });
  } catch (err) {
    throw new Error(
      `Native Claude refresh failed for ${normalizedLabel}. ` +
        `Reauthenticate in native Claude and then rerun \`aim claude capture-native ${normalizedLabel}\` ` +
        `or import a bundle file. (${String(err?.message ?? err)})`,
    );
  }
}

async function maintainAnthropicNativeLabel({
  state,
  label,
  homeDir,
  refreshImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  const existing = getAnthropicCredential(state, normalizedLabel);
  if (hasCompleteClaudeNativeBundle(existing)) {
    return await refreshAnthropicNativeBundleCredential({
      state,
      label: normalizedLabel,
      refreshImpl,
    });
  }
  const captured = captureAnthropicNativeBundleForLabel({
    state,
    label: normalizedLabel,
    sourceHome: homeDir,
  });
  return captured.credential;
}

function recordAccountMaintenanceAttempt(state, label, { providerHint = null } = {}) {
  const observedAt = new Date().toISOString();
  const account = getAccountRecord(state, label, { create: true });
  const normalizedProvider = normalizeProviderId(providerHint);
  if (account && normalizedProvider && !normalizeProviderId(account.provider)) {
    account.provider = normalizedProvider;
  }
  if (account) {
    ensureAccountShape(account, { providerHint: account.provider ?? normalizedProvider ?? undefined });
  }
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
  const storedEmail =
    provider === ANTHROPIC_PROVIDER
      ? (
        buildClaudeCredentialSummaryFromBundle(credential)?.emailAddress
        || (typeof credential?.emailAddress === "string" ? credential.emailAddress.trim().toLowerCase() : "")
      )
      : "";
  const hasFreshCredentials =
    credential
    && typeof credential.access === "string"
    && credential.access.trim()
    && typeof credential.refresh === "string"
    && credential.refresh.trim()
    && expiresMs !== null
    && expiresMs > snapshotNow
    && (provider !== OPENAI_CODEX_PROVIDER || typeof credential.accountId === "string" && credential.accountId.trim());
  const hasCompleteClaudeBundle =
    provider !== ANTHROPIC_PROVIDER || hasCompleteClaudeNativeBundle(credential);

  if (provider === ANTHROPIC_PROVIDER) {
    if (blockedReason) {
      return {
        operatorStatus: "blocked",
        eligible: false,
        actionRequired: "fix_blocker",
        reason: blockedReason,
      };
    }
    if (expectedEmail && storedEmail && expectedEmail !== storedEmail) {
      return {
        operatorStatus: "blocked",
        detailReason: "conflict",
        eligible: false,
        actionRequired: "fix_blocker",
        reason: `Stored Claude identity ${storedEmail} does not match expected ${expectedEmail}.`,
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
    if (!hasCompleteClaudeBundle) {
      return {
        operatorStatus: "reauth",
        detailReason: "missing_native_claude_bundle",
        eligible: false,
        actionRequired: "run_aim_claude_capture_native",
        reason:
          "Stored Anthropic tokens are still fresh, but this label does not have a complete native Claude login bundle yet.",
      };
    }
    return {
      operatorStatus: "ready",
      detailReason: "native_claude",
      eligible: true,
      actionRequired: null,
      reason: "Ready for native Claude switching.",
    };
  }

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

function getAnthropicPoolLabels(state) {
  ensureStateShape(state);
  return Object.entries(state.accounts)
    .filter(([, account]) => isObject(account))
    .filter(([, account]) => normalizeProviderId(account.provider) === ANTHROPIC_PROVIDER)
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
    const usageExhausted = usageOk && isUsageSnapshotExhausted(usage);
    const eligible = status.eligible && usageOk && !usageExhausted;
    byLabel[label] = {
      ...status,
      label,
      browserFacts,
      usage,
      eligible,
      poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
      usageReason: !usageOk ? "usage_unavailable" : usageExhausted ? "usage_exhausted" : null,
    };
    if (eligible) {
      eligibleLabels.push(label);
    }
  }

  return { labels, byLabel, eligibleLabels };
}

function collectAnthropicPoolStatus({ state, homeDir, usageByLabel, now }) {
  const labels = getAnthropicPoolLabels(state);
  const byLabel = {};
  const eligibleLabels = [];

  for (const label of labels) {
    const account = state.accounts[label];
    const browserFacts = readBrowserFacts({ account, homeDir, label });
    const status = derivePoolAccountStatus({
      account,
      label,
      credentials: getAnthropicCredential(state, label),
      browserFacts,
      now,
    });
    const usage = usageByLabel[label] ?? null;
    const usageOk = usage?.ok === true && Array.isArray(usage.windows) && usage.windows.length > 0;
    const usageExhausted = usageOk && isUsageSnapshotExhausted(usage);
    const eligible = status.eligible && usageOk && !usageExhausted;
    byLabel[label] = {
      ...status,
      label,
      browserFacts,
      usage,
      eligible,
      poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
      usageReason: !usageOk ? "usage_unavailable" : usageExhausted ? "usage_exhausted" : null,
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

export function pickNextBestLocalCliPoolLabel({
  rankedCandidates,
  minPrimaryRemainingPct = LOCAL_CLI_MIN_PRIMARY_REMAINING_PCT,
}) {
  const candidates = (Array.isArray(rankedCandidates) ? rankedCandidates : [])
    .map((candidate) => ({
      ...candidate,
      keptCurrent: false,
      reasons: [],
    }));
  if (candidates.length === 0) return null;
  const primaryRemainingFloor = clampPercent(minPrimaryRemainingPct);
  const gatedCandidates = candidates.filter((candidate) => candidate.primaryRemainingPct >= primaryRemainingFloor);
  const selectionPool = gatedCandidates.length > 0 ? gatedCandidates : candidates;

  selectionPool.sort((a, b) => {
    if (a.secondaryUsedPct !== b.secondaryUsedPct) return a.secondaryUsedPct - b.secondaryUsedPct;
    if (a.primaryUsedPct !== b.primaryUsedPct) return a.primaryUsedPct - b.primaryUsedPct;
    if (a.secondaryRemainingPct !== b.secondaryRemainingPct) return b.secondaryRemainingPct - a.secondaryRemainingPct;
    if (a.primaryRemainingPct !== b.primaryRemainingPct) return b.primaryRemainingPct - a.primaryRemainingPct;
    if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
    return a.label.localeCompare(b.label);
  });

  const best = selectionPool[0] ?? null;
  if (!best) return null;
  best.reasons.push(
    gatedCandidates.length > 0
      ? "lowest_weekly_used_over_5h_gate"
      : "lowest_weekly_used_after_5h_gate_relaxed",
  );
  return best;
}

export function pickNextCodexUseRoundRobinLabel({
  poolLabels,
  eligibleLabels,
  currentLabel,
}) {
  const orderedPoolLabels = [...new Set((Array.isArray(poolLabels) ? poolLabels : []).map((label) => normalizeLabel(label)))];
  const eligibleSet = new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)));
  const orderedEligibleLabels = orderedPoolLabels.filter((label) => eligibleSet.has(label));
  if (orderedEligibleLabels.length === 0) return null;

  const current = typeof currentLabel === "string" ? normalizeLabel(currentLabel) : null;
  const currentIsEligible = Boolean(current) && eligibleSet.has(current);

  if (orderedEligibleLabels.length === 1) {
    const [label] = orderedEligibleLabels;
    return {
      label,
      keptCurrent: currentIsEligible && label === current,
      reasons: ["round_robin_single_eligible"],
    };
  }

  if (!currentIsEligible) {
    return {
      label: orderedEligibleLabels[0],
      keptCurrent: false,
      reasons: ["round_robin_bootstrap_first_eligible"],
    };
  }

  const currentIndex = orderedPoolLabels.indexOf(current);
  if (currentIndex === -1) {
    return {
      label: orderedEligibleLabels[0],
      keptCurrent: false,
      reasons: ["round_robin_bootstrap_first_eligible"],
    };
  }

  for (let offset = 1; offset <= orderedPoolLabels.length; offset += 1) {
    const candidate = orderedPoolLabels[(currentIndex + offset) % orderedPoolLabels.length];
    if (candidate !== current && eligibleSet.has(candidate)) {
      return {
        label: candidate,
        keptCurrent: false,
        reasons: ["round_robin_next_eligible"],
      };
    }
  }

  return {
    label: orderedEligibleLabels[0],
    keptCurrent: false,
    reasons: ["round_robin_bootstrap_first_eligible"],
  };
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

function discoverHermesHomes({ homeDir }) {
  const profilesRoot = resolveHermesProfilesRoot(homeDir);
  if (!fs.existsSync(profilesRoot)) {
    return [];
  }
  const homes = [];
  for (const entry of fs.readdirSync(profilesRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const homeId = normalizeHermesHomeId(entry.name);
      const homePath = resolveHermesHomePath(homeDir, homeId);
      const markers = [
        path.join(homePath, "auth.json"),
        path.join(homePath, "config.yaml"),
        path.join(homePath, ".env"),
        path.join(homePath, "state.db"),
        path.join(homePath, "gateway_state.json"),
      ];
      if (!markers.some((markerPath) => fs.existsSync(markerPath))) {
        continue;
      }
      homes.push({
        homeId,
        homePath,
        authPath: path.join(homePath, "auth.json"),
        stateDbPath: path.join(homePath, "state.db"),
      });
    } catch {
      // Ignore malformed home ids; Hermes home dirs are authoritative and the next fix should happen there.
    }
  }
  return homes.toSorted((a, b) => a.homeId.localeCompare(b.homeId));
}

function readHermesHomeStatus({ state, homeDir, homeId }) {
  ensureStateShape(state);
  const normalizedHomeId = normalizeHermesHomeId(homeId);
  const authPath = path.join(resolveHermesHomePath(homeDir, normalizedHomeId), "auth.json");
  const readback = readHermesAuthFile({ authPath });
  const tokenPairLabel =
    readback.ok === true
      ? findCodexLabelByTokenPair(state, {
          accessToken: readback.accessToken,
          refreshToken: readback.refreshToken,
        })
      : null;
  const accountIdLabel =
    readback.ok === true && !tokenPairLabel && readback.accountId
      ? findCodexLabelByAccountId(state, readback.accountId)
      : null;
  const currentLabel = tokenPairLabel || accountIdLabel || null;
  const activeCredential = currentLabel ? getCodexCredential(state, currentLabel) : null;
  const authDrifted =
    Boolean(currentLabel)
    && isObject(activeCredential)
    && !doesHermesReadbackMatchCodexCredential(readback, activeCredential);
  const needsSync =
    Boolean(currentLabel)
    && isObject(activeCredential)
    && (authDrifted || !doesHermesPoolMatchCodexCredential(readback, activeCredential));
  const demandEntry = isObject(getHermesFleetDemandState(state)[normalizedHomeId])
    ? getHermesFleetDemandState(state)[normalizedHomeId]
    : null;
  return {
    homeId: normalizedHomeId,
    homeDir: resolveHermesHomePath(homeDir, normalizedHomeId),
    authPath,
    stateDbPath: resolveHermesStateDbPath(homeDir, normalizedHomeId),
    currentLabel: currentLabel || null,
    matchMode: tokenPairLabel ? "token_pair" : accountIdLabel ? "account_id" : "none",
    authDrifted,
    needsSync,
    activeAccountPresent: currentLabel ? isObject(state.accounts[currentLabel]) : false,
    activeCredentialPresent: currentLabel ? isObject(getCodexCredential(state, currentLabel)) : false,
    demand: demandEntry,
    readback,
  };
}

function buildWarningsFromHermesHomeStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (!status.readback.exists) {
    warnings.push({
      kind: "hermes_home_missing_auth_file",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "hermes_home_auth_unreadable",
      system: "hermes",
      homeId: status.homeId,
      status: status.readback.error,
    });
    return warnings;
  }

  if (status.readback.ok === true && status.readback.activeProvider && status.readback.activeProvider !== OPENAI_CODEX_PROVIDER) {
    warnings.push({
      kind: "hermes_home_active_provider_unsupported",
      system: "hermes",
      homeId: status.homeId,
      provider: status.readback.activeProvider,
    });
  }

  if (status.readback.ok === true && !status.readback.providerEntryPresent) {
    warnings.push({
      kind: "hermes_home_missing_provider_entry",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.readback.ok === true && status.readback.providerEntryPresent && !status.currentLabel) {
    warnings.push({
      kind: "hermes_home_label_unmapped",
      system: "hermes",
      homeId: status.homeId,
    });
  }

  if (status.currentLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "hermes_home_label_missing",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
    });
  }

  if (status.currentLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "hermes_home_credentials_missing",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
    });
  }

  if (status.currentLabel && status.activeCredentialPresent && status.authDrifted) {
    warnings.push({
      kind: "hermes_home_auth_drifted",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
      matchMode: status.matchMode,
    });
  } else if (status.currentLabel && status.activeCredentialPresent && status.needsSync) {
    warnings.push({
      kind: "hermes_home_auth_needs_sync",
      system: "hermes",
      homeId: status.homeId,
      label: status.currentLabel,
      matchMode: status.matchMode,
    });
  }

  return warnings;
}

function buildHermesHomeBlockers(status) {
  const hardBlockingWarningKinds = new Set([
    "hermes_home_missing_auth_file",
    "hermes_home_auth_unreadable",
    "hermes_home_active_provider_unsupported",
    "hermes_home_missing_provider_entry",
    "hermes_home_label_missing",
    "hermes_home_credentials_missing",
  ]);
  return buildWarningsFromHermesHomeStatus(status)
    .filter((warning) => hardBlockingWarningKinds.has(warning.kind))
    .map((warning) => {
    const blocker = {
      reason: warning.kind,
      homeId: warning.homeId,
    };
    if (typeof warning.label === "string" && warning.label.trim()) {
      blocker.label = warning.label.trim();
    }
    if (typeof warning.provider === "string" && warning.provider.trim()) {
      blocker.provider = warning.provider.trim();
    }
    if (typeof warning.status === "string" && warning.status.trim()) {
      blocker.status = warning.status.trim();
    }
    return blocker;
    });
}

function buildHermesDemandUnreadableBlocker(error) {
  const blocker = {
    reason: "hermes_home_demand_unreadable",
  };
  if (typeof error?.homeId === "string" && error.homeId.trim()) {
    blocker.homeId = error.homeId.trim();
  }
  if (typeof error?.stateDbPath === "string" && error.stateDbPath.trim()) {
    blocker.stateDbPath = error.stateDbPath.trim();
  }
  const detail = String(error?.message ?? error ?? "").trim();
  if (detail) {
    blocker.detail = detail;
  }
  return blocker;
}

function runSqlite3Query({ dbPath, sql, homeDir, spawnImpl = spawnSync }) {
  const sqlite3Command = resolveSqlite3Command({ homeDir, spawnImpl });
  const result = spawnImpl(sqlite3Command, ["-separator", "\t", dbPath, sql], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result?.error) {
    throw new Error(`Failed to run sqlite3 for ${dbPath}: ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    const stderr = String(result?.stderr ?? "").trim();
    throw new Error(`Failed to query sqlite3 for ${dbPath}: ${stderr || `exit ${result?.status ?? "unknown"}`}`);
  }
  return String(result?.stdout ?? "").trim();
}

export function readHermesHomeTokenUsage({
  homeDir,
  homeId,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
  spawnImpl = spawnSync,
}) {
  const normalizedHomeId = normalizeHermesHomeId(homeId);
  const stateDbPath = resolveHermesStateDbPath(homeDir, normalizedHomeId);
  if (!fs.existsSync(stateDbPath)) {
    return {
      homeId: normalizedHomeId,
      stateDbPath,
      exists: false,
      sessionsTotal: 0,
      sessionsConsidered: 0,
      sessionsWithTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      totalTokens: 0,
      latestSessionAt: null,
    };
  }

  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const cutoffSeconds = snapshotNow / 1000 - normalizedLookbackDays * 24 * 60 * 60;
  const sql = `
SELECT
  COUNT(*) AS sessions_total,
  SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN 1 ELSE 0 END) AS sessions_considered,
  SUM(
    CASE
      WHEN started_at >= ${cutoffSeconds}
        AND (
          COALESCE(input_tokens, 0)
          + COALESCE(output_tokens, 0)
          + COALESCE(cache_read_tokens, 0)
          + COALESCE(cache_write_tokens, 0)
          + COALESCE(reasoning_tokens, 0)
        ) > 0
      THEN 1
      ELSE 0
    END
  ) AS sessions_with_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(input_tokens, 0) ELSE 0 END), 0) AS input_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(output_tokens, 0) ELSE 0 END), 0) AS output_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(cache_read_tokens, 0) ELSE 0 END), 0) AS cache_read_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(cache_write_tokens, 0) ELSE 0 END), 0) AS cache_write_tokens,
  COALESCE(SUM(CASE WHEN started_at >= ${cutoffSeconds} THEN COALESCE(reasoning_tokens, 0) ELSE 0 END), 0) AS reasoning_tokens,
  MAX(CASE WHEN started_at >= ${cutoffSeconds} THEN started_at ELSE NULL END) AS latest_session_at
FROM sessions;`;
  let stdout;
  try {
    stdout = runSqlite3Query({ dbPath: stateDbPath, sql, homeDir, spawnImpl });
  } catch (error) {
    const wrapped = new Error(
      `Failed to read Hermes session demand for ${normalizedHomeId}: ${String(error?.message ?? error ?? "unknown error")}`,
    );
    wrapped.code = "HERMES_HOME_DEMAND_UNREADABLE";
    wrapped.homeId = normalizedHomeId;
    wrapped.stateDbPath = stateDbPath;
    throw wrapped;
  }
  const fields = stdout.split("\t");
  const [
    sessionsTotalRaw = "0",
    sessionsConsideredRaw = "0",
    sessionsWithTokensRaw = "0",
    inputTokensRaw = "0",
    outputTokensRaw = "0",
    cacheReadTokensRaw = "0",
    cacheWriteTokensRaw = "0",
    reasoningTokensRaw = "0",
    latestSessionAtRaw = "",
  ] = fields;
  const inputTokens = roundDemandWeight(inputTokensRaw);
  const outputTokens = roundDemandWeight(outputTokensRaw);
  const cacheReadTokens = roundDemandWeight(cacheReadTokensRaw);
  const cacheWriteTokens = roundDemandWeight(cacheWriteTokensRaw);
  const reasoningTokens = roundDemandWeight(reasoningTokensRaw);
  const latestSessionAtSeconds = Number(latestSessionAtRaw);
  return {
    homeId: normalizedHomeId,
    stateDbPath,
    exists: true,
    sessionsTotal: Math.max(0, Math.round(normalizeDemandWeight(sessionsTotalRaw, 0))),
    sessionsConsidered: Math.max(0, Math.round(normalizeDemandWeight(sessionsConsideredRaw, 0))),
    sessionsWithTokens: Math.max(0, Math.round(normalizeDemandWeight(sessionsWithTokensRaw, 0))),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens: roundDemandWeight(inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens + reasoningTokens),
    latestSessionAt: Number.isFinite(latestSessionAtSeconds) && latestSessionAtSeconds > 0
      ? new Date(latestSessionAtSeconds * 1000).toISOString()
      : null,
  };
}

export function refreshHermesHomeDemandLedger({
  state,
  homeDir,
  homes,
  now = Date.now(),
  lookbackDays = DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
  spawnImpl = spawnSync,
}) {
  // AIM owns the durable Hermes demand ledger; live Hermes state.db files are read-only inputs.
  // Keep demand normalization here so Hermes rebalance/watch/status do not drift.
  ensureStateShape(state);
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedLookbackDays = Math.max(1, Math.round(normalizeDemandWeight(lookbackDays, DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS)));
  const homeIds = [...new Set((Array.isArray(homes) ? homes : []).map((home) => normalizeHermesHomeId(typeof home === "string" ? home : home?.homeId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const ledger = getHermesFleetDemandState(state);
  const usageByHome = new Map();
  const observedWeights = [];

  for (const homeId of homeIds) {
    const usage = readHermesHomeTokenUsage({
      homeDir,
      homeId,
      now: snapshotNow,
      lookbackDays: normalizedLookbackDays,
      spawnImpl,
    });
    usageByHome.set(homeId, usage);
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

  for (const homeId of homeIds) {
    const usage = usageByHome.get(homeId);
    const source = usage && usage.totalTokens > 0 ? HERMES_SESSION_DEMAND_SOURCE : COLD_START_EQUAL_SHARE_DEMAND_SOURCE;
    ledger[homeId] = {
      updatedAt,
      lookbackDays: normalizedLookbackDays,
      source,
      inputTokens: roundDemandWeight(usage?.inputTokens ?? 0),
      outputTokens: roundDemandWeight(usage?.outputTokens ?? 0),
      cacheReadTokens: roundDemandWeight(usage?.cacheReadTokens ?? 0),
      cacheWriteTokens: roundDemandWeight(usage?.cacheWriteTokens ?? 0),
      reasoningTokens: roundDemandWeight(usage?.reasoningTokens ?? 0),
      totalTokens: roundDemandWeight(usage?.totalTokens ?? 0),
      demandWeight: roundDemandWeight(source === HERMES_SESSION_DEMAND_SOURCE ? usage.totalTokens : fallbackDemandWeight),
    };
  }

  return {
    allocationMode,
    lookbackDays: normalizedLookbackDays,
    observedHomeCount: observedWeights.length,
    coldStartHomeCount: homeIds.length - observedWeights.length,
    demandByHome: Object.fromEntries(homeIds.map((homeId) => [homeId, ledger[homeId]])),
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

function renameWeightedPlanEntries(entries, keyName) {
  return (Array.isArray(entries) ? entries : []).map((entry) => {
    const { subjectId, ...rest } = isObject(entry) ? entry : {};
    return {
      [keyName]: typeof subjectId === "string" ? subjectId : null,
      ...rest,
    };
  });
}

function mapWeightedPlanSubjectKeys(plan, keyName) {
  return {
    ...plan,
    moved: renameWeightedPlanEntries(plan?.moved, keyName),
    unchanged: renameWeightedPlanEntries(plan?.unchanged, keyName),
    skipped: renameWeightedPlanEntries(plan?.skipped, keyName),
  };
}

function planWeightedPoolAssignments({
  configuredSubjects,
  currentAssignments,
  eligibleLabels,
  usage,
  demandLedger,
  now,
  normalizeSubjectId,
  observedDemandSource,
}) {
  // This is intentionally not the same primitive as Codex "next best label".
  // Rebalance is many-to-one demand allocation across remaining account headroom, with low-churn hysteresis.
  const subjectIds = [...new Set((Array.isArray(configuredSubjects) ? configuredSubjects : []).map((subjectId) => normalizeSubjectId(subjectId)))].toSorted((a, b) =>
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
  const ledger = isObject(demandLedger) ? demandLedger : {};
  const allocationMode = Object.values(ledger).some((entry) => entry?.source === observedDemandSource)
    ? "demand_weighted"
    : "cold_start_equal_share";

  if (labels.length === 0) {
    for (const subjectId of subjectIds) {
      skipped.push({ subjectId, reason: "no_eligible_pool_account" });
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

  const demandBySubject = Object.fromEntries(
    subjectIds.map((subjectId) => {
      const entry = isObject(ledger[subjectId]) ? ledger[subjectId] : {};
      return [
        subjectId,
        {
          source:
            entry.source === observedDemandSource || entry.source === COLD_START_EQUAL_SHARE_DEMAND_SOURCE
              ? entry.source
              : COLD_START_EQUAL_SHARE_DEMAND_SOURCE,
          demandWeight: roundDemandWeight(Math.max(MIN_AGENT_DEMAND_WEIGHT, normalizeDemandWeight(entry.demandWeight, MIN_AGENT_DEMAND_WEIGHT))),
        },
      ];
    }),
  );
  const totalDemandWeight = subjectIds.reduce((sum, subjectId) => sum + demandBySubject[subjectId].demandWeight, 0);
  const supply = buildWeightedRebalanceSupply({
    labels,
    usage,
  });
  const targetUnitsTotal = labels.reduce((sum, label) => sum + normalizeDemandWeight(supply.byLabel[label]?.targetUnits, 0), 0);
  if (targetUnitsTotal <= 0) {
    for (const subjectId of subjectIds) {
      const demand = demandBySubject[subjectId];
      skipped.push({
        subjectId,
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
  const subjectIdsByDemand = [...subjectIds].sort((a, b) => {
    const aDemand = demandBySubject[a].demandWeight;
    const bDemand = demandBySubject[b].demandWeight;
    if (aDemand !== bDemand) return bDemand - aDemand;
    const aCurrent = typeof existingAssignments[a] === "string" && labels.includes(normalizeLabel(existingAssignments[a])) ? 1 : 0;
    const bCurrent = typeof existingAssignments[b] === "string" && labels.includes(normalizeLabel(existingAssignments[b])) ? 1 : 0;
    if (aCurrent !== bCurrent) return bCurrent - aCurrent;
    return a.localeCompare(b);
  });

  for (const subjectId of subjectIdsByDemand) {
    const currentLabelRaw = typeof existingAssignments[subjectId] === "string" ? existingAssignments[subjectId] : null;
    const normalizedCurrentLabel = currentLabelRaw ? normalizeLabel(currentLabelRaw) : null;
    const currentLabel = normalizedCurrentLabel && labels.includes(normalizedCurrentLabel) ? normalizedCurrentLabel : null;
    const demand = demandBySubject[subjectId];
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
        subjectId,
        reason: "projected_demand_exceeds_eligible_supply",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
      });
      continue;
    }

    nextAssignments[subjectId] = selection.label;
    assignedCounts[selection.label] = (assignedCounts[selection.label] ?? 0) + 1;
    assignedDemandByLabel[selection.label] = roundDemandWeight(
      normalizeDemandWeight(assignedDemandByLabel[selection.label], 0) + demand.demandWeight,
    );

    if (currentLabel === selection.label) {
      unchanged.push({
        subjectId,
        label: selection.label,
        reason: selection.keptCurrent ? "kept_current_hysteresis" : "weighted_best_fit",
        demandWeight: demand.demandWeight,
        demandSource: demand.source,
        targetDemandWeight: selection.targetDemandWeight,
        projectedDemandWeight: selection.projectedDemandWeight,
      });
    } else {
      moved.push({
        subjectId,
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
  if (subjectIds.length === 0) {
    status = "noop";
  } else if (skipped.length > 0 && skipped.length === subjectIds.length) {
    const blockedReason = skipped.every((entry) => entry.reason === "projected_demand_exceeds_eligible_supply")
      ? "projected_demand_exceeds_eligible_supply"
      : "no_eligible_pool_account";
    blockers.push({ reason: blockedReason });
    status = "blocked";
  } else if (subjectIds.length > 0 && moved.length === 0 && skipped.length === 0) {
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

export function planWeightedOpenclawRebalance({ configuredAgents, currentAssignments, eligibleLabels, usage, agentDemand, now }) {
  return mapWeightedPlanSubjectKeys(
    planWeightedPoolAssignments({
      configuredSubjects: configuredAgents,
      currentAssignments,
      eligibleLabels,
      usage,
      demandLedger: agentDemand,
      now,
      normalizeSubjectId: normalizeAgentId,
      observedDemandSource: OPENCLAW_SESSION_DEMAND_SOURCE,
    }),
    "agentId",
  );
}

export function planWeightedHermesRebalance({ configuredHomes, currentAssignments, eligibleLabels, usage, homeDemand, now }) {
  return mapWeightedPlanSubjectKeys(
    planWeightedPoolAssignments({
      configuredSubjects: configuredHomes,
      currentAssignments,
      eligibleLabels,
      usage,
      demandLedger: homeDemand,
      now,
      normalizeSubjectId: normalizeHermesHomeId,
      observedDemandSource: HERMES_SESSION_DEMAND_SOURCE,
    }),
    "homeId",
  );
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

function appendAnthropicHistory(state, entries) {
  ensureStateShape(state);
  const current = Array.isArray(state.pool.anthropic.history) ? state.pool.anthropic.history : [];
  const additions = (Array.isArray(entries) ? entries : []).filter((entry) => isObject(entry));
  state.pool.anthropic.history = pruneOpenaiCodexHistory([...current, ...additions]);
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

function buildAnthropicExhaustionHistoryEntries({ usage, eligibleLabels, observedAt }) {
  const eligible = new Set(Array.isArray(eligibleLabels) ? eligibleLabels : []);
  const entries = [];

  for (const [label, snapshot] of Object.entries(isObject(usage) ? usage : {})) {
    if (!isUsageSnapshotExhausted(snapshot)) continue;
    entries.push({
      observedAt,
      kind: "exhaustion",
      label,
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
    lastWatchReceipt: isObject(target.lastWatchReceipt) ? target.lastWatchReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
  };
}

function readPiCliTargetStatus({ state, homeDir }) {
  ensureStateShape(state);
  const importMeta = getAuthorityCodexImport(state);
  const target = getPiTargetState(state);
  const agentDir = resolveManagedPiAgentDir({ homeDir });
  const readback = readPiAuthFile({ agentDir });
  const activeLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const expectedAccountId = typeof target.expectedAccountId === "string" ? target.expectedAccountId.trim() : "";
  const actualAccountId = readback.ok ? readback.accountId : null;
  const inferredLabel = actualAccountId ? findCodexLabelByAccountId(state, actualAccountId) : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedCodexLabels(state),
    agentDir,
    authPath: resolvePiAuthFilePath(agentDir),
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

function buildHermesFleetSpread(homes) {
  const spread = new Map();
  for (const home of Array.isArray(homes) ? homes : []) {
    const label = typeof home?.currentLabel === "string" ? normalizeLabel(home.currentLabel) : "";
    if (!label) continue;
    const current = spread.get(label) ?? { label, carriedHomeCount: 0, carriedDemandWeight: 0 };
    current.carriedHomeCount += 1;
    current.carriedDemandWeight = roundDemandWeight(
      current.carriedDemandWeight + normalizeDemandWeight(home?.demand?.demandWeight, 0),
    );
    spread.set(label, current);
  }
  return Array.from(spread.values()).toSorted((a, b) => a.label.localeCompare(b.label));
}

function readHermesFleetStatus({ state, homeDir }) {
  ensureStateShape(state);
  const fleet = getHermesFleetState(state);
  const homes = discoverHermesHomes({ homeDir }).map((home) => {
    const status = readHermesHomeStatus({ state, homeDir, homeId: home.homeId });
    return {
      ...status,
      warnings: buildWarningsFromHermesHomeStatus(status),
    };
  });
  return {
    profilesRoot: resolveHermesProfilesRoot(homeDir),
    homeCount: homes.length,
    mappedHomeCount: homes.filter((home) => typeof home.currentLabel === "string" && home.currentLabel.trim()).length,
    warningHomeCount: homes.filter((home) => Array.isArray(home.warnings) && home.warnings.length > 0).length,
    spread: buildHermesFleetSpread(homes),
    homes,
    lastApplyReceipt: isObject(fleet.lastApplyReceipt) ? fleet.lastApplyReceipt : null,
    lastWatchReceipt: isObject(fleet.lastWatchReceipt) ? fleet.lastWatchReceipt : null,
    lastRebalancedAt: typeof fleet.lastRebalancedAt === "string" ? fleet.lastRebalancedAt.trim() || null : null,
  };
}

function readClaudeCliTargetStatus({ state, homeDir }) {
  ensureStateShape(state);
  const importMeta = getAuthorityAnthropicImport(state);
  const target = getClaudeTargetState(state);
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const readback = readClaudeNativeBundle({ homeDir });
  const activeLabel = typeof target.activeLabel === "string" ? target.activeLabel.trim() : "";
  const activeCredential = activeLabel ? getAnthropicCredential(state, activeLabel) : null;
  const expected = buildClaudeCredentialSummaryFromBundle(activeCredential);
  const inferredLabel =
    readback.summary
      ? getAnthropicCredentialMatchLabel(state, {
          accessToken: readback.summary.access,
          refreshToken: readback.summary.refresh,
        })
      : null;
  const authStatus =
    activeLabel || readback.exists
      ? readClaudeAuthStatus({ homeDir })
      : {
          available: false,
          commandPath: resolveClaudeCommand({ homeDir }),
        };
  const actualSubscriptionType =
    typeof authStatus?.subscriptionType === "string" && authStatus.subscriptionType.trim()
      ? authStatus.subscriptionType.trim()
      : readback.summary?.subscriptionType
        ? readback.summary.subscriptionType
        : null;
  const actualEmailAddress =
    typeof authStatus?.email === "string" && authStatus.email.trim()
      ? authStatus.email.trim().toLowerCase()
      : readback.summary?.emailAddress
        ? readback.summary.emailAddress
        : null;
  const actualOrganizationName =
    typeof authStatus?.orgName === "string" && authStatus.orgName.trim()
      ? authStatus.orgName.trim()
      : readback.summary?.organizationName
        ? readback.summary.organizationName
        : null;
  const actualOrganizationUuid =
    typeof authStatus?.orgId === "string" && authStatus.orgId.trim()
      ? authStatus.orgId.trim()
      : readback.summary?.organizationUuid
        ? readback.summary.organizationUuid
        : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedAnthropicLabels(state),
    claudeDir,
    credentialsPath: readback.credentialsPath,
    appStatePath: readback.appStatePath,
    activeLabel: activeLabel || null,
    activeAccountPresent: activeLabel ? isObject(state.accounts[activeLabel]) : false,
    activeCredentialPresent: activeLabel ? isObject(activeCredential) : false,
    expectedSubscriptionType: expected?.subscriptionType || null,
    expectedEmailAddress: expected?.emailAddress || null,
    expectedOrganizationName: expected?.organizationName || null,
    expectedOrganizationUuid: expected?.organizationUuid || null,
    actualSubscriptionType,
    actualEmailAddress,
    actualOrganizationName,
    actualOrganizationUuid,
    inferredLabel: inferredLabel || null,
    readback,
    authStatus,
    authOverrideEnv: readClaudeAuthOverrideEnv(),
    lastSelectionReceipt: isObject(target.lastSelectionReceipt) ? target.lastSelectionReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
  };
}

function buildWarningsFromHermesFleetStatus(status) {
  const warnings = [];
  for (const home of Array.isArray(status?.homes) ? status.homes : []) {
    warnings.push(...buildWarningsFromHermesHomeStatus(home));
  }
  return warnings;
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

function buildWarningsFromPiTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (!status.importedLabels?.length && status.activeLabel) {
    warnings.push({
      kind: "pi_import_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "pi_target_label_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "pi_target_credentials_missing",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.readback.exists) {
    warnings.push({
      kind: "pi_target_missing_auth_file",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback.exists && status.readback.ok !== true) {
    warnings.push({
      kind: "pi_target_auth_unreadable",
      system: "pi-cli",
      status: status.readback.error,
    });
  }

  if (status.activeLabel && status.readback.ok === true && !status.readback.providerEntryPresent) {
    warnings.push({
      kind: "pi_target_missing_provider_entry",
      system: "pi-cli",
      label: status.activeLabel,
    });
  }

  if (
    status.activeLabel
    && status.readback.ok === true
    && status.readback.providerEntryPresent
    && status.readback.providerEntryType
    && status.readback.providerEntryType !== "oauth"
  ) {
    warnings.push({
      kind: "pi_target_provider_entry_invalid",
      system: "pi-cli",
      label: status.activeLabel,
      status: status.readback.providerEntryType,
    });
  }

  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    warnings.push({
      kind: "pi_target_account_mismatch",
      system: "pi-cli",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }

  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    warnings.push({
      kind: "pi_target_label_mismatch",
      system: "pi-cli",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return warnings;
}

function buildWarningsFromClaudeTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;

  if (status.activeLabel && !status.activeAccountPresent) {
    warnings.push({
      kind: "claude_target_label_missing",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && !status.activeCredentialPresent) {
    warnings.push({
      kind: "claude_target_credentials_missing",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && status.readback?.credentials?.exists !== true) {
    warnings.push({
      kind: "claude_target_missing_auth_file",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback?.credentials?.exists === true && status.readback.credentials.ok !== true) {
    warnings.push({
      kind: "claude_target_auth_unreadable",
      system: "claude-cli",
      status: status.readback.credentials.error,
    });
  }

  if (status.activeLabel && status.readback?.credentials?.ok === true && !status.readback.credentials.claudeAiOauthPresent) {
    warnings.push({
      kind: "claude_target_missing_provider_entry",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (status.activeLabel && status.readback?.appState?.exists !== true) {
    warnings.push({
      kind: "claude_target_missing_app_state",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (status.readback?.appState?.exists === true && status.readback.appState.ok !== true) {
    warnings.push({
      kind: "claude_target_app_state_unreadable",
      system: "claude-cli",
      status: status.readback.appState.error,
    });
  }

  if (status.activeLabel && status.readback?.appState?.ok === true && !status.readback.appState.oauthAccountPresent) {
    warnings.push({
      kind: "claude_target_missing_oauth_account",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (
    status.activeLabel
    && status.expectedSubscriptionType
    && status.actualSubscriptionType
    && status.expectedSubscriptionType !== status.actualSubscriptionType
  ) {
    warnings.push({
      kind: "claude_target_subscription_mismatch",
      system: "claude-cli",
      label: status.activeLabel,
      status: status.actualSubscriptionType,
    });
  }

  if (
    status.activeLabel
    && status.expectedEmailAddress
    && status.actualEmailAddress
    && status.expectedEmailAddress !== status.actualEmailAddress
  ) {
    warnings.push({
      kind: "claude_target_email_mismatch",
      system: "claude-cli",
      label: status.activeLabel,
      status: status.actualEmailAddress,
    });
  }

  if (
    status.activeLabel
    && status.expectedOrganizationName
    && status.actualOrganizationName
    && status.expectedOrganizationName !== status.actualOrganizationName
  ) {
    warnings.push({
      kind: "claude_target_organization_mismatch",
      system: "claude-cli",
      label: status.activeLabel,
      status: status.actualOrganizationName,
    });
  }

  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    warnings.push({
      kind: "claude_target_label_mismatch",
      system: "claude-cli",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  if (status.activeLabel && status.authStatus?.available === true && status.authStatus.ok !== true) {
    warnings.push({
      kind: "claude_target_status_unreadable",
      system: "claude-cli",
      label: status.activeLabel,
      status: status.authStatus.error || status.authStatus.status || "unknown",
    });
  }

  if (status.activeLabel && status.authStatus?.ok === true && status.authStatus.loggedIn !== true) {
    warnings.push({
      kind: "claude_target_not_logged_in",
      system: "claude-cli",
      label: status.activeLabel,
    });
  }

  if (
    status.activeLabel
    && status.authStatus?.ok === true
    && typeof status.authStatus.authMethod === "string"
    && status.authStatus.authMethod
    && status.authStatus.authMethod !== "claude.ai"
  ) {
    warnings.push({
      kind:
        Array.isArray(status.authOverrideEnv) && status.authOverrideEnv.length > 0
          ? "claude_target_env_override"
          : "claude_target_auth_method_mismatch",
      system: "claude-cli",
      label: status.activeLabel,
      authMethod: status.authStatus.authMethod,
      ...(Array.isArray(status.authOverrideEnv) && status.authOverrideEnv.length > 0
        ? { env: status.authOverrideEnv }
        : {}),
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

function applyClaudeCliFromState({ label, homeDir }, state) {
  ensureStateShape(state);
  if (getAnthropicPoolLabels(state).length === 0) {
    throw new Error(
      "No Claude pool labels are available on this machine yet. " +
        "Reauth a Claude label first with `aim <label>`.",
    );
  }

  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown Claude label: ${normalizedLabel}. Run \`aim status\` to inspect the local pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== ANTHROPIC_PROVIDER) {
    throw new Error(`Refusing to activate non-Claude label=${normalizedLabel} provider=${provider || "unknown"}.`);
  }

  const credential = assertAnthropicCredentialShape({
    label: normalizedLabel,
    credential: getAnthropicCredential(state, normalizedLabel),
    requireFresh: true,
    requireClaudeNativeBundle: true,
  });

  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const authPayload = buildClaudeAuthDotJson({ credential });
  const credentialsWrite = writeJsonFileIfChanged(resolveClaudeAuthFilePath(claudeDir), authPayload, { mode: 0o600 });
  const appStateWrite = writeClaudeAppStateOauthAccount({ homeDir, credential });
  const readback = readClaudeNativeBundle({ homeDir });
  if (readback.ok !== true) {
    throw new Error("Failed to read back managed Claude auth bundle after apply.");
  }
  if (!hasCompleteClaudeNativeBundle(readback.nativeClaudeBundle) || !readback.summary) {
    throw new Error("Claude readback is missing native auth bundle fields after apply.");
  }
  const inferredLabel = getAnthropicCredentialMatchLabel(state, {
    accessToken: readback.summary.access,
    refreshToken: readback.summary.refresh,
  });
  if (inferredLabel && inferredLabel !== normalizedLabel) {
    throw new Error(`Claude readback mismatch after apply: expected label=${normalizedLabel}, got ${inferredLabel}.`);
  }

  const target = getClaudeTargetState(state);
  target.claudeDir = claudeDir;
  delete target.authPath;
  delete target.expectedSubscriptionType;
  target.credentialsPath = readback.credentialsPath;
  target.appStatePath = readback.appStatePath;
  target.activeLabel = normalizedLabel;
  target.lastAppliedAt = new Date().toISOString();

  return {
    label: normalizedLabel,
    subscriptionType: credential.subscriptionType,
    claudeDir,
    credentialsPath: readback.credentialsPath,
    appStatePath: readback.appStatePath,
    wrote: {
      credentials: credentialsWrite.wrote,
      appState: appStateWrite.wrote,
    },
  };
}

function applyPiCliFromState({ label, homeDir }, state) {
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
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"} for Pi.`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const agentDir = resolveManagedPiAgentDir({ homeDir });
  const existing = readPiAuthFile({ agentDir });
  if (existing.exists && existing.ok !== true) {
    throw new Error(`Failed to read current Pi auth file before apply: ${existing.error || "unknown error"}`);
  }
  const authPayload = {
    ...(existing.ok === true && isObject(existing.json) ? existing.json : {}),
    [OPENAI_CODEX_PROVIDER]: buildPiAuthEntry({ credential }),
  };
  const writeResult = writeJsonFileIfChanged(resolvePiAuthFilePath(agentDir), authPayload, { mode: 0o600 });
  const readback = readPiAuthFile({ agentDir });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back managed Pi auth file: ${readback.error || "unknown error"}`);
  }
  if (readback.accountId !== credential.accountId) {
    throw new Error(
      `Pi readback mismatch after apply: expected accountId=${credential.accountId}, got ${readback.accountId || "none"}.`,
    );
  }

  const target = getPiTargetState(state);
  target.agentDir = agentDir;
  target.authPath = readback.authPath;
  target.activeLabel = normalizedLabel;
  target.expectedAccountId = credential.accountId;
  target.lastAppliedAt = new Date().toISOString();

  return {
    label: normalizedLabel,
    accountId: credential.accountId,
    agentDir,
    authPath: readback.authPath,
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

  for (const label of buildDirtyImportedCodexLabels(state)) {
    warnings.push({ kind: "local_update_not_promoted", provider: OPENAI_CODEX_PROVIDER, label });
  }
  for (const label of buildDirtyImportedAnthropicLabels(state)) {
    warnings.push({ kind: "local_update_not_promoted", provider: ANTHROPIC_PROVIDER, label });
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
  const authorityCodexImportStatus = buildAuthorityCodexImportStatus(state);
  const authorityAnthropicImportStatus = buildAuthorityAnthropicImportStatus(state);
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
    const authorityImportStatus =
      provider === OPENAI_CODEX_PROVIDER
        ? getAuthorityCodexImportLabelStatus(state, label)
        : provider === ANTHROPIC_PROVIDER
          ? getAuthorityAnthropicImportLabelStatus(state, label)
          : null;
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
      ...(authorityImportStatus?.imported
        ? {
            authorityImport: {
              dirtyLocal: authorityImportStatus.dirty,
            },
          }
        : {}),
    });
  }

  const codexCli = readCodexCliTargetStatus({ state, homeDir });
  const claudeCli = readClaudeCliTargetStatus({ state, homeDir });
  const piCli = readPiCliTargetStatus({ state, homeDir });
  const hermesFleet = readHermesFleetStatus({ state, homeDir });
  const openclawTarget = getOpenclawTargetState(state);
  const nextBestCandidate = pickNextBestLocalCliPoolLabel({
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
    imports: {
      authority: {
        codex: sanitizeForStatus(authorityCodexImportStatus),
        anthropic: sanitizeForStatus(authorityAnthropicImportStatus),
      },
    },
    codexCli: sanitizeForStatus(codexCli),
    claudeCli: sanitizeForStatus(claudeCli),
    piCli: sanitizeForStatus(piCli),
    hermesFleet: sanitizeForStatus(hermesFleet),
    warnings: [
      ...buildWarningsFromState(state),
      ...buildWarningsFromStatusAccounts(sortedAccounts),
      ...buildWarningsFromCodexTargetStatus(codexCli),
      ...buildWarningsFromClaudeTargetStatus(claudeCli),
      ...buildWarningsFromPiTargetStatus(piCli),
      ...buildWarningsFromHermesFleetStatus(hermesFleet),
    ],
  };
}

function formatInteractiveLoginSummary(login) {
  const mode = normalizeInteractiveOAuthMode(login?.mode);
  if (mode === REAUTH_MODE_NATIVE_CLAUDE) {
    return REAUTH_MODE_NATIVE_CLAUDE;
  }
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

function readStatusAccountUsedPercent(usage, index) {
  if (!usage || usage.ok !== true) return null;
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const usedPercent = Number(windows[index]?.usedPercent);
  return Number.isFinite(usedPercent) ? usedPercent : null;
}

function formatStatusAccountUsedCell(usage, index) {
  const usedPercent = readStatusAccountUsedPercent(usage, index);
  if (!Number.isFinite(usedPercent)) return "--";
  return `${Math.round(usedPercent)}%`;
}

function formatStatusDeltaMsCell(deltaMs) {
  if (!Number.isFinite(deltaMs)) return "--";
  const deltaHours = deltaMs / 3600000;
  if (deltaHours <= 0) return "0h";
  if (deltaHours >= 48) {
    return `${(deltaHours / 24).toFixed(1)}d`;
  }
  return `${deltaHours.toFixed(1)}h`;
}

function readStatusAccountResetDeltaMs(usage, index, now = Date.now()) {
  if (!usage || usage.ok !== true) return null;
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const resetAt = windows[index]?.resetAt;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  return ms - now;
}

function readStatusAccountExpiryDeltaMs(credentials, now = Date.now()) {
  const expiresAt = typeof credentials?.expiresAt === "string" ? credentials.expiresAt.trim() : "";
  const ms = parseExpiresAtToMs(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return ms - now;
}

function formatStatusAccountResetCell(usage, index) {
  return formatStatusDeltaMsCell(readStatusAccountResetDeltaMs(usage, index));
}

function averageStatusNumbers(values) {
  const normalizedValues = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (normalizedValues.length === 0) return null;
  return normalizedValues.reduce((sum, value) => sum + value, 0) / normalizedValues.length;
}

function buildStatusAverageAccountTableRow(accounts, now = Date.now()) {
  const normalizedAccounts = Array.isArray(accounts) ? accounts : [];
  const averageExpiryDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountExpiryDeltaMs(account?.credentials, now)),
  );
  const averageFiveHourUsedPct = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountUsedPercent(account?.usage, 0)),
  );
  const averageFiveHourResetDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountResetDeltaMs(account?.usage, 0, now)),
  );
  const averageWeekUsedPct = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountUsedPercent(account?.usage, 1)),
  );
  const averageWeekResetDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountResetDeltaMs(account?.usage, 1, now)),
  );

  return [
    "average",
    "--",
    "--",
    Number.isFinite(averageExpiryDeltaMs) ? formatDurationRough(averageExpiryDeltaMs) : "--",
    Number.isFinite(averageFiveHourUsedPct) ? `${Math.round(averageFiveHourUsedPct)}%` : "--",
    formatStatusDeltaMsCell(averageFiveHourResetDeltaMs),
    Number.isFinite(averageWeekUsedPct) ? `${Math.round(averageWeekUsedPct)}%` : "--",
    formatStatusDeltaMsCell(averageWeekResetDeltaMs),
    "all",
    "-",
  ];
}

function buildStatusAccountFlags(account) {
  const flags = [];
  const detailReason = String(account?.operator?.detailReason ?? "").trim();
  if (account?.authorityImport?.dirtyLocal === true) {
    flags.push("dirty_authority");
  }
  if (detailReason === "missing_browser" || detailReason === "binding_missing_for_future_reauth") {
    flags.push("missing_browser");
  } else if (detailReason && detailReason !== "manual_mode" && detailReason !== "native_claude") {
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
  const hermesHomeCount = Math.max(0, Math.round(Number(view.hermesFleet?.homeCount ?? 0)));
  const hermesMappedHomeCount = Math.max(0, Math.round(Number(view.hermesFleet?.mappedHomeCount ?? 0)));
  const hermesWarningHomeCount = Math.max(0, Math.round(Number(view.hermesFleet?.warningHomeCount ?? 0)));
  const showHermesCompact =
    hermesHomeCount > 0
    || hermesMappedHomeCount > 0
    || typeof view.hermesFleet?.lastApplyReceipt?.status === "string"
    || typeof view.hermesFleet?.lastWatchReceipt?.status === "string";
  const hermesCompact = showHermesCompact
    ? `  hermes=${hermesMappedHomeCount}/${hermesHomeCount}  h_warn=${hermesWarningHomeCount}  h_apply=${view.hermesFleet?.lastApplyReceipt?.status || "--"}  h_watch=${view.hermesFleet?.lastWatchReceipt?.status || "--"}`
    : "";
  return `load=${load}  spare=${spare}  5h_floor=${floor5}(${floor5Label})  7d_floor=${floor7}(${floor7Label})  eta=${eta}${hermesCompact}\n`;
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

  const codexAuthoritySource =
    typeof view.imports?.authority?.codex?.source === "string" ? view.imports.authority.codex.source.trim() : "";
  const codexAuthorityImportedAt =
    typeof view.imports?.authority?.codex?.importedAt === "string" ? view.imports.authority.codex.importedAt.trim() : "";
  const codexDirtyImportedLabels = Array.isArray(view.imports?.authority?.codex?.dirtyLabels) ? view.imports.authority.codex.dirtyLabels : [];
  const codexImportedLabels = Array.isArray(view.codexCli?.importedLabels) ? view.codexCli.importedLabels : [];
  if (codexAuthoritySource || codexImportedLabels.length > 0) {
    lines.push(`Authority import (Codex): source=${codexAuthoritySource || "none"} labels=${codexImportedLabels.length}`);
    if (codexAuthorityImportedAt) {
      lines.push(`Authority import age (Codex): ${formatAgeSince(codexAuthorityImportedAt)}`);
    }
    if (codexDirtyImportedLabels.length > 0) {
      lines.push(`Authority dirty (Codex): ${codexDirtyImportedLabels.length} label(s) pending promote`);
    }
  }
  const claudeAuthoritySource =
    typeof view.imports?.authority?.anthropic?.source === "string" ? view.imports.authority.anthropic.source.trim() : "";
  const claudeAuthorityImportedAt =
    typeof view.imports?.authority?.anthropic?.importedAt === "string"
      ? view.imports.authority.anthropic.importedAt.trim()
      : "";
  const claudeDirtyImportedLabels =
    Array.isArray(view.imports?.authority?.anthropic?.dirtyLabels) ? view.imports.authority.anthropic.dirtyLabels : [];
  const claudeImportedLabels = Array.isArray(view.claudeCli?.importedLabels) ? view.claudeCli.importedLabels : [];
  if (claudeAuthoritySource || claudeImportedLabels.length > 0) {
    lines.push(`Authority import (Claude): source=${claudeAuthoritySource || "none"} labels=${claudeImportedLabels.length}`);
    if (claudeAuthorityImportedAt) {
      lines.push(`Authority import age (Claude): ${formatAgeSince(claudeAuthorityImportedAt)}`);
    }
    if (claudeDirtyImportedLabels.length > 0) {
      lines.push(`Authority dirty (Claude): ${claudeDirtyImportedLabels.length} label(s) pending promote`);
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
    const averageAccountRow = view.accounts.length > 0 ? buildStatusAverageAccountTableRow(view.accounts) : null;
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
      ...(averageAccountRow ? [averageAccountRow] : []),
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

  const hermesHomes = Array.isArray(view.hermesFleet?.homes) ? view.hermesFleet.homes : [];
  if (showAssignments && hermesHomes.length > 0) {
    lines.push("");
    lines.push("Hermes homes");
    for (const home of hermesHomes.toSorted((a, b) => String(a?.homeId ?? "").localeCompare(String(b?.homeId ?? "")))) {
      lines.push(`- ${home.homeId} -> ${home.currentLabel || "unmapped"}`);
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
        ["last_watch", view.codexCli.lastWatchReceipt?.status || "--"],
        ["last_watch_at", view.codexCli.lastWatchReceipt?.observedAt || "--"],
      ]),
    );
  }

  if (view.hermesFleet) {
    lines.push("");
    lines.push("HERMES");
    lines.push(
      ...formatStatusBlockRows([
        ["homes", formatMetricValue(view.hermesFleet.homeCount ?? 0, { integer: true })],
        ["mapped_homes", `${view.hermesFleet.mappedHomeCount ?? 0}/${view.hermesFleet.homeCount ?? 0}`],
        ["warning_homes", formatMetricValue(view.hermesFleet.warningHomeCount ?? 0, { integer: true })],
        ["last_apply", view.hermesFleet.lastApplyReceipt?.status || "--"],
        ["last_watch", view.hermesFleet.lastWatchReceipt?.status || "--"],
      ]),
    );
    const hermesSpread = Array.isArray(view.hermesFleet.spread) ? view.hermesFleet.spread : [];
    if (hermesSpread.length > 0) {
      lines.push(
        `Spread: ${hermesSpread.map((entry) => `${entry.label}=${entry.carriedHomeCount} home(s)/${entry.carriedDemandWeight}w`).join(", ")}`,
      );
    }
  }

  if (view.claudeCli) {
    lines.push("");
    lines.push("CLAUDE");
    lines.push(
      ...formatStatusBlockRows([
        ["active_label", view.claudeCli.activeLabel || "none"],
        ["subscription", view.claudeCli.actualSubscriptionType || view.claudeCli.expectedSubscriptionType || "--"],
        ["auth_method", view.claudeCli.authStatus?.authMethod || "--"],
        ["auth_status", view.claudeCli.authStatus?.available === true
          ? (view.claudeCli.authStatus.ok === true
            ? (view.claudeCli.authStatus.loggedIn === true ? "logged_in" : "logged_out")
            : "error")
          : "unavailable"],
        ["synced_age", view.claudeCli.importedAt ? formatAgeSince(view.claudeCli.importedAt.trim()) : "--"],
        ["credentials_path", view.claudeCli.credentialsPath || "--"],
        ["app_state_path", view.claudeCli.appStatePath || "--"],
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
  if (provider === ANTHROPIC_PROVIDER) return "Stored tokens";
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
  const reauthMode =
    provider === ANTHROPIC_PROVIDER
      ? REAUTH_MODE_NATIVE_CLAUDE
      : normalizeInteractiveOAuthMode(account?.reauth?.mode);
  const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
  const credentialHealth = resolveCredentialHealth(credential);
  const nativeBundleComplete = provider === ANTHROPIC_PROVIDER ? hasCompleteClaudeNativeBundle(credential) : null;
  const needsSetup =
    provider === ANTHROPIC_PROVIDER
      ? false
      : !reauthMode
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
  if (provider === ANTHROPIC_PROVIDER) {
    reason =
      typeof operator?.reason === "string" && operator.reason.trim()
        ? operator.reason.trim()
        : nativeBundleComplete
          ? "Ready for native Claude switching."
          : "No complete native Claude bundle is stored for this label yet.";
  } else if (panelKind === "setup") {
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
    nativeBundleComplete,
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
  if (panelState.provider === ANTHROPIC_PROVIDER) {
    lines.push(`Native bundle: ${panelState.nativeBundleComplete ? "complete" : "missing"}`);
  } else {
    lines.push(`Browser: ${panelState.browserSummary}`);
  }
  process.stdout.write(`${lines.join("\n")}\n\n`);
}

function buildAnthropicLabelPanelActions(panelState) {
  const actions = [];
  if (panelState.nativeBundleComplete) {
    actions.push({
      key: "1",
      action: "use_native_claude_label",
      label: "Use this label in Claude",
      details: ["Will write this label's native Claude bundle into the managed Claude CLI files now."],
    });
    actions.push({
      key: "2",
      action: "refresh_native_claude_bundle",
      label: "Refresh native bundle",
      details: ["Will refresh stored Claude tokens and keep the same native Claude identity metadata."],
    });
    actions.push({
      key: "3",
      action: "capture_native_claude",
      label: "Capture current native Claude login",
      details: ["Will read the live Claude login files from this host and store them on this label."],
    });
    actions.push({
      key: "4",
      action: "import_native_claude_bundle",
      label: "Import native Claude bundle",
      details: ["Will ask for a portable Claude bundle JSON file path and store it on this label."],
    });
    actions.push({
      key: "5",
      action: "export_live_native_claude_bundle",
      label: "Export current live native bundle",
      details: ["Will ask where to write a portable Claude bundle JSON from the live Claude login on this host."],
    });
    actions.push({
      key: "6",
      action: "show_details",
      label: "Show details",
      details: [`Will print the raw provider, credential, and native Claude state for ${panelState.label}.`],
    });
  } else {
    actions.push({
      key: "1",
      action: "capture_native_claude",
      label: "Capture current native Claude login",
      details: ["Will read the live Claude login files from this host and store them on this label."],
    });
    actions.push({
      key: "2",
      action: "import_native_claude_bundle",
      label: "Import native Claude bundle",
      details: ["Will ask for a portable Claude bundle JSON file path and store it on this label."],
    });
    actions.push({
      key: "3",
      action: "export_live_native_claude_bundle",
      label: "Export current live native bundle",
      details: ["Will ask where to write a portable Claude bundle JSON from the live Claude login on this host."],
    });
    actions.push({
      key: "4",
      action: "show_details",
      label: "Show details",
      details: [`Will print the raw provider, credential, and native Claude state for ${panelState.label}.`],
    });
  }
  actions.push({
    key: "0",
    action: "done",
    label: "Done",
    details: ["Makes no changes."],
  });
  return actions;
}

function buildLabelPanelActions(panelState, { homeDir, suggestions, discoveryWarning } = {}) {
  if (panelState.provider === ANTHROPIC_PROVIDER) {
    return buildAnthropicLabelPanelActions(panelState);
  }
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
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel);
  const provider = normalizeProviderId(account?.provider);
  const credential =
    provider === OPENAI_CODEX_PROVIDER
      ? getCodexCredential(state, normalizedLabel)
      : provider === ANTHROPIC_PROVIDER
        ? getAnthropicCredential(state, normalizedLabel)
        : null;
  const details = {
    label: normalizedLabel,
    provider: provider || null,
    account,
    credential,
    browser: showBrowserBinding({ state, label: normalizedLabel, homeDir }),
    liveClaude: provider === ANTHROPIC_PROVIDER ? readClaudeNativeBundle({ homeDir }) : null,
  };
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
  refreshAnthropicImpl = refreshAnthropicToken,
}) {
  const normalizedLabel = normalizeLabel(label);
  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: normalizedLabel,
    promptLineImpl,
  });
  const attemptedAt = recordAccountMaintenanceAttempt(state, normalizedLabel, { providerHint: provider });
  let hermesSync = {
    status: "noop",
    checkedHomeCount: 0,
    matchedHomeCount: 0,
    syncedHomeIds: [],
    writes: [],
  };
  let authorityPromotion = {
    imported: false,
    dirty: false,
  };

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
      ensureAnthropicLabelConfigured(state, normalizedLabel);
      const cred = await maintainAnthropicNativeLabel({
        state,
        label: normalizedLabel,
        homeDir,
        refreshImpl: refreshAnthropicImpl,
      });
      state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = cred;
    } else {
      throw new Error(`Provider not supported: ${provider}`);
    }

    recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
    if (provider === OPENAI_CODEX_PROVIDER) {
      authorityPromotion = markImportedCodexLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
    } else if (provider === ANTHROPIC_PROVIDER) {
      authorityPromotion = markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
    }
    if (provider === OPENAI_CODEX_PROVIDER) {
      hermesSync = syncHermesHomesForLabel({
        state,
        label: normalizedLabel,
        homeDir,
      });
    }
    state.schemaVersion = SCHEMA_VERSION;
    return {
      ok: true,
      label: normalizedLabel,
      provider,
      maintenance: {
        status: "ready",
        observedAt: attemptedAt,
      },
      ...(authorityPromotion.imported
        ? {
            authorityPromotion: {
              dirty: authorityPromotion.dirty,
              ...(authorityPromotion.dirty
                ? {
                    status: "pending_publish",
                    target:
                      provider === OPENAI_CODEX_PROVIDER
                        ? (typeof getAuthorityCodexImport(state).source === "string" ? getAuthorityCodexImport(state).source : null)
                        : (typeof getAuthorityAnthropicImport(state).source === "string" ? getAuthorityAnthropicImport(state).source : null),
                  }
                : { status: "clean" }),
            },
          }
        : {}),
      hermesSync,
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

  if (
    action === "capture_native_claude"
    || action === "import_native_claude_bundle"
    || action === "export_live_native_claude_bundle"
    || action === "refresh_native_claude_bundle"
    || action === "use_native_claude_label"
  ) {
    if (action === "use_native_claude_label") {
      const activated = activateClaudeLabelSelection({ state, homeDir, label: normalizedLabel });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n\n`);
      return { done: false };
    }

    const attemptedAt = recordAccountMaintenanceAttempt(state, normalizedLabel, { providerHint: ANTHROPIC_PROVIDER });
    try {
      if (action === "capture_native_claude") {
        const captured = captureAnthropicNativeBundleForLabel({
          state,
          label: normalizedLabel,
          sourceHome: homeDir,
        });
        recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
        writeJsonFileWithBackup(statePath, state);
        process.stdout.write(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              captured: {
                label: normalizedLabel,
                sourceHome: captured.sourceHome,
                emailAddress: captured.summary.emailAddress,
                organizationName: captured.summary.organizationName,
                organizationUuid: captured.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n\n`,
        );
        return { done: false };
      }

      if (action === "import_native_claude_bundle") {
        const bundlePath = resolveCliPath(
          await promptLineImpl(`Bundle JSON path for "${normalizedLabel}":`),
          { homeDir, optionName: "bundle path" },
        );
        const imported = importAnthropicNativeBundleForLabel({
          state,
          label: normalizedLabel,
          filePath: bundlePath,
        });
        recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
        writeJsonFileWithBackup(statePath, state);
        process.stdout.write(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              imported: {
                label: normalizedLabel,
                filePath: imported.filePath,
                sourceHome: imported.sourceHome,
                emailAddress: imported.summary.emailAddress,
                organizationName: imported.summary.organizationName,
                organizationUuid: imported.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n\n`,
        );
        return { done: false };
      }

      if (action === "export_live_native_claude_bundle") {
        const outPath = resolveCliPath(
          await promptLineImpl(`Write native Claude bundle for "${normalizedLabel}" to:`, {
            defaultValue: path.join(homeDir, `${normalizedLabel}.claude-native-bundle.json`),
          }),
          { homeDir, optionName: "bundle output path" },
        );
        const exported = exportLiveClaudeNativeBundle({
          filePath: outPath,
          sourceHome: homeDir,
          labelHint: normalizedLabel,
        });
        process.stdout.write(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              exported: {
                filePath: exported.filePath,
                sourceHome: exported.sourceHome,
                emailAddress: exported.summary.emailAddress,
                organizationName: exported.summary.organizationName,
                organizationUuid: exported.summary.organizationUuid,
                wrote: exported.wrote,
              },
            }),
            null,
            2,
          )}\n\n`,
        );
        return { done: false };
      }

      const refreshed = await refreshAnthropicNativeBundleCredential({
        state,
        label: normalizedLabel,
        refreshImpl: refreshAnthropicImpl,
      });
      state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = refreshed;
      recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
      markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${normalizedLabel} is ready.\n\n`);
    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, normalizedLabel, {
        observedAt: attemptedAt,
        ...(message.match(/conflict|does not match|unsupported|already stored/i) ? { blockedReason: message } : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      reportPanelActionError(err);
    }
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

function getPrimaryRemainingPctFromUsageSnapshot(snapshot) {
  if (!snapshot || snapshot.ok !== true) return null;
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return null;
  return clampPercent(100 - Number(windows[0]?.usedPercent ?? 0));
}

function buildCodexWatchNonfatalWarnings(status) {
  return buildWarningsFromCodexTargetStatus(status)
    .filter((warning) => warning?.kind === "codex_import_missing");
}

function buildCodexWatchTargetBlockers(status) {
  const blockers = [];
  if (!status) return blockers;

  if (status.storeError) {
    blockers.push({ reason: "codex_target_config_invalid", status: status.storeError });
  } else if (status.storeMode && status.storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    blockers.push({ reason: "codex_target_store_mode_unsupported", status: status.storeMode });
  }

  if (status.activeLabel && !status.activeAccountPresent) {
    blockers.push({ reason: "codex_target_label_missing", label: status.activeLabel });
  }
  if (status.activeLabel && !status.activeCredentialPresent) {
    blockers.push({ reason: "codex_target_credentials_missing", label: status.activeLabel });
  }
  if (status.activeLabel && !status.readback.exists) {
    blockers.push({ reason: "codex_target_missing_auth_file", label: status.activeLabel });
  }
  if (status.readback.exists && status.readback.ok !== true) {
    blockers.push({ reason: "codex_target_auth_unreadable", status: status.readback.error || "unknown" });
  }
  if (status.activeLabel && status.expectedAccountId && status.actualAccountId && status.expectedAccountId !== status.actualAccountId) {
    blockers.push({
      reason: "codex_target_account_mismatch",
      label: status.activeLabel,
      accountId: status.actualAccountId,
      expectedAccountId: status.expectedAccountId,
    });
  }
  if (status.activeLabel && status.inferredLabel && status.inferredLabel !== status.activeLabel) {
    blockers.push({
      reason: "codex_target_label_mismatch",
      label: status.activeLabel,
      actualLabel: status.inferredLabel,
    });
  }

  return blockers;
}

async function activateCodexPoolSelection({
  state,
  homeDir,
  observedAt: observedAtOverride,
  usageByProvider: usageByProviderOverride,
  selectionMode = "round_robin",
}) {
  ensureStateShape(state);
  // Structural target validation comes first: if this machine's Codex home is not
  // AIM-manageable, fail loud before doing pool selection or usage probing.
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir }) });
  const observedAt =
    typeof observedAtOverride === "string" && observedAtOverride.trim()
      ? observedAtOverride.trim()
      : new Date().toISOString();
  const usageByProvider = isObject(usageByProviderOverride)
    ? usageByProviderOverride
    : await probeUsageSnapshotsByProvider(state);
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
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
  const currentLabel = currentTarget.activeLabel ?? currentTarget.inferredLabel ?? null;
  let selection;
  if (selectionMode === "round_robin") {
    selection = pickNextCodexUseRoundRobinLabel({
      poolLabels: poolStatus.labels,
      eligibleLabels: poolStatus.eligibleLabels,
      currentLabel,
    });
  } else if (selectionMode === "weighted_usage") {
    const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
    const currentAssignments = getOpenclawAssignments(state);
    const rankedCandidates = rankPoolCandidates({
      labels: poolStatus.eligibleLabels,
      usage: usageByLabel,
      currentLabel,
      currentAssignments,
      configuredAgents: configuredCodexAgents,
      agentDemand: state.pool.openaiCodex.agentDemand,
      lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
      now: Date.parse(observedAt),
    });
    selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  } else {
    throw new Error(`Unsupported Codex selection mode: ${selectionMode}`);
  }
  if (!selection) {
    throw new Error("Failed to select a Codex pool label.");
  }

  const activated = applyCodexCliFromState({ label: selection.label, homeDir }, state);
  const postStatus = readCodexCliTargetStatus({ state, homeDir });
  const warnings = buildWarningsFromCodexTargetStatus(postStatus);
  const status =
    !activated.wrote && currentLabel === selection.label && currentTarget.expectedAccountId === activated.accountId
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "codex_use",
    status,
    observedAt,
    previousLabel: currentLabel ?? undefined,
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

async function watchCodexPoolSelectionOnce(
  {
    state,
    homeDir,
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
  },
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
  } = {},
) {
  ensureStateShape(state);
  // Watch mode owns the threshold decision and receipt, but it must never invent
  // a second auth writer. Weighted selection and auth mutation still flow through
  // activateCodexPoolSelection() -> applyCodexCliFromState().
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir }) });
  const effectiveThresholdPct = resolveCodexWatchThresholdPct(thresholdPct);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state);
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const currentTarget = readCodexCliTargetStatus({ state, homeDir });
  const target = getCodexTargetState(state);
  const currentLabelBefore = currentTarget.activeLabel || null;
  const warnings = buildCodexWatchNonfatalWarnings(currentTarget);

  if (!currentLabelBefore) {
    const poolLabels = getCodexPoolLabels(state);
    if (poolLabels.length === 0) {
      const receipt = {
        action: "codex_watch",
        status: "blocked",
        observedAt,
        thresholdPct: effectiveThresholdPct,
        currentLabelBefore: null,
        currentLabelAfter: currentTarget.inferredLabel || null,
        primaryRemainingPctBefore: null,
        triggeredSelection: false,
        warnings,
        blockers: [{ reason: "no_pool_account_available" }],
      };
      target.lastWatchReceipt = receipt;
      return { status: "blocked", receipt, wrote: false };
    }

    const selection = await activateCodexPoolSelectionImpl({
      state,
      homeDir,
      observedAt,
      usageByProvider,
      selectionMode: "weighted_usage",
    });
    const postTarget = readCodexCliTargetStatus({ state, homeDir });
    const receipt = {
      action: "codex_watch",
      status: selection.status,
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore: null,
      currentLabelAfter: postTarget.activeLabel || postTarget.inferredLabel || null,
      primaryRemainingPctBefore: null,
      triggeredSelection: true,
      selectionReceipt: selection.receipt,
      warnings: [...warnings, ...(Array.isArray(selection.receipt?.warnings) ? selection.receipt.warnings : [])],
      blockers: Array.isArray(selection.receipt?.blockers) ? selection.receipt.blockers : [],
    };
    target.lastWatchReceipt = receipt;
    return { status: selection.status, receipt, wrote: Boolean(selection.wrote) };
  }

  const targetBlockers = buildCodexWatchTargetBlockers(currentTarget);
  if (targetBlockers.length > 0) {
    const receipt = {
      action: "codex_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore: null,
      triggeredSelection: false,
      warnings,
      blockers: targetBlockers,
    };
    target.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  const activeUsage = usageByLabel[currentLabelBefore] ?? null;
  const primaryRemainingPctBefore = getPrimaryRemainingPctFromUsageSnapshot(activeUsage);
  if (primaryRemainingPctBefore === null) {
    const blockers = [
      {
        reason: "active_target_usage_unavailable",
        label: currentLabelBefore,
        ...(
          (typeof activeUsage?.status === "string" && activeUsage.status.trim())
          || Number.isFinite(Number(activeUsage?.status))
            ? { status: activeUsage.status }
          : {}),
        ...(typeof activeUsage?.error === "string" && activeUsage.error.trim()
          ? { detail: activeUsage.error.trim() }
          : {}),
      },
    ];
    const receipt = {
      action: "codex_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore: null,
      triggeredSelection: false,
      warnings,
      blockers,
    };
    target.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  if (primaryRemainingPctBefore >= effectiveThresholdPct) {
    const receipt = {
      action: "codex_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore,
      triggeredSelection: false,
      warnings,
      blockers: [],
    };
    target.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  const selection = await activateCodexPoolSelectionImpl({
    state,
    homeDir,
    observedAt,
    usageByProvider,
    selectionMode: "weighted_usage",
  });
  const postTarget = readCodexCliTargetStatus({ state, homeDir });
  const receipt = {
    action: "codex_watch",
    status: selection.status,
    observedAt,
    thresholdPct: effectiveThresholdPct,
    currentLabelBefore,
    currentLabelAfter: postTarget.activeLabel || postTarget.inferredLabel || null,
    primaryRemainingPctBefore,
    triggeredSelection: true,
    selectionReceipt: selection.receipt,
    warnings: [...warnings, ...(Array.isArray(selection.receipt?.warnings) ? selection.receipt.warnings : [])],
    blockers: Array.isArray(selection.receipt?.blockers) ? selection.receipt.blockers : [],
  };
  target.lastWatchReceipt = receipt;
  return { status: selection.status, receipt, wrote: Boolean(selection.wrote) };
}

async function watchCodexPoolSelectionLoop(
  {
    statePath,
    homeDir,
    intervalSeconds = DEFAULT_CODEX_WATCH_INTERVAL_SECONDS,
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
    maxIterations = Number.POSITIVE_INFINITY,
  },
  {
    emitResultImpl = null,
    sleepImpl = sleep,
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
  } = {},
) {
  const effectiveIntervalSeconds = resolveCodexWatchIntervalSeconds(intervalSeconds);
  const effectiveMaxIterations =
    Number.isFinite(Number(maxIterations)) && Number(maxIterations) > 0
      ? Math.floor(Number(maxIterations))
      : Number.POSITIVE_INFINITY;
  let lastResult = null;

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration += 1) {
    const state = loadAimgrState(statePath);
    lastResult = await watchCodexPoolSelectionOnce(
      {
        state,
        homeDir,
        thresholdPct,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
      },
    );
    writeJsonFileWithBackup(statePath, state);
    if (typeof emitResultImpl === "function") {
      await emitResultImpl(lastResult, { iteration });
    }
    if (iteration + 1 >= effectiveMaxIterations) {
      break;
    }
    await sleepImpl(effectiveIntervalSeconds * 1000);
  }

  return lastResult;
}

async function activateClaudePoolSelection({ state, homeDir }) {
  ensureStateShape(state);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProvider(state);
  const usageByLabel = usageByProvider[ANTHROPIC_PROVIDER];
  const poolStatus = collectAnthropicPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });

  appendAnthropicHistory(
    state,
    buildAnthropicExhaustionHistoryEntries({
      usage: usageByLabel,
      eligibleLabels: poolStatus.eligibleLabels,
      observedAt,
    }),
  );

  if (poolStatus.labels.length === 0) {
    throw new Error(
      "No Claude pool labels are available on this machine yet. " +
        "Reauth a Claude label first with `aim <label>`.",
    );
  }

  const target = getClaudeTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readClaudeCliTargetStatus({ state, homeDir });
    clearManagedClaudeCliActivation({ state, homeDir });
    const blockerDetails = poolStatus.labels
      .map((label) => {
        const entry = poolStatus.byLabel[label];
        if (!entry || entry.eligible === true) return null;
        return {
          label,
          reason: entry.usageReason || entry.detailReason || entry.reason || "not_eligible",
        };
      })
      .filter(Boolean);
    const receipt = {
      action: "claude_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      warnings: [],
      blockers: blockerDetails.length > 0 ? blockerDetails : [{ reason: "no_eligible_pool_account" }],
      reasons: [],
      wroteCredentialsJson: false,
      wroteAppStateJson: false,
    };
    target.lastSelectionReceipt = receipt;
    appendAnthropicHistory(state, [
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

  const currentTarget = readClaudeCliTargetStatus({ state, homeDir });
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel: currentTarget.activeLabel,
    currentAssignments: {},
    configuredAgents: [],
    agentDemand: {},
    lastApplyReceipt: null,
    now: Date.parse(observedAt),
  });
  const selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  if (!selection) {
    throw new Error("Failed to select a next-best Claude pool label.");
  }

  const activated = applyClaudeCliFromState({
    label: selection.label,
    homeDir,
  }, state);
  const postStatus = readClaudeCliTargetStatus({ state, homeDir });
  const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
  const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
  const status =
    !wroteAny
    && currentTarget.activeLabel === selection.label
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "claude_use",
    status,
    observedAt,
    previousLabel: currentTarget.activeLabel ?? undefined,
    label: selection.label,
    subscriptionType: activated.subscriptionType,
    keptCurrent: Boolean(selection.keptCurrent),
    reasons: Array.isArray(selection.reasons) ? selection.reasons : [],
    credentialsPath: activated.credentialsPath,
    appStatePath: activated.appStatePath,
    wroteCredentialsJson: Boolean(activated.wrote?.credentials),
    wroteAppStateJson: Boolean(activated.wrote?.appState),
    warnings,
    blockers: [],
  };
  target.lastSelectionReceipt = receipt;
  appendAnthropicHistory(state, [
    {
      observedAt,
      kind: "selection",
      status,
      label: selection.label,
      hadSpareEligibleCapacity: poolStatus.eligibleLabels.length > 1,
      reason: selection.keptCurrent ? "kept_current" : "next_best",
    },
  ]);

  return { status, receipt, wrote: wroteAny };
}

function classifyClaudeActivationError(err) {
  const message = String(err?.message ?? err);
  if (/nativeclaudebundle.*missing|missing or incomplete native Claude bundle|missing_native_claude_bundle/i.test(message)) {
    return "missing_native_claude_bundle";
  }
  if (/expired anthropic credentials|credentials are expired/i.test(message)) {
    return "expired_credentials";
  }
  if (/Missing anthropic credentials/i.test(message)) {
    return "missing_credentials";
  }
  return "activation_failed";
}

function activateClaudeLabelSelection({ state, homeDir, label }) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();
  const target = getClaudeTargetState(state);
  const currentTarget = readClaudeCliTargetStatus({ state, homeDir });

  try {
    const activated = applyClaudeCliFromState({
      label: normalizedLabel,
      homeDir,
    }, state);
    const postStatus = readClaudeCliTargetStatus({ state, homeDir });
    const warnings = buildWarningsFromClaudeTargetStatus(postStatus);
    const wroteAny = Boolean(activated.wrote?.credentials || activated.wrote?.appState);
    const status =
      !wroteAny && currentTarget.activeLabel === normalizedLabel
        ? "noop"
        : warnings.length > 0
          ? "activated_with_warnings"
          : "activated";
    const receipt = {
      action: "claude_use",
      status,
      observedAt,
      previousLabel: currentTarget.activeLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      subscriptionType: activated.subscriptionType,
      reasons: ["explicit_label"],
      credentialsPath: activated.credentialsPath,
      appStatePath: activated.appStatePath,
      wroteCredentialsJson: Boolean(activated.wrote?.credentials),
      wroteAppStateJson: Boolean(activated.wrote?.appState),
      warnings,
      blockers: [],
    };
    target.lastSelectionReceipt = receipt;
    appendAnthropicHistory(state, [
      {
        observedAt,
        kind: "selection",
        status,
        label: normalizedLabel,
        hadSpareEligibleCapacity: false,
        reason: "explicit_label",
      },
    ]);
    return { status, receipt, wrote: wroteAny };
  } catch (err) {
    const message = String(err?.message ?? err);
    const receipt = {
      action: "claude_use",
      status: "blocked",
      observedAt,
      previousLabel: currentTarget.activeLabel ?? currentTarget.inferredLabel ?? undefined,
      label: normalizedLabel,
      explicit: true,
      reasons: ["explicit_label"],
      warnings: [],
      blockers: [
        {
          label: normalizedLabel,
          reason: classifyClaudeActivationError(err),
          detail: message,
        },
      ],
      wroteCredentialsJson: false,
      wroteAppStateJson: false,
    };
    target.lastSelectionReceipt = receipt;
    appendAnthropicHistory(state, [
      {
        observedAt,
        kind: "selection",
        status: "blocked",
        label: normalizedLabel,
        hadSpareEligibleCapacity: false,
        reason: classifyClaudeActivationError(err),
      },
    ]);
    return { status: "blocked", receipt, wrote: false };
  }
}

async function activatePiPoolSelection({ state, homeDir }) {
  ensureStateShape(state);
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

  const target = getPiTargetState(state);
  if (poolStatus.eligibleLabels.length === 0) {
    const currentTarget = readPiCliTargetStatus({ state, homeDir });
    clearManagedPiCliActivation({ state, homeDir });
    const receipt = {
      action: "pi_use",
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

  const currentTarget = readPiCliTargetStatus({ state, homeDir });
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
  const selection = pickNextBestLocalCliPoolLabel({ rankedCandidates });
  if (!selection) {
    throw new Error("Failed to select a next-best Pi pool label.");
  }

  const activated = applyPiCliFromState({ label: selection.label, homeDir }, state);
  const postStatus = readPiCliTargetStatus({ state, homeDir });
  const warnings = buildWarningsFromPiTargetStatus(postStatus);
  const status =
    !activated.wrote && currentTarget.activeLabel === selection.label && currentTarget.expectedAccountId === activated.accountId
      ? "noop"
      : warnings.length > 0
        ? "activated_with_warnings"
        : "activated";

  const receipt = {
    action: "pi_use",
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

function buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped = false } = {}) {
  const entries = [];
  for (const home of Array.isArray(homeStatuses) ? homeStatuses : []) {
    const homeId = typeof home?.homeId === "string" ? normalizeHermesHomeId(home.homeId) : null;
    if (!homeId) continue;
    if (typeof home?.currentLabel === "string" && home.currentLabel.trim()) {
      entries.push([homeId, normalizeLabel(home.currentLabel)]);
      continue;
    }
    if (includeUnmapped) {
      entries.push([homeId, null]);
    }
  }
  return Object.fromEntries(entries);
}

function syncHermesHomesForLabel(
  {
    state,
    label,
    homeDir,
  },
  {
    discoverHermesHomesImpl = discoverHermesHomes,
    readHermesHomeStatusImpl = readHermesHomeStatus,
    writeHermesAuthFromStateImpl = writeHermesAuthFromState,
  } = {},
) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const homes = discoverHermesHomesImpl({ homeDir });
  const statuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const matchingHomes = statuses.filter((home) => home.currentLabel === normalizedLabel);
  const homesNeedingSync = matchingHomes.filter((home) => home.needsSync);
  const writes = [];
  for (const home of homesNeedingSync.toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    writes.push(
      writeHermesAuthFromStateImpl(
        { label: normalizedLabel, authPath: home.authPath },
        state,
      ),
    );
  }
  return {
    status: homesNeedingSync.length > 0 ? "applied" : "noop",
    checkedHomeCount: homes.length,
    matchedHomeCount: matchingHomes.length,
    syncedHomeIds: homesNeedingSync.map((home) => home.homeId).toSorted((a, b) => a.localeCompare(b)),
    writes,
  };
}

export async function rebalanceHermesPool(
  params,
  state,
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    discoverHermesHomesImpl = discoverHermesHomes,
    readHermesHomeStatusImpl = readHermesHomeStatus,
    refreshHermesHomeDemandLedgerImpl = refreshHermesHomeDemandLedger,
    writeHermesAuthFromStateImpl = writeHermesAuthFromState,
  } = {},
) {
  ensureStateShape(state);
  const homeDir = resolveHomeDir(params.home);
  const observedAt =
    typeof params?.observedAt === "string" && params.observedAt.trim()
      ? params.observedAt.trim()
      : new Date().toISOString();
  const usageByProvider = isObject(params?.usageByProvider)
    ? params.usageByProvider
    : await probeUsageSnapshotsByProviderImpl(state);
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

  const fleet = getHermesFleetState(state);
  const homes = discoverHermesHomesImpl({ homeDir });
  const homeStatuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const homeWarnings = homeStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const homeBlockers = homeStatuses.flatMap((home) => buildHermesHomeBlockers(home));
  fleet.lastRebalancedAt = observedAt;

  if (homeBlockers.length > 0) {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: null,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: [],
      perAccountLoad: [],
      warnings: homeWarnings,
      blockers: homeBlockers,
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }

  let demandRefresh;
  try {
    demandRefresh = refreshHermesHomeDemandLedgerImpl({
      state,
      homeDir,
      homes,
      now: Date.parse(observedAt),
      lookbackDays: DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
    });
  } catch (error) {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: null,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: [],
      perAccountLoad: [],
      warnings: homeWarnings,
      blockers: [buildHermesDemandUnreadableBlocker(error)],
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }
  const plan = planWeightedHermesRebalance({
    configuredHomes: homeStatuses.map((home) => home.homeId),
    currentAssignments: buildHermesAssignmentsByHome(homeStatuses),
    eligibleLabels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    homeDemand: demandRefresh.demandByHome,
    now: Date.parse(observedAt),
  });

  if (plan.status === "blocked") {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: plan.allocationMode,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: homeWarnings,
      blockers: plan.blockers,
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }

  const writes = [];
  const resynced = [];
  for (const moved of [...plan.moved].toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    const homeStatus = homeStatuses.find((home) => home.homeId === moved.homeId);
    if (!homeStatus) {
      throw new Error(`Missing Hermes home for planned rebalance move: ${moved.homeId}`);
    }
    writes.push(
      writeHermesAuthFromStateImpl(
        { label: moved.to, authPath: homeStatus.authPath },
        state,
      ),
    );
  }
  for (const homeStatus of homeStatuses.toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    if (!homeStatus.currentLabel || !homeStatus.needsSync) continue;
    if (plan.moved.some((entry) => entry.homeId === homeStatus.homeId)) continue;
    writes.push(
      writeHermesAuthFromStateImpl(
        { label: homeStatus.currentLabel, authPath: homeStatus.authPath },
        state,
      ),
    );
    resynced.push({
      homeId: homeStatus.homeId,
      label: homeStatus.currentLabel,
      matchMode: homeStatus.matchMode,
    });
  }

  const postStatuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const postWarnings = postStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const resyncedHomeIds = new Set(resynced.map((entry) => entry.homeId));
  const wroteAuth = writes.some((entry) => entry?.wrote?.auth === true);
  let status = "applied";
  if (plan.status === "noop" && !wroteAuth) {
    status = postWarnings.length > 0 ? "applied_with_warnings" : "noop";
  } else if (plan.status === "applied_with_warnings" || postWarnings.length > 0) {
    status = "applied_with_warnings";
  }

  const receipt = {
    action: "rebalance_hermes",
    status,
    observedAt,
    allocationMode: plan.allocationMode,
    assignments: sanitizeForStatus(buildHermesAssignmentsByHome(postStatuses, { includeUnmapped: true })),
    moved: plan.moved,
    resynced,
    unchanged: plan.unchanged.filter((entry) => !resyncedHomeIds.has(entry.homeId)),
    skipped: plan.skipped,
    perAccountLoad: plan.perAccountLoad,
    warnings: postWarnings,
    blockers: [],
    writes,
  };
  fleet.lastApplyReceipt = receipt;
  return { status, receipt, writes };
}

async function watchHermesPoolSelectionOnce(
  {
    state,
    homeDir,
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
  },
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    rebalanceHermesPoolImpl = rebalanceHermesPool,
  } = {},
) {
  ensureStateShape(state);
  const effectiveThresholdPct = resolveCodexWatchThresholdPct(thresholdPct);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state);
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const poolStatus = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });
  const eligibleLabels = new Set(poolStatus.eligibleLabels);
  const fleet = getHermesFleetState(state);
  const homeStatuses = discoverHermesHomes({ homeDir }).map((home) => readHermesHomeStatus({ state, homeDir, homeId: home.homeId }));
  const warnings = homeStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const homeBlockers = homeStatuses.flatMap((home) => buildHermesHomeBlockers(home));
  const needsSyncHomeIds = homeStatuses.filter((home) => home.needsSync || !home.currentLabel).map((home) => home.homeId);

  if (homeStatuses.length === 0) {
    const receipt = {
      action: "hermes_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: 0,
      currentAssignmentsBefore: {},
      currentAssignmentsAfter: {},
      lowestPrimaryRemainingPctBefore: null,
      triggeredRebalance: false,
      needsSyncHomeIds: [],
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings: [],
      blockers: [],
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  if (homeBlockers.length > 0) {
    const receipt = {
      action: "hermes_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore: null,
      triggeredRebalance: false,
      needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings,
      blockers: homeBlockers,
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  const currentAssignmentsBefore = buildHermesAssignmentsByHome(homeStatuses);
  const belowThresholdHomeIds = [];
  const ineligibleHomeIds = [];
  const usageBlockers = [];
  let lowestPrimaryRemainingPctBefore = null;

  for (const home of homeStatuses) {
    const currentLabel = home.currentLabel;
    if (!currentLabel) {
      continue;
    }
    if (currentLabel && !eligibleLabels.has(currentLabel)) {
      ineligibleHomeIds.push(home.homeId);
    }
    const activeUsage = usageByLabel[currentLabel] ?? null;
    const primaryRemainingPctBefore = getPrimaryRemainingPctFromUsageSnapshot(activeUsage);
    if (primaryRemainingPctBefore === null) {
      usageBlockers.push({
        reason: "hermes_home_usage_unavailable",
        homeId: home.homeId,
        label: currentLabel,
        ...(
          (typeof activeUsage?.status === "string" && activeUsage.status.trim())
          || Number.isFinite(Number(activeUsage?.status))
            ? { status: activeUsage.status }
          : {}),
        ...(typeof activeUsage?.error === "string" && activeUsage.error.trim()
          ? { detail: activeUsage.error.trim() }
          : {}),
      });
      continue;
    }
    lowestPrimaryRemainingPctBefore =
      lowestPrimaryRemainingPctBefore === null
        ? primaryRemainingPctBefore
        : Math.min(lowestPrimaryRemainingPctBefore, primaryRemainingPctBefore);
    if (primaryRemainingPctBefore < effectiveThresholdPct) {
      belowThresholdHomeIds.push(home.homeId);
    }
  }

  if (usageBlockers.length > 0) {
    const receipt = {
      action: "hermes_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore,
      triggeredRebalance: false,
      needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
      belowThresholdHomeIds,
      ineligibleHomeIds,
      warnings,
      blockers: usageBlockers,
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  if (belowThresholdHomeIds.length === 0 && ineligibleHomeIds.length === 0 && needsSyncHomeIds.length === 0) {
    const receipt = {
      action: "hermes_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore,
      triggeredRebalance: false,
      needsSyncHomeIds: [],
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings,
      blockers: [],
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  const rebalanced = await rebalanceHermesPoolImpl(
    {
      home: homeDir,
      observedAt,
      usageByProvider,
    },
    state,
  );
  const postStatuses = discoverHermesHomes({ homeDir }).map((home) => readHermesHomeStatus({ state, homeDir, homeId: home.homeId }));
  const receipt = {
    action: "hermes_watch",
    status: rebalanced.status,
    observedAt,
    thresholdPct: effectiveThresholdPct,
    homeCount: homeStatuses.length,
    currentAssignmentsBefore: sanitizeForStatus(currentAssignmentsBefore),
    currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(postStatuses, { includeUnmapped: true })),
    lowestPrimaryRemainingPctBefore,
    triggeredRebalance: true,
    needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
    belowThresholdHomeIds,
    ineligibleHomeIds,
    rebalanceReceipt: rebalanced.receipt,
    warnings: [
      ...warnings,
      ...(Array.isArray(rebalanced.receipt?.warnings) ? rebalanced.receipt.warnings : []),
    ],
    blockers: Array.isArray(rebalanced.receipt?.blockers) ? rebalanced.receipt.blockers : [],
  };
  fleet.lastWatchReceipt = receipt;
  return { status: rebalanced.status, receipt, wrote: Array.isArray(rebalanced.writes) && rebalanced.writes.some((entry) => entry?.wrote?.auth === true) };
}

async function watchHermesPoolSelectionLoop(
  {
    statePath,
    homeDir,
    intervalSeconds = DEFAULT_CODEX_WATCH_INTERVAL_SECONDS,
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
    maxIterations = Number.POSITIVE_INFINITY,
  },
  {
    emitResultImpl = null,
    sleepImpl = sleep,
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    rebalanceHermesPoolImpl = rebalanceHermesPool,
  } = {},
) {
  const effectiveIntervalSeconds = resolveCodexWatchIntervalSeconds(intervalSeconds);
  const effectiveMaxIterations =
    Number.isFinite(Number(maxIterations)) && Number(maxIterations) > 0
      ? Math.floor(Number(maxIterations))
      : Number.POSITIVE_INFINITY;
  let lastResult = null;

  for (let iteration = 0; iteration < effectiveMaxIterations; iteration += 1) {
    const state = loadAimgrState(statePath);
    lastResult = await watchHermesPoolSelectionOnce(
      {
        state,
        homeDir,
        thresholdPct,
      },
      {
        probeUsageSnapshotsByProviderImpl,
        rebalanceHermesPoolImpl,
      },
    );
    writeJsonFileWithBackup(statePath, state);
    if (typeof emitResultImpl === "function") {
      await emitResultImpl(lastResult, { iteration });
    }
    if (iteration + 1 >= effectiveMaxIterations) {
      break;
    }
    await sleepImpl(effectiveIntervalSeconds * 1000);
  }

  return lastResult;
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
    refreshAnthropicImpl = refreshAnthropicToken,
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
    rebalanceHermesPoolImpl = rebalanceHermesPool,
    sleepImpl = sleep,
    watchLoopMaxIterations = Number.POSITIVE_INFINITY,
  } = deps;
  const { opts, positional } = parseArgs(argv);
  const knownCmds = new Set(["status", "login", "pin", "autopin", "rebalance", "apply", "sync", "promote", "auth", "codex", "hermes", "claude", "pi", "browser", "internal"]);
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
    const view = await buildStatusView({
      statePath,
      state,
      homeDir,
    });
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

  if (cmd === "internal") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing internal subcommand.");
    }
    if (subcmd !== "apply-codex-promotion" && subcmd !== "apply-claude-promotion") {
      throw new Error(`Unsupported internal subcommand: ${subcmd}.`);
    }
    const rawPayload = await readTextFromStream(stdin);
    if (!String(rawPayload ?? "").trim()) {
      throw new Error(`Missing ${subcmd === "apply-codex-promotion" ? "codex" : "Claude"} promotion payload on stdin.`);
    }
    let payload;
    try {
      payload = JSON.parse(rawPayload);
    } catch (err) {
      throw new Error(`Invalid ${subcmd === "apply-codex-promotion" ? "codex" : "Claude"} promotion payload JSON: ${String(err?.message ?? err)}`);
    }
    const state = loadAimgrState(statePath);
    const applied =
      subcmd === "apply-codex-promotion"
        ? applyCodexPromotionPayloadToState({
            state,
            payload,
            authorityDisplay: statePath,
          })
        : applyClaudePromotionPayloadToState({
            state,
            payload,
            authorityDisplay: statePath,
          });
    if (applied.status === "applied") {
      writeJsonFileWithBackup(statePath, state);
    }
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, applied }), null, 2)}\n`);
    return;
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
      throw new Error("Missing rebalance target. Usage: aim rebalance openclaw | aim rebalance hermes");
    }
    if (system === "openclaw") {
      const state = loadAimgrState(statePath);
      const rebalanced = await rebalanceOpenclawPool(opts, state);
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
      if (rebalanced.status === "blocked") {
        process.exitCode = 1;
      }
      return;
    }
    if (system === "hermes") {
      const state = loadAimgrState(statePath);
      const rebalanced = await rebalanceHermesPoolImpl(opts, state);
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
      if (rebalanced.status === "blocked") {
        process.exitCode = 1;
      }
      return;
    }
    throw new Error(`Unsupported rebalance target: ${system} (supported: openclaw, hermes).`);
  }

  if (cmd === "apply") {
    const state = loadAimgrState(statePath);
    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
    return;
  }

  if (cmd === "auth") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing auth subcommand. Usage: aim auth write hermes <label> --auth-file <abs-path>");
    }
    if (subcmd !== "write") {
      throw new Error(`Unsupported auth subcommand: ${subcmd} (supported: write).`);
    }
    const system = String(positional[2] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error("Missing auth target. Usage: aim auth write hermes <label> --auth-file <abs-path>");
    }
    if (system !== "hermes") {
      throw new Error(`Unsupported auth target: ${system} (supported: hermes).`);
    }
    const label = normalizeLabel(positional[3]);
    const state = loadAimgrState(statePath);
    const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
    return;
  }

  if (cmd === "sync") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error(
        "Missing sync target. Usage: aim sync openclaw | aim sync codex --from agents@amirs-mac-studio | aim sync claude --from agents@amirs-mac-studio",
      );
    }
    const state = loadAimgrState(statePath);
    if (system === "openclaw") {
      const synced = await syncOpenclawFromState(opts, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
      return;
    }
    if (system === "codex") {
      const imported = importCodexFromAuthority({
        from: opts.from,
        state,
        homeDir,
        discardDirty: opts.discardDirty === true,
      });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, imported }), null, 2)}\n`);
      return;
    }
    if (system === "claude") {
      const imported = importAnthropicFromAuthority({
        from: opts.from,
        state,
        homeDir,
        discardDirty: opts.discardDirty === true,
      });
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, imported }), null, 2)}\n`);
      return;
    }
    if (system === "hermes") {
      throw new Error(
        "`aim sync hermes` was removed. Use `aim auth write hermes <label> --auth-file <abs-path>` and manage Hermes runtime files outside AIM.",
      );
    }
    throw new Error(`Unsupported sync target: ${system} (supported: openclaw, codex, claude).`);
  }

  if (cmd === "promote") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error("Missing promote target. Usage: aim promote codex --to <authority> <label> [<label>...] | aim promote claude --to <authority> <label> [<label>...]");
    }
    const labels = positional.slice(2);
    const state = loadAimgrState(statePath);
    const promoted =
      system === "codex"
        ? promoteCodexToAuthority({
            to: opts.to,
            labels,
            state,
          })
        : system === "claude"
          ? promoteClaudeToAuthority({
              to: opts.to,
              labels,
              state,
            })
          : (() => {
              throw new Error(`Unsupported promote target: ${system} (supported: codex, claude).`);
            })();
    writeJsonFileWithBackup(statePath, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, promoted }), null, 2)}\n`);
    return;
  }

  if (cmd === "codex") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing codex subcommand. Usage: aim codex use | aim codex watch");
    }
    if (subcmd === "watch") {
      if (String(positional[2] ?? "").trim()) {
        throw new Error("`aim codex watch <label>` is not supported. Use `aim codex watch` and let AIM decide when to rotate.");
      }
      const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
      if (opts.once) {
        const state = loadAimgrState(statePath);
        const watched = await watchCodexPoolSelectionOnce(
          {
            state,
            homeDir,
            thresholdPct,
          },
          {
            probeUsageSnapshotsByProviderImpl,
            activateCodexPoolSelectionImpl,
          },
        );
        writeJsonFileWithBackup(statePath, state);
        process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
        if (watched.status === "blocked") {
          process.exitCode = 1;
        }
        return;
      }

      await watchCodexPoolSelectionLoop(
        {
          statePath,
          homeDir,
          intervalSeconds: opts.intervalSeconds,
          thresholdPct,
          maxIterations: watchLoopMaxIterations,
        },
        {
          sleepImpl,
          probeUsageSnapshotsByProviderImpl,
          activateCodexPoolSelectionImpl,
          emitResultImpl: async (watched) => {
            process.stdout.write(
              `${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`,
            );
          },
        },
      );
      return;
    }
    if (subcmd !== "use") {
      throw new Error(`Unsupported codex subcommand: ${subcmd} (supported: use, watch).`);
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

  if (cmd === "hermes") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing hermes subcommand. Usage: aim hermes watch");
    }
    if (subcmd !== "watch") {
      throw new Error(`Unsupported hermes subcommand: ${subcmd} (supported: watch).`);
    }
    if (String(positional[2] ?? "").trim()) {
      throw new Error("`aim hermes watch <label>` is not supported. Use `aim hermes watch` and let AIM decide when to rebalance.");
    }
    const thresholdPct = resolveCodexWatchThresholdPct(opts.rotateBelow5hRemainingPct);
    if (opts.once) {
      const state = loadAimgrState(statePath);
      const watched = await watchHermesPoolSelectionOnce(
        {
          state,
          homeDir,
          thresholdPct,
        },
        {
          probeUsageSnapshotsByProviderImpl,
          rebalanceHermesPoolImpl,
        },
      );
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`);
      if (watched.status === "blocked") {
        process.exitCode = 1;
      }
      return;
    }

    await watchHermesPoolSelectionLoop(
      {
        statePath,
        homeDir,
        intervalSeconds: opts.intervalSeconds,
        thresholdPct,
        maxIterations: watchLoopMaxIterations,
      },
      {
        sleepImpl,
        probeUsageSnapshotsByProviderImpl,
        rebalanceHermesPoolImpl,
        emitResultImpl: async (watched) => {
          process.stdout.write(
            `${JSON.stringify(sanitizeForStatus({ ok: watched.status !== "blocked", watched }), null, 2)}\n`,
          );
        },
      },
    );
    return;
  }

  if (cmd === "claude") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error(
        "Missing claude subcommand. Usage: aim claude use [label] | aim claude capture-native <label> | aim claude export-live --out <file> | aim claude import-native <label> --in <file>",
      );
    }
    if (subcmd === "capture-native") {
      const label = normalizeLabel(positional[2]);
      const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
      const state = loadAimgrState(statePath);
      const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
      try {
        const captured = captureAnthropicNativeBundleForLabel({
          state,
          label,
          sourceHome,
        });
        recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
        writeJsonFileWithBackup(statePath, state);
        process.stdout.write(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              captured: {
                label,
                sourceHome: captured.sourceHome,
                emailAddress: captured.summary.emailAddress,
                organizationName: captured.summary.organizationName,
                organizationUuid: captured.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n`,
        );
        return;
      } catch (err) {
        const message = String(err?.message ?? err);
        recordAccountMaintenanceFailure(state, label, {
          observedAt: attemptedAt,
          ...(message.match(/conflict|does not match|unsupported|already stored/i) ? { blockedReason: message } : {}),
        });
        writeJsonFileWithBackup(statePath, state);
        throw err;
      }
    }
    if (subcmd === "export-live") {
      const outFile = resolveCliPath(opts.outFile, { homeDir, optionName: "--out" });
      const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
      const exported = exportLiveClaudeNativeBundle({
        filePath: outFile,
        sourceHome,
      });
      process.stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            exported: {
              filePath: exported.filePath,
              sourceHome: exported.sourceHome,
              emailAddress: exported.summary.emailAddress,
              organizationName: exported.summary.organizationName,
              organizationUuid: exported.summary.organizationUuid,
              wrote: exported.wrote,
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    }
    if (subcmd === "import-native") {
      const label = normalizeLabel(positional[2]);
      const inFile = resolveCliPath(opts.inFile, { homeDir, optionName: "--in" });
      const state = loadAimgrState(statePath);
      const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
      try {
        const imported = importAnthropicNativeBundleForLabel({
          state,
          label,
          filePath: inFile,
        });
        recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
        writeJsonFileWithBackup(statePath, state);
        process.stdout.write(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              imported: {
                label,
                filePath: imported.filePath,
                sourceHome: imported.sourceHome,
                emailAddress: imported.summary.emailAddress,
                organizationName: imported.summary.organizationName,
                organizationUuid: imported.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n`,
        );
        return;
      } catch (err) {
        const message = String(err?.message ?? err);
        recordAccountMaintenanceFailure(state, label, {
          observedAt: attemptedAt,
          ...(message.match(/conflict|does not match|unsupported|already stored/i) ? { blockedReason: message } : {}),
        });
        writeJsonFileWithBackup(statePath, state);
        throw err;
      }
    }
    if (subcmd !== "use") {
      throw new Error(`Unsupported claude subcommand: ${subcmd} (supported: use, capture-native, export-live, import-native).`);
    }
    const state = loadAimgrState(statePath);
    const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
    const activated = explicitLabel
      ? activateClaudeLabelSelection({ state, homeDir, label: explicitLabel })
      : await activateClaudePoolSelection({ state, homeDir });
    writeJsonFileWithBackup(statePath, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
    if (activated.status === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  if (cmd === "pi") {
    const subcmd = String(positional[1] ?? "").trim().toLowerCase();
    if (!subcmd) {
      throw new Error("Missing pi subcommand. Usage: aim pi use");
    }
    if (subcmd !== "use") {
      throw new Error(`Unsupported pi subcommand: ${subcmd} (supported: use).`);
    }
    const state = loadAimgrState(statePath);
    if (String(positional[2] ?? "").trim()) {
      throw new Error("`aim pi use <label>` was removed. Use `aim pi use` for next-best selection or `aim <label>` if the account needs reauth.");
    }
    const activated = await activatePiPoolSelection({ state, homeDir });
    writeJsonFileWithBackup(statePath, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
    if (activated.status === "blocked") {
      process.exitCode = 1;
    }
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}
