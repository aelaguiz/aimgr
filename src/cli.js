import fs from "node:fs";
import path from "node:path";

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

function parseArgs(argv) {
  const opts = {
    home: undefined,
    state: undefined,
    json: false,
    probe: false,
    write: false,
    help: false,
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
    if (arg === "--probe") {
      opts.probe = true;
      continue;
    }
    if (arg === "--write" || arg === "--apply") {
      opts.write = true;
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
    "aimgr — AI account manager (plaintext files, SSOT, no guessing).",
    "",
    "Usage:",
    "  aimgr status [--home <dir>] [--state <path>] [--json] [--probe]",
    "  aimgr adopt openclaw [--home <dir>] [--state <path>] [--write]",
    "  aimgr relabel openclaw <fromProfileId> <toProfileId> [--home <dir>] [--state <path>] [--write]",
    "  aimgr pin openclaw <agentId> <profileId> [--home <dir>] [--state <path>] [--write]",
    "  aimgr sync  openclaw [--home <dir>] [--state <path>] [--write]",
    "",
    "Options:",
    "  --home <dir>    Override HOME for reading/writing state (default: real HOME).",
    "  --state <path>  Override aimgr state file path (default: <home>/.aimgr/secrets.json).",
    "  --json          JSON output (status only).",
    "  --probe         Fetch provider usage/status from network (status only).",
    "  --write         Actually write changes for adopt/sync (default: dry-run).",
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

function resolveOpenclawAgentsDir(homeDir) {
  return path.join(homeDir, ".openclaw", "agents");
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

function loadAimgrState(statePath) {
  const raw = readJsonFile(statePath);
  if (!raw) {
    return {
      version: 1,
      accounts: {},
      openclaw: { agentPins: {} },
    };
  }
  if (!isObject(raw)) {
    throw new Error(`aimgr state must be an object: ${statePath}`);
  }
  return {
    version: Number(raw.version ?? 1),
    accounts: isObject(raw.accounts) ? raw.accounts : {},
    openclaw: isObject(raw.openclaw) ? raw.openclaw : { agentPins: {} },
  };
}

function sanitizeForStatus(value) {
  const exactSecretKeys = new Set(
    [
      // Common OpenClaw OAuthCredential fields (pi-ai OAuthCredentials)
      "access",
      "refresh",
      "expires",
      // Common OAuth2 spellings
      "access_token",
      "refresh_token",
      "id_token",
      // Common API key spellings
      "key",
      "apikey",
      "api_key",
      "client_secret",
      // Common generic spellings
      "token",
      "secret",
      "password",
      "cookie",
      "session",
      // CamelCase variants we’ve seen in other CLIs
      "accessToken",
      "refreshToken",
      "idToken",
    ].map((k) => String(k).toLowerCase()),
  );

  const isLikelySecretKey = (key) => {
    const raw = String(key ?? "");
    const k = raw.trim().toLowerCase();
    if (k.length === 0) return false;
    if (exactSecretKeys.has(k)) return true;

    // Catch obvious variants: e.g. "openaiAccessToken", "oauth_refresh_token", "sessionToken".
    if (k.includes("token")) return true;
    if (k.includes("secret")) return true;
    if (k.includes("password")) return true;
    if (k === "key" || k.endsWith("_key") || k.endsWith("key")) return true;
    if (k.includes("cookie")) return true;
    if (k.includes("session")) return true;

    return false;
  };

  const seen = new WeakSet();
  const walk = (v) => {
    if (!v || typeof v !== "object") {
      return v;
    }
    if (seen.has(v)) {
      return "[circular]";
    }
    seen.add(v);

    if (Array.isArray(v)) {
      return v.map((item) => walk(item));
    }

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

function sanitizeLabelForProfileId(label) {
  const raw = String(label ?? "").trim().toLowerCase();
  const safe = raw
    .replace(/@.*$/, "") // strip domain if email-ish
    .replace(/[^a-z0-9_-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return safe || "imported";
}

function suggestRelabeledProfileIdForDefault(originalProfileId, credential, alreadyUsedProfileIds) {
  const cred = isObject(credential) ? credential : {};
  const provider = normalizeProviderId(cred.provider ?? String(originalProfileId).split(":")[0]);

  const email = typeof cred.email === "string" ? cred.email : null;
  const accountId = typeof cred.accountId === "string" ? cred.accountId : null;

  let baseLabel = null;
  if (email && email.includes("@")) {
    baseLabel = sanitizeLabelForProfileId(email.split("@")[0]);
  }
  if (!baseLabel && accountId && accountId.length >= 6) {
    baseLabel = `acct_${sanitizeLabelForProfileId(accountId.slice(-6))}`;
  }
  if (!baseLabel) {
    baseLabel = "imported";
  }

  let candidate = `${provider}:${baseLabel}`;
  if (!alreadyUsedProfileIds.has(candidate)) {
    return candidate;
  }

  // Deterministic de-dupe: append _2, _3, ...
  for (let i = 2; i <= 1000; i += 1) {
    const next = `${provider}:${baseLabel}_${i}`;
    if (!alreadyUsedProfileIds.has(next)) {
      return next;
    }
  }
  throw new Error(`Failed to generate a unique profileId for ${originalProfileId}`);
}

function listDirNames(dirPath) {
  if (!fs.existsSync(dirPath)) {
    return [];
  }
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  return entries.filter((e) => e.isDirectory()).map((e) => e.name);
}

function readOpenclawAuthStore(homeDir, agentId) {
  const storePath = path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
  const store = readJsonFile(storePath);
  return { storePath, store };
}

function summarizeOpenclawStore(store) {
  if (!store) {
    return null;
  }
  const profiles = isObject(store.profiles) ? store.profiles : {};
  const order = isObject(store.order) ? store.order : undefined;
  const lastGood = isObject(store.lastGood) ? store.lastGood : undefined;

  const profileSummaries = Object.entries(profiles).map(([profileId, cred]) => {
    const c = isObject(cred) ? cred : {};
    return {
      profileId,
      provider: String(c.provider ?? ""),
      type: String(c.type ?? ""),
      email: typeof c.email === "string" ? c.email : null,
      accountId: typeof c.accountId === "string" ? c.accountId : null,
      expires: typeof c.expires === "number" ? c.expires : null,
    };
  });

  return {
    version: store.version ?? null,
    profiles: profileSummaries,
    order,
    lastGood,
  };
}

function buildOpenclawWarnings(allStoresByAgent) {
  const warnings = [];

  // Global: any *:default profiles
  for (const [agentId, s] of Object.entries(allStoresByAgent)) {
    if (!s?.profiles) continue;
    const defaults = s.profiles.filter((p) => String(p.profileId).endsWith(":default"));
    if (defaults.length > 0) {
      warnings.push({
        kind: "openclaw_default_profile",
        agentId,
        profileIds: defaults.map((d) => d.profileId),
      });
    }
  }

  // Main store: accountId collisions for openai-codex
  const main = allStoresByAgent.main;
  if (main?.profiles) {
    const codex = main.profiles.filter((p) => normalizeProviderId(p.provider) === "openai-codex");
    const byAccountId = new Map();
    for (const p of codex) {
      if (!p.accountId) continue;
      const existing = byAccountId.get(p.accountId) ?? [];
      existing.push(p.profileId);
      byAccountId.set(p.accountId, existing);
    }
    for (const [accountId, profileIds] of byAccountId.entries()) {
      if (profileIds.length > 1) {
        warnings.push({
          kind: "openclaw_account_id_collision",
          agentId: "main",
          provider: "openai-codex",
          accountId,
          profileIds,
        });
      }
    }
  }

  return warnings;
}

function buildOpenclawPinWarnings(state, openclawStoresByAgent) {
  const warnings = [];
  const pins = isObject(state.openclaw?.agentPins) ? state.openclaw.agentPins : {};
  for (const [agentId, pinnedProfileId] of Object.entries(pins)) {
    if (typeof pinnedProfileId !== "string" || pinnedProfileId.trim().length === 0) {
      continue;
    }
    const store = openclawStoresByAgent[agentId];
    if (!store) {
      warnings.push({
        kind: "openclaw_pin_missing_store",
        agentId,
        provider: "openai-codex",
        pinnedProfileId,
      });
      continue;
    }
    const list = Array.isArray(store.order?.["openai-codex"]) ? store.order["openai-codex"] : null;
    if (!list) {
      warnings.push({
        kind: "openclaw_pin_not_enforced",
        agentId,
        provider: "openai-codex",
        pinnedProfileId,
        reason: "missing_order",
      });
      continue;
    }
    if (list.length !== 1 || String(list[0]) !== pinnedProfileId) {
      warnings.push({
        kind: "openclaw_pin_not_enforced",
        agentId,
        provider: "openai-codex",
        pinnedProfileId,
        actual: list,
      });
    }
  }
  return warnings;
}

function buildAimgrWarnings(state) {
  const warnings = [];

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const codexProfiles = [];
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) !== "openai-codex") continue;

    const oc = isObject(account.openclaw) ? account.openclaw : null;
    const profileId = oc && typeof oc.profileId === "string" ? oc.profileId : null;
    const accountId = typeof account.accountId === "string" ? account.accountId : null;
    if (!profileId) continue;
    codexProfiles.push({ label, profileId, accountId });

    if (profileId.endsWith(":default")) {
      warnings.push({
        kind: "aimgr_contains_default_profile",
        provider: "openai-codex",
        label,
        profileId,
      });
    }
  }

  // accountId collisions inside aimgr (per provider)
  const byAccountId = new Map();
  for (const p of codexProfiles) {
    if (!p.accountId) continue;
    const existing = byAccountId.get(p.accountId) ?? [];
    existing.push(p.profileId);
    byAccountId.set(p.accountId, existing);
  }
  for (const [accountId, profileIds] of byAccountId.entries()) {
    if (profileIds.length > 1) {
      warnings.push({
        kind: "aimgr_account_id_collision",
        provider: "openai-codex",
        accountId,
        profileIds,
      });
    }
  }

  // pins that point to missing profiles
  const pins = isObject(state.openclaw?.agentPins) ? state.openclaw.agentPins : {};
  const configuredProfileIds = new Set(codexProfiles.map((p) => p.profileId));
  for (const [agentId, profileId] of Object.entries(pins)) {
    if (typeof profileId !== "string") continue;
    if (!configuredProfileIds.has(profileId)) {
      warnings.push({
        kind: "aimgr_agent_pin_missing_profile",
        agentId,
        provider: "openai-codex",
        profileId,
      });
    }
  }

  return warnings;
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
      provider: "openai-codex",
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
    provider: "openai-codex",
    ok: true,
    windows,
    plan,
  };
}

async function buildStatus(params) {
  const homeDir = resolveHomeDir(params.home);
  const statePath = resolveAimgrStatePath(params);
  const state = loadAimgrState(statePath);

  const openclawAgentsDir = resolveOpenclawAgentsDir(homeDir);
  const agentIds = listDirNames(openclawAgentsDir).toSorted((a, b) => a.localeCompare(b));
  const openclawStoresByAgent = {};
  for (const agentId of agentIds) {
    const { store } = readOpenclawAuthStore(homeDir, agentId);
    openclawStoresByAgent[agentId] = summarizeOpenclawStore(store);
  }

  const warnings = [
    ...buildAimgrWarnings(state),
    ...buildOpenclawWarnings(openclawStoresByAgent),
    ...buildOpenclawPinWarnings(state, openclawStoresByAgent),
  ];

  const accountsByLabel = isObject(state.accounts) ? state.accounts : {};
  const accounts = Object.entries(accountsByLabel ?? {}).map(([label, account]) => ({
    label,
    ...(sanitizeForStatus(account) ?? {}),
  }));

  const probes = {};
  if (params.probe) {
    const codexUsage = {};
    for (const [label, account] of Object.entries(accountsByLabel)) {
      if (!isObject(account)) continue;
      if (normalizeProviderId(account.provider) !== "openai-codex") continue;
      const oc = isObject(account.openclaw) ? account.openclaw : null;
      const cred = oc && isObject(oc.credential) ? oc.credential : null;
      const accessToken = cred && typeof cred.access === "string" ? cred.access : null;
      const accountId = typeof account.accountId === "string" ? account.accountId : null;
      if (!accessToken) {
        codexUsage[label] = { provider: "openai-codex", ok: false, status: "missing_access_token" };
        continue;
      }
      try {
        codexUsage[label] = await fetchCodexUsageSnapshot({
          accessToken,
          accountId,
          timeoutMs: 8000,
        });
      } catch (err) {
        codexUsage[label] = {
          provider: "openai-codex",
          ok: false,
          status: "error",
          error: String(err?.message ?? err),
        };
      }
    }
    probes.openaiCodexUsage = codexUsage;
  }

  return {
    aimgr: {
      statePath,
      accounts,
      openclaw: sanitizeForStatus(state.openclaw ?? {}),
    },
    openclaw: {
      homeDir,
      agentsDir: openclawAgentsDir,
      agents: openclawStoresByAgent,
    },
    probes,
    warnings,
  };
}

function adoptOpenclaw(params) {
  const homeDir = resolveHomeDir(params.home);
  const statePath = resolveAimgrStatePath(params);
  const prev = loadAimgrState(statePath);

  const { store: mainStoreRaw, storePath: mainStorePath } = readOpenclawAuthStore(homeDir, "main");
  if (!mainStoreRaw) {
    throw new Error(`OpenClaw main auth store not found: ${mainStorePath}`);
  }
  if (!isObject(mainStoreRaw.profiles)) {
    throw new Error(`OpenClaw auth store missing profiles object: ${mainStorePath}`);
  }

  const next = structuredClone(prev);
  next.accounts = isObject(next.accounts) ? next.accounts : {};
  next.openclaw = isObject(next.openclaw) ? next.openclaw : { agentPins: {} };
  next.openclaw.agentPins = isObject(next.openclaw.agentPins) ? next.openclaw.agentPins : {};

  // Drop any previously adopted openai-codex accounts before re-import.
  for (const [label, account] of Object.entries(next.accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) === "openai-codex") {
      delete next.accounts[label];
    }
  }

  // Import OpenAI-Codex profiles as accounts (label = suffix of profileId).
  // Deterministic cleanup rule: if multiple profiles share the same accountId
  // and one of them is `*:default`, prefer the non-default label and drop `*:default`.
  const codexEntries = Object.entries(mainStoreRaw.profiles)
    .map(([profileId, cred]) => ({ profileId, cred }))
    .filter(({ cred }) => isObject(cred) && normalizeProviderId(cred.provider) === "openai-codex");

  const grouped = new Map();
  for (const entry of codexEntries) {
    const accountId = typeof entry.cred.accountId === "string" ? entry.cred.accountId : "";
    const key = accountId || entry.profileId;
    const list = grouped.get(key) ?? [];
    list.push(entry);
    grouped.set(key, list);
  }

  const keep = [];
  for (const list of grouped.values()) {
    if (list.length <= 1) {
      keep.push(...list);
      continue;
    }
    const defaults = list.filter((e) => String(e.profileId).endsWith(":default"));
    const nonDefaults = list.filter((e) => !String(e.profileId).endsWith(":default"));
    if (defaults.length > 0 && nonDefaults.length > 0) {
      keep.push(...nonDefaults);
      continue;
    }
    keep.push(...list);
  }

  const usedProfileIds = new Set(keep.map((e) => e.profileId));
  for (const { profileId, cred } of keep) {
    let effectiveProfileId = profileId;
    if (String(profileId).endsWith(":default")) {
      // Hard invariant: no *:default in steady state. If OpenClaw has a legacy default profile,
      // adopt it into aimgr under a deterministic non-default label (email local-part preferred,
      // else accountId suffix).
      effectiveProfileId = suggestRelabeledProfileIdForDefault(profileId, cred, usedProfileIds);
      usedProfileIds.add(effectiveProfileId);
    }

    const label = String(effectiveProfileId).split(":").slice(1).join(":") || effectiveProfileId;
    let uniqueLabel = label;
    for (let i = 2; next.accounts[uniqueLabel]; i += 1) {
      uniqueLabel = `${label}_${i}`;
    }

    next.accounts[uniqueLabel] = {
      provider: "openai-codex",
      email: typeof cred.email === "string" ? cred.email : null,
      accountId: typeof cred.accountId === "string" ? cred.accountId : null,
      openclaw: {
        profileId: effectiveProfileId,
        originalProfileId: profileId === effectiveProfileId ? undefined : profileId,
        credential: cred,
        source: mainStorePath,
      },
    };
  }

  // Import any existing per-agent pins (order.openai-codex with a single entry).
  const agentsDir = resolveOpenclawAgentsDir(homeDir);
  for (const agentId of listDirNames(agentsDir)) {
    if (agentId === "main") continue;
    const { store } = readOpenclawAuthStore(homeDir, agentId);
    if (!store || !isObject(store.order)) continue;
    const list = store.order["openai-codex"];
    if (Array.isArray(list) && list.length === 1 && typeof list[0] === "string") {
      next.openclaw.agentPins[agentId] = list[0];
    }
  }

  if (!params.write) {
    return {
      wouldWrite: true,
      statePath,
      nextState: sanitizeForStatus(next),
      note: "Dry-run. Re-run with --write to persist aimgr state.",
    };
  }

  writeJsonFileWithBackup(statePath, next);
  return { wrote: true, statePath };
}

function relabelOpenclawProfile(params, fromProfileId, toProfileId) {
  const statePath = resolveAimgrStatePath(params);
  const prev = loadAimgrState(statePath);

  if (typeof fromProfileId !== "string" || fromProfileId.trim().length === 0) {
    throw new Error("fromProfileId is required.");
  }
  if (typeof toProfileId !== "string" || toProfileId.trim().length === 0) {
    throw new Error("toProfileId is required.");
  }
  if (String(toProfileId).trim().toLowerCase().endsWith(":default")) {
    throw new Error(`Refusing to relabel to *:default (${toProfileId}). Managed profiles must be labeled.`);
  }

  const next = structuredClone(prev);
  next.accounts = isObject(next.accounts) ? next.accounts : {};
  next.openclaw = isObject(next.openclaw) ? next.openclaw : { agentPins: {} };
  next.openclaw.agentPins = isObject(next.openclaw.agentPins) ? next.openclaw.agentPins : {};

  const matches = Object.entries(next.accounts).filter(([, account]) => {
    if (!isObject(account)) return false;
    const oc = isObject(account.openclaw) ? account.openclaw : null;
    return oc && oc.profileId === fromProfileId;
  });
  if (matches.length === 0) {
    throw new Error(`No aimgr account found with openclaw.profileId=${fromProfileId}`);
  }
  if (matches.length > 1) {
    throw new Error(
      `Multiple aimgr accounts match openclaw.profileId=${fromProfileId}; state must be repaired manually.`,
    );
  }

  const [oldLabel, account] = matches[0];
  const oc = account.openclaw;
  if (!isObject(oc) || !isObject(oc.credential)) {
    throw new Error(`Account ${oldLabel} is missing openclaw.credential; cannot relabel safely.`);
  }

  // Compute new label from profile suffix (provider:label).
  const newLabel = String(toProfileId).split(":").slice(1).join(":") || toProfileId;
  if (newLabel !== oldLabel && next.accounts[newLabel]) {
    throw new Error(`Target account label already exists in state: ${newLabel}`);
  }

  // Ensure no other account already uses toProfileId.
  for (const [label, a] of Object.entries(next.accounts)) {
    if (!isObject(a)) continue;
    if (label === oldLabel) continue;
    const aoc = isObject(a.openclaw) ? a.openclaw : null;
    if (aoc && aoc.profileId === toProfileId) {
      throw new Error(`Another account already uses openclaw.profileId=${toProfileId} (${label}).`);
    }
  }

  const updated = structuredClone(account);
  updated.openclaw = { ...updated.openclaw, profileId: toProfileId };

  // Move under new key if needed.
  delete next.accounts[oldLabel];
  next.accounts[newLabel] = updated;

  // Update any pins pointing to the old profile id.
  for (const [agentId, profileId] of Object.entries(next.openclaw.agentPins)) {
    if (profileId === fromProfileId) {
      next.openclaw.agentPins[agentId] = toProfileId;
    }
  }

  if (!params.write) {
    return {
      wouldWrite: true,
      statePath,
      nextState: sanitizeForStatus(next),
      note: "Dry-run. Re-run with --write to persist.",
    };
  }
  writeJsonFileWithBackup(statePath, next);
  return { wrote: true, statePath, relabeled: { fromProfileId, toProfileId } };
}

function pinOpenclawAgent(params, agentId, profileId) {
  const statePath = resolveAimgrStatePath(params);
  const prev = loadAimgrState(statePath);
  const next = structuredClone(prev);
  next.accounts = isObject(next.accounts) ? next.accounts : {};
  next.openclaw = isObject(next.openclaw) ? next.openclaw : { agentPins: {} };
  next.openclaw.agentPins = isObject(next.openclaw.agentPins) ? next.openclaw.agentPins : {};

  if (typeof agentId !== "string" || agentId.trim().length === 0) {
    throw new Error("agentId is required.");
  }
  if (typeof profileId !== "string" || profileId.trim().length === 0) {
    throw new Error("profileId is required.");
  }

  const configuredProfileIds = new Set(
    Object.values(next.accounts)
      .filter((a) => isObject(a) && isObject(a.openclaw) && typeof a.openclaw.profileId === "string")
      .map((a) => a.openclaw.profileId),
  );
  if (!configuredProfileIds.has(profileId)) {
    throw new Error(
      `profileId is not present in aimgr accounts: ${profileId}. Add/adopt the account first.`,
    );
  }

  next.openclaw.agentPins[agentId] = profileId;

  if (!params.write) {
    return {
      wouldWrite: true,
      statePath,
      nextState: sanitizeForStatus(next),
      note: "Dry-run. Re-run with --write to persist.",
    };
  }
  writeJsonFileWithBackup(statePath, next);
  return { wrote: true, statePath, pin: { agentId, profileId } };
}

function syncOpenclaw(params) {
  const homeDir = resolveHomeDir(params.home);
  const statePath = resolveAimgrStatePath(params);
  const state = loadAimgrState(statePath);
  const accounts = isObject(state.accounts) ? state.accounts : {};

  const desired = [];
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) !== "openai-codex") continue;
    const oc = isObject(account.openclaw) ? account.openclaw : null;
    const profileId = oc && typeof oc.profileId === "string" ? oc.profileId : null;
    const credential = oc && isObject(oc.credential) ? oc.credential : null;
    if (!profileId || !credential) continue;
    desired.push({ label, profileId, credential });
  }

  if (desired.length === 0) {
    throw new Error(`No OpenClaw openai-codex accounts found in aimgr state: ${statePath}`);
  }

  // Hard requirements: no *:default profiles and no ambiguous (duplicate) accountIds.
  const profileIdsWithDefault = desired.filter((d) => d.profileId.endsWith(":default"));
  if (profileIdsWithDefault.length > 0) {
    throw new Error(
      `aimgr state contains *:default OpenClaw profile ids (${profileIdsWithDefault
        .map((d) => d.profileId)
        .join(", ")}). Rename/drop them before sync.`,
    );
  }
  const byAccountId = new Map();
  for (const d of desired) {
    const accountId = typeof d.credential.accountId === "string" ? d.credential.accountId : null;
    if (!accountId) continue;
    const existing = byAccountId.get(accountId) ?? [];
    existing.push(d.profileId);
    byAccountId.set(accountId, existing);
  }
  for (const [accountId, profileIds] of byAccountId.entries()) {
    if (profileIds.length > 1) {
      throw new Error(
        `aimgr openai-codex profiles are ambiguous: multiple profile ids share the same accountId (${accountId}): ${profileIds.join(
          ", ",
        )}. Keep only one label per account before sync.`,
      );
    }
  }

  const main = readOpenclawAuthStore(homeDir, "main");
  const mainStoreRaw = main.store ?? { version: 1, profiles: {} };
  if (!isObject(mainStoreRaw.profiles)) {
    throw new Error(`OpenClaw main auth store missing profiles object: ${main.storePath}`);
  }

  const desiredProfileIds = new Set(desired.map((d) => d.profileId));
  const nextMain = structuredClone(mainStoreRaw);

  // Remove existing openai-codex profiles that are NOT desired (nukes *:default too).
  for (const [profileId, cred] of Object.entries(nextMain.profiles)) {
    if (!isObject(cred)) continue;
    if (normalizeProviderId(cred.provider) !== "openai-codex") continue;
    if (!desiredProfileIds.has(profileId)) {
      delete nextMain.profiles[profileId];
    }
  }
  // Add/replace desired profiles from aimgr SSOT.
  for (const entry of desired) {
    nextMain.profiles[entry.profileId] = entry.credential;
  }
  nextMain.order = isObject(nextMain.order) ? nextMain.order : {};
  nextMain.order["openai-codex"] = Array.from(desiredProfileIds).toSorted((a, b) =>
    a.localeCompare(b),
  );

  // Per-agent pins
  const pins = isObject(state.openclaw?.agentPins) ? state.openclaw.agentPins : {};

  const writes = [];
  if (params.write) {
    writeJsonFileWithBackup(main.storePath, nextMain);
    writes.push(main.storePath);
  }

  const agentsDir = resolveOpenclawAgentsDir(homeDir);
  const agentIds = listDirNames(agentsDir);
  for (const agentId of agentIds) {
    if (agentId === "main") {
      continue;
    }
    const { storePath, store } = readOpenclawAuthStore(homeDir, agentId);
    const pinnedProfileId = pins[agentId];
    if (!store) {
      if (typeof pinnedProfileId === "string" && pinnedProfileId.trim().length > 0) {
        if (!desiredProfileIds.has(pinnedProfileId)) {
          throw new Error(
            `OpenClaw pin references unknown profileId: agent=${agentId} profile=${pinnedProfileId}`,
          );
        }

        const minimal = {
          version: 1,
          profiles: {},
          order: { "openai-codex": [pinnedProfileId] },
          lastGood: { "openai-codex": pinnedProfileId },
        };
        if (params.write) {
          writeJsonFileWithBackup(storePath, minimal);
          writes.push(storePath);
        }
      }
      continue;
    }
    const raw = store ?? { version: 1, profiles: {} };
    if (!isObject(raw.profiles)) {
      throw new Error(`OpenClaw auth store missing profiles object: ${storePath}`);
    }
    const next = structuredClone(raw);

    // Remove unwanted openai-codex profiles everywhere (eradicates *:default drift).
    for (const [profileId, cred] of Object.entries(next.profiles)) {
      if (!isObject(cred)) continue;
      if (normalizeProviderId(cred.provider) !== "openai-codex") continue;
      if (!desiredProfileIds.has(profileId)) {
        delete next.profiles[profileId];
      }
    }

    // Keep any existing order, but ensure it doesn't point at removed profiles.
    if (isObject(next.order) && Array.isArray(next.order["openai-codex"])) {
      next.order["openai-codex"] = next.order["openai-codex"].filter((id) =>
        desiredProfileIds.has(String(id)),
      );
      if (next.order["openai-codex"].length === 0) {
        delete next.order["openai-codex"];
      }
    }

    // If pinned, enforce single-profile order + lastGood.
    if (typeof pinnedProfileId === "string" && pinnedProfileId.trim().length > 0) {
      if (!desiredProfileIds.has(pinnedProfileId)) {
        throw new Error(
          `OpenClaw pin references unknown profileId: agent=${agentId} profile=${pinnedProfileId}`,
        );
      }
      next.order = isObject(next.order) ? next.order : {};
      next.order["openai-codex"] = [pinnedProfileId];
      next.lastGood = isObject(next.lastGood) ? next.lastGood : {};
      next.lastGood["openai-codex"] = pinnedProfileId;
    } else if (isObject(next.lastGood) && typeof next.lastGood["openai-codex"] === "string") {
      // Clean lastGood if it points at a removed profile id.
      if (!desiredProfileIds.has(next.lastGood["openai-codex"])) {
        delete next.lastGood["openai-codex"];
      }
    }

    if (params.write) {
      writeJsonFileWithBackup(storePath, next);
      writes.push(storePath);
    }
  }

  if (!params.write) {
    return {
      wouldWrite: true,
      statePath,
      mainStorePath: main.storePath,
      desiredProfiles: desired.map((d) => d.profileId),
      pins,
      note: "Dry-run. Re-run with --write to apply.",
    };
  }
  return { wrote: true, writes };
}

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const cmd = positional[0];
  const sub = positional[1];

  if (opts.help || !cmd) {
    printHelp();
    return;
  }

  if (cmd === "status") {
    const status = await buildStatus(opts);
    if (opts.json) {
      process.stdout.write(`${JSON.stringify(status, null, 2)}\n`);
      return;
    }
    const warnings = status.warnings ?? [];
    process.stdout.write(`aimgr state: ${status.aimgr.statePath}\n`);
    process.stdout.write(`aimgr accounts: ${status.aimgr.accounts.length}\n`);
    process.stdout.write(`openclaw home: ${status.openclaw.homeDir}\n`);
    process.stdout.write(`openclaw agents: ${Object.keys(status.openclaw.agents).length}\n`);
    process.stdout.write(`warnings: ${warnings.length}\n`);
    for (const w of warnings.slice(0, 50)) {
      process.stdout.write(`- ${w.kind} ${w.agentId ? `agent=${w.agentId}` : ""}\n`);
    }
    return;
  }

  if (cmd === "adopt" && sub === "openclaw") {
    const result = adoptOpenclaw(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (cmd === "relabel" && sub === "openclaw") {
    const fromProfileId = positional[2];
    const toProfileId = positional[3];
    const result = relabelOpenclawProfile(opts, fromProfileId, toProfileId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (cmd === "pin" && sub === "openclaw") {
    const agentId = positional[2];
    const profileId = positional[3];
    const result = pinOpenclawAgent(opts, agentId, profileId);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  if (cmd === "sync" && sub === "openclaw") {
    const result = syncOpenclaw(opts);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${[cmd, sub].filter(Boolean).join(" ")}`);
}
