import { createClient } from "redis";
import {
  normalizeCredentialRecord,
  normalizeKeyPrefix,
  normalizeMetaRecord,
} from "./records.js";
import { normalizeProviderId } from "../core/normalize.js";

export function buildRedisKeys(keyPrefix) {
  const prefix = normalizeKeyPrefix(keyPrefix);
  return {
    prefix,
    meta: () => `${prefix}meta`,
    credentials: () => `${prefix}credentials`,
    credentialsByProvider: (provider) => `${prefix}credentialsByProvider:${provider}`,
    credential: ({ provider, label }) => `${prefix}credential:${provider}:${label}`,
  };
}

export function buildRedisStatusClientOptions({ timeoutMs = 2_000 } = {}) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 2_000;
  return {
    socket: {
      connectTimeout: boundedTimeoutMs,
      socketTimeout: boundedTimeoutMs,
      reconnectStrategy: false,
    },
  };
}

export async function connectRedisStore({ url, keyPrefix, client = null, clientOptions = {} } = {}) {
  if (!url && !client) {
    throw new Error("Missing Redis URL.");
  }
  const redisClient = client ?? createClient({ ...clientOptions, url });
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

async function readIndexedRecordEntries(store, indexKey) {
  const keys = await store.client.sMembers(indexKey);
  const sortedKeys = [...keys].sort();
  if (sortedKeys.length === 0) return [];
  const values = await store.client.mGet(sortedKeys);
  return values.map((raw, index) => ({
    key: sortedKeys[index],
    value: parseJsonRecord(raw, sortedKeys[index]),
  })).filter((entry) => entry.value !== null);
}

async function readIndexedRecords(store, indexKey) {
  return (await readIndexedRecordEntries(store, indexKey)).map((entry) => entry.value);
}

function isRedisWatchError(err) {
  const message = String(err?.message ?? err);
  return err?.name === "WatchError" || /watched keys/i.test(message);
}

export async function readSnapshot(store) {
  const [metaRaw, credentialsRaw] = await Promise.all([
    store.client.get(store.keys.meta()),
    readIndexedRecords(store, store.keys.credentials()),
  ]);
  const meta = parseJsonRecord(metaRaw, store.keys.meta());
  const credentials = credentialsRaw
    .map((record) => normalizeCredentialRecord(record))
    .sort((a, b) => `${a.provider}:${a.label}`.localeCompare(`${b.provider}:${b.label}`));
  return {
    meta: meta ? normalizeMetaRecord(meta) : null,
    credentials,
    observedAt: new Date().toISOString(),
    keyPrefix: store.keyPrefix,
  };
}

export async function readCredentialRecordsByProvider(store, provider) {
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    throw new Error("Missing provider for Redis credential read.");
  }
  const entries = await readIndexedRecordEntries(store, store.keys.credentialsByProvider(normalizedProvider));
  const records = [];
  const identities = new Set();
  for (const entry of entries) {
    const record = normalizeCredentialRecord(entry.value);
    const expectedKey = store.keys.credential(record);
    const identity = `${record.provider}:${record.label}`;
    if (entry.key !== expectedKey || record.provider !== normalizedProvider || identities.has(identity)) {
      throw new Error("Redis provider credential index is inconsistent.");
    }
    identities.add(identity);
    records.push(record);
  }
  return records.sort((left, right) => left.label.localeCompare(right.label));
}

function buildWrittenRecord({ current, expectedVersion, nextRecord, updatedBy, observedAt }) {
  const creating = expectedVersion === null || expectedVersion === undefined;
  const nextVersion = creating ? 1 : Number(expectedVersion) + 1;
  return {
    ...nextRecord,
    createdAt: current?.createdAt ?? nextRecord.createdAt ?? observedAt,
    updatedAt: observedAt,
    updatedBy: updatedBy ?? nextRecord.updatedBy ?? null,
    version: nextVersion,
  };
}

// This is the only shared mutation boundary for Redis-backed AIM state. Callers
// pass record-shaped data; raw keys and WATCH/MULTI/EXEC stay here.
export async function casPutJsonRecord(store, { key, indexKeys = [], expectedVersion, nextRecord, updatedBy, observedAt = new Date().toISOString() }) {
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

    const written = buildWrittenRecord({ current, expectedVersion, nextRecord, updatedBy, observedAt });
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

export async function publishMeta(store, { expectedVersion, metaRecord, updatedBy, observedAt } = {}) {
  const record = normalizeMetaRecord(metaRecord, { now: observedAt });
  return casPutJsonRecord(store, {
    key: store.keys.meta(),
    expectedVersion,
    nextRecord: record,
    updatedBy,
    observedAt,
  });
}

export async function publishCredential(store, { expectedVersion, credentialRecord, updatedBy, observedAt } = {}) {
  const record = normalizeCredentialRecord(credentialRecord, { now: observedAt });
  return casPutJsonRecord(store, {
    key: store.keys.credential(record),
    indexKeys: [
      store.keys.credentials(),
      store.keys.credentialsByProvider(record.provider),
    ],
    expectedVersion,
    nextRecord: record,
    updatedBy,
    observedAt,
  });
}

export async function importCredentialsSnapshot(store, snapshot, {
  updatedBy = "import",
  observedAt = new Date().toISOString(),
  replaceExisting = false,
} = {}) {
  const results = [];
  const current = replaceExisting ? await readSnapshot(store) : null;
  const currentCredentials = new Map(
    (current?.credentials ?? []).map((record) => [`${record.provider}:${record.label}`, record]),
  );
  if (snapshot.meta) {
    results.push(await publishMeta(store, {
      expectedVersion: replaceExisting ? current?.meta?.version ?? null : null,
      metaRecord: snapshot.meta,
      updatedBy,
      observedAt,
    }));
  }
  for (const credential of snapshot.credentials ?? []) {
    const key = `${credential.provider}:${credential.label}`;
    results.push(await publishCredential(store, {
      expectedVersion: replaceExisting ? currentCredentials.get(key)?.version ?? null : null,
      credentialRecord: credential,
      updatedBy,
      observedAt,
    }));
  }
  return results;
}

export async function importSnapshot(store, snapshot, options = {}) {
  return importCredentialsSnapshot(store, snapshot, options);
}

function legacyKeys(store) {
  const prefix = store.keyPrefix;
  return {
    machines: `${prefix}machines`,
    labels: `${prefix}labels`,
    sessions: `${prefix}sessions`,
  };
}

export async function readLegacyRedisSnapshot(store) {
  const keys = legacyKeys(store);
  const [machines, labels, sessions] = await Promise.all([
    readIndexedRecords(store, keys.machines),
    readIndexedRecords(store, keys.labels),
    readIndexedRecords(store, keys.sessions),
  ]);
  return {
    machines,
    labels,
    sessions,
    observedAt: new Date().toISOString(),
    keyPrefix: store.keyPrefix,
  };
}

async function deleteKeys(store, keys) {
  const uniqueKeys = [...new Set(keys.filter(Boolean))];
  if (uniqueKeys.length === 0) return 0;
  if (typeof store.client.del !== "function") {
    throw new Error("Redis client does not support DEL.");
  }
  return store.client.del(uniqueKeys);
}

export async function deleteLegacyRedisCredentialKeys(store) {
  const keys = legacyKeys(store);
  const snapshot = await readLegacyRedisSnapshot(store);
  const recordKeys = [
    ...snapshot.machines.map((record) => `${store.keyPrefix}machine:${record.machineId}`),
    ...snapshot.labels.map((record) => `${store.keyPrefix}label:${record.provider}:${record.label}`),
    ...snapshot.sessions.map((record) => `${store.keyPrefix}session:${record.provider}:${record.label}:${record.machineId}`),
    ...snapshot.sessions.map((record) => `${store.keyPrefix}sessionsByLabel:${record.provider}:${record.label}`),
    ...snapshot.sessions.map((record) => `${store.keyPrefix}sessionsByMachine:${record.machineId}`),
  ];
  const deleted = await deleteKeys(store, [keys.machines, keys.labels, keys.sessions, ...recordKeys]);
  return {
    ok: true,
    deleted,
    legacyCounts: {
      machines: snapshot.machines.length,
      labels: snapshot.labels.length,
      sessions: snapshot.sessions.length,
    },
  };
}
