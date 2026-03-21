import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
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
const INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE = "aim-browser-profile";
const LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE = "openclaw-browser-profile";
const INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK = "manual-callback";
const STATUS_RESET_TIMEZONE = "America/Chicago";
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
  const reserved = new Set(["status", "login", "pin", "autopin", "rebalance", "apply", "sync", "codex", "use", "help"]);
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
    json: false,
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
    if (arg === "--json") {
      opts.json = true;
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

function printHelp() {
  const lines = [
    "aim — AI account manager (label-only; one-file SSOT; plaintext on disk).",
    "",
    "Usage:",
    "  aim status [--json]",
    "  aim login <label>",
    "  aim <label>            # shorthand for: aim login <label> (account-only maintenance / reauth)",
    "  aim rebalance openclaw # choose pooled Codex assignments for configured OpenClaw agents",
    "  aim apply             # advanced: materialize stored OpenClaw assignments from ~/.aimgr/secrets.json",
    "  aim sync openclaw     # explicit alias for apply",
    "  aim sync codex --from <authority>  # import/refresh openai-codex labels from an authority AIM state",
    "  aim codex use         # activate the next-best pooled openai-codex label for local Codex CLI",
    "",
    "Notes:",
    "  - SSOT file: ~/.aimgr/secrets.json (auto-backed-up on every write).",
    "  - V0 supports: openai-codex (ChatGPT/Codex OAuth) + anthropic (Claude Pro/Max OAuth) on macOS.",
    "  - Browser-managed OAuth runs inside AIM-owned profiles under ~/.aimgr/browser/<label>/user-data.",
    "  - `aim pin`, `aim autopin openclaw`, and `aim codex use <label>` are removed; use `aim rebalance openclaw`, `aim apply`, and `aim codex use`.",
    "  - Codex target management is file-backed only in v1; keyring/auto homes fail loud.",
    "",
    "Developer options (rare):",
    "  --home <dir>    Run against an alternate HOME (dev/test; e.g. /tmp/aimgr-home).",
    "  --state <path>  Override SSOT file path (default: <home>/.aimgr/secrets.json).",
    "  --from <src>    Authority source for `aim sync codex`.",
    "                  Examples: agents@amirs-mac-studio  |  ssh://agents@amirs-mac-studio/~/.aimgr/secrets.json",
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

export function sessionEntryNeedsModelReset({ entry, desiredProvider, desiredModel }) {
  const provider = String(desiredProvider ?? "").trim();
  const model = String(desiredModel ?? "").trim();
  if (!provider || !model) {
    throw new Error("sessionEntryNeedsModelReset requires desiredProvider + desiredModel.");
  }

  const parsed = extractSessionModelRefFromEntry(entry);
  if (parsed?.provider && parsed.provider !== provider) return true;
  if (parsed?.model && parsed.model !== model) return true;

  const authProfileOverride = typeof entry?.authProfileOverride === "string" ? entry.authProfileOverride.trim() : "";
  if (authProfileOverride && !authProfileOverride.startsWith(`${provider}:`)) {
    return true;
  }

  return false;
}

export function resetSessionEntryToDefaults({ entry, desiredProvider, desiredModel }) {
  if (!isObject(entry)) return { changed: false, entry };
  const provider = String(desiredProvider ?? "").trim();
  const model = String(desiredModel ?? "").trim();
  if (!provider || !model) {
    throw new Error("resetSessionEntryToDefaults requires desiredProvider + desiredModel.");
  }

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
  if (authProfileOverride && !authProfileOverride.startsWith(`${provider}:`)) {
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

export function scanOpenclawSessionsStoreForKeysNeedingModelReset({ store, desiredProvider, desiredModel }) {
  const s = isObject(store) ? store : null;
  if (!s) return [];
  const keys = [];
  for (const [key, entry] of Object.entries(s)) {
    if (sessionEntryNeedsModelReset({ entry, desiredProvider, desiredModel })) {
      keys.push(key);
    }
  }
  return keys;
}

function applyOpenclawSessionsDiskResets({ homeDir, agentId, desiredProvider, desiredModel }) {
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
    const patched = resetSessionEntryToDefaults({ entry: current, desiredProvider, desiredModel });
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
        owner: "aim",
        ...(chromeProfileDirectory ? { seededFrom: chromeProfileDirectory } : {}),
      },
      reauth: {
        mode: INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE,
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
      "session",
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
    if (k.includes("session")) return true;
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

function openChromeUserDataDirForUrl({ url, userDataDir }) {
  const u = String(url ?? "").trim();
  const dir = String(userDataDir ?? "").trim();
  if (!u) return { ok: false, reason: "missing_url" };
  if (!dir) return { ok: false, reason: "missing_user_data_dir" };
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported_platform" };

  const result = spawnSync(
    "open",
    ["-n", "-a", "Google Chrome", "--args", `--user-data-dir=${dir}`, u],
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

function aimBrowserProfileExists({ homeDir, label }) {
  return fs.existsSync(resolveAimBrowserUserDataDir({ homeDir, label }));
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

function readChromeDefaultProfileInfoFromLocalState(localStatePath) {
  const localState = readJsonFile(localStatePath);
  const cache = localState?.profile?.info_cache;
  if (!isObject(cache)) return null;
  const def = cache.Default;
  return isObject(def) ? def : null;
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

function ensureAccountShape(account, { providerHint } = {}) {
  const nextProvider =
    normalizeProviderId(account?.provider ?? providerHint ?? OPENAI_CODEX_PROVIDER) || OPENAI_CODEX_PROVIDER;
  account.provider = nextProvider;
  account.expect = isObject(account.expect) ? account.expect : {};

  const browser = isObject(account.browser) ? account.browser : {};
  account.browser = {
    owner: "aim",
    ...(typeof browser.seededFrom === "string" && browser.seededFrom.trim()
      ? { seededFrom: browser.seededFrom.trim() }
      : {}),
    ...(typeof browser.seededAt === "string" && browser.seededAt.trim() ? { seededAt: browser.seededAt.trim() } : {}),
    ...(typeof browser.verifiedAt === "string" && browser.verifiedAt.trim()
      ? { verifiedAt: browser.verifiedAt.trim() }
      : {}),
    ...(typeof browser.conflictReason === "string" && browser.conflictReason.trim()
      ? { conflictReason: browser.conflictReason.trim() }
      : {}),
  };

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

function resolveOpenAICodexInteractiveLoginModeFromInput(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (raw === "1") return INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE;
  if (raw === "2") return INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK;

  const normalized = raw.toLowerCase().replace(/_/g, "-");
  if (
    normalized === "browser" ||
    normalized === "aim" ||
    normalized === "aim-browser" ||
    normalized === "aim-browser-profile" ||
    normalized === "openclaw" ||
    normalized === "openclaw-browser" ||
    normalized === "openclaw-browser-profile"
  ) {
    return INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE;
  }
  if (
    normalized === "manual" ||
    normalized === "callback" ||
    normalized === "manual-callback" ||
    normalized === "external-browser"
  ) {
    return INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
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

async function ensureProviderConfiguredForLabel({ state, label }) {
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
  const answer = await promptLine(`Provider for "${label}" (1-2 or id) [1]:`, { defaultValue: "1" });
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

    if (!isObject(account.browser)) {
      account.browser = {};
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
    if (migrationSource && !account.browser.seededFrom) {
      account.browser.seededFrom = migrationSource;
    }
    if (!account.reauth.mode && (legacyBindingMode || migrationSource)) {
      account.reauth.mode =
        legacyBindingMode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK
          ? INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK
          : INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE;
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

function getOpenclawAssignments(state) {
  return getOpenclawTargetState(state).assignments;
}

function getOpenclawPins(state) {
  return getOpenclawAssignments(state);
}

function getOpenclawExclusions(state) {
  return getOpenclawTargetState(state).exclusions;
}

function normalizeInteractiveOAuthMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE) {
    return INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE;
  }
  if (raw === LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE) {
    return INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE;
  }
  if (raw === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
    return INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK;
  }
  return null;
}

export function getInteractiveOAuthBindingForLabel(state, label) {
  ensureStateShape(state);
  const reauth = getAccountReauthState(state, label);
  if (!reauth) return null;
  return { mode: normalizeInteractiveOAuthMode(reauth.mode) };
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

function importCodexFromAuthority({ from, state }) {
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
    delete state.accounts[label];
    delete state.credentials[OPENAI_CODEX_PROVIDER][label];
    if (state.targets.codexCli?.activeLabel === label) {
      delete state.targets.codexCli.activeLabel;
      delete state.targets.codexCli.expectedAccountId;
      delete state.targets.codexCli.lastSelectionReceipt;
    }
    removedLabels.push(label);
  }

  for (const [label, incoming] of incomingByLabel.entries()) {
    const existingLocal = isObject(state.accounts[label]) ? state.accounts[label] : {};
    const incomingExpect = isObject(incoming.account.expect) ? structuredClone(incoming.account.expect) : null;
    const incomingPool = isObject(incoming.account.pool) ? structuredClone(incoming.account.pool) : null;
    const incomingReauthMode = normalizeInteractiveOAuthMode(incoming.account?.reauth?.mode);
    state.accounts[label] = {
      ...(isObject(existingLocal.reauth) ? { reauth: structuredClone(existingLocal.reauth) } : {}),
      provider: OPENAI_CODEX_PROVIDER,
      ...(incomingExpect ? { expect: incomingExpect } : isObject(existingLocal.expect) ? { expect: structuredClone(existingLocal.expect) } : {}),
      ...(incomingPool ? { pool: incomingPool } : isObject(existingLocal.pool) ? { pool: structuredClone(existingLocal.pool) } : {}),
    };
    ensureAccountShape(state.accounts[label], { providerHint: OPENAI_CODEX_PROVIDER });
    if (incomingReauthMode) {
      state.accounts[label].reauth.mode = incomingReauthMode;
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
  browser.owner = "aim";
  browser.seededFrom = selectedProfileId;
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
  const storedSeedSource = typeof browser.seededFrom === "string" ? browser.seededFrom.trim() : "";
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

export async function ensureOpenAICodexInteractiveLoginBinding({
  state,
  label,
  homeDir,
  promptLineImpl = promptLine,
}) {
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  const existingBinding = getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  if (!existingBinding?.mode) {
    process.stdout.write(`No interactive login mode configured for label "${normalizedLabel}" yet.\n`);
    process.stdout.write("Choose login mode:\n");
    process.stdout.write("  1) AIM-owned browser profile\n");
    process.stdout.write("  2) External browser / paste callback URL\n\n");

    const answer = await promptLineImpl(`Login mode for "${normalizedLabel}" (1-2 or id) [1]:`, {
      defaultValue: "1",
    });
    const mode = resolveOpenAICodexInteractiveLoginModeFromInput(answer);
    if (!mode) {
      throw new Error(`Unsupported OpenAI Codex login mode selection: ${answer}`);
    }

    if (mode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
      const binding = { mode };
      setInteractiveOAuthBindingForLabel(state, normalizedLabel, binding);
      return binding;
    }

    await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir });
    const binding = {
      mode: INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE,
    };
    setInteractiveOAuthBindingForLabel(state, normalizedLabel, binding);
    return binding;
  }

  if (existingBinding?.mode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
    return existingBinding;
  }
  if (existingBinding?.mode === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE) {
    await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir });
    const binding = {
      mode: INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE,
    };
    setInteractiveOAuthBindingForLabel(state, normalizedLabel, binding);
    return binding;
  }

  throw new Error(`Unable to resolve interactive login mode for label=${normalizedLabel}.`);
}

export async function refreshOrLoginCodex({
  state,
  label,
  homeDir,
  interactiveBinding,
  loginImpl = loginOpenAICodex,
  refreshImpl = refreshOpenAICodexToken,
  promptImpl = promptRequiredLine,
  openUrlImpl = openChromeUserDataDirForUrl,
  }) {
  const existing = getCodexCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const existingAccountId = existing && typeof existing.accountId === "string" ? existing.accountId : null;
  const binding = interactiveBinding ?? getInteractiveOAuthBindingForLabel(state, label);
  const bindingMode = normalizeInteractiveOAuthMode(binding?.mode);
  const aimBrowserUserDataDir =
    bindingMode === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE
      ? resolveAimBrowserUserDataDir({ homeDir, label })
      : "";

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

      if (bindingMode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
        process.stdout.write(
          [
            "Open this URL in the browser on your laptop and complete login there.",
            "When the browser lands on the localhost callback page, copy the full URL from the address bar and paste it here.",
            "",
          ].join("\n"),
        );
        return;
      }

      if (!aimBrowserUserDataDir) {
        throw new Error(`Missing AIM browser profile for label=${label}.`);
      }

      const opened = openUrlImpl({ url, userDataDir: aimBrowserUserDataDir });
      if (!opened.ok) {
        process.stdout.write(
          [
            `Failed to auto-open AIM browser profile (${opened.reason}).`,
            "Open the URL manually in the correct AIM-owned browser profile (user-data dir):",
            `  ${aimBrowserUserDataDir}`,
            "",
          ].join("\n") + "\n",
        );
      }
    },
    ...(bindingMode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK
      ? {
          onManualCodeInput: manualCallbackPrompt,
          onPrompt: manualCallbackPrompt,
        }
      : {
          onPrompt: async () => {
            throw new Error(
              "Manual redirect-url paste flow is not supported for browser-managed labels. " +
                "Run on the Mac host with the AIM-owned browser profile so the localhost callback can complete.",
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

async function refreshOrLoginAnthropic({ state, label, homeDir }) {
  const existing = getAnthropicCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const userDataDir = resolveAimBrowserUserDataDir({ homeDir, label });

  // Try refresh first (fast + no browser).
  if (existingRefresh) {
    try {
      const updated = await refreshAnthropicToken(existingRefresh);
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

  // Full OAuth login (opens browser, then requires a paste).
  const creds = await loginAnthropic(
    (url) => {
      process.stdout.write(`OAuth URL:\n${url}\n\n`);
      const opened = openChromeUserDataDirForUrl({ url, userDataDir });
      if (!opened.ok) {
        process.stdout.write(
          [
            `Failed to auto-open AIM browser profile (${opened.reason}).`,
            "Open the URL manually in the correct AIM-owned browser profile (user-data dir):",
            `  ${userDataDir}`,
            "",
          ].join("\n") + "\n",
        );
      }
    },
    async () => {
      const paste = await promptRequiredLine(
        'Paste the callback URL from your browser (looks like "https://console.anthropic.com/oauth/code/callback?code=...&state=..."):',
      );
      return parseAnthropicAuthorizationPaste(paste);
    },
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
  browser.owner = "aim";
  if (browser.conflictReason) {
    delete browser.conflictReason;
  }
  if (aimBrowserProfileExists({ homeDir, label })) {
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
    primaryUsedPct: clampPercent(windows[0]?.usedPercent ?? 100),
    secondaryUsedPct: clampPercent(windows[1]?.usedPercent ?? 100),
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

export function derivePoolAccountStatus({ account, credentials, browserFacts, now }) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedAccount = isObject(account) ? account : {};
  const reauth = isObject(normalizedAccount.reauth) ? normalizedAccount.reauth : {};
  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : {};
  const provider = normalizeProviderId(normalizedAccount.provider);
  const browserMode = normalizeInteractiveOAuthMode(reauth.mode);
  const blockedReason = typeof reauth.blockedReason === "string" ? reauth.blockedReason.trim() : "";
  const conflictReason = typeof browser.conflictReason === "string" ? browser.conflictReason.trim() : "";
  const expectedEmail =
    typeof normalizedAccount.expect?.email === "string" ? normalizedAccount.expect.email.trim().toLowerCase() : "";
  const browserEmail =
    typeof browserFacts?.userName === "string" ? browserFacts.userName.trim().toLowerCase() : "";

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

  if (browserMode === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE && browserFacts?.exists !== true) {
    return {
      operatorStatus: "reauth",
      detailReason: "missing_browser",
      eligible: false,
      actionRequired: "run_aim_label",
      reason: "AIM-owned browser profile is missing for this label.",
    };
  }

  if (
    browserMode === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE
    && typeof browser.seededAt === "string"
    && browser.seededAt.trim()
    && !(typeof browser.verifiedAt === "string" && browser.verifiedAt.trim())
  ) {
    return {
      operatorStatus: "reauth",
      detailReason: "seeded_unverified",
      eligible: false,
      actionRequired: "run_aim_label",
      reason: "AIM browser profile was seeded but not yet verified by a successful AIM-managed login or refresh.",
    };
  }

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

  if (browserMode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
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
    const browserFacts = readAimBrowserFacts({ homeDir, label });
    const status = derivePoolAccountStatus({
      account,
      credentials: getCodexCredential(state, label),
      browserFacts,
      now,
    });
    const usage = usageByLabel[label] ?? null;
    const usageOk = usage?.ok === true && Array.isArray(usage.windows) && usage.windows.length > 0;
    const eligible = status.eligible && usageOk;
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

export function rankPoolCandidates({ labels, usage, currentLabel, assignedCounts, now }) {
  const normalizedLabels = [...new Set((Array.isArray(labels) ? labels : []).map((label) => normalizeLabel(label)))];
  const counts = isObject(assignedCounts) ? assignedCounts : {};
  const current = typeof currentLabel === "string" ? normalizeLabel(currentLabel) : null;
  const candidates = normalizedLabels.map((label) => {
    const snapshot = usage?.[label] ?? null;
    const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
    return {
      label,
      accountId: null,
      primaryUsedPct,
      secondaryUsedPct,
      assignedCount: Number.isFinite(Number(counts[label])) ? Number(counts[label]) : 0,
      keptCurrent: false,
      reasons: [],
      observedAt: Number.isFinite(Number(now)) ? Number(now) : Date.now(),
    };
  });

  candidates.sort((a, b) => {
    if (a.primaryUsedPct !== b.primaryUsedPct) return a.primaryUsedPct - b.primaryUsedPct;
    if (a.secondaryUsedPct !== b.secondaryUsedPct) return a.secondaryUsedPct - b.secondaryUsedPct;
    if (a.assignedCount !== b.assignedCount) return a.assignedCount - b.assignedCount;
    return a.label.localeCompare(b.label);
  });

  if (current) {
    const best = candidates[0] ?? null;
    const currentCandidate = candidates.find((candidate) => candidate.label === current) ?? null;
    if (
      best
      && currentCandidate
      && currentCandidate.primaryUsedPct <= best.primaryUsedPct + 10
      && currentCandidate.secondaryUsedPct <= best.secondaryUsedPct + 10
    ) {
      currentCandidate.keptCurrent = true;
      currentCandidate.reasons.push("within_keep_current_threshold");
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

export function planOpenclawRebalance({ configuredAgents, currentAssignments, eligibleLabels, usage, now }) {
  const agentIds = [...new Set((Array.isArray(configuredAgents) ? configuredAgents : []).map((agentId) => normalizeAgentId(agentId)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const existingAssignments = isObject(currentAssignments) ? currentAssignments : {};
  const labels = [...new Set((Array.isArray(eligibleLabels) ? eligibleLabels : []).map((label) => normalizeLabel(label)))];
  const nextAssignments = {};
  const moved = [];
  const unchanged = [];
  const skipped = [];
  const assignedCounts = Object.fromEntries(labels.map((label) => [label, 0]));

  for (const agentId of agentIds) {
    if (labels.length === 0) {
      skipped.push({ agentId, reason: "no_eligible_pool_account" });
      continue;
    }

    const currentLabelRaw = typeof existingAssignments[agentId] === "string" ? existingAssignments[agentId] : null;
    const currentLabel = currentLabelRaw ? normalizeLabel(currentLabelRaw) : null;
    const rankedCandidates = rankPoolCandidates({
      labels,
      usage,
      currentLabel,
      assignedCounts,
      now,
    });
    const selection = pickNextBestPoolLabel({ rankedCandidates });
    if (!selection) {
      skipped.push({ agentId, reason: "no_eligible_pool_account" });
      continue;
    }

    nextAssignments[agentId] = selection.label;
    assignedCounts[selection.label] = (assignedCounts[selection.label] ?? 0) + 1;

    if (currentLabel === selection.label) {
      unchanged.push({ agentId, label: selection.label });
    } else {
      moved.push({ agentId, from: currentLabel ?? null, to: selection.label, reason: selection.keptCurrent ? "kept_current" : "next_best" });
    }
  }

  let status = "applied";
  if (agentIds.length === 0 || skipped.length === agentIds.length) {
    status = "blocked";
  } else if (moved.length === 0 && skipped.length === 0) {
    status = "noop";
  } else if (skipped.length > 0) {
    status = "applied_with_warnings";
  }

  return {
    assignments: nextAssignments,
    moved,
    unchanged,
    skipped,
    status,
  };
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

export function projectPoolCapacity({ history, liveUsage, horizonDays = 7, lookbackDays = 14, now }) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const cutoffMs = snapshotNow - Number(lookbackDays) * 24 * 60 * 60 * 1000;
  const events = (Array.isArray(history) ? history : []).filter((entry) => {
    if (!isObject(entry)) return false;
    const observedAtMs = parseExpiresAtToMs(entry.observedAt);
    return observedAtMs !== null && observedAtMs >= cutoffMs;
  });

  const blockedNoEligible = events.filter((entry) => entry.status === "blocked" && entry.reason === "no_eligible_pool_account").length;
  const warningReceipts = events.filter((entry) => typeof entry.status === "string" && entry.status.endsWith("_with_warnings")).length;
  const spareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === true).length;
  const noSpareExhaustions = events.filter((entry) => entry.kind === "exhaustion" && entry.hadSpareEligibleCapacity === false).length;
  const currentHighUtilizationLabels = Object.entries(isObject(liveUsage) ? liveUsage : {})
    .filter(([, snapshot]) => isUsageSnapshotExhausted(snapshot))
    .map(([label]) => label)
    .toSorted((a, b) => a.localeCompare(b));

  const needMoreAccounts = blockedNoEligible >= 1 || noSpareExhaustions >= 2;
  let riskLevel = "low";
  if (needMoreAccounts) {
    riskLevel = "high";
  } else if (spareExhaustions >= 1 || warningReceipts >= 2) {
    riskLevel = "medium";
  }

  const reasons = [];
  if (blockedNoEligible > 0) reasons.push(`${blockedNoEligible} blocked receipt(s) reported no eligible pool account.`);
  if (noSpareExhaustions > 0) reasons.push(`${noSpareExhaustions} exhaustion event(s) occurred with no spare eligible capacity.`);
  if (spareExhaustions > 0) reasons.push(`${spareExhaustions} exhaustion event(s) occurred but spare eligible capacity existed.`);
  if (warningReceipts > 0) reasons.push(`${warningReceipts} recent receipt(s) completed with warnings.`);

  return {
    needMoreAccounts,
    riskLevel,
    reasons,
    basedOn: {
      horizonDays,
      lookbackDays,
      blockedNoEligible,
      warningReceipts,
      spareExhaustions,
      noSpareExhaustions,
      currentHighUtilizationLabels,
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
  return mode ? { mode } : null;
}

async function buildStatusView({ statePath, state, homeDir }) {
  ensureStateShape(state);
  const usageByProvider = await probeUsageSnapshotsByProvider(state);
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
    const browserFacts = homeDir ? readAimBrowserFacts({ homeDir, label }) : { exists: false };
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
            ...derivePoolAccountStatus({ account, credentials: cred, browserFacts, now: Date.now() }),
            eligible: false,
            poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
          })
        : derivePoolAccountStatus({ account, credentials: cred, browserFacts, now: Date.now() });

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
        owner: "aim",
        exists: browserFacts.exists === true,
        ...(typeof account.browser?.seededFrom === "string" && account.browser.seededFrom.trim()
          ? { seededFrom: account.browser.seededFrom.trim() }
          : {}),
        ...(typeof account.browser?.seededAt === "string" && account.browser.seededAt.trim()
          ? { seededAt: account.browser.seededAt.trim() }
          : {}),
        ...(typeof account.browser?.verifiedAt === "string" && account.browser.verifiedAt.trim()
          ? { verifiedAt: account.browser.verifiedAt.trim() }
          : {}),
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
  const nextBestCandidate = pickNextBestPoolLabel({
    rankedCandidates: rankPoolCandidates({
      labels: codexPool.eligibleLabels,
      usage: usageByProvider[OPENAI_CODEX_PROVIDER],
      currentLabel: codexCli.activeLabel,
      now: Date.now(),
    }),
  });
  const capacity = projectPoolCapacity({
    history: state.pool.openaiCodex.history,
    liveUsage: usageByProvider[OPENAI_CODEX_PROVIDER],
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
  if (mode === INTERACTIVE_OAUTH_MODE_MANUAL_CALLBACK) {
    return "manual-callback";
  }
  if (mode === INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE) {
    return "aim-browser-profile";
  }
  return null;
}

function renderStatusText(view) {
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

  lines.push(`Accounts (${view.accounts.length})`);
  for (const a of view.accounts) {
    const identity =
      a.identity?.expectEmail
        ? `expectEmail:${a.identity.expectEmail}`
        : a.identity?.accountId
          ? `accountId:${a.identity.accountId}`
          : a.identity?.browserUserName
            ? `browserUser:${a.identity.browserUserName}`
            : a.identity?.browserGaiaName
              ? `browser:${a.identity.browserGaiaName}`
              : "identity:unknown";
    const login = formatInteractiveLoginSummary(a.login);
    const expires = a.credentials?.expiresIn ? `expires=${a.credentials.expiresIn}` : "expires=unknown";
    const usage =
      a.provider === OPENAI_CODEX_PROVIDER
        ? `usage=${formatCodexUsageSummary(a.usage)}`
        : a.provider === ANTHROPIC_PROVIDER
          ? `usage=${formatClaudeUsageSummary(a.usage)}`
          : "usage=n/a";
    const operatorBits = [
      `${a.operator?.status || "unknown"}`,
      a.operator?.detailReason ? `detail=${a.operator.detailReason}` : null,
      a.operator?.actionRequired ? `action=${a.operator.actionRequired}` : null,
    ].filter(Boolean);
    lines.push(`- ${operatorBits.join(" ")} ${a.provider} ${a.label}${login ? ` login=${login}` : ""} ${identity} ${expires} ${usage}`);
  }

  const assignments = isObject(view.openclaw?.assignments) ? view.openclaw.assignments : {};
  const assignmentEntries = Object.entries(assignments);
  if (assignmentEntries.length > 0) {
    lines.push("");
    lines.push("OpenClaw assignments");
    for (const [agentId, label] of assignmentEntries.toSorted((x, y) => x[0].localeCompare(y[0]))) {
      lines.push(`- ${agentId} -> ${label}`);
    }
  }

  if (view.openclaw?.lastApplyReceipt?.status) {
    lines.push("");
    lines.push(
      `Last rebalance: status=${view.openclaw.lastApplyReceipt.status} observed=${view.openclaw.lastApplyReceipt.observedAt || "unknown"}`,
    );
  }

  if (view.codexCli) {
    lines.push("");
    lines.push("Codex target");
    const targetBits = [
      `home=${view.codexCli.homeDir}`,
      `store=${view.codexCli.storeMode || "unknown"}`,
      `active=${view.codexCli.activeLabel || "none"}`,
    ];
    if (typeof view.codexCli.actualAccountId === "string" && view.codexCli.actualAccountId.trim()) {
      targetBits.push(`accountId=${view.codexCli.actualAccountId.trim()}`);
    }
    if (typeof view.codexCli.importedAt === "string" && view.codexCli.importedAt.trim()) {
      targetBits.push(`synced=${formatAgeSince(view.codexCli.importedAt.trim())}`);
    }
    lines.push(`- ${targetBits.join(" ")}`);
  }

  if (view.nextBestCandidate?.label) {
    lines.push("");
    lines.push(
      `Next best Codex label: ${view.nextBestCandidate.label} ` +
        `(primary=${view.nextBestCandidate.primaryUsedPct}% secondary=${view.nextBestCandidate.secondaryUsedPct}%)`,
    );
  }

  if (view.capacity) {
    lines.push("");
    lines.push(
      `Capacity: needMoreAccounts=${view.capacity.needMoreAccounts ? "yes" : "no"} risk=${view.capacity.riskLevel}`,
    );
  }

  lines.push("");
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  lines.push(`Warnings (${warnings.length})`);
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

  return `${lines.join("\n")}\n`;
}

function applyOpenclawFromState(params, state, { pinsOverride } = {}) {
  const homeDir = resolveHomeDir(params.home);
  ensureStateShape(state);

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const supportedProviders = [OPENAI_CODEX_PROVIDER, ANTHROPIC_PROVIDER];
  const supportedProviderSet = new Set(supportedProviders);
  const assignments = isObject(pinsOverride) ? pinsOverride : getOpenclawPins(state);
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
  const desiredProfileIdsByProvider = new Map(supportedProviders.map((provider) => [provider, []]));

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
      desiredProfileIdsByProvider.get(provider).push(profileId);
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
  for (const provider of supportedProviders) {
    const ids = desiredProfileIdsByProvider.get(provider);
    if (ids && ids.length > 0) {
      nextMain.order[provider] = ids.toSorted((a, b) => a.localeCompare(b));
    } else if (Object.hasOwn(nextMain.order, provider)) {
      delete nextMain.order[provider];
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
    ...Array.from(assignedLabelByAgentId.keys()),
  ]);
  for (const agentId of Array.from(allAgentIds).toSorted((a, b) => a.localeCompare(b))) {
    if (agentId === "main") continue;
    const assignedLabel = assignedLabelByAgentId.get(agentId) ?? null;
    const account = assignedLabel ? accounts[assignedLabel] : null;
    const provider = assignedLabel ? normalizeProviderId(account?.provider) : null;
    const profileId = assignedLabel ? resolveOpenclawProfileIdForProviderLabel(provider, assignedLabel) : null;

    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath);
    if (!existing && !assignedLabel) {
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
      if (Object.hasOwn(next.order, managedProvider)) {
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
  let activePins = getOpenclawPins(state);
  let stalePinWarnings = [];

  if (!params.home) {
    agentsList = readOpenclawAgentsListFromConfig();
    const partition = partitionOpenclawPinsByConfiguredAgents({
      pinsByAgentId: getOpenclawPins(state),
      agentsList,
    });
    activePins = partition.activePins;
    stalePinWarnings = partition.stalePins.map(({ agentId, label }) => ({
      kind: "pin_points_to_missing_config_agent",
      system: "openclaw",
      agentId,
      label,
    }));
  }

  const auth = applyOpenclawFromState(params, state, { pinsOverride: activePins });

  // Config/model sync is intentionally skipped in sandbox mode to keep `--home`
  // as a safe dev/test escape hatch (and to avoid requiring `openclaw` in CI).
  if (params.home) {
    return {
      auth,
      models: { skipped: true, reason: "home_override" },
      sessions: { skipped: true, reason: "home_override" },
      warnings: stalePinWarnings,
    };
  }

  const pins = activePins;
  const pinnedAgentIds = Object.keys(pins);
  if (pinnedAgentIds.length === 0) {
    return {
      auth,
      models: { skipped: true, reason: "no_pins" },
      sessions: { skipped: true, reason: "no_pins" },
      warnings: stalePinWarnings,
    };
  }

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const desiredModelRefByAgentId = {};
  for (const [agentIdRaw, labelRaw] of Object.entries(pins)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const account = accounts[label];
    if (!isObject(account)) {
      throw new Error(`Pin references missing account: agent=${agentId} label=${label}`);
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
    throw new Error(`Pin references unsupported provider: agent=${agentId} label=${label} provider=${provider}`);
  }

  const ops = buildOpenclawModelSyncOps({ agentsList, pinnedAgentIds, modelRefByAgentId: desiredModelRefByAgentId });
  const applied = applyOpenclawModelSyncOps(ops);

  const homeDir = resolveHomeDir(params.home);
  const perAgentScan = [];
  const patchOps = [];
  const desiredSessionByAgentId = {};

  for (const agentIdRaw of pinnedAgentIds) {
    const agentId = normalizeAgentId(agentIdRaw);
    const desiredModelRef = typeof desiredModelRefByAgentId[agentId] === "string" ? desiredModelRefByAgentId[agentId] : "";
    if (!desiredModelRef) {
      throw new Error(`Missing desired modelRef for pinned agent: ${agentId}`);
    }
    const parsedDesired = parseProviderModelRef(desiredModelRef);
    if (!parsedDesired?.provider || !parsedDesired?.model) {
      throw new Error(`Invalid desired model ref for agent=${agentId}: ${desiredModelRef}`);
    }
    desiredSessionByAgentId[agentId] = { ...parsedDesired, modelRef: desiredModelRef };

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
      desiredProvider: parsedDesired.provider,
      desiredModel: parsedDesired.model,
    });

    perAgentScan.push({
      agentId,
      storePath,
      exists: true,
      sessionsTotal: Object.keys(existing).length,
      sessionsWouldChange: keys.length,
    });

    for (const key of keys) {
      patchOps.push({ key, modelRef: desiredModelRef, agentId });
    }
  }

  if (patchOps.length === 0) {
    return {
      auth,
      models: { desiredByAgentId: desiredModelRefByAgentId, ops: applied },
      sessions: { skipped: true, reason: "no_session_changes_needed" },
      warnings: stalePinWarnings,
    };
  }

  const gatewayProbe = probeOpenclawGateway({ timeoutMs: 4000 });
  let gateway = { attempted: false };
  if (gatewayProbe.ok) {
    gateway.attempted = true;
    const patched = await applySessionsModelViaGatewayOps({ ops: patchOps, timeoutMs: 20000 });
    gateway = {
      attempted: true,
      ok: patched.ok,
      failures: patched.failures.slice(0, 10),
      failuresCount: patched.failures.length,
    };
  } else {
    gateway = { attempted: false, ok: false, reason: gatewayProbe.reason, stderr: gatewayProbe.stderr };
  }

  // Always patch disk as a persistent fallback (and to make sure the on-disk store matches reality).
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
    });
    perAgentDisk.push({ agentId, ...result });
    if (result.sessionsChanged > 0) {
      filesChanged += 1;
      sessionsChanged += result.sessionsChanged;
    }
  }

  return {
    auth,
    models: { desiredByAgentId: desiredModelRefByAgentId, ops: applied },
    sessions: {
      mode: gatewayProbe.ok ? "gateway+disk" : "disk",
      gateway,
      filesChanged,
      sessionsChanged,
      sessionsWouldChange: patchOps.length,
      perAgent: perAgentDisk.filter((p) => p.sessionsWouldChange > 0),
    },
    warnings: stalePinWarnings,
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
    const receipt = {
      action: "codex_use",
      status: "blocked",
      observedAt,
      previousLabel: typeof target.activeLabel === "string" ? target.activeLabel.trim() || undefined : undefined,
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
  const rankedCandidates = rankPoolCandidates({
    labels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    currentLabel: currentTarget.activeLabel,
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
  const configuredAgents = discoverConfiguredOpenclawCodexAgents({
    agentsList,
    exclusions: getOpenclawExclusions(state),
  });
  const plan = planOpenclawRebalance({
    configuredAgents,
    currentAssignments: getOpenclawAssignments(state),
    eligibleLabels: poolStatus.eligibleLabels,
    usage: usageByLabel,
    now: Date.parse(observedAt),
  });

  target.lastRebalancedAt = observedAt;

  if (plan.status === "blocked") {
    const receipt = {
      action: "rebalance_openclaw",
      status: "blocked",
      observedAt,
      cleanupMode: null,
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      moved: [],
      unchanged: [],
      skipped: plan.skipped,
      warnings: [],
      blockers: [{ reason: "no_eligible_pool_account" }],
    };
    target.lastApplyReceipt = receipt;
    appendOpenaiCodexHistory(state, [
      {
        observedAt,
        kind: "rebalance",
        status: "blocked",
        reason: "no_eligible_pool_account",
        hadSpareEligibleCapacity: false,
      },
    ]);
    return { status: "blocked", receipt };
  }

  target.assignments = plan.assignments;
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
    cleanupMode:
      typeof synced.sessions?.mode === "string"
        ? synced.sessions.mode
        : typeof synced.sessions?.reason === "string"
          ? synced.sessions.reason
          : null,
    assignments: sanitizeForStatus(plan.assignments),
    moved: plan.moved,
    unchanged: plan.unchanged,
    skipped: plan.skipped,
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
      reason: status === "noop" ? "unchanged_assignments" : "rebalanced",
    },
  ]);

  return { status, receipt, synced };
}

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const knownCmds = new Set(["status", "login", "pin", "autopin", "rebalance", "apply", "sync", "codex"]);
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
    process.stdout.write(renderStatusText(view));
    return;
  }

  if (cmd === "login") {
    const label = normalizeLabel(shorthandLabel ?? positional[1]);
    const state = loadAimgrState(statePath);
    ensureStateShape(state);

    const provider = await ensureProviderConfiguredForLabel({ state, label });
    const attemptedAt = recordAccountMaintenanceAttempt(state, label);

    try {
      if (provider === OPENAI_CODEX_PROVIDER) {
        const interactiveBinding = await ensureOpenAICodexInteractiveLoginBinding({ state, label, homeDir });
        const cred = await refreshOrLoginCodex({ state, label, homeDir, interactiveBinding });
        state.credentials[OPENAI_CODEX_PROVIDER][label] = cred;
      } else if (provider === ANTHROPIC_PROVIDER) {
        await ensureAimBrowserProfileBinding({ state, label, homeDir });
        const cred = await refreshOrLoginAnthropic({ state, label, homeDir });
        state.credentials[ANTHROPIC_PROVIDER][label] = cred;
      } else {
        throw new Error(`Provider not supported: ${provider}`);
      }

      recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
      state.schemaVersion = SCHEMA_VERSION;
      writeJsonFileWithBackup(statePath, state);
      process.stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            label,
            provider,
            maintenance: {
              status: "ready",
              observedAt: attemptedAt,
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
        ...(message.match(/conflict|does not match|unsupported/i) ? { blockedReason: message } : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
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
      const imported = importCodexFromAuthority({ from: opts.from, state });
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
