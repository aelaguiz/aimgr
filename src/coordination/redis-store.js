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

export const REDIS_CONNECTION_POLICY_OBSERVE = "observe";
export const REDIS_CONNECTION_POLICY_ONE_SHOT = "one-shot";
export const REDIS_CONNECTION_POLICY_LEASED = "leased";

const REDIS_CONNECTION_POLICIES = new Set([
  REDIS_CONNECTION_POLICY_OBSERVE,
  REDIS_CONNECTION_POLICY_ONE_SHOT,
  REDIS_CONNECTION_POLICY_LEASED,
]);

function normalizeTimeoutMs(value, fallback) {
  return Number.isFinite(value) && value > 0 ? Math.round(value) : fallback;
}

export function buildRedisConnectionPolicy(connectionPolicy = REDIS_CONNECTION_POLICY_ONE_SHOT, {
  timeoutMs,
} = {}) {
  if (!REDIS_CONNECTION_POLICIES.has(connectionPolicy)) {
    throw new Error(`Unsupported Redis connection policy: ${String(connectionPolicy)}.`);
  }
  const fallbackTimeoutMs = connectionPolicy === REDIS_CONNECTION_POLICY_OBSERVE ? 2_000 : 5_000;
  const boundedTimeoutMs = normalizeTimeoutMs(timeoutMs, fallbackTimeoutMs);
  if (connectionPolicy === REDIS_CONNECTION_POLICY_LEASED) {
    return {
      initialConnectTimeoutMs: boundedTimeoutMs,
      clientOptions: {
        disableOfflineQueue: true,
        socket: {
          connectTimeout: boundedTimeoutMs,
          reconnectStrategy: (retries) => Math.min(100 * (2 ** Math.min(retries, 4)), 1_000),
        },
      },
    };
  }
  return {
    initialConnectTimeoutMs: boundedTimeoutMs,
    clientOptions: {
      socket: {
        connectTimeout: boundedTimeoutMs,
        socketTimeout: boundedTimeoutMs,
        reconnectStrategy: false,
      },
    },
  };
}

// Compatibility name for read-only callers; the policy remains centralized.
export function buildRedisStatusClientOptions({ timeoutMs = 2_000 } = {}) {
  return buildRedisConnectionPolicy(REDIS_CONNECTION_POLICY_OBSERVE, { timeoutMs }).clientOptions;
}

async function connectWithInitialDeadline(client, timeoutMs) {
  let timeoutId = null;
  const connectPromise = Promise.resolve().then(() => client.connect());
  // Retain a rejection handler even when the deadline wins, so a late connect
  // rejection cannot become an unhandled process error.
  connectPromise.catch(() => {});
  try {
    await Promise.race([
      connectPromise,
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error("Redis initial connection timed out.")), timeoutMs);
        timeoutId.unref?.();
      }),
    ]);
  } catch (error) {
    try {
      client.destroy?.();
    } catch {
      // Preserve the fixed, value-free connection error.
    }
    throw error;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }
}

export async function connectRedisStore({
  url,
  keyPrefix,
  client = null,
  clientOptions = {},
  connectionPolicy = REDIS_CONNECTION_POLICY_ONE_SHOT,
  initialConnectTimeoutMs,
  createClientImpl = createClient,
} = {}) {
  if (!url && !client) {
    throw new Error("Missing Redis URL.");
  }
  const policy = buildRedisConnectionPolicy(connectionPolicy, {
    timeoutMs: initialConnectTimeoutMs,
  });
  const redisClient = client ?? createClientImpl({
    ...policy.clientOptions,
    ...clientOptions,
    socket: {
      ...policy.clientOptions.socket,
      ...(clientOptions.socket ?? {}),
    },
    url,
  });
  if (!client) {
    redisClient.on("error", () => {});
    await connectWithInitialDeadline(
      redisClient,
      normalizeTimeoutMs(initialConnectTimeoutMs, policy.initialConnectTimeoutMs),
    );
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
