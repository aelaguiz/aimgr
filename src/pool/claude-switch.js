import { CLAUDE_MODEL_PRESETS, isClaudeModelPreset } from "../core/constants.js";
import { CLAUDE_ROUTE_ERROR_CODES } from "../network/claude-egress-policy.js";
import { CLAUDE_ADMITTED_PLANS } from "../privacy/claude-provider-admission.js";
import { PLAN_WEEK_WEIGHTS } from "../status/table.js";

const SWITCH_USAGE_FRESH_MS = 2 * 60_000;
const UNKNOWN_USAGE_SCORE = -1;
const AUTH_ERRORS = new Set(["auth_invalid", "stale_auth", "scope_blocked", "reauth_required"]);
const MODEL_SCOPES = new Set([...CLAUDE_MODEL_PRESETS, "haiku"]);
const SHARED_FABLE_SONNET_SCOPE = new Set(["fable", "sonnet"]);

function windowKind(window, label) {
  if (window.kind) return window.kind;
  if (label === "5h" || label === "session") return "session";
  if (label === "week" || label === "weekly") return "weekly_all";
  return "weekly_scoped";
}

function scopeApplies(label, preset) {
  const models = label.split(/[^a-z]+/).filter((word) => MODEL_SCOPES.has(word));
  return models.length === 0
    || models.includes(preset)
    || (SHARED_FABLE_SONNET_SCOPE.has(preset) && models.some((model) => SHARED_FABLE_SONNET_SCOPE.has(model)));
}

function sessionCount(account) {
  return Number.isSafeInteger(account.localSessions) && account.localSessions > 0 ? account.localSessions : 0;
}

function isEligible(account, localSessions) {
  const hasRoute = account.egress?.mode === "direct"
    || (account.egress?.mode === "proxy" && account.egress.localStatus === "configured");
  return account.poolEnabled !== false
    && CLAUDE_ADMITTED_PLANS.includes(account.subscriptionType)
    && hasRoute
    && !CLAUDE_ROUTE_ERROR_CODES.has(account.errorKind)
    && (account.credentialReady === true || account.credentialState === "credential_expired")
    && !AUTH_ERRORS.has(account.authState)
    && !AUTH_ERRORS.has(account.errorKind)
    && (account.locked === false || localSessions > 0);
}

function hasRecentObservation(account, preset, nowMs) {
  // A statusline observation records the general meters only.
  const localSource = account.source === "live"
    || account.source === "cache"
    || (account.source === "session" && preset === "opus");
  return localSource
    && account.credentialReady === true
    && !account.stale
    && !account.errorKind
    && (account.authState === "usage_readable" || account.authState === "usage_limited")
    && Number.isFinite(account.usageObservedAtMs)
    && account.usageObservedAtMs <= nowMs
    && nowMs - account.usageObservedAtMs <= SWITCH_USAGE_FRESH_MS;
}

function assessAccount(account, { preset, nowMs, localSessions }) {
  const plan = account.rateLimitTier ?? account.subscriptionType;
  const weights = PLAN_WEEK_WEIGHTS.claude;
  const weekWeight = Object.hasOwn(weights, plan) ? weights[plan] : 1;
  const windows = account.usage?.ok === true ? account.usage.windows : [];
  const blockingResets = [];
  let remaining = Number.POSITIVE_INFINITY;
  let weightedRemaining = Number.POSITIVE_INFINITY;
  let hasCurrentGeneralMeter = false;
  let needsVerification = false;

  for (const window of windows) {
    const label = window.label.toLowerCase();
    const kind = windowKind(window, label);
    if (kind === "weekly_scoped" && !scopeApplies(label, preset)) continue;

    const resetAt = Number.isFinite(window.resetAt) && window.resetAt > 0 ? window.resetAt : null;
    if (resetAt !== null && resetAt <= nowMs) {
      if (window.active !== false) needsVerification = true;
      continue;
    }
    // The status cache projects elapsed windows to zero with no reset.
    if (account.source !== "live" && window.active === false && window.usedPercent === 0 && resetAt === null) {
      needsVerification = true;
      continue;
    }

    if (window.usedPercent >= 100 || window.severity === "exceeded" || window.severity === "blocked") {
      if (window.active !== false) blockingResets.push(resetAt);
      continue;
    }
    if (!Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;

    const headroom = 100 - window.usedPercent;
    remaining = Math.min(remaining, headroom);
    weightedRemaining = Math.min(weightedRemaining, headroom * (kind === "session" ? 1 : weekWeight));
    if (kind === "session" || kind === "weekly_all") hasCurrentGeneralMeter = true;
  }

  if (blockingResets.length > 0) {
    return { account, resetAt: blockingResets.includes(null) ? null : Math.max(...blockingResets) };
  }

  const hasHeadroomEstimate = Number.isFinite(remaining);
  return {
    account,
    score: hasHeadroomEstimate ? weightedRemaining / (localSessions + 1) : UNKNOWN_USAGE_SCORE,
    remainingPercent: hasHeadroomEstimate ? remaining / (localSessions + 1) : null,
    confirmed: hasCurrentGeneralMeter && !needsVerification && hasRecentObservation(account, preset, nowMs),
  };
}

export function rankClaudeSwitchAccounts(accounts, { preset, nowMs } = {}) {
  if (!isClaudeModelPreset(preset)) {
    throw new Error("Claude automatic selection requires the fable, opus, or sonnet preset.");
  }

  const candidates = [];
  const blocked = [];
  for (const account of accounts) {
    const localSessions = sessionCount(account);
    if (!isEligible(account, localSessions)) continue;
    const assessment = assessAccount(account, { preset, nowMs, localSessions });
    if ("resetAt" in assessment) blocked.push(assessment);
    else candidates.push(assessment);
  }
  candidates.sort((left, right) => (
    right.score - left.score
    || sessionCount(left.account) - sessionCount(right.account)
    || left.account.label.localeCompare(right.account.label)
  ));
  return { candidates, blocked };
}
