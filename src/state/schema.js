import { ANTHROPIC_PROVIDER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, LEGACY_INTERACTIVE_OAUTH_MODE_AIM_BROWSER_PROFILE, LEGACY_INTERACTIVE_OAUTH_MODE_OPENCLAW_BROWSER_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK, REAUTH_MODE_NATIVE_CLAUDE, SCHEMA_VERSION } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { readJsonFile, writeJsonFileWithBackupIfChanged } from "../io/json-store.js";
import { ensureAccountShape, normalizeInteractiveOAuthMode } from "./account-shape.js";
import { normalizeAuthorityAnthropicImportMetadata, normalizeAuthorityCodexImportMetadata } from "./authority-normalize.js";
import { pruneOpenaiCodexAgentDemand, pruneOpenaiCodexHistory } from "./demand.js";
import { pruneHermesFleetDemand } from "./demand.js";
import { createEmptyState } from "./empty.js";

export function normalizeLegacyStateV0(raw) {
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
    addLegacyOpenclawAssignment(migrated.targets.openclaw.assignments, agentId, suffix);
  }

  return migrated;
}

export function loadAimgrState(statePath) {
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

export function loadAimgrStateFromJsonValue(raw, sourceDescription = "<memory>") {
  return normalizeAimgrStateFromJsonValue(raw, sourceDescription).state;
}

export function normalizeAimgrStateFromJsonValue(raw, sourceDescription = "<memory>") {
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

function normalizeOpenclawAssignments(assignmentsRaw) {
  const assignments = isObject(assignmentsRaw) ? assignmentsRaw : {};
  const normalized = {};
  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    if (typeof labelRaw !== "string") continue;
    try {
      const agentId = normalizeAgentId(agentIdRaw);
      if (!Object.hasOwn(normalized, agentId)) {
        normalized[agentId] = normalizeLabel(labelRaw);
      }
    } catch {
      // Read-like commands should not fail forever on stale malformed assignment rows.
    }
  }
  return normalized;
}

function addLegacyOpenclawAssignment(assignments, agentIdRaw, labelRaw) {
  if (typeof labelRaw !== "string") return;
  try {
    const agentId = normalizeAgentId(agentIdRaw);
    if (!Object.hasOwn(assignments, agentId)) {
      assignments[agentId] = normalizeLabel(labelRaw);
    }
  } catch {
    // Ignore invalid legacy pins on migration; they must be re-pinned explicitly.
  }
}

export function ensureStateShape(state) {
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
  state.targets.openclaw.assignments = normalizeOpenclawAssignments(state.targets.openclaw.assignments);
  state.targets.openclaw.exclusions = isObject(state.targets.openclaw.exclusions)
    ? state.targets.openclaw.exclusions
    : {};
  state.targets.codexCli = isObject(state.targets.codexCli) ? state.targets.codexCli : {};
  state.targets.sakanaCodex = isObject(state.targets.sakanaCodex) ? state.targets.sakanaCodex : {};
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
      addLegacyOpenclawAssignment(state.targets.openclaw.assignments, agentId, label);
    }
  }
  if (Object.hasOwn(state, "pins")) {
    delete state.pins;
  }

  const legacyAssignments = isObject(state.targets.openclaw.pins) ? state.targets.openclaw.pins : {};
  for (const [agentId, label] of Object.entries(legacyAssignments)) {
    addLegacyOpenclawAssignment(state.targets.openclaw.assignments, agentId, label);
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
