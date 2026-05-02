import { ensureAccountShape } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { buildDirtyImportedAnthropicSyncConflicts, clonePortableAnthropicCredential } from "./anthropic-portable.js";
import { tryBuildAnthropicCredentialFingerprint } from "./anthropic.js";
import { loadAuthorityState } from "./authority-locator.js";
import { formatDirtyImportedAnthropicSyncError } from "./codex-portable.js";
import { buildAnthropicAuthorityIdentityFromCredential, doAnthropicAuthorityIdentitiesMatch, getAuthorityAnthropicImport, getImportedAnthropicLabels } from "../state/authority-anthropic.js";
import { ensureStateShape } from "../state/schema.js";
import { clearManagedClaudeCliAuthFiles, clearManagedClaudeCliTargetState, readClaudeCliTargetStatus } from "../targets/claude-status.js";

export function importAnthropicFromAuthority({ from, state, homeDir, env = {}, discardDirty = false }) {
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
    const currentTarget = readClaudeCliTargetStatus({ state, homeDir, env });
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
