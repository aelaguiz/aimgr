import { closeRedisStore, connectRedisStore, readSnapshot } from "../coordination/redis-store.js";
import { buildCoordinationView } from "../coordination/snapshot.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { loadLocalState } from "../state/local-state.js";
import { buildStatusView } from "./view.js";

function buildRedisCredentials(snapshot) {
  return (snapshot?.credentials ?? [])
    .map((credential) => ({
      provider: credential.provider,
      label: credential.label,
      status: credential.health?.status ?? "unknown",
      reason: credential.health?.reason ?? null,
      updatedAt: credential.updatedAt ?? null,
      expiresAt: typeof credential.credential?.expiresAt === "string" ? credential.credential.expiresAt : null,
      identity: credential.identity ?? {},
      policy: credential.policy ?? {},
    }))
    .sort((a, b) => `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
}

function buildRedisSummary({ configRead, snapshot, cachePath, status = "live", error = null }) {
  return {
    status,
    ...(error ? { error } : {}),
    url: configRead.config.redis.url,
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
  probeUsageSnapshotsByProviderImpl,
  nowMs = Date.now(),
  connectRedisStoreImpl = connectRedisStore,
} = {}) {
  const configRead = readAimgrConfig({ homeDir });
  const redisConfig = configRead.config.redis;
  if (!redisConfig.url) {
    return { used: false, view: null };
  }

  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  let store = null;
  try {
    store = await connectRedisStoreImpl({ url: redisConfig.url, keyPrefix: redisConfig.keyPrefix });
    const snapshot = await readSnapshot(store);
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { localState });
    const view = await buildStatusView({
      statePath: `redis:${snapshot.keyPrefix}`,
      state,
      homeDir,
      env,
      probeUsageSnapshotsByProviderImpl,
      nowMs,
    });
    view.redis = buildRedisSummary({ configRead, snapshot, cachePath });
    view.redisCredentials = sanitizeForStatus(buildRedisCredentials(snapshot));
    writeJsonFileIfChanged(cachePath, sanitizeForStatus(view), { mode: 0o600 });
    return { used: true, view };
  } catch (err) {
    const cached = readJsonFile(cachePath);
    if (cached) {
      const error = String(err?.message ?? err);
      cached.redis = {
        ...(cached.redis ?? {}),
        status: "cache",
        error,
        cachePath,
      };
      cached.warnings = [
        ...(Array.isArray(cached.warnings) ? cached.warnings : []),
        { kind: "redis_status_cache_used", system: "redis", status: error },
      ];
      return { used: true, view: cached };
    }
    throw err;
  } finally {
    await closeRedisStore(store);
  }
}
