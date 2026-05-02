import { ensureAccountShape, normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { assertNoCodexAccountIdCollisions, getCodexCredential } from "../browser/seed.js";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { buildDirtyImportedCodexSyncConflicts } from "./anthropic-portable.js";
import { loadAuthorityState } from "./authority-locator.js";
import { buildPortableCodexCredential, formatDirtyImportedCodexSyncError } from "./codex-portable.js";
import { buildCodexCredentialFingerprint } from "./codex.js";
import { getImportedCodexLabels } from "../state/accounts.js";
import { getAuthorityCodexImport } from "../state/authority-codex.js";
import { ensureStateShape } from "../state/schema.js";
import { readCodexCliTargetStatus } from "../targets/codex-cli.js";
import { clearManagedCodexCliActivation } from "../targets/codex-store.js";
import { clearManagedPiCliActivation, readPiCliTargetStatus } from "../targets/pi-cli.js";

export function importCodexFromAuthority({ from, state, homeDir, env = {}, discardDirty = false }) {
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
    const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
    const currentPiTarget = readPiCliTargetStatus({ state, homeDir, env });
    const removedLabelWasLiveTarget = currentTarget.activeLabel === label || currentTarget.inferredLabel === label;
    const removedLabelWasLivePiTarget = currentPiTarget.activeLabel === label || currentPiTarget.inferredLabel === label;
    delete state.accounts[label];
    delete state.credentials[OPENAI_CODEX_PROVIDER][label];
    if (removedLabelWasLiveTarget) {
      clearManagedCodexCliActivation({ state, homeDir, env });
      delete state.targets.codexCli.lastSelectionReceipt;
      delete state.targets.codexCli.lastWatchReceipt;
    }
    if (removedLabelWasLivePiTarget) {
      clearManagedPiCliActivation({ state, homeDir, env });
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
