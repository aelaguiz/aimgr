import { createHash, randomUUID } from "node:crypto";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { normalizeKeyPrefix } from "./records.js";
import { publishCredential, readCredentialRecordsByProvider } from "./redis-store.js";

export const CODEX_DESKTOP_RESERVED_REASON = "codex_desktop_reserved";
export const CODEX_DESKTOP_NATIVE_OWNED_STATUS = "native_owned";
export const DEFAULT_CODEX_IDENTITY_CATALOG_LEASE_TTL_MS = 30_000;

const catalogCommitCapabilities = new WeakMap();

/**
 * Opaque reservation fingerprint for the Desktop-reserved Codex identity.
 * Status/policy surfaces carry this value instead of the immutable account ID.
 */
export function buildCodexDesktopIdentityFingerprint(accountId) {
  const raw = String(accountId ?? "").trim();
  if (!raw) {
    throw new Error("Cannot fingerprint an empty Codex account identity.");
  }
  const digest = createHash("sha256")
    .update(JSON.stringify(["aimgr-codex-desktop-v1", raw]))
    .digest("base64url");
  return `aimgr-codex-desktop-v1:${digest}`;
}

export function getCodexDesktopReservation(record) {
  const reservation = record?.policy?.expect?.codexDesktop;
  if (!isObject(reservation) || reservation.reserved !== true) return null;
  return reservation;
}

/**
 * Raw provider-wide Codex record list, including identity-only records whose
 * credential material is empty. Reservation decisions must come from this
 * list, never from the normalized coordination view (which drops
 * credential-empty records from `state.credentials`).
 */
export async function listRawCodexIdentityRecords(store) {
  return readCredentialRecordsByProvider(store, OPENAI_CODEX_PROVIDER);
}

/**
 * Index of Desktop-reserved immutable Codex account IDs across every label.
 * A reservation whose fingerprint no longer matches its record identity is a
 * corrupted reservation and fails closed.
 */
export function buildReservedCodexIdentityIndex(records) {
  const index = new Map();
  for (const record of Array.isArray(records) ? records : []) {
    const reservation = getCodexDesktopReservation(record);
    if (!reservation) continue;
    const accountId = typeof record.identity?.accountId === "string" ? record.identity.accountId.trim() : "";
    if (!accountId) {
      throw new Error(
        `Codex Desktop reservation on label=${record.label} has no immutable account identity; refusing to proceed.`,
      );
    }
    if (reservation.identityFingerprint !== buildCodexDesktopIdentityFingerprint(accountId)) {
      throw new Error(
        `Codex Desktop reservation fingerprint mismatch on label=${record.label}; refusing to proceed.`,
      );
    }
    index.set(accountId, { label: record.label, reservation });
  }
  return index;
}

export async function readReservedCodexIdentityIndex(store) {
  return buildReservedCodexIdentityIndex(await listRawCodexIdentityRecords(store));
}

export class CodexDesktopReservedError extends Error {
  constructor({ label, operation }) {
    super(
      `Refusing ${operation || "codex credential write"} for label=${label}: `
        + "this identity is reserved for the Codex Desktop app (codex_desktop_reserved). "
        + "Only `aim codex desktop unpin` may release it.",
    );
    this.name = "CodexDesktopReservedError";
    this.code = CODEX_DESKTOP_RESERVED_REASON;
  }
}

/**
 * Central reservation gate for every Codex identity write, refresh,
 * materialization, or restore. Rejects when the target label carries the
 * reservation or when the written account ID aliases a reserved identity
 * under any other label.
 */
export function assertCodexIdentityWriteAllowed({ index, label, accountId, operation } = {}) {
  if (!(index instanceof Map)) {
    throw new Error("Codex reservation gate requires a reserved-identity index.");
  }
  const normalizedLabel = label ? normalizeLabel(label) : null;
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (normalizedAccountId && index.has(normalizedAccountId)) {
    throw new CodexDesktopReservedError({
      label: normalizedLabel ?? index.get(normalizedAccountId).label,
      operation,
    });
  }
  if (normalizedLabel) {
    for (const [, entry] of index) {
      if (entry.label === normalizedLabel) {
        throw new CodexDesktopReservedError({ label: normalizedLabel, operation });
      }
    }
  }
}

/** Fresh-read convenience wrapper around the reservation gate. */
export async function assertCodexCredentialWriteAllowedFresh(store, { label, accountId, operation } = {}) {
  const index = await readReservedCodexIdentityIndex(store);
  assertCodexIdentityWriteAllowed({ index, label, accountId, operation });
  return index;
}

function buildCatalogLeaseKey(store) {
  const rawPrefix = typeof store?.keyPrefix === "string" ? store.keyPrefix.trim() : "";
  if (!rawPrefix) {
    throw new Error("Invalid Redis store for Codex identity catalog lease.");
  }
  return `${normalizeKeyPrefix(rawPrefix)}lease:identity-catalog:${OPENAI_CODEX_PROVIDER}`;
}

// Ownership check and expiry extension stay one Redis operation, and there is
// deliberately no renew-or-reacquire variant: an expired catalog lease means
// the raw scan is stale and must restart under a brand-new token.
const RENEW_CATALOG_LEASE_SCRIPT = `
-- AIMGR_CODEX_IDENTITY_CATALOG_LEASE_RENEW_V1
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("PEXPIRE", KEYS[1], ARGV[2])
end
return 0
`;

const RELEASE_CATALOG_LEASE_SCRIPT = `
-- AIMGR_CODEX_IDENTITY_CATALOG_LEASE_RELEASE_V1
if redis.call("GET", KEYS[1]) == ARGV[1] then
  return redis.call("DEL", KEYS[1])
end
return 0
`;

/**
 * Provider-wide Codex identity-catalog lease with a unique opaque token per
 * acquisition. Serializes every identity-changing Codex write. The lease
 * exposes no key or token; identity commits go through
 * `commitCodexIdentityRecordFenced`, which fences the write on the live token
 * so an expired/reacquired lease can never commit a stale scan. Any failed or
 * lost commit permanently invalidates this lease handle; a retry must acquire
 * a fresh lease and redo the raw scan and expected-version reads.
 */
export async function acquireCodexIdentityCatalogLease(store, {
  ttlMs = DEFAULT_CODEX_IDENTITY_CATALOG_LEASE_TTL_MS,
} = {}) {
  if (typeof store?.client?.set !== "function" || typeof store?.client?.eval !== "function") {
    throw new Error("Invalid Redis store for Codex identity catalog lease.");
  }
  if (!Number.isInteger(ttlMs) || ttlMs < 1 || ttlMs > 3_600_000) {
    throw new Error("Invalid Codex identity catalog lease TTL.");
  }
  const key = buildCatalogLeaseKey(store);
  const token = randomUUID();

  let acquired;
  try {
    acquired = await store.client.set(key, token, {
      condition: "NX",
      expiration: { type: "PX", value: ttlMs },
    });
  } catch {
    throw new Error("Codex identity catalog lease acquisition failed.");
  }
  if (acquired === null) return null;
  if (acquired !== "OK") throw new Error("Codex identity catalog lease acquisition failed.");

  let active = true;

  async function releaseInternal() {
    let result;
    try {
      result = await store.client.eval(RELEASE_CATALOG_LEASE_SCRIPT, {
        keys: [key],
        arguments: [token],
      });
    } catch {
      throw new Error("Codex identity catalog lease release failed.");
    }
    return Number(result) === 1;
  }

  const lease = {
    async renew() {
      if (!active) return false;
      let result;
      try {
        result = await store.client.eval(RENEW_CATALOG_LEASE_SCRIPT, {
          keys: [key],
          arguments: [token, String(ttlMs)],
        });
      } catch {
        throw new Error("Codex identity catalog lease renewal failed.");
      }
      const renewed = Number(result) === 1;
      if (!renewed) active = false;
      return renewed;
    },

    async release() {
      if (!active) return false;
      active = false;
      return releaseInternal();
    },
  };

  catalogCommitCapabilities.set(lease, async ({ expectedVersion, credentialRecord, updatedBy, observedAt }) => {
    if (!active) return { ok: false, code: "catalog_lease_lost" };
    const result = await publishCredential(store, {
      expectedVersion,
      credentialRecord,
      updatedBy,
      observedAt,
      fence: { key, token },
    });
    if (!result.ok) {
      // One failed fenced commit invalidates this scan permanently. Free the
      // catalog for the writer that won, then force the caller to restart
      // with a new token and a fresh raw scan.
      active = false;
      try {
        await releaseInternal();
      } catch {
        // The lease will expire on its own; the handle is already dead.
      }
      if (result.code === "fence_lost") {
        return { ok: false, code: "catalog_lease_lost" };
      }
      return { ok: false, code: result.code ?? "stale_version" };
    }
    return result;
  });

  return Object.freeze(lease);
}

/**
 * Commits one Codex identity-bearing credential record under the live catalog
 * lease token plus target record version. This is the single write boundary
 * for reservation, retirement, and unpin record shapes.
 */
export async function commitCodexIdentityRecordFenced(lease, args = {}) {
  const capability = catalogCommitCapabilities.get(lease);
  if (!capability) {
    throw new Error("Invalid Codex identity catalog lease for fenced commit.");
  }
  return capability(args);
}

function deepEquals(left, right) {
  return JSON.stringify(left ?? null) === JSON.stringify(right ?? null);
}

/**
 * Single guarded entry point for Codex credential-record publication outside
 * pin/unpin. Acquires the provider-wide catalog lease, fresh-scans the raw
 * record set (including credential-empty identity records), rejects reserved
 * identities and reserved-label writes, and commits under the live-token
 * fence. `allowReservedPolicyRoundTrip` permits a policy-only write to a
 * reserved record when the reservation object, empty credential, and identity
 * all round-trip unchanged.
 */
export async function publishCodexCredentialRecordGuarded(store, {
  expectedVersion,
  credentialRecord,
  updatedBy,
  observedAt,
  operation = "codex credential publication",
  allowReservedPolicyRoundTrip = false,
} = {}) {
  const lease = await acquireCodexIdentityCatalogLease(store);
  if (!lease) {
    throw new Error("Codex identity catalog is busy; retry shortly.");
  }
  try {
    const records = await listRawCodexIdentityRecords(store);
    const index = buildReservedCodexIdentityIndex(records);
    const label = normalizeLabel(credentialRecord?.label);
    const accountId = typeof credentialRecord?.identity?.accountId === "string" && credentialRecord.identity.accountId.trim()
      ? credentialRecord.identity.accountId.trim()
      : typeof credentialRecord?.credential?.accountId === "string" && credentialRecord.credential.accountId.trim()
        ? credentialRecord.credential.accountId.trim()
        : null;

    let reservedRoundTrip = false;
    if (allowReservedPolicyRoundTrip) {
      const current = records.find((record) => record.label === label) ?? null;
      const currentReservation = current ? getCodexDesktopReservation(current) : null;
      if (currentReservation) {
        const nextReservation = credentialRecord?.policy?.expect?.codexDesktop ?? null;
        const credentialStillEmpty = !isObject(credentialRecord?.credential)
          || Object.keys(credentialRecord.credential).length === 0;
        const identityUnchanged = deepEquals(credentialRecord?.identity ?? {}, current.identity ?? {});
        if (!deepEquals(nextReservation, currentReservation) || !credentialStillEmpty || !identityUnchanged) {
          throw new CodexDesktopReservedError({ label, operation });
        }
        reservedRoundTrip = true;
      }
    }
    if (!reservedRoundTrip) {
      assertCodexIdentityWriteAllowed({ index, label, accountId, operation });
    }
    return await commitCodexIdentityRecordFenced(lease, {
      expectedVersion,
      credentialRecord,
      updatedBy,
      observedAt,
    });
  } finally {
    await lease.release().catch(() => {});
  }
}
