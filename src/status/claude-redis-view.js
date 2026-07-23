import crypto from "node:crypto";
import { getRedisConfig } from "../config/aimgr-config.js";
import {
  buildRedisStatusClientOptions,
  closeRedisStore,
  connectRedisStore,
  readCredentialRecordsByProvider,
} from "../coordination/redis-store.js";
import { buildStableIdentityForCredential } from "../coordination/login-publish.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import {
  buildClaudeCredentialSummaryFromBundle,
  hasCompleteClaudeNativeBundle,
} from "../credentials/claude-bundle.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { fetchClaudeUsageSnapshot } from "../pool/usage.js";
import { formatStatusTable } from "./table.js";
import {
  acquireRedisCacheLock,
  readCachedProviderUsage,
  releaseRedisCacheLock,
  writeCachedProviderUsage,
} from "./redis-cache.js";

export const CLAUDE_REDIS_USAGE_FRESH_MS = 5 * 60_000;
export const CLAUDE_REDIS_USAGE_STALE_MAX_MS = 60 * 60_000;
export const CLAUDE_REDIS_USAGE_CONCURRENCY = 3;
export const CLAUDE_REDIS_READ_TIMEOUT_MS = 2_000;

const WINDOW_LABEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]{0,39}$/;
const IDENTITY_BINDING_PATTERN = /^sha256:[a-f0-9]{64}$/;
const WINDOW_KINDS = new Set(["session", "weekly_all", "weekly_scoped"]);
const WINDOW_SEVERITIES = new Set(["normal", "warning", "critical", "exceeded", "blocked"]);
const EVIDENCE_GRADES = new Set([
  "provider-current",
  "provider-recent",
  "historical-strong",
  "historical-weak",
  "contradictory",
]);
const EVIDENCE_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const MAX_CLAUDE_REDIS_ACCOUNTS = 256;
const MAX_CLAUDE_USAGE_WINDOWS = 16;
const HEALTHY_USAGE_STATES = new Set(["usage_readable", "usage_limited"]);
const CACHEABLE_AUTH_STATES = new Set([
  ...HEALTHY_USAGE_STATES,
  "scope_blocked",
  "stale_auth",
  "auth_invalid",
  "provider_throttled",
  "provider_error",
  "http_error",
  "malformed_response",
  "timeout",
  "network_error",
]);
const PLAN_TOKEN_MAP = new Map([
  ["max_20x", "max_20x"],
  ["claude_max_20x", "max_20x"],
  ["default_claude_max_20x", "max_20x"],
  ["oauth_claude_max_20x", "max_20x"],
  ["max", "max"],
  ["claude_max", "max"],
  ["oauth_claude_max", "max"],
  ["pro", "pro"],
  ["claude_pro", "pro"],
  ["oauth_claude_pro", "pro"],
  ["team", "team"],
  ["enterprise", "enterprise"],
  ["free", "free"],
]);

function emptyUsage() {
  return { provider: ANTHROPIC_PROVIDER, ok: false, windows: [] };
}

function normalizePlan(value) {
  const plan = typeof value === "string" ? value.trim().toLowerCase() : "";
  return PLAN_TOKEN_MAP.get(plan) ?? null;
}

function normalizeCredentialMetadataToken(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function normalizeBillingEvidence(record, nowMs) {
  const provenance = isObject(record?.provenance) ? record.provenance : {};
  const evidenceGrade = typeof provenance.evidenceGrade === "string"
    && EVIDENCE_GRADES.has(provenance.evidenceGrade.trim())
    ? provenance.evidenceGrade.trim()
    : null;
  const rawDate = typeof provenance.evidenceAsOf === "string" ? provenance.evidenceAsOf.trim() : "";
  const parsedDate = EVIDENCE_DATE_PATTERN.test(rawDate) ? new Date(`${rawDate}T00:00:00.000Z`) : null;
  const now = new Date(nowMs);
  const today = Number.isFinite(now.getTime()) ? now.toISOString().slice(0, 10) : null;
  const evidenceAsOf = parsedDate
    && today
    && Number.isFinite(parsedDate.getTime())
    && parsedDate.toISOString().slice(0, 10) === rawDate
    && rawDate <= today
    ? rawDate
    : null;
  return evidenceGrade && evidenceAsOf
    ? { evidenceGrade, evidenceAsOf }
    : { evidenceGrade: null, evidenceAsOf: null };
}

function normalizeUsageWindow(value) {
  if (!isObject(value)) return null;
  const label = typeof value.label === "string" ? value.label.trim() : "";
  const usedPercent = Number(value.usedPercent);
  if (!WINDOW_LABEL_PATTERN.test(label) || !Number.isFinite(usedPercent)) return null;
  const resetAt = Number(value.resetAt);
  const kind = typeof value.kind === "string" && WINDOW_KINDS.has(value.kind.trim())
    ? value.kind.trim()
    : null;
  const severity = typeof value.severity === "string" && WINDOW_SEVERITIES.has(value.severity.trim().toLowerCase())
    ? value.severity.trim().toLowerCase()
    : null;
  return {
    label,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(Number.isFinite(resetAt) ? { resetAt } : {}),
    ...(kind ? { kind } : {}),
    ...(severity ? { severity } : {}),
    ...(typeof value.active === "boolean" ? { active: value.active } : {}),
  };
}

function normalizeUsage(value) {
  const windows = Array.isArray(value?.windows)
    ? value.windows.slice(0, MAX_CLAUDE_USAGE_WINDOWS).map(normalizeUsageWindow).filter(Boolean)
    : [];
  return {
    provider: ANTHROPIC_PROVIDER,
    ok: windows.length > 0,
    windows,
  };
}

function filterUnexpiredUsage(value, nowMs) {
  const normalized = normalizeUsage(value);
  const windows = normalized.windows.filter((window) => {
    const resetAt = Number(window.resetAt);
    return !Number.isFinite(resetAt) || resetAt > nowMs;
  });
  return {
    provider: ANTHROPIC_PROVIDER,
    ok: windows.length > 0,
    windows,
  };
}

function hasExpiredActiveWindow(entry, nowMs) {
  return Array.isArray(entry?.usage?.windows) && entry.usage.windows.some((window) => {
    const resetAt = Number(window?.resetAt);
    return window?.active !== false && Number.isFinite(resetAt) && resetAt <= nowMs;
  });
}

function hasExhaustedActiveWindow(usage) {
  return Array.isArray(usage?.windows) && usage.windows.some((window) => {
    if (window?.active === false) return false;
    return Number(window?.usedPercent) >= 100 || ["exceeded", "blocked"].includes(window?.severity);
  });
}

function normalizeTimestamp(value, nowMs) {
  const timestamp = Number(value);
  return Number.isFinite(timestamp) && timestamp > 0 && timestamp <= nowMs ? timestamp : null;
}

function ageFrom(nowMs, timestamp) {
  const normalized = normalizeTimestamp(timestamp, nowMs);
  return normalized === null ? Number.POSITIVE_INFINITY : nowMs - normalized;
}

function normalizeCachedEntry(label, value, nowMs) {
  if (!isCanonicalLabel(label) || !isObject(value)) return null;
  const identityBinding = typeof value.identityBinding === "string" && IDENTITY_BINDING_PATTERN.test(value.identityBinding)
    ? value.identityBinding
    : null;
  const lastAttemptAtMs = normalizeTimestamp(value.lastAttemptAtMs, nowMs);
  if (!identityBinding || lastAttemptAtMs === null) return null;
  const usageObservedAtMs = normalizeTimestamp(value.usageObservedAtMs, nowMs);
  const usage = usageObservedAtMs === null ? emptyUsage() : normalizeUsage(value.usage);
  const rawAuthState = typeof value.authState === "string" ? value.authState.trim() : "";
  const authState = CACHEABLE_AUTH_STATES.has(rawAuthState)
    ? rawAuthState
    : usage.ok
      ? hasExhaustedActiveWindow(usage) ? "usage_limited" : "usage_readable"
      : "status_unavailable";
  const rawErrorKind = typeof value.errorKind === "string" ? value.errorKind.trim() : "";
  return {
    identityBinding,
    subscriptionType: normalizePlan(value.subscriptionType),
    rateLimitTier: normalizePlan(value.rateLimitTier),
    authState,
    errorKind: CACHEABLE_AUTH_STATES.has(rawErrorKind) && !HEALTHY_USAGE_STATES.has(rawErrorKind)
      ? rawErrorKind
      : null,
    usageObservedAtMs: usage.ok ? usageObservedAtMs : null,
    lastAttemptAtMs,
    usage,
  };
}

function normalizeCacheEntries(rawEntries, nowMs) {
  const entries = new Map();
  for (const [label, value] of Object.entries(isObject(rawEntries) ? rawEntries : {}).slice(0, MAX_CLAUDE_REDIS_ACCOUNTS)) {
    const normalized = normalizeCachedEntry(label, value, nowMs);
    if (normalized) entries.set(label, normalized);
  }
  return entries;
}

function serializeCacheEntries(entries) {
  return Object.fromEntries(
    [...entries.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .slice(0, MAX_CLAUDE_REDIS_ACCOUNTS)
      .map(([label, entry]) => [label, {
        identityBinding: entry.identityBinding,
        subscriptionType: normalizePlan(entry.subscriptionType),
        rateLimitTier: normalizePlan(entry.rateLimitTier),
        authState: CACHEABLE_AUTH_STATES.has(entry.authState) ? entry.authState : "status_unavailable",
        errorKind: CACHEABLE_AUTH_STATES.has(entry.errorKind) && !HEALTHY_USAGE_STATES.has(entry.errorKind)
          ? entry.errorKind
          : null,
        usageObservedAtMs: normalizeTimestamp(entry.usageObservedAtMs, Number.MAX_SAFE_INTEGER),
        lastAttemptAtMs: normalizeTimestamp(entry.lastAttemptAtMs, Number.MAX_SAFE_INTEGER),
        usage: normalizeUsage(entry.usage),
      }]),
  );
}

function isCanonicalLabel(value) {
  if (typeof value !== "string" || value.length > 256) return false;
  try {
    return normalizeLabel(value) === value;
  } catch {
    return false;
  }
}

function compactIdentity(value) {
  if (!isObject(value)) return {};
  const fields = ["accountUuid", "emailAddress", "organizationUuid"];
  return Object.fromEntries(
    fields
      .map((field) => [field, typeof value[field] === "string" ? value[field].trim().toLowerCase() : ""])
      .filter(([, fieldValue]) => fieldValue),
  );
}

function identitiesAgree(storedIdentity, derivedIdentity) {
  const stored = compactIdentity(storedIdentity);
  const derived = compactIdentity(derivedIdentity);
  const required = ["accountUuid", "emailAddress", "organizationUuid"];
  return required.every((key) => stored[key] && derived[key] && derived[key] === stored[key]);
}

function identityMaterialIsComplete(value) {
  const identity = compactIdentity(value);
  return ["accountUuid", "emailAddress", "organizationUuid"].every((key) => Boolean(identity[key]));
}

function buildAccountIdentityKey(record, derivedIdentity) {
  const identity = compactIdentity(record?.identity);
  if (Object.keys(identity).length === 0 || !identitiesAgree(identity, derivedIdentity)) return null;
  const canonical = Object.fromEntries(Object.entries(identity).sort(([left], [right]) => left.localeCompare(right)));
  const digest = crypto
    .createHash("sha256")
    .update(`${ANTHROPIC_PROVIDER}\u0000${JSON.stringify(canonical)}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function buildIdentityBinding(record, accountIdentityKey, credentialGeneration) {
  if (!accountIdentityKey || !Number.isSafeInteger(credentialGeneration) || credentialGeneration <= 0) return null;
  const digest = crypto
    .createHash("sha256")
    .update(`${ANTHROPIC_PROVIDER}\u0000${record.label}\u0000${credentialGeneration}\u0000${accountIdentityKey}`)
    .digest("hex");
  return `sha256:${digest}`;
}

function buildCredentialFacts(record, nowMs) {
  const credential = isObject(record?.credential) ? record.credential : {};
  const candidateRecord = record?.health?.status === "candidate";
  const summary = buildClaudeCredentialSummaryFromBundle(credential);
  const derivedIdentity = buildStableIdentityForCredential(ANTHROPIC_PROVIDER, credential);
  const storedIdentityComplete = identityMaterialIsComplete(record?.identity);
  const derivedIdentityComplete = identityMaterialIsComplete(derivedIdentity);
  const identityMismatch = storedIdentityComplete
    && derivedIdentityComplete
    && !identitiesAgree(record.identity, derivedIdentity);
  const accountIdentityKey = buildAccountIdentityKey(record, derivedIdentity);
  const credentialGeneration = Number.isSafeInteger(record?.version) && record.version > 0 ? record.version : null;
  const identityBinding = buildIdentityBinding(record, accountIdentityKey, credentialGeneration);
  const expectedEmail = typeof record?.policy?.expect?.email === "string"
    ? record.policy.expect.email.trim().toLowerCase()
    : "";
  const actualEmail = typeof summary?.emailAddress === "string" ? summary.emailAddress.trim().toLowerCase() : "";
  const expiresMs = parseExpiresAtToMs(credential.expiresAt);
  const subscriptionType = normalizePlan(credential.subscriptionType ?? summary?.subscriptionType);
  const rateLimitTier = normalizePlan(credential.rateLimitTier ?? summary?.rateLimitTier);
  const evidence = normalizeBillingEvidence(record, nowMs);
  const scopes = Array.isArray(credential.scopes)
    ? credential.scopes.map((scope) => String(scope ?? "").trim()).filter(Boolean)
    : Array.isArray(summary?.scopes)
      ? summary.scopes
      : [];
  const nativeExpiresMs = parseExpiresAtToMs(summary?.expiresAt);
  const normalizedTopScopes = Array.isArray(credential.scopes)
    ? [...new Set(credential.scopes.map((scope) => String(scope ?? "").trim()).filter(Boolean))].sort()
    : [];
  const normalizedNativeScopes = Array.isArray(summary?.scopes)
    ? [...new Set(summary.scopes.map((scope) => String(scope ?? "").trim()).filter(Boolean))].sort()
    : [];
  const topLevelMatchesNative = Boolean(
    summary
    && typeof credential.access === "string"
    && credential.access === summary.access
    && typeof credential.refresh === "string"
    && credential.refresh === summary.refresh
    && expiresMs !== null
    && nativeExpiresMs !== null
    && expiresMs === nativeExpiresMs
    && typeof credential.emailAddress === "string"
    && credential.emailAddress.trim().toLowerCase() === summary.emailAddress
    && typeof credential.organizationUuid === "string"
    && credential.organizationUuid.trim() === summary.organizationUuid
    && typeof credential.organizationName === "string"
    && credential.organizationName.trim() === summary.organizationName
    && normalizeCredentialMetadataToken(credential.subscriptionType)
    && normalizeCredentialMetadataToken(credential.subscriptionType)
      === normalizeCredentialMetadataToken(summary.subscriptionType)
    && normalizeCredentialMetadataToken(credential.rateLimitTier)
    && normalizeCredentialMetadataToken(credential.rateLimitTier)
      === normalizeCredentialMetadataToken(summary.rateLimitTier)
    && JSON.stringify(normalizedTopScopes) === JSON.stringify(normalizedNativeScopes)
  );

  let state;
  if (Object.keys(credential).length === 0) {
    state = "credential_missing";
  } else if (candidateRecord) {
    state = "credential_candidate";
  } else if (!hasCompleteClaudeNativeBundle(credential)) {
    state = "credential_incomplete";
  } else if (!topLevelMatchesNative) {
    state = "credential_incomplete";
  } else if (!expectedEmail) {
    state = "identity_unverified";
  } else if (expectedEmail !== actualEmail || identityMismatch) {
    state = "identity_mismatch";
  } else if (expiresMs === null || expiresMs <= nowMs) {
    state = "credential_expired";
  } else if (!accountIdentityKey) {
    state = "identity_unverified";
  } else if (credentialGeneration === null) {
    state = "credential_generation_invalid";
  } else if (!scopes.includes("user:profile")) {
    state = "scope_blocked";
  } else {
    state = "credential_ready";
  }

  return {
    record,
    credential,
    accessToken: state === "credential_ready" ? summary.access : null,
    state,
    credentialReady: state === "credential_ready",
    identityPolicyMatched: Boolean(accountIdentityKey && expectedEmail && expectedEmail === actualEmail),
    duplicateEligible: Boolean(accountIdentityKey && expectedEmail && expectedEmail === actualEmail),
    accountIdentityKey,
    credentialGeneration,
    identityBinding,
    subscriptionType,
    rateLimitTier,
    evidenceGrade: evidence.evidenceGrade,
    evidenceAsOf: evidence.evidenceAsOf,
  };
}

function normalizeSelectedLabels(values) {
  if (!Array.isArray(values)) {
    throw new Error("Invalid Claude account label selection.");
  }
  const labels = [];
  for (const value of values) {
    let label;
    try {
      label = typeof value === "string" ? normalizeLabel(value) : null;
    } catch {
      label = null;
    }
    if (!label || label.length > 256) {
      throw new Error("Invalid Claude account label.");
    }
    if (!labels.includes(label)) labels.push(label);
  }
  return labels;
}

async function readAnthropicRecords({
  homeDir,
  connectRedisStoreImpl = connectRedisStore,
  readCredentialRecordsByProviderImpl = readCredentialRecordsByProvider,
} = {}) {
  let store = null;
  try {
    const { redis } = getRedisConfig({ homeDir });
    store = await connectRedisStoreImpl({
      ...redis,
      clientOptions: buildRedisStatusClientOptions({ timeoutMs: CLAUDE_REDIS_READ_TIMEOUT_MS }),
    });
    return await readCredentialRecordsByProviderImpl(store, ANTHROPIC_PROVIDER);
  } catch {
    throw new Error("Claude Redis account inventory is unavailable.");
  } finally {
    try {
      await closeRedisStore(store);
    } catch {
      // Status reads report one fixed value-free availability error.
    }
  }
}

function selectFacts(records, selectedLabels, nowMs) {
  const normalizedLabels = normalizeSelectedLabels(selectedLabels);
  const allFacts = records
    .filter((record) => record.provider === ANTHROPIC_PROVIDER)
    .map((record) => buildCredentialFacts(record, nowMs));
  if (allFacts.length > MAX_CLAUDE_REDIS_ACCOUNTS) {
    throw new Error("Claude Redis account inventory exceeds the safe account limit.");
  }
  const identityCounts = new Map();
  for (const facts of allFacts) {
    if (!facts.duplicateEligible || !facts.accountIdentityKey) continue;
    identityCounts.set(facts.accountIdentityKey, (identityCounts.get(facts.accountIdentityKey) ?? 0) + 1);
  }
  const factsByLabel = new Map(allFacts.map((facts) => {
    if ((identityCounts.get(facts.accountIdentityKey) ?? 0) <= 1) {
      return [facts.record.label, facts];
    }
    return [facts.record.label, {
      ...facts,
      accessToken: null,
      state: "duplicate_account",
      credentialReady: false,
      identityBinding: null,
    }];
  }));
  if (normalizedLabels.some((label) => !factsByLabel.has(label))) {
    throw new Error("Unknown Claude account label.");
  }
  const labels = normalizedLabels.length > 0 ? normalizedLabels : [...factsByLabel.keys()].sort();
  return labels.map((label) => factsByLabel.get(label));
}

function cacheEntryForFacts(cacheEntries, facts) {
  const entry = cacheEntries.get(facts.record.label) ?? null;
  return entry && facts.identityBinding && entry.identityBinding === facts.identityBinding ? entry : null;
}

function shouldUseCachedEntry(entry, { fresh, nowMs }) {
  if (fresh || !entry) return false;
  if (HEALTHY_USAGE_STATES.has(entry.authState) && hasExpiredActiveWindow(entry, nowMs)) return false;
  return ageFrom(nowMs, entry.lastAttemptAtMs) <= CLAUDE_REDIS_USAGE_FRESH_MS;
}

function usableStaleUsage(entry, nowMs) {
  if (!entry || entry.usage?.ok !== true) return { usage: emptyUsage(), observedAtMs: null };
  if (ageFrom(nowMs, entry.usageObservedAtMs) > CLAUDE_REDIS_USAGE_STALE_MAX_MS) {
    return { usage: emptyUsage(), observedAtMs: null };
  }
  const usage = filterUnexpiredUsage(entry.usage, nowMs);
  return usage.ok
    ? { usage, observedAtMs: entry.usageObservedAtMs }
    : { usage: emptyUsage(), observedAtMs: null };
}

function buildStaticAccount(facts, state = facts.state) {
  return {
    label: facts.record.label,
    subscriptionType: facts.subscriptionType,
    rateLimitTier: facts.rateLimitTier,
    authState: state,
    errorKind: state,
    usageObservedAtMs: null,
    lastAttemptAtMs: null,
    usage: emptyUsage(),
    stale: false,
    source: "redis",
    ageMs: null,
  };
}

function buildCachedAccount(facts, entry, nowMs) {
  const staleUsage = usableStaleUsage(entry, nowMs);
  const usageAgeMs = staleUsage.observedAtMs === null ? null : ageFrom(nowMs, staleUsage.observedAtMs);
  let authState = entry.authState;
  if (HEALTHY_USAGE_STATES.has(authState)) {
    authState = staleUsage.usage.ok
      ? hasExhaustedActiveWindow(staleUsage.usage) ? "usage_limited" : "usage_readable"
      : "status_unavailable";
  }
  const stale = staleUsage.usage.ok && (!HEALTHY_USAGE_STATES.has(authState) || usageAgeMs > CLAUDE_REDIS_USAGE_FRESH_MS);
  return {
    label: facts.record.label,
    subscriptionType: entry.subscriptionType ?? facts.subscriptionType,
    rateLimitTier: entry.rateLimitTier ?? facts.rateLimitTier,
    authState,
    errorKind: entry.errorKind,
    usageObservedAtMs: staleUsage.observedAtMs,
    lastAttemptAtMs: entry.lastAttemptAtMs,
    usage: staleUsage.usage,
    stale,
    source: stale ? "stale-cache" : "cache",
    ageMs: Number.isFinite(usageAgeMs) ? usageAgeMs : null,
  };
}

function classifyUsageFailure(snapshot) {
  const status = Number(snapshot?.status);
  if (snapshot?.ok === true) return "malformed_response";
  if (snapshot?.status === "malformed") return "malformed_response";
  if (snapshot?.status === "timeout") return "timeout";
  if (status === 401) return "stale_auth";
  if (status === 403 && snapshot?.missingScope === true) return "scope_blocked";
  if (status === 403) return "auth_invalid";
  if (status === 429) return "provider_throttled";
  if (status >= 500 && status <= 599) return "provider_error";
  if (status >= 400 && status <= 499) return "http_error";
  return "network_error";
}

function buildLiveAccount(facts, snapshot, cachedEntry, nowMs) {
  if (snapshot?.ok === true) {
    const normalizedSnapshot = normalizeUsage(snapshot);
    const usage = hasExpiredActiveWindow({ usage: normalizedSnapshot }, nowMs)
      ? emptyUsage()
      : filterUnexpiredUsage(normalizedSnapshot, nowMs);
    if (usage.ok) {
      return {
        label: facts.record.label,
        subscriptionType: facts.subscriptionType,
        rateLimitTier: facts.rateLimitTier,
        authState: hasExhaustedActiveWindow(usage) ? "usage_limited" : "usage_readable",
        errorKind: null,
        usageObservedAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        usage,
        stale: false,
        source: "live",
        ageMs: 0,
      };
    }
  }

  const errorKind = classifyUsageFailure(snapshot);
  const staleUsage = usableStaleUsage(cachedEntry, nowMs);
  return {
    label: facts.record.label,
    subscriptionType: facts.subscriptionType,
    rateLimitTier: facts.rateLimitTier,
    authState: errorKind,
    errorKind,
    usageObservedAtMs: staleUsage.observedAtMs,
    lastAttemptAtMs: nowMs,
    usage: staleUsage.usage,
    stale: staleUsage.usage.ok,
    source: staleUsage.usage.ok ? "stale-cache" : "live",
    ageMs: staleUsage.observedAtMs === null ? null : ageFrom(nowMs, staleUsage.observedAtMs),
  };
}

function buildRefreshInProgressAccount(facts, cachedEntry, nowMs) {
  const staleUsage = usableStaleUsage(cachedEntry, nowMs);
  return {
    label: facts.record.label,
    subscriptionType: cachedEntry?.subscriptionType ?? facts.subscriptionType,
    rateLimitTier: cachedEntry?.rateLimitTier ?? facts.rateLimitTier,
    authState: "refresh_in_progress",
    errorKind: "refresh_in_progress",
    usageObservedAtMs: staleUsage.observedAtMs,
    lastAttemptAtMs: cachedEntry?.lastAttemptAtMs ?? null,
    usage: staleUsage.usage,
    stale: staleUsage.usage.ok,
    source: staleUsage.usage.ok ? "stale-cache" : "redis",
    ageMs: staleUsage.observedAtMs === null ? null : ageFrom(nowMs, staleUsage.observedAtMs),
  };
}

function toCacheEntry(account, facts) {
  return {
    identityBinding: facts.identityBinding,
    subscriptionType: account.subscriptionType,
    rateLimitTier: account.rateLimitTier,
    authState: account.authState,
    errorKind: account.errorKind,
    usageObservedAtMs: account.usageObservedAtMs,
    lastAttemptAtMs: account.lastAttemptAtMs,
    usage: account.usage,
  };
}

async function mapWithConcurrency(items, concurrency, worker) {
  if (items.length === 0) return [];
  const results = new Array(items.length);
  let nextIndex = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await worker(items[index], index);
    }
  });
  await Promise.all(runners);
  return results;
}

async function settleWithin(promise, timeoutMs) {
  let timeout;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timeout = setTimeout(() => {
          const error = new Error("Provider request timed out.");
          error.name = "TimeoutError";
          reject(error);
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
}

function buildStatusResult({
  accounts,
  nowMs,
  requestCount,
  fresh,
  refreshInProgress = false,
  cacheWriteFailed = false,
  cacheState = "ready",
}) {
  const missingAccounts = accounts
    .filter((account) => !HEALTHY_USAGE_STATES.has(account.authState))
    .map((account) => account.label);
  return {
    ok: accounts.length > 0 && accounts.every((account) => HEALTHY_USAGE_STATES.has(account.authState)),
    checkedAtMs: nowMs,
    source: "redis",
    cacheTtlSeconds: CLAUDE_REDIS_USAGE_FRESH_MS / 1000,
    staleMaxSeconds: CLAUDE_REDIS_USAGE_STALE_MAX_MS / 1000,
    requestCount,
    freshRequested: fresh === true,
    refreshInProgress: refreshInProgress === true,
    cacheWriteFailed: cacheWriteFailed === true,
    cacheState,
    missingAccounts,
    accounts,
  };
}

export async function collectClaudeRedisAccountInventory({
  homeDir,
  nowMs = Date.now(),
  cachePath = resolveAimgrRedisCachePath({ homeDir }),
  connectRedisStoreImpl = connectRedisStore,
  readCredentialRecordsByProviderImpl = readCredentialRecordsByProvider,
} = {}) {
  const records = await readAnthropicRecords({ homeDir, connectRedisStoreImpl, readCredentialRecordsByProviderImpl });
  const facts = selectFacts(records, [], nowMs);
  const cached = readCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER });
  const cacheEntries = normalizeCacheEntries(cached.entries, nowMs);
  const accounts = facts.map((entry) => {
    const cachedEntry = entry.credentialReady ? cacheEntryForFacts(cacheEntries, entry) : null;
    const staleUsage = cachedEntry ? usableStaleUsage(cachedEntry, nowMs) : { usage: emptyUsage(), observedAtMs: null };
    const ageMs = staleUsage.observedAtMs === null ? null : ageFrom(nowMs, staleUsage.observedAtMs);
    return {
      label: entry.record.label,
      evidenceGrade: entry.evidenceGrade,
      evidenceAsOf: entry.evidenceAsOf,
      credentialReady: entry.credentialReady,
      identityPolicyMatched: entry.identityPolicyMatched,
      state: entry.credentialReady
        && cachedEntry
        && ageFrom(nowMs, cachedEntry.lastAttemptAtMs) <= CLAUDE_REDIS_USAGE_FRESH_MS
        ? cachedEntry.authState
        : entry.state,
      subscriptionType: entry.subscriptionType,
      rateLimitTier: entry.rateLimitTier,
      usageObservedAtMs: staleUsage.observedAtMs,
      usage: staleUsage.usage,
      stale: staleUsage.usage.ok && ageMs > CLAUDE_REDIS_USAGE_FRESH_MS,
      source: staleUsage.usage.ok ? ageMs > CLAUDE_REDIS_USAGE_FRESH_MS ? "stale-cache" : "cache" : "redis",
    };
  });
  const countState = (state) => accounts.filter((account) => account.state === state).length;
  const counts = {
    total: accounts.length,
    credentialReady: accounts.filter((account) => account.credentialReady).length,
    credentialMissing: countState("credential_missing"),
    credentialCandidate: countState("credential_candidate"),
    credentialIncomplete: countState("credential_incomplete"),
    credentialExpired: countState("credential_expired"),
    identityUnverified: countState("identity_unverified"),
    identityMismatch: countState("identity_mismatch"),
    duplicateAccount: countState("duplicate_account"),
    credentialGenerationInvalid: countState("credential_generation_invalid"),
  };
  return {
    ok: counts.identityUnverified === 0
      && counts.identityMismatch === 0
      && counts.duplicateAccount === 0
      && counts.credentialGenerationInvalid === 0,
    complete: accounts.length > 0 && accounts.every((account) => account.credentialReady),
    checkedAtMs: nowMs,
    source: "redis",
    requestCount: 0,
    cacheState: cached.state,
    counts,
    accounts,
  };
}

export async function collectClaudeRedisAccountUsageStatus({
  homeDir,
  records = null,
  selectedLabels = [],
  fresh = false,
  nowMs = Date.now(),
  cachePath = resolveAimgrRedisCachePath({ homeDir }),
  connectRedisStoreImpl = connectRedisStore,
  readCredentialRecordsByProviderImpl = readCredentialRecordsByProvider,
  fetchClaudeUsageSnapshotImpl = fetchClaudeUsageSnapshot,
  fetchJsonWithTimeoutImpl,
  acquireRedisCacheLockImpl = acquireRedisCacheLock,
  writeCachedProviderUsageImpl = writeCachedProviderUsage,
} = {}) {
  const normalizedLabels = normalizeSelectedLabels(selectedLabels);
  const authoritativeRecords = Array.isArray(records)
    ? records.filter((record) => record?.provider === ANTHROPIC_PROVIDER)
    : await readAnthropicRecords({ homeDir, connectRedisStoreImpl, readCredentialRecordsByProviderImpl });
  const facts = selectFacts(authoritativeRecords, normalizedLabels, nowMs);
  let cacheRead = readCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER });
  let cacheEntries = normalizeCacheEntries(cacheRead.entries, nowMs);
  const authoritativeLabels = new Set(authoritativeRecords.map((record) => record.label));
  for (const label of cacheEntries.keys()) {
    if (!authoritativeLabels.has(label)) cacheEntries.delete(label);
  }
  const accountsByLabel = new Map();
  let pending = [];

  if (cacheRead.state === "unsafe") {
    const accounts = facts.map((entry) => entry.credentialReady
      ? buildStaticAccount(entry, "cache_unsafe")
      : buildStaticAccount(entry));
    return buildStatusResult({ accounts, nowMs, requestCount: 0, fresh, cacheState: cacheRead.state });
  }

  for (const entry of facts) {
    if (!entry.credentialReady) {
      accountsByLabel.set(entry.record.label, buildStaticAccount(entry));
      continue;
    }
    const cachedEntry = cacheEntryForFacts(cacheEntries, entry);
    if (shouldUseCachedEntry(cachedEntry, { fresh, nowMs })) {
      accountsByLabel.set(entry.record.label, buildCachedAccount(entry, cachedEntry, nowMs));
      continue;
    }
    pending.push({ facts: entry, cachedEntry });
  }

  if (pending.length === 0) {
    return buildStatusResult({
      accounts: facts.map((entry) => accountsByLabel.get(entry.record.label)),
      nowMs,
      requestCount: 0,
      fresh,
      cacheState: cacheRead.state,
    });
  }

  const lock = acquireRedisCacheLockImpl({ homeDir, cachePath, nowMs });
  if (!lock) {
    for (const pendingEntry of pending) {
      accountsByLabel.set(
        pendingEntry.facts.record.label,
        buildRefreshInProgressAccount(pendingEntry.facts, pendingEntry.cachedEntry, nowMs),
      );
    }
    return buildStatusResult({
      accounts: facts.map((entry) => accountsByLabel.get(entry.record.label)),
      nowMs,
      requestCount: 0,
      fresh,
      refreshInProgress: true,
      cacheState: cacheRead.state,
    });
  }

  let requestCount = 0;
  let cacheWriteFailed = false;
  try {
    cacheRead = readCachedProviderUsage({ homeDir, cachePath, provider: ANTHROPIC_PROVIDER });
    cacheEntries = normalizeCacheEntries(cacheRead.entries, nowMs);
    for (const label of cacheEntries.keys()) {
      if (!authoritativeLabels.has(label)) cacheEntries.delete(label);
    }
    if (cacheRead.state === "unsafe") {
      for (const pendingEntry of pending) {
        accountsByLabel.set(
          pendingEntry.facts.record.label,
          buildStaticAccount(pendingEntry.facts, "cache_unsafe"),
        );
      }
      return buildStatusResult({
        accounts: facts.map((entry) => accountsByLabel.get(entry.record.label)),
        nowMs,
        requestCount: 0,
        fresh,
        cacheState: cacheRead.state,
      });
    }
    const afterLock = [];
    for (const pendingEntry of pending) {
      const newest = cacheEntryForFacts(cacheEntries, pendingEntry.facts);
      if (shouldUseCachedEntry(newest, { fresh, nowMs })) {
        accountsByLabel.set(
          pendingEntry.facts.record.label,
          buildCachedAccount(pendingEntry.facts, newest, nowMs),
        );
      } else {
        afterLock.push({ facts: pendingEntry.facts, cachedEntry: newest });
      }
    }

    const refreshed = await mapWithConcurrency(
      afterLock,
      CLAUDE_REDIS_USAGE_CONCURRENCY,
      async ({ facts: entry, cachedEntry }) => {
        requestCount += 1;
        let snapshot;
        try {
          snapshot = await settleWithin(
            fetchClaudeUsageSnapshotImpl({
              accessToken: entry.accessToken,
              timeoutMs: 5000,
              env: {},
              allowWebFallback: false,
              ...(fetchJsonWithTimeoutImpl ? { fetchJsonWithTimeoutImpl } : {}),
            }),
            5000,
          );
        } catch (error) {
          snapshot = {
            provider: ANTHROPIC_PROVIDER,
            ok: false,
            status: error?.name === "AbortError" || error?.name === "TimeoutError" ? "timeout" : "error",
          };
        }
        return { facts: entry, account: buildLiveAccount(entry, snapshot, cachedEntry, nowMs) };
      },
    );
    for (const { facts: entry, account } of refreshed) {
      accountsByLabel.set(entry.record.label, account);
      cacheEntries.set(entry.record.label, toCacheEntry(account, entry));
    }

    try {
      writeCachedProviderUsageImpl({
        homeDir,
        cachePath,
        provider: ANTHROPIC_PROVIDER,
        entries: serializeCacheEntries(cacheEntries),
      });
    } catch {
      // A cache failure must not hide a live provider result or trigger a retry.
      cacheWriteFailed = true;
    }
  } finally {
    releaseRedisCacheLock(lock);
  }

  return buildStatusResult({
    accounts: facts.map((entry) => accountsByLabel.get(entry.record.label)),
    nowMs,
    requestCount,
    fresh,
    cacheWriteFailed,
    cacheState: cacheWriteFailed ? "write_failed" : "ready",
  });
}

function findWindow(usage, labels) {
  const wanted = new Set(labels.map((label) => label.toLowerCase()));
  return Array.isArray(usage?.windows)
    ? usage.windows.find((window) => wanted.has(String(window?.label ?? "").toLowerCase())) ?? null
    : null;
}

function formatPercent(window) {
  const value = Number(window?.usedPercent);
  return Number.isFinite(value) ? `${Math.round(value)}%` : "--";
}

function formatReset(window, nowMs) {
  const resetAt = Number(window?.resetAt);
  if (!Number.isFinite(resetAt)) return "--";
  const deltaMs = resetAt - nowMs;
  if (deltaMs <= 0) return "now";
  const hours = deltaMs / 3_600_000;
  return hours >= 48 ? `${(hours / 24).toFixed(1)}d` : `${hours.toFixed(1)}h`;
}

function formatPlan(entry) {
  const subscription = normalizePlan(entry?.subscriptionType);
  const tier = normalizePlan(entry?.rateLimitTier);
  if (subscription && tier && subscription !== tier) return `${subscription}/${tier}`;
  return subscription || tier || "--";
}

function formatCacheState(value) {
  return new Set(["ready", "missing", "invalid", "unsafe", "write_failed"])
    .has(typeof value === "string" ? value : "")
    ? value
    : "unknown";
}

function usageColumns(accounts, nowMs) {
  const fixed = new Set(["5h", "session", "week", "weekly", "fable", "sonnet", "opus"]);
  const extra = [...new Set(
    accounts.flatMap((entry) => entry.usage.windows
      .filter((window) => window.kind === "weekly_scoped" && !fixed.has(window.label.toLowerCase()))
      .map((window) => window.label)),
  )].sort((left, right) => left.localeCompare(right));
  const headers = ["5h", "5h_in", "week", "wk_in", "Fable", "Fb_in", "Opus", "Op_in", ...extra.flatMap((label) => [label, `${label}_in`])];
  const values = (entry) => {
    const session = findWindow(entry.usage, ["5h", "Session"]);
    const week = findWindow(entry.usage, ["Week", "Weekly"]);
    const fable = findWindow(entry.usage, ["Fable", "Sonnet"]);
    const opus = findWindow(entry.usage, ["Opus"]);
    return [
      formatPercent(session), formatReset(session, nowMs),
      formatPercent(week), formatReset(week, nowMs),
      formatPercent(fable), formatReset(fable, nowMs),
      formatPercent(opus), formatReset(opus, nowMs),
      ...extra.flatMap((label) => {
        const window = findWindow(entry.usage, [label]);
        return [formatPercent(window), formatReset(window, nowMs)];
      }),
    ];
  };
  return { headers, values };
}

export function renderClaudeRedisAccountUsageStatus(result, { includeDiagnostics = true } = {}) {
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  const nowMs = Number(result?.checkedAtMs) || Date.now();
  const columns = usageColumns(accounts, nowMs);
  const rows = [["account", "plan", "state", ...columns.headers, "source"]];
  for (const account of accounts) {
    rows.push([
      account.label,
      formatPlan(account),
      account.authState,
      ...columns.values(account),
      account.source,
    ]);
  }
  const lines = [
    `CLAUDE ACCOUNT USAGE (${accounts.length})`,
    ...formatStatusTable(rows),
  ];
  if (includeDiagnostics) {
    lines.push(
      `requests=${Number(result?.requestCount ?? 0)}  cache_ttl=${Number(result?.cacheTtlSeconds ?? 0)}s  stale_max=${Number(result?.staleMaxSeconds ?? 0)}s`,
      `cache_state=${formatCacheState(result?.cacheState)}  cache_write=${result?.cacheWriteFailed === true ? "failed" : "ok"}`,
    );
    if (Array.isArray(result?.missingAccounts) && result.missingAccounts.length > 0) {
      lines.push(`missing_accounts=${result.missingAccounts.join(",")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function renderClaudeRedisAccountInventory(result) {
  const accounts = Array.isArray(result?.accounts) ? result.accounts : [];
  const nowMs = Number(result?.checkedAtMs) || Date.now();
  const columns = usageColumns(accounts, nowMs);
  const rows = [["account", "evidence", "as_of", "loaded", "state", "plan", ...columns.headers, "source"]];
  for (const account of accounts) {
    rows.push([
      account.label,
      account.evidenceGrade ?? "--",
      account.evidenceAsOf ?? "--",
      account.credentialReady ? "yes" : "no",
      account.state,
      formatPlan(account),
      ...columns.values(account),
      account.source,
    ]);
  }
  const counts = result?.counts ?? {};
  return `${[
    `CLAUDE ACCOUNT INVENTORY (${Number(counts.total ?? accounts.length)})`,
    ...formatStatusTable(rows),
    `loaded=${Number(counts.credentialReady ?? 0)}/${Number(counts.total ?? accounts.length)}  missing=${Number(counts.credentialMissing ?? 0)}  candidate=${Number(counts.credentialCandidate ?? 0)}  incomplete=${Number(counts.credentialIncomplete ?? 0)}  expired=${Number(counts.credentialExpired ?? 0)}  requests=0  complete=${result?.complete === true ? "yes" : "no"}`,
  ].join("\n")}\n`;
}
