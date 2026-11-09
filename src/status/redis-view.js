import { readClaudeAccountMetadata } from "../coordination/claude-metadata.js";
import { readCachedClaudeAccountMetadata } from "../coordination/claude-runtime.js";
import { readLocalClaudeCredential } from "../credentials/claude-local.js";
import { readClaudeEnvironment } from "../privacy/claude-environment.js";
import { redactRedisEndpoint } from "../core/sanitize.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { normalizeCodexPlan } from "../core/codex-plan.js";
import { parseExpiresAtToMs, formatExpiresIn } from "../core/time.js";
import { buildCoordinationView } from "../coordination/snapshot.js";
import { localCodexRecords } from "../coordination/codex-runtime.js";
import { readCodexEnvironment } from "../privacy/codex-environment.js";
import { readReferencedLocalCodexCredential } from "../credentials/codex-local.js";
import { readHeldRedisCredentialLeaseLabels } from "../coordination/redis-credential-lease.js";
import {
  closeRedisStore,
  connectRedisStore,
  readSnapshot,
  readAccountNotes,
  REDIS_CONNECTION_POLICY_OBSERVE,
} from "../coordination/redis-store.js";
import { buildClaudeCredentialSummaryFromBundle } from "../credentials/claude-bundle.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { decodeJwtPayload } from "../credentials/jwt.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { collectCodexUsageSnapshots, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { loadLocalState } from "../state/local-state.js";
import { readClaudeCliTargetStatus } from "../targets/claude-status.js";
import { readCodexCliTargetStatus } from "../targets/codex-cli.js";
import { collectClaudeRedisAccountUsageStatus, formatClaudePlan } from "./claude-redis-view.js";
import { describeClaudeEgress, projectClaudeEgress, claudeProxyHealthProblem, hasNoLocalClaudeRoute } from "./claude-egress.js";
import { readClaudeProxyHealth } from "./claude-proxy-health.js";
import { claudeBindingRequiresProxy, readClaudeOfflineBinding } from "../network/claude-offline-binding.js";
import { CLAUDE_ROUTE_ERROR_CODES } from "../network/claude-egress-policy.js";
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
function codexCredentialPlan(credential) {
  for (const token of [credential?.access, credential?.idToken]) {
    const claims = decodeJwtPayload(token);
    const plan = normalizeCodexPlan(claims?.["https://api.openai.com/auth"]?.chatgpt_plan_type);
    if (plan) return plan;
  }
  return null;
}

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

function projectUsage(value, provider) {
  const windows = Array.isArray(value?.windows)
    ? value.windows.slice(0, 16).map((window) => {
        const rawLabel = safeText(window?.label);
        const label = provider === OPENAI_CODEX_PROVIDER && rawLabel === "168h" ? "Week" : rawLabel;
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
  const resetCreditsAvailable = value?.resetCreditsAvailable;
  return {
    provider: safeToken(value?.provider) ?? null,
    ok: value?.ok === true && windows.length > 0,
    status: safeToken(value?.status) ?? "unavailable",
    windows,
    source: safeToken(value?.source) ?? "unavailable",
    stale: value?.stale === true,
    ...(Number.isInteger(resetCreditsAvailable) && resetCreditsAvailable >= 0
      ? { resetCreditsAvailable }
      : {}),
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
    ...(provider === OPENAI_CODEX_PROVIDER && /^[a-f0-9]{64}$/.test(value?.localAccountKey ?? "") ? { localAccountKey: value.localAccountKey } : {}),
    plan: typeof value?.plan === "string" && /^[a-z0-9_]+(?:\/[a-z0-9_]+)?$/.test(value.plan) ? value.plan : null,
    ...(provider === ANTHROPIC_PROVIDER ? { egress: projectClaudeEgress(value?.egress) } : {}),
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
    usage: projectUsage(value?.usage, provider),
    lock: {
      status: safeToken(value?.lock?.status) ?? "unknown",
      source: safeToken(value?.lock?.source) ?? "unavailable",
    },
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
  if (["login_required", "reauth_required", "runtime_required", "expired", "local_auth_unavailable"].includes(record?.health?.reason)) {
    return { status: record.health.reason, ready: false };
  }
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
      localAccountKey: record.localAccountKey ?? null,
      plan: normalizeCodexPlan(usage.plan) ?? codexCredentialPlan(record.credential),
      operator: {
        status: credentials.ready && record.policy?.pool?.enabled !== false ? "ready" : credentials.status === "reauth_required" ? "reauth" : "blocked",
        eligible: credentials.ready && record.policy?.pool?.enabled !== false && lockStatus !== "held",
      },
      credentials: {
        status: credentials.status,
        source: "environment-local",
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
  return (claudeStatus?.accounts ?? []).map((account) => {
    const proxyProblem = claudeProxyHealthProblem(account);
    const launchable = !CLAUDE_ROUTE_ERROR_CODES.has(account.errorKind)
      && (account.credentialReady === true || account.credentialState === "credential_expired");
    return {
      label: account.label,
      provider: ANTHROPIC_PROVIDER,
      plan: formatClaudePlan(account),
      egress: projectClaudeEgress(account.egress),
      operator: {
        status: hasNoLocalClaudeRoute(account) ? "no_route" : proxyProblem ? proxyProblem.status.toLowerCase().replaceAll(" ", "_") : launchable ? "ready" : account.credentialState === "reauth_required" ? "reauth" : "blocked",
        eligible: !hasNoLocalClaudeRoute(account) && !proxyProblem && launchable && account.locked === false,
      },
      credentials: {
        status: account.credentialState ?? "unknown",
        source: "environment-local",
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
    };
  });
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
    accountNotes: null,
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
  readClaudeProxyHealthImpl = readClaudeProxyHealth,
  readCodexEnvironmentImpl = readCodexEnvironment,
  readClaudeEnvironmentImpl,
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
    const snapshot = await readSnapshot(store, { excludeCodexGrants: true, excludeClaudeGrants: true });
    let environment = null;
    try { environment = readCodexEnvironmentImpl(); } catch { /* Codex setup cannot hide other providers. */ }
    snapshot.credentials.push(...await localCodexRecords({ store, homeDir, env, environment }));
    snapshot.credentials.push(...await readClaudeAccountMetadata(store));
    const notes = await readAccountNotes(store).catch(() => null);
    const knownAccounts = new Set(snapshot.credentials.map((record) => `${record.provider}:${record.label}`));
    const accountNotes = notes?.filter((record) => knownAccounts.has(`${record.provider}:${record.label}`))
      .map(({ provider, label, note }) => ({ provider, label, note })) ?? null;
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { localState });
    state.codexEnvironment = environment;
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
        readClaudeProxyHealthImpl,
        readClaudeEnvironmentImpl,
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
      accountNotes,
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
    cached.accountNotes = null;

    // Cached pool metadata is not evidence of a current local authorization.
    // In particular, logout or copying this cache cannot resurrect a grant.
    let environment = null;
    try { environment = readCodexEnvironmentImpl(); } catch { /* report local setup below */ }
    for (const account of cached.accounts) {
      if (account.provider !== OPENAI_CODEX_PROVIDER) continue;
      let local = { status: environment ? "login_required" : "runtime_required", credential: null };
      if (environment && account.localAccountKey) {
        try { local = readReferencedLocalCodexCredential({ homeDir, env, environment, accountKey: account.localAccountKey }); }
        catch { local.status = "local_auth_unavailable"; }
      }
      account.credentials = { status: local.status === "ready" ? "ok" : local.status, source: "environment-local",
        ...(local.credential?.expiresAt ? { expiresAt: local.credential.expiresAt, expiresIn: formatExpiresIn(local.credential.expiresAt, nowMs) } : {}) };
      if (local.status !== "ready") account.operator = { status: local.status === "reauth_required" ? "reauth" : "blocked", eligible: false };
    }

    // Shared status is only a historical observation. Check this machine's
    // current owner against safe cached metadata before reporting availability.
    let claudeEnvironment = null;
    let claudeMetadata = [];
    try {
      claudeEnvironment = (readClaudeEnvironmentImpl ?? readClaudeEnvironment)();
      claudeMetadata = readCachedClaudeAccountMetadata({ homeDir, environment: claudeEnvironment });
    } catch { /* Missing local setup or metadata cannot establish readiness. */ }
    for (const account of cached.accounts) {
      if (account.provider !== ANTHROPIC_PROVIDER) continue;
      let local = { status: claudeEnvironment ? "login_required" : "runtime_required" };
      const metadata = claudeMetadata.find(record => record.label === account.label);
      if (claudeEnvironment && metadata) {
        try { local = readLocalClaudeCredential({ homeDir, label: account.label, metadata, environment: claudeEnvironment }); }
        catch { local = { status: "local_auth_unavailable" }; }
      }
      const launchable = local.status === "ready" || local.status === "expired";
      const expiry = getAnthropicCredentialView(local.credential)?.expiresAt;
      account.credentials = { status: local.status === "ready" ? "credential_ready" : local.status === "expired" ? "credential_expired" : local.status,
        source: "environment-local", ...(expiry ? { expiresAt: expiry, expiresIn: formatExpiresIn(expiry, nowMs) } : {}) };
      if (!launchable) account.operator = { status: local.status === "reauth_required" ? "reauth" : "blocked", eligible: false };
    }

    // The assignment is cached provider data; local route availability is a
    // current machine fact. Recheck it even while Redis is unreachable. A newly
    // installed route does not establish fresh account readiness while offline.
    for (const account of cached.accounts) {
      if (account.provider !== ANTHROPIC_PROVIDER) continue;
      const binding = readClaudeOfflineBinding(homeDir, account.label);
      if (binding?.invalidated) account.operator = { status: "blocked", eligible: false };
      if (account.egress?.mode !== "proxy") {
        if (claudeBindingRequiresProxy(binding) && ["direct", "unknown"].includes(account.egress?.mode)) {
          account.egress = { mode: "missing_assignment" };
          account.operator = { status: "blocked", eligible: false };
        }
        continue;
      }
      account.egress = describeClaudeEgress({ egress: account.egress }, configRead.config.claudeProxyProfiles ?? {});
      if (hasNoLocalClaudeRoute(account)) account.operator = { status: "no_route", eligible: false };
      else if (account.operator.status === "no_route" || account.operator.status.startsWith("proxy_")) account.operator = { status: "unknown", eligible: false };
    }
    const proxyHealth = await readClaudeProxyHealthImpl(cached.accounts
      .filter(account => account.egress?.mode === "proxy" && account.egress.localStatus === "configured")
      .map(account => account.egress.profileRef));
    for (const account of cached.accounts) {
      if (account.egress?.mode !== "proxy" || account.egress.localStatus !== "configured") continue;
      account.egress.health = proxyHealth[account.egress.profileRef] ?? "unknown";
      const problem = claudeProxyHealthProblem(account);
      if (problem) account.operator = { status: problem.status.toLowerCase().replaceAll(" ", "_"), eligible: false };
    }

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
