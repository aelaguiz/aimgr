import { resolveOpenclawProfileIdForProviderLabel } from "../browser/seed.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { readJsonFile, writeJsonFileWithBackupIfChanged } from "../io/json-store.js";
import { resolveHomeDir, resolveOpenclawAuthStorePath } from "../io/paths.js";
import { discoverOpenclawAgentIdsWithAuthStores } from "./stores.js";
import { getOpenclawPins } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

function isManagedOpenclawProfileEntry({ profileId, credential, supportedProviderSet }) {
  const provider = normalizeProviderId(credential?.provider);
  if (supportedProviderSet.has(provider)) {
    return true;
  }
  const id = typeof profileId === "string" ? profileId.trim() : "";
  const delimiter = id.indexOf(":");
  if (delimiter <= 0) {
    return false;
  }
  return supportedProviderSet.has(normalizeProviderId(id.slice(0, delimiter)));
}

export function applyOpenclawFromState(params, state, { pinsOverride, managedAgentIds } = {}) {
  const homeDir = typeof params.homeDir === "string" && params.homeDir.trim()
    ? params.homeDir
    : resolveHomeDir(params.home, { env: params.env });
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
      const storedCredential = credsByLabel[label];
      const cred = provider === ANTHROPIC_PROVIDER
        ? getAnthropicCredentialView(storedCredential)
        : storedCredential;
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
    if (!isManagedOpenclawProfileEntry({ profileId, credential: existingCred, supportedProviderSet })) continue;
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
      if (!isManagedOpenclawProfileEntry({ profileId: pid, credential: c, supportedProviderSet })) continue;
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
