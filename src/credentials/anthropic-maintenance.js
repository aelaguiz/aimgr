import { refreshAnthropicToken } from "@mariozechner/pi-ai";
import { ensureAccountShape, resolveBrowserBinding } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { toIsoFromExpiresMs } from "../core/time.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { assertAnthropicCredentialShape } from "./anthropic.js";
import { deriveAnthropicCredentialFromClaudeBundle, getClaudeNativeBundle, hasCompleteClaudeNativeBundle, updateClaudeBundleTokenFields } from "./claude-bundle.js";
import { captureAnthropicNativeBundleForLabel, isAnthropicDuplicateNativeBundleErrorMessage } from "./claude-native.js";
import { getAccountBrowserState, getAccountReauthState, getAccountRecord } from "../state/accounts.js";

export async function refreshAnthropicNativeBundleCredential({
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

export async function maintainAnthropicNativeLabel({
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

export function recordAccountMaintenanceAttempt(state, label, { providerHint = null } = {}) {
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

export function recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt }) {
  const verifiedAt = String(observedAt ?? new Date().toISOString());
  const reauth = getAccountReauthState(state, label, { create: true });
  reauth.lastAttemptAt = verifiedAt;
  reauth.lastVerifiedAt = verifiedAt;
  if (Object.hasOwn(reauth, "blockedReason")) {
    delete reauth.blockedReason;
  }

  const browser = getAccountBrowserState(state, label);
  if (browser && browser.conflictReason) {
    delete browser.conflictReason;
  }
  const binding = resolveBrowserBinding({ account: getAccountRecord(state, label), homeDir, label });
  if (browser && binding) {
    browser.verifiedAt = verifiedAt;
  }
}

export function recordAccountMaintenanceFailure(state, label, { observedAt, blockedReason } = {}) {
  const failedAt = String(observedAt ?? new Date().toISOString());
  const reauth = getAccountReauthState(state, label, { create: true });
  reauth.lastAttemptAt = failedAt;
  if (isAnthropicDuplicateNativeBundleErrorMessage(reauth.blockedReason)) {
    delete reauth.blockedReason;
  }
  if (typeof blockedReason === "string" && blockedReason.trim()) {
    reauth.blockedReason = blockedReason.trim();
  }
}
