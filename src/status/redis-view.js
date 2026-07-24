import {
  buildRedisStatusClientOptions,
  closeRedisStore,
  connectRedisStore,
  readSnapshot,
} from "../coordination/redis-store.js";
import { buildCoordinationView } from "../coordination/snapshot.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { loadLocalState } from "../state/local-state.js";
import { collectClaudeRedisAccountUsageStatus } from "./claude-redis-view.js";
import { buildStatusView } from "./view.js";
import {
  AIMGR_REDIS_STATUS_CACHE_KIND,
  acquireRedisCacheLock,
  readCachedRedisStatusView,
  releaseRedisCacheLock,
  writeCachedRedisStatusView,
} from "./redis-cache.js";

export { AIMGR_REDIS_STATUS_CACHE_KIND };
export const AIMGR_REDIS_STATUS_CACHE_MAX_AGE_MS = 60 * 60_000;

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/%+<>=~-]{0,127}$/;
const STATUS_METRIC_FIELDS = {
  pool_now: new Set([
    "ready_accounts", "total_accounts", "active_agents", "total_agents", "assigned_load_w",
    "usable_capacity_w", "pool_load_pct", "spare_w", "spare_heavy", "spare_medium", "spare_light",
  ]),
  windows: new Set([
    "pool_5h_used_pct", "pool_5h_remaining_w", "pool_7d_used_pct", "pool_7d_remaining_w",
    "floor_5h_pct", "floor_5h_label", "floor_7d_pct", "floor_7d_label",
  ]),
  pressure: new Set([
    "recent_overflows_14d", "rebalances_blocked_14d", "rebalances_warn_14d", "cold_start_agents",
    "over_target_accounts",
  ]),
  projection: new Set([
    "load_pct_6h", "load_pct_24h", "load_pct_72h", "load_pct_7d", "overflow_eta_h",
    "first_constraint", "first_constraint_label",
  ]),
};

function safeToken(value) {
  const token = typeof value === "string" ? value.trim() : "";
  return SAFE_TOKEN_PATTERN.test(token) ? token : null;
}

function safeText(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return SAFE_TEXT_PATTERN.test(text) ? text : null;
}

function safeTimestamp(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  const parsed = raw ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function redactRedisEndpoint(value) {
  try {
    const parsed = new URL(String(value ?? ""));
    if (!new Set(["redis:", "rediss:"]).has(parsed.protocol) || !parsed.hostname) return "configured";
    return `${parsed.protocol}//${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`;
  } catch {
    return "configured";
  }
}

function projectUsage(value) {
  const provider = safeToken(value?.provider);
  const status = safeToken(value?.status);
  const windows = Array.isArray(value?.windows)
    ? value.windows.slice(0, 16).map((window) => {
        const label = safeText(window?.label);
        const usedPercent = Number(window?.usedPercent);
        if (!label || !Number.isFinite(usedPercent)) return null;
        const resetAt = Number(window?.resetAt);
        const kind = safeToken(window?.kind);
        const severity = safeToken(window?.severity);
        return {
          label,
          usedPercent: Math.max(0, Math.min(100, usedPercent)),
          ...(Number.isFinite(resetAt) ? { resetAt } : {}),
          ...(kind ? { kind } : {}),
          ...(severity ? { severity } : {}),
          ...(typeof window?.active === "boolean" ? { active: window.active } : {}),
        };
      }).filter(Boolean)
    : [];
  return {
    ...(provider ? { provider } : {}),
    ok: value?.ok === true && windows.length > 0,
    ...(status ? { status } : {}),
    windows,
  };
}

function projectStatusAccount(value) {
  const label = safeToken(value?.label);
  const provider = safeToken(value?.provider);
  if (!label || !provider) return null;
  const operatorStatus = safeToken(value?.operator?.status);
  const credentialStatus = safeToken(value?.credentials?.status);
  const expiresAt = safeTimestamp(value?.credentials?.expiresAt);
  const expiresIn = safeText(value?.credentials?.expiresIn);
  return {
    label,
    provider,
    operator: {
      status: operatorStatus ?? "unknown",
      eligible: value?.operator?.eligible === true,
    },
    credentials: {
      status: credentialStatus ?? "unknown",
      ...(expiresAt ? { expiresAt } : {}),
      ...(expiresIn ? { expiresIn } : {}),
    },
    usage: projectUsage(value?.usage),
  };
}

function projectMetricRecord(value, allowedFields) {
  const projected = {};
  for (const field of allowedFields) {
    const fieldValue = value?.[field];
    if (typeof fieldValue === "number" && Number.isFinite(fieldValue)) {
      projected[field] = fieldValue;
    } else if (typeof fieldValue === "boolean") {
      projected[field] = fieldValue;
    } else {
      const text = safeText(fieldValue);
      if (text) projected[field] = text;
    }
  }
  return projected;
}

function projectWarning(value) {
  const kind = safeToken(value?.kind);
  if (!kind) return null;
  const warning = { kind };
  for (const field of ["system", "label", "provider", "status"]) {
    const token = safeToken(value?.[field]);
    if (token) warning[field] = token;
  }
  return warning;
}

function projectRedisSummary(value) {
  const keyPrefix = safeText(value?.keyPrefix);
  const primaryHost = safeToken(value?.primaryHost);
  const transport = safeToken(value?.transport);
  const observedAt = safeTimestamp(value?.observedAt);
  const credentialCount = Number(value?.credentialCount);
  return {
    status: safeToken(value?.status) ?? "cache",
    url: redactRedisEndpoint(value?.url),
    ...(keyPrefix ? { keyPrefix } : {}),
    ...(primaryHost ? { primaryHost } : {}),
    ...(transport ? { transport } : {}),
    ...(observedAt ? { observedAt } : {}),
    credentialCount: Number.isFinite(credentialCount) ? Math.max(0, Math.round(credentialCount)) : 0,
  };
}

function projectRedisCredential(value) {
  const provider = safeToken(value?.provider);
  const label = safeToken(value?.label);
  if (!provider || !label) return null;
  const status = safeToken(value?.status);
  const updatedAt = safeTimestamp(value?.updatedAt);
  const expiresAt = safeTimestamp(value?.expiresAt);
  return {
    provider,
    label,
    status: status ?? "unknown",
    ...(updatedAt ? { updatedAt } : {}),
    ...(expiresAt ? { expiresAt } : {}),
  };
}

export function buildRedisDiagnosticCacheView(view) {
  const generatedAt = safeTimestamp(view?.generatedAt);
  const viewNowMs = Number(view?.nowMs);
  const statePath = safeText(view?.statePath) ?? "redis:unavailable";
  const result = {
    kind: AIMGR_REDIS_STATUS_CACHE_KIND,
    generatedAt,
    nowMs: Number.isFinite(viewNowMs) ? viewNowMs : generatedAt ? Date.parse(generatedAt) : null,
    statePath,
    accounts: (Array.isArray(view?.accounts) ? view.accounts : [])
      .slice(0, 512)
      .map(projectStatusAccount)
      .filter(Boolean),
    redis: projectRedisSummary(view?.redis),
    redisCredentials: (Array.isArray(view?.redisCredentials) ? view.redisCredentials : [])
      .slice(0, 512)
      .map(projectRedisCredential)
      .filter(Boolean),
    warnings: (Array.isArray(view?.warnings) ? view.warnings : [])
      .slice(0, 512)
      .map(projectWarning)
      .filter(Boolean),
  };
  for (const [section, fields] of Object.entries(STATUS_METRIC_FIELDS)) {
    result[section] = projectMetricRecord(view?.[section], fields);
  }
  return result;
}

function diagnosticCacheIsFresh(view, nowMs) {
  const observedAtMs = Number(view?.nowMs);
  const ageMs = nowMs - observedAtMs;
  return Number.isFinite(observedAtMs) && ageMs >= 0 && ageMs <= AIMGR_REDIS_STATUS_CACHE_MAX_AGE_MS;
}

function buildRedisCredentials(snapshot) {
  return (snapshot?.credentials ?? [])
    .map((credential) => ({
      provider: credential.provider,
      label: credential.label,
      status: credential.health?.status ?? "unknown",
      updatedAt: credential.updatedAt ?? null,
      expiresAt: typeof credential.credential?.expiresAt === "string" ? credential.credential.expiresAt : null,
    }))
    .sort((a, b) => `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
}

function buildCanonicalClaudeUsageByLabel(status) {
  const usageByLabel = {};
  for (const account of status?.accounts ?? []) {
    usageByLabel[account.label] = {
      provider: ANTHROPIC_PROVIDER,
      ok: account.usage?.ok === true,
      status: account.authState,
      windows: Array.isArray(account.usage?.windows) ? account.usage.windows : [],
      ...(account.errorKind ? { errorKind: account.errorKind } : {}),
      source: account.source,
      stale: account.stale === true,
      locked: account.locked === true,
    };
  }
  return usageByLabel;
}

function buildRedisSummary({ configRead, snapshot, cachePath, status = "live", error = null }) {
  return {
    status,
    ...(error ? { error } : {}),
    url: redactRedisEndpoint(configRead.config.redis.url),
    keyPrefix: snapshot?.keyPrefix ?? configRead.config.redis.keyPrefix,
    primaryHost: configRead.config.redis.primaryHost,
    transport: configRead.config.redis.transport,
    cachePath,
    observedAt: snapshot?.observedAt ?? null,
    credentialCount: snapshot?.credentials?.length ?? 0,
  };
}

export async function buildRedisStatusView({
  homeDir,
  env = {},
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
  fetchJsonWithTimeoutImpl,
  nowMs = Date.now(),
  connectRedisStoreImpl = connectRedisStore,
} = {}) {
  const configRead = readAimgrConfig({ homeDir });
  const redisConfig = configRead.config.redis;
  if (!redisConfig.url) {
    return { used: false, view: null, claudeUsageStatus: null };
  }

  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  let store = null;
  try {
    store = await connectRedisStoreImpl({
      url: redisConfig.url,
      keyPrefix: redisConfig.keyPrefix,
      clientOptions: buildRedisStatusClientOptions(),
    });
    const snapshot = await readSnapshot(store);
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { localState });
    const claudeUsageStatus = await collectClaudeRedisAccountUsageStatus({
      homeDir,
      records: snapshot.credentials,
      redisStore: store,
      fresh: false,
      nowMs,
      fetchJsonWithTimeoutImpl,
    });
    const stateWithoutAnthropicProbe = {
      ...state,
      credentials: {
        ...state.credentials,
        [ANTHROPIC_PROVIDER]: {},
      },
    };
    const usageByProvider = await probeUsageSnapshotsByProviderImpl(stateWithoutAnthropicProbe, { env });
    usageByProvider[ANTHROPIC_PROVIDER] = buildCanonicalClaudeUsageByLabel(claudeUsageStatus);
    const view = await buildStatusView({
      statePath: `redis:${snapshot.keyPrefix}`,
      state,
      homeDir,
      env,
      usageByProviderOverride: usageByProvider,
      nowMs,
    });
    view.redis = buildRedisSummary({ configRead, snapshot, cachePath });
    view.redisCredentials = buildRedisCredentials(snapshot);
    const cacheLock = acquireRedisCacheLock({ homeDir, cachePath, nowMs });
    if (cacheLock) {
      try {
        writeCachedRedisStatusView({
          homeDir,
          cachePath,
          view: buildRedisDiagnosticCacheView(view),
        });
      } catch {
        // Status remains live even when a local diagnostic cache is unsafe or
        // temporarily unwritable. Never replace Redis truth with that failure.
      } finally {
        releaseRedisCacheLock(cacheLock);
      }
    }
    return { used: true, view, claudeUsageStatus };
  } catch {
    const cachedRaw = readCachedRedisStatusView({ homeDir, cachePath }).view;
    const cached = cachedRaw ? buildRedisDiagnosticCacheView(cachedRaw) : null;
    if (cached && diagnosticCacheIsFresh(cached, nowMs)) {
      cached.redis = {
        ...(cached.redis ?? {}),
        status: "cache",
        error: "unavailable",
      };
      cached.warnings = [
        ...(Array.isArray(cached.warnings) ? cached.warnings : []),
        { kind: "redis_status_cache_used", system: "redis", status: "unavailable" },
      ];
      const cacheLock = acquireRedisCacheLock({ homeDir, cachePath, nowMs });
      if (cacheLock) {
        try {
          writeCachedRedisStatusView({ homeDir, cachePath, view: cached });
        } catch {
          // A fallback remains useful even when legacy-cache migration fails.
        } finally {
          releaseRedisCacheLock(cacheLock);
        }
      }
      return { used: true, view: cached, claudeUsageStatus: null };
    }
    throw new Error("Redis status is unavailable.");
  } finally {
    try {
      await closeRedisStore(store);
    } catch {
      // Status errors are intentionally fixed and value-free.
    }
  }
}
