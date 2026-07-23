import { randomUUID } from "node:crypto";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { normalizeKeyPrefix } from "./records.js";

export const DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS = 30_000;

const MAX_REDIS_CREDENTIAL_LEASE_TTL_MS = 3_600_000;
const leaseGuardedDeleteCapabilities = new WeakMap();

// The ownership check and expiry extension must remain one Redis operation.
const RENEW_CREDENTIAL_LEASE_SCRIPT = `
-- AIMGR_CREDENTIAL_LEASE_RENEW_V1
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

// A stale owner must never delete a lease acquired by a newer process.
const RELEASE_CREDENTIAL_LEASE_SCRIPT = `
-- AIMGR_CREDENTIAL_LEASE_RELEASE_V1
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

// Clearing continuity state must be conditional on the exact lease owner and
// the exact state observed by that owner in one Redis operation.
const GUARDED_DELETE_CREDENTIAL_STATE_SCRIPT = `
-- AIMGR_CREDENTIAL_LEASE_GUARDED_DELETE_V1
if redis.call("GET", KEYS[1]) ~= ARGV[1] then
  return 0
end
if redis.call("GET", KEYS[2]) ~= ARGV[2] then
  return -1
end
return redis.call("DEL", KEYS[2])
`;

function normalizeLeaseTtlMs(value) {
  if (!Number.isInteger(value) || value < 1 || value > MAX_REDIS_CREDENTIAL_LEASE_TTL_MS) {
    throw new Error("Invalid Redis credential lease TTL.");
  }
  return value;
}

function normalizeLeaseProvider(value) {
  const provider = normalizeProviderId(value);
  if (!provider || !/^[a-z0-9][a-z0-9-]*$/.test(provider)) {
    throw new Error("Invalid Redis credential lease provider.");
  }
  return provider;
}

function buildCredentialLeaseKey(store, { provider, label }) {
  const rawPrefix = typeof store?.keyPrefix === "string" ? store.keyPrefix.trim() : "";
  if (!rawPrefix || typeof store?.client?.set !== "function" || typeof store?.client?.eval !== "function") {
    throw new Error("Invalid Redis store for credential lease.");
  }
  const normalizedProvider = normalizeLeaseProvider(provider);
  const normalizedLabel = normalizeLabel(label);
  return `${normalizeKeyPrefix(rawPrefix)}lease:credential:${normalizedProvider}:${normalizedLabel}`;
}

function redisLeaseError(operation) {
  return new Error(`Redis credential lease ${operation} failed.`);
}

function succeeded(value) {
  return Number(value) === 1;
}

/**
 * Atomically deletes exact coordination state only while `lease` still owns
 * its Redis key. The lease key and token stay private in this module.
 */
export async function guardedDeleteWithRedisCredentialLease(lease, {
  targetKey,
  expectedValue,
} = {}) {
  const capability = leaseGuardedDeleteCapabilities.get(lease);
  if (!capability) throw new Error("Invalid Redis credential lease for guarded deletion.");
  return capability({ targetKey, expectedValue });
}

/**
 * Atomically acquires one provider/label lease in an already-connected store.
 *
 * The returned object deliberately exposes no key or ownership token. A null
 * result means another process currently owns the lease. The caller must keep
 * renewing a long-running operation and release the lease in a finally block.
 */
export async function acquireRedisCredentialLease(store, {
  provider,
  label,
  ttlMs = DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS,
} = {}) {
  const boundedTtlMs = normalizeLeaseTtlMs(ttlMs);
  const key = buildCredentialLeaseKey(store, { provider, label });
  const keyPrefix = normalizeKeyPrefix(store.keyPrefix);
  const token = randomUUID();

  let acquired;
  try {
    acquired = await store.client.set(key, token, {
      condition: "NX",
      expiration: { type: "PX", value: boundedTtlMs },
    });
  } catch {
    throw redisLeaseError("acquisition");
  }

  if (acquired === null) return null;
  if (acquired !== "OK") throw redisLeaseError("acquisition");

  let active = true;
  const lease = {
    async renew() {
      if (!active) return false;
      let result;
      try {
        result = await store.client.eval(RENEW_CREDENTIAL_LEASE_SCRIPT, {
          keys: [key],
          arguments: [token, String(boundedTtlMs)],
        });
      } catch {
        throw redisLeaseError("renewal");
      }
      const renewed = succeeded(result);
      if (!renewed) active = false;
      return renewed;
    },

    async release() {
      if (!active) return false;
      let result;
      try {
        result = await store.client.eval(RELEASE_CREDENTIAL_LEASE_SCRIPT, {
          keys: [key],
          arguments: [token],
        });
      } catch {
        throw redisLeaseError("release");
      }
      active = false;
      return succeeded(result);
    },
  };
  leaseGuardedDeleteCapabilities.set(lease, async ({ targetKey, expectedValue } = {}) => {
    if (
      !active
      || typeof targetKey !== "string"
      || !targetKey.startsWith(keyPrefix)
      || targetKey === key
      || typeof expectedValue !== "string"
      || expectedValue.length === 0
    ) {
      return false;
    }
    let result;
    try {
      result = await store.client.eval(GUARDED_DELETE_CREDENTIAL_STATE_SCRIPT, {
        keys: [key, targetKey],
        arguments: [token, expectedValue],
      });
    } catch {
      throw redisLeaseError("guarded deletion");
    }
    if (Number(result) === 0) {
      // The lease changed or expired. Do not let the stale owner perform any
      // later operation through this local handle.
      active = false;
    }
    return succeeded(result);
  });
  return Object.freeze(lease);
}
