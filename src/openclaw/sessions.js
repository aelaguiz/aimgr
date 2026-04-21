import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { readJsonFile, writeJsonFileWithBackup } from "../io/json-store.js";
import { resolveOpenclawSessionsStorePath } from "./stores.js";

export function parseProviderModelRef(raw) {
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

export function normalizeSessionResetTarget({ desiredProvider, desiredModel }) {
  const provider = String(desiredProvider ?? "").trim();
  const model = String(desiredModel ?? "").trim();
  if ((provider && !model) || (!provider && model)) {
    throw new Error("Session reset target requires desiredProvider + desiredModel together.");
  }
  return { provider, model };
}

export function extractProviderFromAuthProfileOverride(rawValue) {
  const raw = typeof rawValue === "string" ? rawValue.trim() : "";
  if (!raw) return null;
  const delimiter = raw.indexOf(":");
  if (delimiter <= 0) return null;
  return normalizeProviderId(raw.slice(0, delimiter));
}

export function shouldClearSessionAuthProfileOverride({
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

export function applyOpenclawSessionsDiskResets({
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
