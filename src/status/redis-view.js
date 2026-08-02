import { readAimgrConfig } from "../config/aimgr-config.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { parseExpiresAtToMs, formatExpiresIn } from "../core/time.js";
import { buildCoordinationView } from "../coordination/snapshot.js";
import { readHeldRedisCredentialLeaseLabels } from "../coordination/redis-credential-lease.js";
import {
  closeRedisStore,
  connectRedisStore,
  readSnapshot,
  REDIS_CONNECTION_POLICY_OBSERVE,
} from "../coordination/redis-store.js";
import { buildClaudeCredentialSummaryFromBundle } from "../credentials/claude-bundle.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { collectCodexUsageSnapshots, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { loadLocalState } from "../state/local-state.js";
import { readClaudeCliTargetStatus } from "../targets/claude-status.js";
import { readCodexCliTargetStatus } from "../targets/codex-cli.js";
import { collectClaudeRedisAccountUsageStatus } from "./claude-redis-view.js";
import {
  AIMGR_REDIS_STATUS_CACHE_KIND,
  acquireRedisCacheLock,
  readCachedRedisStatusView,
  releaseRedisCacheLock,
  writeCachedRedisStatusView,
} from "./redis-cache.js";

export { AIMGR_REDIS_STATUS_CACHE_KIND };

const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const SAFE_TEXT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 _.:/%+<>=~-]{0,127}$/;

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
    return value ? "configured" : "unconfigured";
  }
}

function projectUsage(value) {
  const windows = Array.isArray(value?.windows)
    ? value.windows.slice(0, 16).map((window) => {
        const label = safeText(window?.label);
        const usedPercent = Number(window?.usedPercent);
        if (!label || !Number.isFinite(usedPercent)) return null;
        const resetAt = Number(window?.resetAt);
        return {
          label,
          usedPercent: Math.max(0, Math.min(100, usedPercent)),
          ...(Number.isFinite(resetAt) ? { resetAt } : {}),
          ...(safeToken(window?.kind) ? { kind: safeToken(window.kind) } : {}),
          ...(safeToken(window?.severity) ? { severity: safeToken(window.severity) } : {}),
          ...(typeof window?.active === "boolean" ? { active: window.active } : {}),
        };
      }).filter(Boolean)
    : [];
  const ageMs = Number(value?.ageMs);
  const observedAtMs = Number(value?.observedAtMs ?? value?.usageObservedAtMs);
  return {
    provider: safeToken(value?.provider) ?? null,
    ok: value?.ok === true && windows.length > 0,
    status: safeToken(value?.status) ?? "unavailable",
    windows,
    source: safeToken(value?.source) ?? "unavailable",
    stale: value?.stale === true,
    ...(Number.isFinite(ageMs) && ageMs >= 0 ? { ageMs } : {}),
    ...(Number.isFinite(observedAtMs) && observedAtMs > 0 ? { observedAtMs } : {}),
  };
}

function projectStatusAccount(value) {
  const label = safeToken(value?.label);
  const provider = safeToken(value?.provider);
  if (!label || !provider) return null;
  const expiresAt = safeTimestamp(value?.credentials?.expiresAt);
  return {
    label,
    provider,
    operator: {
      status: safeToken(value?.operator?.status) ?? "unknown",
      eligible: value?.operator?.eligible === true,
    },
    credentials: {
      status: safeToken(value?.credentials?.status) ?? "unknown",
      source: safeToken(value?.credentials?.source) ?? "redis",
      ...(expiresAt ? { expiresAt } : {}),
      ...(safeText(value?.credentials?.expiresIn) ? { expiresIn: safeText(value.credentials.expiresIn) } : {}),
    },
    usage: projectUsage(value?.usage),
    lock: {
      status: safeToken(value?.lock?.status) ?? "unknown",
      source: safeToken(value?.lock?.source) ?? "unavailable",
    },
    ...(value?.rotation ? {
      rotation: {
        status: safeToken(value.rotation.status) ?? "unknown",
        source: safeToken(value.rotation.source) ?? "unavailable",
      },
    } : {}),
    ...(value?.localProjection ? {
      localProjection: {
        state: safeToken(value.localProjection.state) ?? "unknown",
        ...(Number.isFinite(Number(value.localProjection.receiptAgeMs))
          ? { receiptAgeMs: Math.max(0, Number(value.localProjection.receiptAgeMs)) }
          : {}),
      },
    } : {}),
  };
}

function projectTarget(value, kind) {
  if (kind === "claude") {
    return {
      lastRunLabel: safeToken(value?.lastRunLabel),
      inferredLabel: safeToken(value?.inferredLabel),
      status: safeToken(value?.status) ?? "local",
    };
  }
  return {
    activeLabel: safeToken(value?.activeLabel),
    inferredLabel: safeToken(value?.inferredLabel),
    status: safeToken(value?.status) ?? "local",
  };
}

function projectRedisSummary(value) {
  const credentialCount = Number(value?.credentialCount);
  const cacheAgeMs = Number(value?.cacheAgeMs);
  return {
    status: safeToken(value?.status) ?? "unavailable",
    url: redactRedisEndpoint(value?.url),
    ...(safeText(value?.keyPrefix) ? { keyPrefix: safeText(value.keyPrefix) } : {}),
    ...(safeToken(value?.primaryHost) ? { primaryHost: safeToken(value.primaryHost) } : {}),
    ...(safeToken(value?.transport) ? { transport: safeToken(value.transport) } : {}),
    ...(safeTimestamp(value?.observedAt) ? { observedAt: safeTimestamp(value.observedAt) } : {}),
    credentialCount: Number.isFinite(credentialCount) ? Math.max(0, Math.round(credentialCount)) : 0,
    ...(Number.isFinite(cacheAgeMs) && cacheAgeMs >= 0 ? { cacheAgeMs } : {}),
    ...(safeToken(value?.error) ? { error: safeToken(value.error) } : {}),
  };
}

function projectRedisCredential(value) {
  const provider = safeToken(value?.provider);
  const label = safeToken(value?.label);
  if (!provider || !label) return null;
  return {
    provider,
    label,
    status: safeToken(value?.status) ?? "unknown",
    ...(safeTimestamp(value?.updatedAt) ? { updatedAt: safeTimestamp(value.updatedAt) } : {}),
    ...(safeTimestamp(value?.expiresAt) ? { expiresAt: safeTimestamp(value.expiresAt) } : {}),
  };
}

export function buildRedisDiagnosticCacheView(view) {
  const generatedAt = safeTimestamp(view?.generatedAt);
  const nowMs = Number(view?.nowMs);
  return {
    kind: AIMGR_REDIS_STATUS_CACHE_KIND,
    generatedAt,
    nowMs: Number.isFinite(nowMs) ? nowMs : generatedAt ? Date.parse(generatedAt) : null,
    statePath: safeText(view?.statePath) ?? "redis:unavailable",
    accounts: (Array.isArray(view?.accounts) ? view.accounts : []).slice(0, 512).map(projectStatusAccount).filter(Boolean),
    codexCli: projectTarget(view?.codexCli, "codex"),
    claudeCli: projectTarget(view?.claudeCli, "claude"),
    redis: projectRedisSummary(view?.redis),
    redisCredentials: (Array.isArray(view?.redisCredentials) ? view.redisCredentials : [])
      .slice(0, 512)
      .map(projectRedisCredential)
      .filter(Boolean),
    warnings: (Array.isArray(view?.warnings) ? view.warnings : []).slice(0, 32).flatMap((warning) => {
      const kind = safeToken(warning?.kind);
      return kind ? [{ kind }] : [];
    }),
  };
}

function buildRedisCredentials(snapshot) {
  return (snapshot?.credentials ?? []).map((record) => {
    let expiresAt = null;
    if (record.provider === ANTHROPIC_PROVIDER) {
      const view = getAnthropicCredentialView(record.credential);
      expiresAt = buildClaudeCredentialSummaryFromBundle(view)?.expiresAt ?? null;
    } else if (typeof record.credential?.expiresAt === "string") {
      expiresAt = record.credential.expiresAt;
    }
    return {
      provider: record.provider,
      label: record.label,
      status: record.health?.status ?? "unknown",
      updatedAt: record.updatedAt ?? null,
      expiresAt,
    };
  }).sort((left, right) => `${left.provider}:${left.label}`.localeCompare(`${right.provider}:${right.label}`));
}

function buildRedisSummary({ configRead, snapshot, cachePath, status = "live", error = null, cacheAgeMs = null }) {
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
    ...(Number.isFinite(cacheAgeMs) ? { cacheAgeMs: Math.max(0, cacheAgeMs) } : {}),
  };
}

function readLocalTargetFacts({ state, homeDir, env }) {
  let codexCli;
  let claudeCli;
  try {
    codexCli = readCodexCliTargetStatus({ state, homeDir, env });
  } catch {
    codexCli = {
      status: "unreadable",
      activeLabel: state?.targets?.codexCli?.activeLabel ?? null,
      inferredLabel: null,
    };
  }
  try {
    claudeCli = readClaudeCliTargetStatus({ state, homeDir, env });
  } catch {
    claudeCli = {
      status: "unreadable",
      lastRunLabel: state?.targets?.claudeCli?.lastRunLabel ?? null,
      inferredLabel: null,
    };
  }
  return { codexCli, claudeCli };
}

function credentialStatusForCodex(record, nowMs) {
  const credential = record?.credential ?? {};
  const expiresAtMs = parseExpiresAtToMs(credential.expiresAt);
  const ready = record?.health?.status !== "candidate"
    && typeof credential.access === "string" && credential.access.trim()
    && typeof credential.refresh === "string" && credential.refresh.trim()
    && typeof credential.accountId === "string" && credential.accountId.trim()
    && expiresAtMs !== null && expiresAtMs > nowMs;
  if (record?.policy?.reauth?.blockedReason === "oauth_reauth_required") return { status: "reauth", ready: false };
  if (record?.health?.status === "candidate") return { status: "candidate", ready: false };
  if (expiresAtMs !== null && expiresAtMs <= nowMs) return { status: "expired", ready: false };
  return { status: ready ? "ok" : "missing", ready: Boolean(ready) };
}

function buildCodexAccounts({ snapshot, usageByLabel, lockedLabels, lockSource, nowMs }) {
  return (snapshot?.credentials ?? []).filter((record) => record.provider === OPENAI_CODEX_PROVIDER).map((record) => {
    const credentials = credentialStatusForCodex(record, nowMs);
    const usage = usageByLabel?.[record.label] ?? {
      provider: OPENAI_CODEX_PROVIDER,
      ok: false,
      status: "unavailable",
      source: "unavailable",
      stale: false,
      windows: [],
    };
    const lockStatus = lockSource === "redis"
      ? lockedLabels.has(record.label) ? "held" : "free"
      : "unknown";
    return {
      label: record.label,
      provider: OPENAI_CODEX_PROVIDER,
      operator: {
        status: credentials.ready && record.policy?.pool?.enabled !== false ? "ready" : credentials.status === "reauth" ? "reauth" : "blocked",
        eligible: credentials.ready && record.policy?.pool?.enabled !== false && lockStatus !== "held",
      },
      credentials: {
        status: credentials.status,
        source: "redis",
        ...(typeof record.credential?.expiresAt === "string" ? {
          expiresAt: record.credential.expiresAt,
          expiresIn: formatExpiresIn(record.credential.expiresAt, nowMs),
        } : {}),
      },
      usage: {
        ...usage,
        provider: OPENAI_CODEX_PROVIDER,
        source: usage.source ?? "unavailable",
        stale: usage.stale === true,
      },
      lock: { status: lockStatus, source: lockSource },
    };
  });
}

function buildClaudeAccounts(claudeStatus) {
  return (claudeStatus?.accounts ?? []).map((account) => ({
    label: account.label,
    provider: ANTHROPIC_PROVIDER,
    operator: {
      status: account.credentialReady ? "ready" : account.credentialState === "reauth_required" ? "reauth" : "blocked",
      eligible: account.credentialReady === true && account.locked !== true && account.rotationPending !== true,
    },
    credentials: {
      status: account.credentialState ?? "unknown",
      source: "redis",
      ...(typeof account.credentialExpiresAt === "string" ? {
        expiresAt: account.credentialExpiresAt,
        expiresIn: formatExpiresIn(account.credentialExpiresAt, claudeStatus.checkedAtMs),
      } : {}),
    },
    usage: {
      ...account.usage,
      provider: ANTHROPIC_PROVIDER,
      status: account.authState,
      source: account.source,
      stale: account.stale === true,
      ageMs: account.ageMs,
      usageObservedAtMs: account.usageObservedAtMs,
    },
    lock: account.lock,
    rotation: account.rotation,
    localProjection: account.localProjection,
  }));
}

function buildLocalOnlyView({ configRead, homeDir, env, nowMs, cachePath, status, error = null }) {
  const localState = loadLocalState({ homeDir });
  const state = buildCoordinationView({ credentials: [], keyPrefix: configRead.config.redis.keyPrefix }, { localState });
  const targets = readLocalTargetFacts({ state, homeDir, env });
  return {
    generatedAt: new Date(nowMs).toISOString(),
    nowMs,
    statePath: "local-state",
    accounts: [],
    ...targets,
    redis: buildRedisSummary({ configRead, snapshot: null, cachePath, status, error }),
    redisCredentials: [],
    warnings: status === "unconfigured" ? [] : [{ kind: "redis_status_unavailable" }],
  };
}

export async function buildRedisStatusView({
  homeDir,
  env = {},
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
  fetchJsonWithTimeoutImpl,
  nowMs = Date.now(),
  connectRedisStoreImpl = connectRedisStore,
  readHeldRedisCredentialLeaseLabelsImpl = readHeldRedisCredentialLeaseLabels,
} = {}) {
  const configRead = readAimgrConfig({ homeDir });
  const redisConfig = configRead.config.redis;
  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  if (!redisConfig.url) {
    return {
      used: true,
      view: buildLocalOnlyView({ configRead, homeDir, env, nowMs, cachePath, status: "unconfigured" }),
      claudeUsageStatus: null,
    };
  }

  let store = null;
  try {
    store = await connectRedisStoreImpl({
      url: redisConfig.url,
      keyPrefix: redisConfig.keyPrefix,
      connectionPolicy: REDIS_CONNECTION_POLICY_OBSERVE,
    });
    const snapshot = await readSnapshot(store);
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { localState });
    const targets = readLocalTargetFacts({ state, homeDir, env });

    let claudeUsageStatus;
    try {
      claudeUsageStatus = await collectClaudeRedisAccountUsageStatus({
        homeDir,
        records: snapshot.credentials,
        redisStore: store,
        fresh: false,
        nowMs,
        fetchJsonWithTimeoutImpl,
        readHeldRedisCredentialLeaseLabelsImpl,
      });
    } catch {
      claudeUsageStatus = {
        ok: false,
        checkedAtMs: nowMs,
        source: "unavailable",
        requestCount: 0,
        cacheState: "unavailable",
        accounts: [],
      };
    }

    const stateWithoutAnthropicProbe = {
      ...state,
      credentials: { ...state.credentials, [ANTHROPIC_PROVIDER]: {} },
    };
    let usageByProvider;
    try {
      usageByProvider = await collectCodexUsageSnapshots({
        state: stateWithoutAnthropicProbe,
        homeDir,
        env,
        nowMs,
        probeUsageSnapshotsByProviderImpl,
      });
    } catch {
      usageByProvider = { [OPENAI_CODEX_PROVIDER]: {} };
    }

    const codexLabels = snapshot.credentials
      .filter((record) => record.provider === OPENAI_CODEX_PROVIDER)
      .map((record) => record.label);
    let lockedCodexLabels = new Set();
    let codexLockSource = "redis";
    try {
      lockedCodexLabels = await readHeldRedisCredentialLeaseLabelsImpl(store, {
        provider: OPENAI_CODEX_PROVIDER,
        labels: codexLabels,
      });
    } catch {
      codexLockSource = "unavailable";
    }

    const accounts = [
      ...buildCodexAccounts({
        snapshot,
        usageByLabel: usageByProvider?.[OPENAI_CODEX_PROVIDER] ?? {},
        lockedLabels: lockedCodexLabels,
        lockSource: codexLockSource,
        nowMs,
      }),
      ...buildClaudeAccounts(claudeUsageStatus),
    ].sort((left, right) => left.label.localeCompare(right.label));
    const view = {
      generatedAt: new Date(nowMs).toISOString(),
      nowMs,
      statePath: `redis:${snapshot.keyPrefix}`,
      accounts,
      ...targets,
      redis: buildRedisSummary({ configRead, snapshot, cachePath }),
      redisCredentials: buildRedisCredentials(snapshot),
      warnings: [
        ...(claudeUsageStatus.source === "unavailable" ? [{ kind: "claude_status_unavailable" }] : []),
        ...(codexLockSource === "unavailable" ? [{ kind: "codex_lock_status_unavailable" }] : []),
      ],
    };

    const cacheLock = acquireRedisCacheLock({ homeDir, cachePath, nowMs });
    if (cacheLock) {
      try {
        writeCachedRedisStatusView({ homeDir, cachePath, view: buildRedisDiagnosticCacheView(view) });
      } catch {
        // Live status remains authoritative when its optional redacted cache fails.
      } finally {
        releaseRedisCacheLock(cacheLock);
      }
    }
    return { used: true, view, claudeUsageStatus };
  } catch {
    const localFallback = buildLocalOnlyView({
      configRead,
      homeDir,
      env,
      nowMs,
      cachePath,
      status: "unavailable",
      error: "unavailable",
    });
    const cachedRaw = readCachedRedisStatusView({ homeDir, cachePath }).view;
    const cached = cachedRaw ? buildRedisDiagnosticCacheView(cachedRaw) : null;
    if (!cached) return { used: true, view: localFallback, claudeUsageStatus: null };

    const observedAtMs = Number(cached.nowMs);
    const cacheAgeMs = Number.isFinite(observedAtMs) ? Math.max(0, nowMs - observedAtMs) : null;
    cached.generatedAt = new Date(nowMs).toISOString();
    cached.nowMs = nowMs;
    cached.codexCli = localFallback.codexCli;
    cached.claudeCli = localFallback.claudeCli;
    cached.redis = buildRedisSummary({
      configRead,
      snapshot: {
        keyPrefix: cached.redis?.keyPrefix ?? redisConfig.keyPrefix,
        observedAt: cached.redis?.observedAt ?? null,
        credentials: cached.redisCredentials ?? [],
      },
      cachePath,
      status: "cache",
      error: "unavailable",
      cacheAgeMs,
    });
    cached.warnings = [
      ...(Array.isArray(cached.warnings) ? cached.warnings : []),
      { kind: "redis_status_cache_used" },
    ];
    return { used: true, view: cached, claudeUsageStatus: null };
  } finally {
    try {
      await closeRedisStore(store);
    } catch {
      // Read-only status close failures do not replace the independently sourced view.
    }
  }
}
