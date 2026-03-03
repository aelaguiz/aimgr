import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import readline from "node:readline/promises";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai";

const SCHEMA_VERSION = "0.1";
const OPENAI_CODEX_PROVIDER = "openai-codex";

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
  const reserved = new Set(["status", "login", "pin", "apply", "help"]);
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
    "  aim apply",
    "",
    "Notes:",
    "  - SSOT file: ~/.aimgr/secrets.json (auto-backed-up on every write).",
    "  - V0 supports: openai-codex (ChatGPT/Codex OAuth) on macOS.",
    "  - OAuth runs inside OpenClaw browser profiles under ~/.openclaw/browser/*/user-data.",
    "",
    "Developer options (rare):",
    "  --home <dir>    Run against an alternate HOME (dev/test; e.g. /tmp/aimgr-home).",
    "  --state <path>  Override SSOT file path (default: <home>/.aimgr/secrets.json).",
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

function resolveOpenclawAuthStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "agent", "auth-profiles.json");
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

function ensureStateShape(state) {
  state.accounts = isObject(state.accounts) ? state.accounts : {};
  state.pins = isObject(state.pins) ? state.pins : { openclaw: {} };
  state.pins.openclaw = isObject(state.pins.openclaw) ? state.pins.openclaw : {};
  state.credentials = isObject(state.credentials) ? state.credentials : {};
  state.credentials[OPENAI_CODEX_PROVIDER] = isObject(state.credentials[OPENAI_CODEX_PROVIDER])
    ? state.credentials[OPENAI_CODEX_PROVIDER]
    : {};
}

function getCodexCredential(state, label) {
  ensureStateShape(state);
  const byLabel = state.credentials[OPENAI_CODEX_PROVIDER];
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
  return `${OPENAI_CODEX_PROVIDER}:${label}`;
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

  const provider = normalizeProviderId(existing?.provider ?? OPENAI_CODEX_PROVIDER);
  if (provider && provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`accounts.${label}.provider=${provider} is not supported in v0 (only openai-codex).`);
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
      provider: OPENAI_CODEX_PROVIDER,
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
        provider: OPENAI_CODEX_PROVIDER,
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
  const credsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];

  // Missing creds
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    if (normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) continue;
    const openclawBrowserProfile =
      typeof account.openclawBrowserProfile === "string" ? account.openclawBrowserProfile.trim() : "";
    if (!openclawBrowserProfile) {
      warnings.push({ kind: "missing_openclaw_browser_profile", provider: OPENAI_CODEX_PROVIDER, label });
    }
    if (!isObject(credsByLabel[label])) {
      warnings.push({ kind: "missing_credentials", provider: OPENAI_CODEX_PROVIDER, label });
    }
  }

  // Collisions (accountId -> multiple labels)
  const byAccountId = new Map();
  for (const [label, cred] of Object.entries(credsByLabel)) {
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
    if (!isObject(credsByLabel[label])) {
      warnings.push({ kind: "pin_points_to_missing_credentials", system: "openclaw", agentId, label });
    }
  }

  return warnings;
}

async function buildStatusView({ statePath, state }) {
  ensureStateShape(state);

  const accounts = [];
  const usageByLabel = {};

  // Probe usage by default (fail-loud-but-not-fake: unknown if fetch fails).
  const credsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  const probes = Object.entries(credsByLabel)
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
      const cred = isObject(credsByLabel[label]) ? credsByLabel[label] : null;
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

  const credsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  const managedLabels = Object.entries(state.accounts)
    .filter(([, account]) => isObject(account) && normalizeProviderId(account.provider) === OPENAI_CODEX_PROVIDER)
    .map(([label]) => label)
    .filter((label) => isObject(credsByLabel[label]));

  if (managedLabels.length === 0) {
    throw new Error("No managed openai-codex accounts with credentials found in SSOT. Run `aim login <label>` first.");
  }

  // Build desired OpenClaw oauth credential records.
  const desiredProfiles = {};
  for (const label of managedLabels) {
    const cred = credsByLabel[label];
    const expiresMs = parseExpiresAtToMs(cred.expiresAt);
    if (!expiresMs) {
      throw new Error(`credentials.openai-codex.${label}.expiresAt is missing/invalid.`);
    }
    desiredProfiles[resolveOpenclawProfileIdForCodexLabel(label)] = {
      type: "oauth",
      provider: OPENAI_CODEX_PROVIDER,
      access: cred.access,
      refresh: cred.refresh,
      expires: expiresMs,
      accountId: cred.accountId,
    };
  }

  // Main store: replace all openai-codex profiles with managed profiles.
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
    if (normalizeProviderId(existingCred.provider) !== OPENAI_CODEX_PROVIDER) continue;
    delete nextMain.profiles[profileId];
  }
  for (const [profileId, oauthCred] of Object.entries(desiredProfiles)) {
    nextMain.profiles[profileId] = oauthCred;
  }
  nextMain.order = isObject(nextMain.order) ? nextMain.order : {};
  nextMain.order[OPENAI_CODEX_PROVIDER] = Object.keys(desiredProfiles).toSorted((a, b) => a.localeCompare(b));

  writeJsonFileWithBackup(mainStorePath, nextMain);

  // Per-agent pins: order override only (profiles inherited from main).
  const pins = isObject(state.pins?.openclaw) ? state.pins.openclaw : {};
  const wrote = [mainStorePath];
  for (const [agentIdRaw, labelRaw] of Object.entries(pins)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    if (!isObject(credsByLabel[label])) {
      throw new Error(`Pin references label with missing credentials: agent=${agentId} label=${label}`);
    }
    const profileId = resolveOpenclawProfileIdForCodexLabel(label);

    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath) ?? { version: 1, profiles: {} };
    if (!isObject(existing) || !isObject(existing.profiles)) {
      throw new Error(`OpenClaw auth store is missing profiles object: ${storePath}`);
    }
    const next = structuredClone(existing);
    next.version = Number(next.version ?? 1);
    next.profiles = isObject(next.profiles) ? next.profiles : {};

    // Remove any local openai-codex profiles to prevent drift/collisions.
    for (const [pid, c] of Object.entries(next.profiles)) {
      if (!isObject(c)) continue;
      if (normalizeProviderId(c.provider) !== OPENAI_CODEX_PROVIDER) continue;
      delete next.profiles[pid];
    }

    next.order = isObject(next.order) ? next.order : {};
    next.order[OPENAI_CODEX_PROVIDER] = [profileId];
    next.lastGood = isObject(next.lastGood) ? next.lastGood : {};
    next.lastGood[OPENAI_CODEX_PROVIDER] = profileId;

    writeJsonFileWithBackup(storePath, next);
    wrote.push(storePath);
  }

  return { wrote };
}

export async function main(argv) {
  const { opts, positional } = parseArgs(argv);
  const knownCmds = new Set(["status", "login", "pin", "apply"]);
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

    const openclawBrowserProfile = await ensureCodexAccountConfig({ state, label, homeDir });
    const cred = await refreshOrLoginCodex({ state, label, homeDir, openclawBrowserProfile });
    state.credentials[OPENAI_CODEX_PROVIDER][label] = cred;

    // Auto-pin: eliminate the common "second step" by pinning agent_<label> -> <label>
    // (only if that OpenClaw agent exists on disk).
    const openclawStateDir = resolveOpenclawStateDir({ homeDir });
    const inferredAgentId = inferOpenclawAgentIdForLabel({ openclawStateDir, label });
    if (inferredAgentId) {
      state.pins.openclaw[inferredAgentId] = label;
    }

    state.schemaVersion = SCHEMA_VERSION;

    writeJsonFileWithBackup(statePath, state);

    const applied = applyOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, label, applied }), null, 2)}\n`);
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
    state.pins.openclaw[agentId] = label;
    state.schemaVersion = SCHEMA_VERSION;
    writeJsonFileWithBackup(statePath, state);

    const applied = applyOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, pin: { agentId, label }, applied }), null, 2)}\n`);
    return;
  }

  if (cmd === "apply") {
    const state = loadAimgrState(statePath);
    const applied = applyOpenclawFromState(opts, state);
    process.stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, applied }), null, 2)}\n`);
    return;
  }

  throw new Error(`Unknown command: ${cmd}`);
}
