import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { buildCodexCredentialFingerprint } from "../credentials/codex.js";
import { clampPercent } from "../core/numbers.js";
import { isObject } from "../core/normalize.js";
import { fetchJsonWithTimeout } from "../io/fetch.js";
import { ensureStateShape } from "../state/schema.js";
import {
  acquireRedisCacheLock,
  readCachedProviderUsage,
  releaseRedisCacheLock,
  writeCachedProviderUsage,
} from "../status/redis-cache.js";

export async function fetchCodexUsageSnapshot({
  accessToken,
  accountId,
  timeoutMs,
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
}) {
  const headers = {
    Authorization: `Bearer ${accessToken}`,
    "User-Agent": "CodexBar",
    Accept: "application/json",
    ...(accountId ? { "ChatGPT-Account-Id": accountId } : {}),
  };

  const res = await fetchJsonWithTimeoutImpl(
    "https://chatgpt.com/backend-api/wham/usage",
    { method: "GET", headers },
    timeoutMs,
  );

  if (!res.ok) {
    let error;
    let rateLimitMetadata = {};
    try {
      const data = await res.json();
      rateLimitMetadata = extractCodexRateLimitMetadata(data);
      const rawError = data?.error?.message ?? data?.message ?? data?.detail;
      if (typeof rawError === "string" && rawError.trim()) {
        error = rawError.trim();
      }
    } catch {
      // ignore parse errors
    }
    return {
      provider: OPENAI_CODEX_PROVIDER,
      ok: false,
      status: res.status,
      tokenExpired: res.status === 401 || res.status === 403,
      ...(error ? { error } : {}),
      ...rateLimitMetadata,
    };
  }

  const data = await res.json();
  const rateLimitMetadata = extractCodexRateLimitMetadata(data);
  const windows = [];

  const primary = data?.rate_limit?.primary_window;
  if (primary) {
    const windowHours = Math.round(((primary.limit_window_seconds || 10800) * 1.0) / 3600);
    windows.push({
      label: `${windowHours}h`,
      usedPercent: clampPercent(primary.used_percent || 0),
      resetAt: primary.reset_at ? primary.reset_at * 1000 : undefined,
    });
  }

  const secondary = data?.rate_limit?.secondary_window;
  if (secondary) {
    const windowHours = Math.round(((secondary.limit_window_seconds || 86400) * 1.0) / 3600);
    const label = windowHours >= 168 ? "Week" : windowHours >= 24 ? "Day" : `${windowHours}h`;
    windows.push({
      label,
      usedPercent: clampPercent(secondary.used_percent || 0),
      resetAt: secondary.reset_at ? secondary.reset_at * 1000 : undefined,
    });
  }

  let plan = data?.plan_type;
  const balanceRaw = data?.credits?.balance;
  if (balanceRaw !== undefined && balanceRaw !== null) {
    const balance = typeof balanceRaw === "number" ? balanceRaw : parseFloat(balanceRaw) || 0;
    plan = plan ? `${plan} ($${balance.toFixed(2)})` : `$${balance.toFixed(2)}`;
  }

  return {
    provider: OPENAI_CODEX_PROVIDER,
    ok: true,
    windows,
    plan,
    ...rateLimitMetadata,
  };
}

export function extractCodexRateLimitMetadata(data) {
  const metadata = {};
  const rateLimit = isObject(data?.rate_limit) ? data.rate_limit : {};
  const allowed =
    typeof data?.allowed === "boolean"
      ? data.allowed
      : typeof rateLimit.allowed === "boolean"
        ? rateLimit.allowed
        : undefined;
  const limitReached =
    typeof data?.limit_reached === "boolean"
      ? data.limit_reached
      : typeof rateLimit.limit_reached === "boolean"
        ? rateLimit.limit_reached
        : undefined;
  const rateLimitReachedTypeRaw =
    typeof data?.rate_limit_reached_type === "string"
      ? data.rate_limit_reached_type
      : typeof rateLimit.rate_limit_reached_type === "string"
        ? rateLimit.rate_limit_reached_type
        : "";
  const rateLimitReachedType = rateLimitReachedTypeRaw.trim();

  if (allowed !== undefined) {
    metadata.allowed = allowed;
  }
  if (limitReached !== undefined) {
    metadata.limitReached = limitReached;
  }
  if (rateLimitReachedType) {
    metadata.rateLimitReachedType = rateLimitReachedType;
  }
  return metadata;
}

const CLAUDE_LIMIT_KINDS = new Set(["session", "weekly_all", "weekly_scoped"]);
const CLAUDE_LIMIT_SEVERITIES = new Set(["normal", "warning", "critical", "exceeded", "blocked"]);

function normalizeClaudeUsageLabel(value, fallback) {
  const label = typeof value === "string" ? value.trim() : "";
  if (label && label.length <= 40 && /^[A-Za-z0-9][A-Za-z0-9 ._:/()-]*$/.test(label)) {
    return label;
  }
  return fallback;
}

function claudeLimitSortRank(window) {
  if (window?.kind === "session") return 0;
  if (window?.kind === "weekly_all") return 1;
  if (window?.kind === "weekly_scoped") return 2;
  return 3;
}

export function buildClaudeUsageWindows(data) {
  if (Array.isArray(data?.limits) && data.limits.length > 0) {
    const windows = data.limits
      .map((limit, sourceIndex) => {
        const usedPercent = limit?.percent;
        if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent)) return null;
        const rawKind = typeof limit?.kind === "string" ? limit.kind.trim() : "";
        if (!CLAUDE_LIMIT_KINDS.has(rawKind)) return null;
        const kind = rawKind;
        const modelName = normalizeClaudeUsageLabel(limit?.scope?.model?.display_name, "");
        const surfaceName = normalizeClaudeUsageLabel(
          limit?.scope?.surface?.display_name ?? limit?.scope?.surface,
          "",
        );
        if (kind === "weekly_scoped" && !modelName && !surfaceName) return null;
        const label =
          kind === "session"
            ? "5h"
            : kind === "weekly_all"
              ? "Week"
              : modelName || surfaceName;
        const resetAt = limit?.resets_at ? new Date(limit.resets_at).getTime() : undefined;
        const rawSeverity = typeof limit?.severity === "string" ? limit.severity.trim().toLowerCase() : "";
        const severity = CLAUDE_LIMIT_SEVERITIES.has(rawSeverity) ? rawSeverity : "";
        return {
          label,
          usedPercent: clampPercent(usedPercent),
          ...(Number.isFinite(resetAt) ? { resetAt } : {}),
          ...(kind ? { kind } : {}),
          ...(severity ? { severity } : {}),
          ...(typeof limit?.is_active === "boolean" ? { active: limit.is_active } : {}),
          sourceIndex,
        };
      })
      .filter(Boolean)
      .sort((left, right) => claudeLimitSortRank(left) - claudeLimitSortRank(right) || left.sourceIndex - right.sourceIndex)
      .map(({ sourceIndex: _sourceIndex, ...window }) => window);
    if (windows.length > 0) {
      return windows;
    }
  }
  const windows = [];

  if (typeof data?.five_hour?.utilization === "number" && Number.isFinite(data.five_hour.utilization)) {
    windows.push({
      label: "5h",
      usedPercent: clampPercent(data.five_hour.utilization),
      resetAt: data.five_hour.resets_at ? new Date(data.five_hour.resets_at).getTime() : undefined,
    });
  }

  if (typeof data?.seven_day?.utilization === "number" && Number.isFinite(data.seven_day.utilization)) {
    windows.push({
      label: "Week",
      usedPercent: clampPercent(data.seven_day.utilization),
      resetAt: data.seven_day.resets_at ? new Date(data.seven_day.resets_at).getTime() : undefined,
    });
  }

  if (typeof data?.seven_day_sonnet?.utilization === "number" && Number.isFinite(data.seven_day_sonnet.utilization)) {
    windows.push({
      label: "Fable",
      usedPercent: clampPercent(data.seven_day_sonnet.utilization),
      resetAt: data.seven_day_sonnet.resets_at ? new Date(data.seven_day_sonnet.resets_at).getTime() : undefined,
    });
  }

  if (typeof data?.seven_day_opus?.utilization === "number" && Number.isFinite(data.seven_day_opus.utilization)) {
    windows.push({
      label: "Opus",
      usedPercent: clampPercent(data.seven_day_opus.utilization),
      resetAt: data.seven_day_opus.resets_at ? new Date(data.seven_day_opus.resets_at).getTime() : undefined,
    });
  }

  return windows;
}

export async function fetchClaudeUsageSnapshot({
  accessToken,
  timeoutMs,
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
}) {
  const res = await fetchJsonWithTimeoutImpl(
    "https://api.anthropic.com/api/oauth/usage",
    {
      method: "GET",
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "User-Agent": "aimgr",
        Accept: "application/json",
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "oauth-2025-04-20",
      },
    },
    timeoutMs,
  );

  if (!res.ok) {
    let message;
    try {
      const data = await res.json();
      const raw = data?.error?.message;
      if (typeof raw === "string" && raw.trim()) {
        message = raw.trim();
      }
    } catch {
      // ignore parse errors
    }

    const missingScope = res.status === 403 && message?.includes("scope requirement user:profile");
    return {
      provider: ANTHROPIC_PROVIDER,
      ok: false,
      status: res.status,
      ...(message ? { error: message } : {}),
      ...(missingScope ? { missingScope: true } : {}),
      ...(!missingScope && (res.status === 401 || res.status === 403) ? { tokenExpired: true } : {}),
    };
  }

  let data;
  try {
    data = await res.json();
  } catch {
    return {
      provider: ANTHROPIC_PROVIDER,
      ok: false,
      status: "malformed",
    };
  }
  const windows = buildClaudeUsageWindows(data);
  if (windows.length === 0) {
    return {
      provider: ANTHROPIC_PROVIDER,
      ok: false,
      status: "malformed",
    };
  }
  const opusUnavailable =
    Object.hasOwn(data ?? {}, "seven_day_opus") && (data?.seven_day_opus === null || data?.seven_day_opus === undefined);

  return {
    provider: ANTHROPIC_PROVIDER,
    ok: true,
    windows,
    ...(opusUnavailable ? { opusUnavailable: true } : {}),
  };
}

export function getCodexUsagePercents(snapshot) {
  if (!snapshot || snapshot.ok !== true) {
    return { primaryUsedPct: 100, secondaryUsedPct: 100 };
  }
  const windows = Array.isArray(snapshot.windows) ? snapshot.windows : [];
  return {
    primaryUsedPct: clampPercent(windows[0]?.usedPercent ?? 0),
    secondaryUsedPct: clampPercent(windows[1]?.usedPercent ?? 0),
  };
}

export async function probeUsageSnapshotsByProvider(state, { fetchJsonWithTimeoutImpl = fetchJsonWithTimeout } = {}) {
  ensureStateShape(state);
  const usageByProvider = {
    [OPENAI_CODEX_PROVIDER]: {},
    [ANTHROPIC_PROVIDER]: {},
  };
  const probes = [];

  for (const [label, cred] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        const accountId = typeof cred.accountId === "string" ? cred.accountId.trim() : null;
        try {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = await fetchCodexUsageSnapshot({
            accessToken: cred.access,
            accountId,
            timeoutMs: 8000,
            fetchJsonWithTimeoutImpl,
          });
        } catch (err) {
          usageByProvider[OPENAI_CODEX_PROVIDER][label] = {
            provider: OPENAI_CODEX_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  for (const [label, storedCredential] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    const cred = getAnthropicCredentialView(storedCredential);
    if (!isObject(cred) || typeof cred.access !== "string") continue;
    probes.push(
      (async () => {
        try {
          usageByProvider[ANTHROPIC_PROVIDER][label] = await fetchClaudeUsageSnapshot({
            accessToken: cred.access,
            timeoutMs: 8000,
            allowWebFallback: false,
            fetchJsonWithTimeoutImpl,
          });
        } catch (err) {
          usageByProvider[ANTHROPIC_PROVIDER][label] = {
            provider: ANTHROPIC_PROVIDER,
            ok: false,
            status: "error",
            error: String(err?.message ?? err),
          };
        }
      })(),
    );
  }

  await Promise.all(probes);
  return usageByProvider;
}

function hasUsableUsage(value) {
  return value?.ok === true && Array.isArray(value.windows) && value.windows.length > 0;
}

function codexUsageUnavailable() {
  return {
    provider: OPENAI_CODEX_PROVIDER,
    ok: false,
    status: "unavailable",
    source: "unavailable",
    stale: false,
  };
}

export const CODEX_USAGE_FRESH_MS = 5 * 60_000;

/**
 * Build the shared provider-usage snapshot consumed by status and automatic
 * Codex selection. Live values win. A cache entry is usable only for the exact
 * credential fingerprint that produced it, and its age stays visible.
 */
export async function collectCodexUsageSnapshots({
  state,
  homeDir,
  env = {},
  nowMs = Date.now(),
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
} = {}) {
  ensureStateShape(state);
  const canUseCache = typeof homeDir === "string" && homeDir.trim().length > 0;
  const cached = canUseCache
    ? readCachedProviderUsage({ homeDir, provider: OPENAI_CODEX_PROVIDER }).entries
    : {};
  const resolvedCodex = {};
  const nextCacheEntries = {};
  const credentialsToProbe = {};
  const credentialFacts = new Map();

  for (const [label, credential] of Object.entries(state.credentials[OPENAI_CODEX_PROVIDER])) {
    let identityBinding;
    try {
      identityBinding = buildCodexCredentialFingerprint(credential);
    } catch {
      resolvedCodex[label] = codexUsageUnavailable();
      continue;
    }
    const cachedEntry = cached[label];
    const cacheMatches = cachedEntry?.identityBinding === identityBinding && hasUsableUsage(cachedEntry.usage);
    const lastAttemptAtMs = Number(cachedEntry?.lastAttemptAtMs);
    const attemptAgeMs = Number.isFinite(lastAttemptAtMs) ? nowMs - lastAttemptAtMs : null;
    const usageObservedAtMs = Number(cachedEntry?.usageObservedAtMs);
    const usageAgeMs = Number.isFinite(usageObservedAtMs) ? Math.max(0, nowMs - usageObservedAtMs) : null;
    if (
      cacheMatches
      && Number.isFinite(attemptAgeMs)
      && attemptAgeMs >= 0
      && attemptAgeMs <= CODEX_USAGE_FRESH_MS
    ) {
      resolvedCodex[label] = {
        ...cachedEntry.usage,
        source: "cache",
        stale: usageAgeMs === null || usageAgeMs > CODEX_USAGE_FRESH_MS,
        observedAtMs: Number.isFinite(usageObservedAtMs) ? usageObservedAtMs : null,
        ageMs: usageAgeMs,
      };
      nextCacheEntries[label] = cachedEntry;
      continue;
    }
    credentialsToProbe[label] = credential;
    credentialFacts.set(label, { identityBinding, cachedEntry, cacheMatches });
  }

  let liveByProvider = {};
  if (Object.keys(credentialsToProbe).length > 0) {
    const reducedState = structuredClone(state);
    reducedState.credentials[OPENAI_CODEX_PROVIDER] = credentialsToProbe;
    reducedState.credentials[ANTHROPIC_PROVIDER] = {};
    try {
      liveByProvider = await probeUsageSnapshotsByProviderImpl(reducedState, { env });
    } catch {
      liveByProvider = {};
    }
  }
  const liveCodex = isObject(liveByProvider?.[OPENAI_CODEX_PROVIDER])
    ? liveByProvider[OPENAI_CODEX_PROVIDER]
    : {};

  for (const [label, { identityBinding, cachedEntry, cacheMatches }] of credentialFacts) {
    const live = liveCodex[label] ?? codexUsageUnavailable();
    if (hasUsableUsage(live)) {
      resolvedCodex[label] = {
        ...live,
        source: "live",
        stale: false,
        observedAtMs: nowMs,
        ageMs: 0,
      };
      nextCacheEntries[label] = {
        identityBinding,
        usageObservedAtMs: nowMs,
        lastAttemptAtMs: nowMs,
        usage: live,
      };
      continue;
    }
    if (cacheMatches) {
      const observedAtMs = Number(cachedEntry.usageObservedAtMs);
      resolvedCodex[label] = {
        ...cachedEntry.usage,
        source: "cache",
        stale: true,
        observedAtMs: Number.isFinite(observedAtMs) ? observedAtMs : null,
        ageMs: Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : null,
        liveStatus: live?.status ?? "unavailable",
      };
      nextCacheEntries[label] = {
        ...cachedEntry,
        lastAttemptAtMs: nowMs,
      };
      continue;
    }
    resolvedCodex[label] = {
      ...codexUsageUnavailable(),
      ...(typeof live?.status === "string" || Number.isFinite(Number(live?.status))
        ? { status: live.status }
        : {}),
      ...(live?.tokenExpired === true ? { tokenExpired: true } : {}),
      ...(live?.missingScope === true ? { missingScope: true } : {}),
    };
  }

  if (canUseCache) {
    const lock = acquireRedisCacheLock({ homeDir, nowMs });
    if (lock) {
      try {
        writeCachedProviderUsage({
          homeDir,
          provider: OPENAI_CODEX_PROVIDER,
          entries: nextCacheEntries,
        });
      } catch {
        // Selection/status remain usable when this non-authoritative cache is
        // missing, unsafe, or temporarily unwritable.
      } finally {
        releaseRedisCacheLock(lock);
      }
    }
  }

  return {
    [OPENAI_CODEX_PROVIDER]: resolvedCodex,
    [ANTHROPIC_PROVIDER]: {},
  };
}
