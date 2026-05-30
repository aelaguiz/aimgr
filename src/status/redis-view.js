import { closeRedisStore, connectRedisStore, readSnapshot, registerMachine } from "../coordination/redis-store.js";
import { buildCoordinationView } from "../coordination/snapshot.js";
import { buildLocalMachineInfo } from "../coordination/machine.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveAimgrRedisCachePath } from "../io/paths.js";
import { loadLocalState } from "../state/local-state.js";
import { buildStatusView } from "./view.js";

function buildSessionMatrix(snapshot) {
  const machines = (snapshot.machines ?? []).map((machine) => machine.machineId).sort();
  return (snapshot.labels ?? [])
    .map((label) => {
      const sessions = {};
      for (const machineId of machines) {
        const session = (snapshot.sessions ?? []).find(
          (candidate) =>
            candidate.provider === label.provider
            && candidate.label === label.label
            && candidate.machineId === machineId,
        );
        sessions[machineId] = session
          ? {
              status: session.health?.status ?? "unknown",
              reason: session.health?.reason ?? null,
              updatedAt: session.updatedAt ?? null,
              expiresAt: typeof session.credential?.expiresAt === "string" ? session.credential.expiresAt : null,
              identity: session.identity ?? {},
              lineage: session.lineage ?? {},
            }
          : { status: "missing", reason: "no_session" };
      }
      return {
        provider: label.provider,
        label: label.label,
        stableIdentity: label.stableIdentity ?? {},
        sessions,
      };
    })
    .sort((a, b) => `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
}

function buildRedisSummary({ configRead, snapshot, machineId, cachePath, status = "live", error = null }) {
  return {
    status,
    ...(error ? { error } : {}),
    url: configRead.config.redis.url,
    keyPrefix: snapshot?.keyPrefix ?? configRead.config.redis.keyPrefix,
    primaryHost: configRead.config.redis.primaryHost,
    transport: configRead.config.redis.transport,
    machineId,
    cachePath,
    observedAt: snapshot?.observedAt ?? null,
    machineCount: snapshot?.machines?.length ?? 0,
    labelCount: snapshot?.labels?.length ?? 0,
    sessionCount: snapshot?.sessions?.length ?? 0,
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

  const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
  const cachePath = resolveAimgrRedisCachePath({ homeDir });
  let store = null;
  try {
    store = await connectRedisStoreImpl({ url: redisConfig.url, keyPrefix: redisConfig.keyPrefix });
    await registerMachine(store, machine);
    const snapshot = await readSnapshot(store);
    const localState = loadLocalState({ homeDir });
    const state = buildCoordinationView(snapshot, { machineId: machine.machineId, localState });
    const view = await buildStatusView({
      statePath: `redis:${snapshot.keyPrefix}`,
      state,
      homeDir,
      env,
      probeUsageSnapshotsByProviderImpl,
      nowMs,
    });
    view.redis = buildRedisSummary({ configRead, snapshot, machineId: machine.machineId, cachePath });
    view.redisMachines = sanitizeForStatus(snapshot.machines ?? []);
    view.redisSessionMatrix = sanitizeForStatus(buildSessionMatrix(snapshot));
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
