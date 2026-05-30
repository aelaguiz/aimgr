import { createClient } from "redis";
import {
  normalizeKeyPrefix,
  normalizeLabelRecord,
  normalizeMachineRecord,
  normalizeMetaRecord,
  normalizeSessionRecord,
} from "./records.js";

export function buildRedisKeys(keyPrefix) {
  const prefix = normalizeKeyPrefix(keyPrefix);
  return {
    prefix,
    meta: () => `${prefix}meta`,
    machines: () => `${prefix}machines`,
    labels: () => `${prefix}labels`,
    sessions: () => `${prefix}sessions`,
    machine: (machineId) => `${prefix}machine:${machineId}`,
    label: ({ provider, label }) => `${prefix}label:${provider}:${label}`,
    session: ({ provider, label, machineId }) => `${prefix}session:${provider}:${label}:${machineId}`,
    sessionsByLabel: ({ provider, label }) => `${prefix}sessionsByLabel:${provider}:${label}`,
    sessionsByMachine: (machineId) => `${prefix}sessionsByMachine:${machineId}`,
  };
}

export async function connectRedisStore({ url, keyPrefix, client = null } = {}) {
  if (!url && !client) {
    throw new Error("Missing Redis URL.");
  }
  const redisClient = client ?? createClient({ url });
  if (!client) {
    redisClient.on("error", () => {});
    await redisClient.connect();
  }
  return {
    client: redisClient,
    ownsClient: !client,
    keyPrefix: normalizeKeyPrefix(keyPrefix),
    keys: buildRedisKeys(keyPrefix),
  };
}

export async function closeRedisStore(store) {
  if (store?.ownsClient && store.client?.isOpen) {
    await store.client.quit();
  }
}

function parseJsonRecord(raw, key) {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(raw);
  } catch (err) {
    throw new Error(`Failed to parse Redis JSON record ${key}: ${String(err?.message ?? err)}`);
  }
}

async function readIndexedRecords(store, indexKey) {
  const keys = await store.client.sMembers(indexKey);
  const sortedKeys = [...keys].sort();
  if (sortedKeys.length === 0) return [];
  const values = await store.client.mGet(sortedKeys);
  return values
    .map((raw, index) => parseJsonRecord(raw, sortedKeys[index]))
    .filter(Boolean);
}

function isRedisWatchError(err) {
  const message = String(err?.message ?? err);
  return err?.name === "WatchError" || /watched keys/i.test(message);
}

export async function readSnapshot(store) {
  const [metaRaw, machinesRaw, labelsRaw, sessionsRaw] = await Promise.all([
    store.client.get(store.keys.meta()),
    readIndexedRecords(store, store.keys.machines()),
    readIndexedRecords(store, store.keys.labels()),
    readIndexedRecords(store, store.keys.sessions()),
  ]);
  const meta = parseJsonRecord(metaRaw, store.keys.meta());
  const machines = machinesRaw.map((record) => normalizeMachineRecord(record)).sort((a, b) => a.machineId.localeCompare(b.machineId));
  const labels = labelsRaw.map((record) => normalizeLabelRecord(record)).sort((a, b) => `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
  const sessions = sessionsRaw.map((record) => normalizeSessionRecord(record)).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  return {
    meta: meta ? normalizeMetaRecord(meta) : null,
    machines,
    labels,
    sessions,
    observedAt: new Date().toISOString(),
    keyPrefix: store.keyPrefix,
  };
}

function buildWrittenRecord({ current, expectedVersion, nextRecord, machineId, observedAt }) {
  const creating = expectedVersion === null || expectedVersion === undefined;
  const nextVersion = creating ? 1 : Number(expectedVersion) + 1;
  return {
    ...nextRecord,
    createdAt: current?.createdAt ?? nextRecord.createdAt ?? observedAt,
    updatedAt: observedAt,
    updatedBy: machineId ?? nextRecord.updatedBy ?? null,
    version: nextVersion,
  };
}

// This is the only shared mutation boundary for Redis-backed AIM state. Callers
// pass record-shaped data; raw keys and WATCH/MULTI/EXEC stay here.
export async function casPutJsonRecord(store, { key, indexKeys = [], expectedVersion, nextRecord, machineId, observedAt = new Date().toISOString() }) {
  await store.client.watch(key);
  try {
    const currentRaw = await store.client.get(key);
    const current = parseJsonRecord(currentRaw, key);
    if (expectedVersion === null || expectedVersion === undefined) {
      if (current) {
        await store.client.unwatch();
        return { ok: false, code: "stale_version", currentVersion: current.version, current };
      }
    } else if (!current || current.version !== expectedVersion) {
      await store.client.unwatch();
      return {
        ok: false,
        code: "stale_version",
        currentVersion: current?.version ?? null,
        current,
      };
    }

    const written = buildWrittenRecord({ current, expectedVersion, nextRecord, machineId, observedAt });
    const tx = store.client.multi();
    tx.set(key, JSON.stringify(written));
    for (const indexKey of indexKeys) {
      tx.sAdd(indexKey, key);
    }
    let result;
    try {
      result = await tx.exec();
    } catch (err) {
      if (!isRedisWatchError(err)) throw err;
      result = null;
    }
    if (result === null) {
      const latest = parseJsonRecord(await store.client.get(key), key);
      return { ok: false, code: "stale_version", currentVersion: latest?.version ?? null, current: latest };
    }
    return { ok: true, record: written };
  } finally {
    try {
      await store.client.unwatch();
    } catch {
      // WATCH is cleared by EXEC on success; this keeps early returns tidy.
    }
  }
}

export async function publishMeta(store, { expectedVersion, metaRecord, machineId, observedAt } = {}) {
  const record = normalizeMetaRecord(metaRecord, { now: observedAt });
  return casPutJsonRecord(store, {
    key: store.keys.meta(),
    expectedVersion,
    nextRecord: record,
    machineId,
    observedAt,
  });
}

export async function registerMachine(store, machineInfo) {
  const observedAt = machineInfo.observedAt ?? new Date().toISOString();
  const key = store.keys.machine(machineInfo.machineId);
  let lastResult = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const current = parseJsonRecord(await store.client.get(key), key);
    const record = normalizeMachineRecord(
      {
        ...current,
        ...machineInfo,
        lastSeenAt: observedAt,
      },
      { now: observedAt },
    );
    lastResult = await casPutJsonRecord(store, {
      key,
      indexKeys: [store.keys.machines()],
      expectedVersion: current?.version ?? null,
      nextRecord: record,
      machineId: machineInfo.machineId,
      observedAt,
    });
    if (lastResult.ok || lastResult.code !== "stale_version") return lastResult;
  }
  return lastResult;
}

export async function publishLabel(store, { expectedVersion, labelRecord, machineId, observedAt } = {}) {
  const record = normalizeLabelRecord(labelRecord, { now: observedAt });
  return casPutJsonRecord(store, {
    key: store.keys.label(record),
    indexKeys: [store.keys.labels()],
    expectedVersion,
    nextRecord: record,
    machineId,
    observedAt,
  });
}

export async function publishSession(store, { expectedVersion, sessionRecord, machineId, observedAt } = {}) {
  const record = normalizeSessionRecord(sessionRecord, { now: observedAt });
  return casPutJsonRecord(store, {
    key: store.keys.session(record),
    indexKeys: [
      store.keys.sessions(),
      store.keys.sessionsByLabel(record),
      store.keys.sessionsByMachine(record.machineId),
    ],
    expectedVersion,
    nextRecord: record,
    machineId: machineId ?? record.machineId,
    observedAt,
  });
}

export async function importSnapshot(store, snapshot, { machineId = "import", observedAt = new Date().toISOString() } = {}) {
  const results = [];
  if (snapshot.meta) {
    results.push(await publishMeta(store, { expectedVersion: null, metaRecord: snapshot.meta, machineId, observedAt }));
  }
  for (const machine of snapshot.machines ?? []) {
    results.push(await registerMachine(store, { ...machine, observedAt }));
  }
  for (const label of snapshot.labels ?? []) {
    results.push(await publishLabel(store, { expectedVersion: null, labelRecord: label, machineId, observedAt }));
  }
  for (const session of snapshot.sessions ?? []) {
    results.push(await publishSession(store, { expectedVersion: null, sessionRecord: session, machineId, observedAt }));
  }
  return results;
}
