import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { loginAnthropic, loginOpenAICodex, refreshAnthropicToken, refreshOpenAICodexToken } from "@mariozechner/pi-ai";

const SCHEMA_VERSION = "0.1";
const OPENAI_CODEX_PROVIDER = "openai-codex";
const ANTHROPIC_PROVIDER = "anthropic";
const OPENCLAW_ENFORCED_CODEX_MODEL = "openai-codex/gpt-5.2";
const OPENCLAW_ENFORCED_ANTHROPIC_MODEL = "anthropic/claude-opus-4-6";

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
  const reserved = new Set(["status", "login", "pin", "autopin", "apply", "sync", "help"]);
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
    "  aim <label>            # shorthand for: aim login <label> (also auto-pins agent_<label> if present)",
    "  aim pin <openclaw_agent_id> <label>   # rare: manual override / non-standard mapping",
    "  aim autopin openclaw [--pool boss,lessons,...]  # pin all unpinned OpenClaw agents evenly across labels",
    "  aim apply             # sync OpenClaw derived state from ~/.aimgr/secrets.json",
    "  aim sync openclaw     # explicit alias for apply",
    "",
    "Notes:",
    "  - SSOT file: ~/.aimgr/secrets.json (auto-backed-up on every write).",
    "  - V0 supports: openai-codex (ChatGPT/Codex OAuth) + anthropic (Claude Pro/Max OAuth) on macOS.",
    "  - OAuth runs inside OpenClaw browser profiles under ~/.openclaw/browser/*/user-data.",
    "",
    "Developer options (rare):",
    "  --home <dir>    Run against an alternate HOME (dev/test; e.g. /tmp/aimgr-home).",
    "  --state <path>  Override SSOT file path (default: <home>/.aimgr/secrets.json).",
    "",
  ];
  process.stdout.write(`${lines.join("\n")}\n`);
}

function parseCsvList(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

function resolveAutopinPoolLabels({ state, poolArg }) {
  ensureStateShape(state);
  const explicit = parseCsvList(poolArg);
  if (explicit.length > 0) {
    return explicit.map((label) => normalizeLabel(label));
  }

  const reserved = new Set(["coder", "coder2", "growth"]);
  const discovered = [];
  for (const [labelRaw, account] of Object.entries(state.accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider ?? OPENAI_CODEX_PROVIDER);
    if (provider !== OPENAI_CODEX_PROVIDER) continue;
    const label = normalizeLabel(labelRaw);
    if (reserved.has(label)) continue;
    discovered.push(label);
  }

  return discovered.toSorted((a, b) => a.localeCompare(b));
}

export function planEvenLabelAssignments({ candidateAgentIds, existingPinsByAgentId, poolLabels }) {
  const agents = Array.isArray(candidateAgentIds) ? candidateAgentIds : [];
  const pins = isObject(existingPinsByAgentId) ? existingPinsByAgentId : {};
  const pool = Array.isArray(poolLabels) ? poolLabels : [];

  const normalizedPool = [...new Set(pool.map((label) => normalizeLabel(label)))];
  if (normalizedPool.length === 0) {
    throw new Error("autopin requires a non-empty pool of labels.");
  }

  const counts = new Map(normalizedPool.map((label) => [label, 0]));
  for (const labelRaw of Object.values(pins)) {
    if (typeof labelRaw !== "string") continue;
    let label;
    try {
      label = normalizeLabel(labelRaw);
    } catch {
      continue;
    }
    if (!counts.has(label)) continue;
    counts.set(label, counts.get(label) + 1);
  }

  const uniqueCandidates = [...new Set(agents.map((id) => normalizeAgentId(id)))].toSorted((a, b) =>
    a.localeCompare(b),
  );
  const assignments = {};

  const pickLeastUsedLabel = () => {
    let bestLabel = normalizedPool[0];
    let bestCount = counts.get(bestLabel);
    for (let i = 1; i < normalizedPool.length; i += 1) {
      const label = normalizedPool[i];
      const count = counts.get(label);
      if (count < bestCount) {
        bestLabel = label;
        bestCount = count;
      }
    }
    return bestLabel;
  };

  for (const agentId of uniqueCandidates) {
    if (Object.hasOwn(pins, agentId)) continue;
    const label = pickLeastUsedLabel();
    assignments[agentId] = label;
    counts.set(label, counts.get(label) + 1);
  }

  return { assignments, poolLabels: normalizedPool };
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

function resolveOpenclawAuthStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
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

function createEmptyState() {
  return {
    schemaVersion: SCHEMA_VERSION,
    accounts: {},
    pins: { openclaw: {} },
    credentials: {},
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
  migrated.pins.openclaw = isObject(migrated.pins.openclaw) ? migrated.pins.openclaw : {};
  for (const [agentId, profileId] of Object.entries(legacyPins)) {
    if (typeof profileId !== "string") continue;
    const parts = profileId.split(":");
    if (parts.length < 2) continue;
    const suffix = parts.slice(1).join(":");
    try {
      migrated.pins.openclaw[agentId] = normalizeLabel(suffix);
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
  if (!isObject(raw)) {
    throw new Error(`aimgr state must be a JSON object: ${statePath}`);
  }

  // Current SSOT shape (schemaVersion present) — keep unknown keys, but ensure we have the basics.
  if (typeof raw.schemaVersion === "string") {
    const state = structuredClone(raw);
    state.schemaVersion = String(state.schemaVersion || SCHEMA_VERSION);
    state.accounts = isObject(state.accounts) ? state.accounts : {};
    state.pins = isObject(state.pins) ? state.pins : { openclaw: {} };
    state.pins.openclaw = isObject(state.pins.openclaw) ? state.pins.openclaw : {};
    state.credentials = isObject(state.credentials) ? state.credentials : {};
    return state;
  }

  // Legacy shape — migrate in-memory (write happens on next mutation).
  return normalizeLegacyStateV0(raw);
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
  state.accounts = isObject(state.accounts) ? state.accounts : {};
  state.pins = isObject(state.pins) ? state.pins : { openclaw: {} };
  state.pins.openclaw = isObject(state.pins.openclaw) ? state.pins.openclaw : {};
  state.credentials = isObject(state.credentials) ? state.credentials : {};
  state.credentials[OPENAI_CODEX_PROVIDER] = isObject(state.credentials[OPENAI_CODEX_PROVIDER])
    ? state.credentials[OPENAI_CODEX_PROVIDER]
    : {};
  state.credentials[ANTHROPIC_PROVIDER] = isObject(state.credentials[ANTHROPIC_PROVIDER])
    ? state.credentials[ANTHROPIC_PROVIDER]
    : {};
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

async function ensureCodexAccountConfig({ state, label, homeDir }) {
  ensureStateShape(state);
  const existing = state.accounts[label];
  if (existing && !isObject(existing)) {
    throw new Error(`accounts.${label} must be an object (got ${typeof existing})`);
  }

  const providerRaw = typeof existing?.provider === "string" ? existing.provider.trim() : "";
  const provider = normalizeProviderId(providerRaw || OPENAI_CODEX_PROVIDER);
  if (!SUPPORTED_OAUTH_PROVIDERS.has(provider)) {
    throw new Error(
      `accounts.${label}.provider=${providerRaw || "(missing)"} is not supported. ` +
        `Supported: ${Array.from(SUPPORTED_OAUTH_PROVIDERS.keys()).join(", ")}`,
    );
  }

  const openclawBrowserProfile =
    typeof existing?.openclawBrowserProfile === "string" ? existing.openclawBrowserProfile.trim() : "";

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  if (
    openclawBrowserProfile &&
    openclawBrowserProfileExists({ openclawStateDir, profileId: openclawBrowserProfile })
  ) {
    state.accounts[label] = {
      ...(existing ? existing : {}),
      provider,
      openclawBrowserProfile,
    };
    delete state.accounts[label].chromeProfileDirectory;
    return openclawBrowserProfile;
  }

  if (openclawBrowserProfile) {
    process.stdout.write(
      `Stored OpenClaw browser profile "${openclawBrowserProfile}" for label "${label}" not found under:\n` +
        `  ${path.join(openclawStateDir, "browser")}\n` +
        "Pick a valid OpenClaw browser profile so we don't silently create a fresh browser identity.\n\n",
    );
  }

  if (!fs.existsSync(openclawStateDir)) {
    throw new Error(
      "OpenClaw state directory not found. " +
        `Expected: ${openclawStateDir}. ` +
        "Run OpenClaw once (or set up its state dir), then retry.",
    );
  }

  const profiles = discoverOpenclawBrowserProfiles({ openclawStateDir });
  if (profiles.length > 0) {
    process.stdout.write(`OpenClaw browser profiles found (from ${path.join(openclawStateDir, "browser")}):\n`);
    profiles.forEach((profile, idx) => {
      process.stdout.write(`  ${idx + 1}) ${formatOpenclawBrowserProfileChoice(profile)}\n`);
    });
    process.stdout.write("\n");

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const answer = await promptRequiredLine(
        `Pick OpenClaw browser profile for label "${label}" (number 1-${profiles.length}, or type the profile id):`,
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

      state.accounts[label] = {
        ...(existing ? existing : {}),
        provider,
        openclawBrowserProfile: profileId,
      };
      delete state.accounts[label].chromeProfileDirectory;
      return profileId;
    }
  }

  if (profiles.length === 0) {
    throw new Error(
      "No OpenClaw browser profiles discovered on this host. " +
        `Expected at least one profile under: ${path.join(openclawStateDir, "browser")}. ` +
        "Start OpenClaw browser management to create profiles, then retry.",
    );
  }

  // Unreachable: either we select from discovered profiles or we throw.
}

async function refreshOrLoginCodex({ state, label, homeDir, openclawBrowserProfile }) {
  const existing = getCodexCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const existingAccountId = existing && typeof existing.accountId === "string" ? existing.accountId : null;

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const userDataDir = resolveOpenclawBrowserUserDataDir({
    openclawStateDir,
    profileId: openclawBrowserProfile,
  });

  // Try refresh first (fast + no browser).
  if (existingRefresh) {
    try {
      const updated = await refreshOpenAICodexToken(existingRefresh);
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
      };
    } catch (err) {
      process.stdout.write(`Refresh failed for ${label}; falling back to OAuth login (${String(err?.message ?? err)}).\n`);
    }
  }

  // Full OAuth login (opens browser).
  const creds = await loginOpenAICodex({
    onAuth: ({ url }) => {
      process.stdout.write(`OAuth URL:\n${url}\n\n`);
      const opened = openChromeUserDataDirForUrl({ url, userDataDir });
      if (!opened.ok) {
        process.stdout.write(
          [
            `Failed to auto-open OpenClaw browser profile (${opened.reason}).`,
            `Open the URL manually in the correct OpenClaw browser profile (user-data dir):`,
            `  ${userDataDir}`,
            "",
          ].join("\n") + "\n",
        );
      }
    },
    onPrompt: async () => {
      throw new Error(
        "Manual redirect-url paste flow is not supported in aimgr v0. " +
          "Run on the Mac host with a real browser so the localhost callback can complete.",
      );
    },
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
  };
}

async function refreshOrLoginAnthropic({ state, label, homeDir, openclawBrowserProfile }) {
  const existing = getAnthropicCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;

  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const userDataDir = resolveOpenclawBrowserUserDataDir({
    openclawStateDir,
    profileId: openclawBrowserProfile,
  });

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
            `Failed to auto-open OpenClaw browser profile (${opened.reason}).`,
            `Open the URL manually in the correct OpenClaw browser profile (user-data dir):`,
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

function formatCodexUsageSummary(snapshot) {
  if (!snapshot) return "unknown";
  if (snapshot.ok !== true) {
    if (snapshot.tokenExpired) return "expired";
    if (snapshot.status) return `error:${snapshot.status}`;
    return "error";
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  if (windows.length === 0) return "ok";
  return windows.map((w) => `${w.label} ${Math.round(w.usedPercent)}%`).join(" · ");
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
    const openclawBrowserProfile =
      typeof account.openclawBrowserProfile === "string" ? account.openclawBrowserProfile.trim() : "";
    if (!openclawBrowserProfile) {
      warnings.push({ kind: "missing_openclaw_browser_profile", provider: provider || "unknown", label });
    }
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

  // Pins pointing to missing labels/creds
  const pins = isObject(state.pins?.openclaw) ? state.pins.openclaw : {};
  for (const [agentId, label] of Object.entries(pins)) {
    if (typeof label !== "string") continue;
    if (!isObject(accounts[label])) {
      warnings.push({ kind: "pin_points_to_missing_account", system: "openclaw", agentId, label });
      continue;
    }
    const provider = normalizeProviderId(accounts[label]?.provider);
    if (provider === OPENAI_CODEX_PROVIDER) {
      if (!isObject(codexCredsByLabel[label])) {
        warnings.push({ kind: "pin_points_to_missing_credentials", system: "openclaw", agentId, label });
      }
      continue;
    }
    if (provider === ANTHROPIC_PROVIDER) {
      if (!isObject(anthropicCredsByLabel[label])) {
        warnings.push({
          kind: "pin_points_to_missing_credentials",
          system: "openclaw",
          agentId,
          label,
          provider,
        });
      }
      continue;
    }

    warnings.push({ kind: "pin_points_to_unsupported_provider", system: "openclaw", agentId, label, provider });
  }

  return warnings;
}

async function buildStatusView({ statePath, state }) {
  ensureStateShape(state);

  const accounts = [];
  const usageByLabel = {};

  // Probe usage by default (fail-loud-but-not-fake: unknown if fetch fails).
  const codexCredsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  const anthropicCredsByLabel = state.credentials[ANTHROPIC_PROVIDER];
  const probes = Object.entries(codexCredsByLabel)
    .filter(([, cred]) => isObject(cred) && typeof cred.access === "string")
    .map(async ([label, cred]) => {
      const accessToken = cred.access;
      const accountId = typeof cred.accountId === "string" ? cred.accountId : null;
      try {
        usageByLabel[label] = await fetchCodexUsageSnapshot({ accessToken, accountId, timeoutMs: 8000 });
      } catch (err) {
        usageByLabel[label] = {
          provider: OPENAI_CODEX_PROVIDER,
          ok: false,
          status: "error",
          error: String(err?.message ?? err),
        };
      }
    });

  await Promise.all(probes);

  for (const [label, account] of Object.entries(state.accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    const expectEmail = typeof account.expect?.email === "string" ? account.expect.email : null;
    const openclawBrowserProfile =
      typeof account.openclawBrowserProfile === "string" ? account.openclawBrowserProfile.trim() : "";
    const browser = openclawBrowserProfile ? { openclawBrowserProfile } : undefined;

    if (provider === OPENAI_CODEX_PROVIDER) {
      const cred = isObject(codexCredsByLabel[label]) ? codexCredsByLabel[label] : null;
      const accountId = cred && typeof cred.accountId === "string" ? cred.accountId : null;
      const expiresAt = cred && typeof cred.expiresAt === "string" ? cred.expiresAt : null;
      accounts.push({
        label,
        provider,
        ...(browser ? { browser } : {}),
        identity: {
          ...(expectEmail ? { expectEmail } : {}),
          ...(accountId ? { accountId } : {}),
        },
        credentials: {
          status: cred ? "ok" : "missing",
          ...(expiresAt ? { expiresAt } : {}),
          ...(expiresAt ? { expiresIn: formatExpiresIn(expiresAt) } : {}),
        },
        usage: usageByLabel[label] ?? { provider, ok: false, status: "unknown" },
      });
      continue;
    }

    if (provider === ANTHROPIC_PROVIDER) {
      const cred = isObject(anthropicCredsByLabel[label]) ? anthropicCredsByLabel[label] : null;
      const expiresAt = cred && typeof cred.expiresAt === "string" ? cred.expiresAt : null;
      accounts.push({
        label,
        provider,
        ...(browser ? { browser } : {}),
        identity: { ...(expectEmail ? { expectEmail } : {}) },
        credentials: {
          status: cred ? "ok" : "missing",
          ...(expiresAt ? { expiresAt } : {}),
          ...(expiresAt ? { expiresIn: formatExpiresIn(expiresAt) } : {}),
        },
        usage: { ok: false, status: "n/a" },
      });
      continue;
    }

    accounts.push({
      label,
      provider: provider || "unknown",
      ...(browser ? { browser } : {}),
      identity: { ...(expectEmail ? { expectEmail } : {}) },
      credentials: { status: "unknown" },
      usage: { ok: false, status: "n/a" },
    });
  }

  const pins = isObject(state.pins?.openclaw) ? state.pins.openclaw : {};

  return {
    generatedAt: new Date().toISOString(),
    statePath,
    accounts: accounts.toSorted((a, b) => a.label.localeCompare(b.label)),
    pins: { openclaw: sanitizeForStatus(pins) },
    warnings: buildWarningsFromState(state),
  };
}

function renderStatusText(view) {
  const lines = [];
  lines.push(`aim SSOT: ${view.statePath}`);
  lines.push("");

  lines.push(`Accounts (${view.accounts.length})`);
  for (const a of view.accounts) {
    const identity =
      a.identity?.expectEmail
        ? `expectEmail:${a.identity.expectEmail}`
        : a.identity?.accountId
          ? `accountId:${a.identity.accountId}`
          : "identity:unknown";
    const browser =
      typeof a.browser?.openclawBrowserProfile === "string" && a.browser.openclawBrowserProfile.trim()
        ? `browser=${a.browser.openclawBrowserProfile.trim()}`
        : null;
    const expires = a.credentials?.expiresIn ? `expires=${a.credentials.expiresIn}` : "expires=unknown";
    const usage = a.provider === OPENAI_CODEX_PROVIDER ? `usage=${formatCodexUsageSummary(a.usage)}` : "usage=n/a";
    lines.push(`- ${a.provider} ${a.label} ${identity} ${expires} ${usage}${browser ? ` ${browser}` : ""}`);
  }

  const pins = isObject(view.pins?.openclaw) ? view.pins.openclaw : {};
  const pinEntries = Object.entries(pins);
  if (pinEntries.length > 0) {
    lines.push("");
    lines.push("OpenClaw pins");
    for (const [agentId, label] of pinEntries.toSorted((x, y) => x[0].localeCompare(y[0]))) {
      lines.push(`- ${agentId} -> ${label}`);
    }
  }

  lines.push("");
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  lines.push(`Warnings (${warnings.length})`);
  for (const w of warnings.slice(0, 50)) {
    const parts = [`- ${w.kind}`];
    if (w.label) parts.push(`label=${w.label}`);
    if (w.agentId) parts.push(`agent=${w.agentId}`);
    if (w.accountId) parts.push(`accountId=${w.accountId}`);
    lines.push(parts.join(" "));
  }

  return `${lines.join("\n")}\n`;
}

function applyOpenclawFromState(params, state) {
  const homeDir = resolveHomeDir(params.home);
  ensureStateShape(state);

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const supportedProviders = [OPENAI_CODEX_PROVIDER, ANTHROPIC_PROVIDER];
  const supportedProviderSet = new Set(supportedProviders);

  const managedLabelsByProvider = new Map(supportedProviders.map((provider) => [provider, []]));
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    if (!supportedProviderSet.has(provider)) continue;
    const credsByLabel = state.credentials[provider];
    if (!isObject(credsByLabel?.[label])) continue;
    managedLabelsByProvider.get(provider).push(label);
  }

  const totalManaged = Array.from(managedLabelsByProvider.values()).reduce((sum, labels) => sum + labels.length, 0);
  if (totalManaged === 0) {
    throw new Error(
      "No managed accounts with credentials found in SSOT. " +
        "Run `aim <label>` (or `aim login <label>`) to login at least one account first.",
    );
  }

  // Build desired OpenClaw oauth credential records.
  const desiredProfiles = {};
  const desiredProfileIdsByProvider = new Map(supportedProviders.map((provider) => [provider, []]));

  for (const provider of supportedProviders) {
    const labels = managedLabelsByProvider.get(provider).toSorted((a, b) => a.localeCompare(b));
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

  // Main store: replace all managed-provider profiles with managed profiles.
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

  writeJsonFileWithBackup(mainStorePath, nextMain);

  // Per-agent pins: order override only (profiles inherited from main).
  const pins = isObject(state.pins?.openclaw) ? state.pins.openclaw : {};
  const wrote = [mainStorePath];
  for (const [agentIdRaw, labelRaw] of Object.entries(pins)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const account = accounts[label];
    if (!isObject(account)) {
      throw new Error(`Pin references missing account: agent=${agentId} label=${label}`);
    }
    const provider = normalizeProviderId(account.provider);
    if (!supportedProviderSet.has(provider)) {
      throw new Error(`Pin references unsupported provider: agent=${agentId} label=${label} provider=${provider}`);
    }
    const credsByLabel = state.credentials[provider];
    if (!isObject(credsByLabel?.[label])) {
      throw new Error(`Pin references label with missing credentials: agent=${agentId} label=${label} provider=${provider}`);
    }
    const profileId = resolveOpenclawProfileIdForProviderLabel(provider, label);

    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath) ?? { version: 1, profiles: {} };
    if (!isObject(existing) || !isObject(existing.profiles)) {
      throw new Error(`OpenClaw auth store is missing profiles object: ${storePath}`);
    }
    const next = structuredClone(existing);
    next.version = Number(next.version ?? 1);
    next.profiles = isObject(next.profiles) ? next.profiles : {};

    // Remove any local profiles for this provider to prevent drift/collisions.
    for (const [pid, c] of Object.entries(next.profiles)) {
      if (!isObject(c)) continue;
      if (normalizeProviderId(c.provider) !== provider) continue;
      delete next.profiles[pid];
    }

    next.order = isObject(next.order) ? next.order : {};
    next.order[provider] = [profileId];
    next.lastGood = isObject(next.lastGood) ? next.lastGood : {};
    next.lastGood[provider] = profileId;

    writeJsonFileWithBackup(storePath, next);
    wrote.push(storePath);
  }

  return { wrote };
}

async function syncOpenclawFromState(params, state) {
  const auth = applyOpenclawFromState(params, state);

  // Config/model sync is intentionally skipped in sandbox mode to keep `--home`
  // as a safe dev/test escape hatch (and to avoid requiring `openclaw` in CI).
  if (params.home) {
    return { auth, models: { skipped: true, reason: "home_override" }, sessions: { skipped: true, reason: "home_override" } };
  }

  const pins = isObject(state.pins?.openclaw) ? state.pins.openclaw : {};
  const pinnedAgentIds = Object.keys(pins);
  if (pinnedAgentIds.length === 0) {
    return { auth, models: { skipped: true, reason: "no_pins" }, sessions: { skipped: true, reason: "no_pins" } };
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

  const agentsList = readOpenclawAgentsListFromConfig();
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
  };
}

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const knownCmds = new Set(["status", "login", "pin", "autopin", "apply", "sync"]);
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
    const view = await buildStatusView({ statePath, state });
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
    const openclawBrowserProfile = await ensureCodexAccountConfig({ state, label, homeDir });

    if (provider === OPENAI_CODEX_PROVIDER) {
      const cred = await refreshOrLoginCodex({ state, label, homeDir, openclawBrowserProfile });
      state.credentials[OPENAI_CODEX_PROVIDER][label] = cred;
    } else if (provider === ANTHROPIC_PROVIDER) {
      const cred = await refreshOrLoginAnthropic({ state, label, homeDir, openclawBrowserProfile });
      state.credentials[ANTHROPIC_PROVIDER][label] = cred;
    } else {
      throw new Error(`Provider not supported: ${provider}`);
    }

    // Auto-pin: eliminate the common "second step" by pinning agent_<label> -> <label>
    // (only if that OpenClaw agent exists on disk).
    const openclawStateDir = resolveOpenclawStateDir({ homeDir });
    const inferredAgentId = inferOpenclawAgentIdForLabel({ openclawStateDir, label });
    if (inferredAgentId) {
      state.pins.openclaw[inferredAgentId] = label;
    }

    state.schemaVersion = SCHEMA_VERSION;

    writeJsonFileWithBackup(statePath, state);

    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, label, provider, synced }), null, 2)}\n`);
    return;
  }

  if (cmd === "pin") {
    const agentId = normalizeAgentId(positional[1]);
    const label = normalizeLabel(positional[2]);
    const state = loadAimgrState(statePath);
    ensureStateShape(state);
    if (!isObject(state.accounts[label])) {
      throw new Error(`Unknown label: ${label}. Add it by running \`aim login ${label}\` first.`);
    }
    const provider = normalizeProviderId(state.accounts[label]?.provider);
    if (provider !== OPENAI_CODEX_PROVIDER && provider !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing to pin OpenClaw agent to unsupported provider=${provider || "unknown"} label=${label}.`);
    }
    state.pins.openclaw[agentId] = label;
    state.schemaVersion = SCHEMA_VERSION;
    writeJsonFileWithBackup(statePath, state);

    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(
      `${JSON.stringify(sanitizeForStatus({ ok: true, pin: { agentId, label }, synced }), null, 2)}\n`,
    );
    return;
  }

  if (cmd === "autopin") {
    const system = String(positional[1] ?? "").trim().toLowerCase();
    if (!system) {
      throw new Error('Missing autopin target. Usage: aim autopin openclaw [--pool boss,lessons,...]');
    }
    if (system !== "openclaw") {
      throw new Error(`Unsupported autopin target: ${system} (only "openclaw" is supported in v0).`);
    }

    const state = loadAimgrState(statePath);
    ensureStateShape(state);

    const poolLabels = resolveAutopinPoolLabels({ state, poolArg: opts.pool });
    if (poolLabels.length === 0) {
      throw new Error(
        "No pool labels available for autopin. " +
          "Either pass --pool boss,lessons,... or login additional labels via `aim <label>` first.",
      );
    }

    for (const label of poolLabels) {
      if (!isObject(state.accounts[label])) {
        throw new Error(`Unknown label in autopin pool: ${label}. Add it by running \`aim ${label}\` first.`);
      }
      const cred = getCodexCredential(state, label);
      if (!cred) {
        throw new Error(`Missing openai-codex credentials for label=${label}. Run \`aim ${label}\` to login first.`);
      }
    }

    const agentsList = readOpenclawAgentsListFromConfig();
    const allAgentIds = agentsList
      .map((entry) => {
        const id = typeof entry?.id === "string" ? entry.id.trim() : "";
        return id ? normalizeAgentId(id) : null;
      })
      .filter(Boolean);

    const pinnedAgentIds = Object.keys(state.pins.openclaw);
    const pinnedSet = new Set(pinnedAgentIds);
    const candidateAgentIds = allAgentIds.filter((agentId) => !pinnedSet.has(agentId));

    const { assignments } = planEvenLabelAssignments({
      candidateAgentIds,
      existingPinsByAgentId: state.pins.openclaw,
      poolLabels,
    });

    for (const [agentId, label] of Object.entries(assignments)) {
      state.pins.openclaw[agentId] = label;
    }

    state.schemaVersion = SCHEMA_VERSION;
    writeJsonFileWithBackup(statePath, state);

    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          autopin: {
            system,
            poolLabels,
            added: Object.keys(assignments).length,
            skippedAlreadyPinned: pinnedAgentIds.length,
          },
          synced,
        }),
        null,
        2,
      )}\n`,
    );
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
      throw new Error('Missing sync target. Usage: aim sync openclaw');
    }
    if (system !== "openclaw") {
      throw new Error(`Unsupported sync target: ${system} (only "openclaw" is supported in v0).`);
    }
    const state = loadAimgrState(statePath);
    const synced = await syncOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}
