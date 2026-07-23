import { ensureAccountShape, resolveBrowserBinding } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { hasCompleteClaudeNativeBundle } from "./claude-bundle.js";
import { captureAnthropicNativeBundleForLabel, isAnthropicDuplicateNativeBundleErrorMessage } from "./claude-native.js";
import { getAccountBrowserState, getAccountReauthState, getAccountRecord } from "../state/accounts.js";

export async function maintainAnthropicNativeLabel({
  state,
  label,
  homeDir,
}) {
  const normalizedLabel = normalizeLabel(label);
  const existing = getAnthropicCredential(state, normalizedLabel);
  if (hasCompleteClaudeNativeBundle(existing)) {
    throw new Error(
      `Direct Claude token refresh is retired for label=${normalizedLabel}. `
        + `Use \`aim claude run ${normalizedLabel}\` so the official client refreshes under the Redis lease.`,
    );
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
