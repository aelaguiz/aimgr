import path from "node:path";
import { normalizeBrowserBindingMode, normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { getMissingBrowserActionForBinding } from "../browser/seed.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AIM_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { buildClaudeCredentialSummaryFromBundle, hasCompleteClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { resolveAnthropicBlockedReasonForStatus } from "../credentials/claude-native.js";
import { getCodexUsagePercents } from "./usage.js";

export function derivePoolAccountStatus({ account, label, credentials, browserFacts, now }) {
  const snapshotNow = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const normalizedAccount = isObject(account) ? account : {};
  const reauth = isObject(normalizedAccount.reauth) ? normalizedAccount.reauth : {};
  const browser = isObject(normalizedAccount.browser) ? normalizedAccount.browser : {};
  const provider = normalizeProviderId(normalizedAccount.provider);
  const browserMode = normalizeInteractiveOAuthMode(reauth.mode);
  const bindingMode = normalizeBrowserBindingMode(browser.mode);
  const blockedReason = typeof reauth.blockedReason === "string" ? reauth.blockedReason.trim() : "";
  const conflictReason = typeof browser.conflictReason === "string" ? browser.conflictReason.trim() : "";
  const expectedEmail =
    typeof normalizedAccount.expect?.email === "string" ? normalizedAccount.expect.email.trim().toLowerCase() : "";
  const browserEmail =
    typeof browserFacts?.userName === "string" ? browserFacts.userName.trim().toLowerCase() : "";
  const credential = isObject(credentials) ? credentials : null;
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

  if (browserMode === REAUTH_MODE_BROWSER_MANAGED && browserFacts?.bindingPresent !== true) {
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "binding_missing_for_future_reauth",
        eligible: true,
        actionRequired: "run_aim_browser_set",
        reason:
          "Credentials are still usable now; set an explicit browser binding before the next browser-managed reauth.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "binding_missing_for_future_reauth",
      eligible: false,
      actionRequired: "run_aim_browser_set",
      reason: "No explicit browser binding is configured for this browser-managed label.",
    };
  }

  if (
    browserMode === REAUTH_MODE_BROWSER_MANAGED
    && browserFacts?.bindingPresent === true
    && browserFacts?.exists !== true
  ) {
    const missingAction = getMissingBrowserActionForBinding({
      label: normalizeLabel(label),
      bindingMode,
    });
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "missing_browser",
        eligible: true,
        actionRequired: missingAction.actionRequired,
        reason:
          bindingMode === BROWSER_MODE_AIM_PROFILE
            ? "Credentials are still usable now; run `aim <label>` later to recreate the missing AIM-managed browser profile."
            : "Credentials are still usable now; repair the missing mapped browser binding before the next browser-managed reauth.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "missing_browser",
      eligible: false,
      actionRequired: missingAction.actionRequired,
      reason:
        bindingMode === BROWSER_MODE_AIM_PROFILE
          ? "AIM-managed browser profile is missing for this label."
          : "Configured browser binding cannot be resolved on disk.",
    };
  }

  if (
    browserMode === REAUTH_MODE_BROWSER_MANAGED
    && bindingMode === BROWSER_MODE_AIM_PROFILE
    && typeof browser.seededAt === "string"
    && browser.seededAt.trim()
    && !(typeof browser.verifiedAt === "string" && browser.verifiedAt.trim())
  ) {
    if (hasFreshCredentials) {
      return {
        operatorStatus: "ready",
        detailReason: "seeded_unverified",
        eligible: true,
        actionRequired: "run_aim_label",
        reason:
          "Credentials are still usable now; run `aim <label>` later to verify the seeded AIM-owned browser profile.",
      };
    }
    return {
      operatorStatus: "reauth",
      detailReason: "seeded_unverified",
      eligible: false,
      actionRequired: "run_aim_label",
      reason: "AIM browser profile was seeded but not yet verified by a successful AIM-managed login or refresh.",
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
  if (snapshot.ok !== true) {
    return snapshot.status === 429 || snapshot.status === 409 || /rate limit|exhaust/i.test(String(snapshot.error ?? ""));
  }
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  return primaryUsedPct >= 95 || secondaryUsedPct >= 95;
}
