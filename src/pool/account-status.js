import path from "node:path";
import { normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { buildClaudeCredentialSummaryFromBundle, hasCompleteClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { resolveAnthropicBlockedReasonForStatus } from "../credentials/claude-native.js";
import { getCodexUsagePercents } from "./usage.js";

export function derivePoolAccountStatus({ account, label, credentials, browserFacts, now }) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedAccount = isObject(account) ? account : {};
  const reauth = isObject(normalizedAccount.reauth) ? normalizedAccount.reauth : {};
  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : {};
  const provider = normalizeProviderId(normalizedAccount.provider);
  const browserMode = normalizeInteractiveOAuthMode(reauth.mode);
  const blockedReason = typeof reauth.blockedReason === "string" ? reauth.blockedReason.trim() : "";
  const conflictReason = typeof browser.conflictReason === "string" ? browser.conflictReason.trim() : "";
  const expectedEmail =
    typeof normalizedAccount.expect?.email === "string" ? normalizedAccount.expect.email.trim().toLowerCase() : "";
  const browserEmail =
    typeof browserFacts?.userName === "string" ? browserFacts.userName.trim().toLowerCase() : "";
  const rawCredential = isObject(credentials) ? credentials : null;
  const credential = provider === ANTHROPIC_PROVIDER
    ? getAnthropicCredentialView(rawCredential)
    : rawCredential;
  const expiresMs = parseExpiresAtToMs(credential?.expiresAt);
  const storedEmail =
    provider === ANTHROPIC_PROVIDER
      ? (
        buildClaudeCredentialSummaryFromBundle(credential)?.emailAddress
        || (typeof credential?.emailAddress === "string" ? credential.emailAddress.trim().toLowerCase() : "")
      )
      : "";
  const hasFreshCredentials =
    credential
    && typeof credential.access === "string"
    && credential.access.trim()
    && typeof credential.refresh === "string"
    && credential.refresh.trim()
    && expiresMs !== null
    && expiresMs > snapshotNow
    && (provider !== OPENAI_CODEX_PROVIDER || typeof credential.accountId === "string" && credential.accountId.trim());
  const hasCompleteClaudeBundle =
    provider !== ANTHROPIC_PROVIDER || hasCompleteClaudeNativeBundle(credential);
  const effectiveAnthropicBlockedReason =
    provider === ANTHROPIC_PROVIDER
      ? resolveAnthropicBlockedReasonForStatus({
          blockedReason,
          hasFreshCredentials,
          hasCompleteClaudeBundle,
        })
      : blockedReason;

  if (blockedReason === "oauth_reauth_required") {
    return {
      operatorStatus: "reauth",
      detailReason: "reauth_required",
      eligible: false,
      actionRequired: "run_aim_label",
      reason: "OAuth refresh is no longer usable; run the existing AIM login flow.",
    };
  }

  if (provider === ANTHROPIC_PROVIDER) {
    if (effectiveAnthropicBlockedReason) {
      return {
        operatorStatus: "blocked",
        eligible: false,
        actionRequired: "fix_blocker",
        reason: effectiveAnthropicBlockedReason,
      };
    }
    if (expectedEmail && storedEmail && expectedEmail !== storedEmail) {
      return {
        operatorStatus: "blocked",
        detailReason: "conflict",
        eligible: false,
        actionRequired: "fix_blocker",
        reason: `Stored Claude identity ${storedEmail} does not match expected ${expectedEmail}.`,
      };
    }
    if (!hasFreshCredentials) {
      return {
        operatorStatus: "reauth",
        detailReason: "missing_credentials",
        eligible: false,
        actionRequired: "run_aim_label",
        reason:
          expiresMs !== null && expiresMs <= snapshotNow
            ? "Credentials are expired."
            : "No currently usable credentials are stored for this label.",
      };
    }
    if (!hasCompleteClaudeBundle) {
      return {
        operatorStatus: "reauth",
        detailReason: "missing_native_claude_bundle",
        eligible: false,
        actionRequired: "run_aim_claude_capture_native",
        reason:
          "Stored Anthropic tokens are still fresh, but this label does not have a complete native Claude login bundle yet.",
      };
    }
    return {
      operatorStatus: "ready",
      detailReason: "native_claude",
      eligible: true,
      actionRequired: null,
      reason: "Ready for native Claude switching.",
    };
  }

  if (conflictReason) {
    return {
      operatorStatus: "blocked",
      detailReason: "conflict",
      eligible: false,
      actionRequired: "fix_conflict",
      reason: conflictReason,
    };
  }
  if (expectedEmail && browserEmail && expectedEmail !== browserEmail) {
    return {
      operatorStatus: "blocked",
      detailReason: "conflict",
      eligible: false,
      actionRequired: "fix_conflict",
      reason: `Browser identity ${browserEmail} does not match expected ${expectedEmail}.`,
    };
  }
  if (blockedReason) {
    return {
      operatorStatus: "blocked",
      eligible: false,
      actionRequired: "fix_blocker",
      reason: blockedReason,
    };
  }

  if (!hasFreshCredentials) {
    return {
      operatorStatus: "reauth",
      detailReason: "missing_credentials",
      eligible: false,
      actionRequired: "run_aim_label",
      reason:
        expiresMs !== null && expiresMs <= snapshotNow
          ? "Credentials are expired."
          : "No currently usable credentials are stored for this label.",
    };
  }

  if (browserMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return {
      operatorStatus: "ready",
      detailReason: "manual_mode",
      eligible: true,
      actionRequired: null,
      reason: "Ready; recovery path uses manual callback/SSO when needed.",
    };
  }

  return {
    operatorStatus: "ready",
    eligible: true,
    actionRequired: null,
    reason: "Ready for selection and rebalance.",
  };
}

export function isUsageSnapshotExhausted(snapshot) {
  if (!snapshot) return false;
  if (isUsageSnapshotHardRateLimited(snapshot)) return true;
  if (snapshot.ok !== true) return false;
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  return primaryUsedPct >= 95 || secondaryUsedPct >= 95;
}

export function isUsageSnapshotHardRateLimited(snapshot) {
  if (!snapshot) return false;
  if (snapshot.ok !== true) {
    return snapshot.status === 429 || snapshot.status === 409 || /rate limit|usage limit|too many requests|exhaust/i.test(String(snapshot.error ?? ""));
  }
  if (snapshot.allowed === false || snapshot.limitReached === true) return true;
  if (typeof snapshot.rateLimitReachedType === "string" && snapshot.rateLimitReachedType.trim()) return true;
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  return primaryUsedPct >= 100 || secondaryUsedPct >= 100;
}
