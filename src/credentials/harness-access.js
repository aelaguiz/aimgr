import { createHash } from "node:crypto";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { acquireRedisCredentialLease } from "../coordination/redis-credential-lease.js";
import { buildStableIdentityForCredential } from "../coordination/login-publish.js";
import { publishCredential } from "../coordination/redis-store.js";
import { refreshRedisRuntimeState } from "../coordination/runtime.js";
import { findCredentialRecord } from "../coordination/snapshot.js";
import { getAnthropicCredentialView } from "./anthropic.js";
import { hasCompleteClaudeNativeBundle } from "./claude-bundle.js";
import { maintainRedisClaudeCredential } from "./claude-maintenance.js";
import { CodexRefreshInvalidGrantError, refreshCodexWithoutBrowser } from "./codex-login.js";

export const HARNESS_CREDENTIAL_SCHEMA_VERSION = 1;
export const HARNESS_CREDENTIAL_FRESHNESS_FLOOR_MS = 5 * 60_000;

export const HARNESS_CREDENTIAL_ERROR_DETAILS = Object.freeze({
  helper_unavailable: Object.freeze({
    message: "The AIM credential helper is unavailable.",
    action: "Verify the installed AIM executable and retry.",
  }),
  helper_untrusted: Object.freeze({
    message: "The AIM credential helper executable is not trusted.",
    action: "Reinstall AIM from an owner-controlled path.",
  }),
  helper_timeout: Object.freeze({
    message: "The AIM credential helper timed out.",
    action: "Retry after credential maintenance or coordination recovers.",
  }),
  protocol_mismatch: Object.freeze({
    message: "The AIM credential helper protocol request is invalid.",
    action: "Update AIM and the calling harness to compatible versions.",
  }),
  unknown_label: Object.freeze({
    message: "The requested AIM account label does not exist.",
    action: "Install a descriptor for an existing exact AIM label.",
  }),
  provider_mismatch: Object.freeze({
    message: "The requested AIM label belongs to another provider.",
    action: "Choose a label for the requested provider.",
  }),
  credential_incomplete: Object.freeze({
    message: "The AIM credential record is incomplete.",
    action: "Repair or reauthenticate the exact AIM label.",
  }),
  credential_expired: Object.freeze({
    message: "The AIM access credential is expired.",
    action: "Run credential maintenance or reauthenticate the exact label.",
  }),
  reauth_required: Object.freeze({
    message: "The AIM account requires reauthentication.",
    action: "Reauthenticate the exact AIM label, then retry this session.",
  }),
  lease_busy: Object.freeze({
    message: "Another AIM operation is maintaining this account.",
    action: "Wait for that operation to finish, then retry.",
  }),
  coordination_unavailable: Object.freeze({
    message: "AIM credential coordination is unavailable.",
    action: "Restore Redis coordination, then retry.",
  }),
  identity_conflict: Object.freeze({
    message: "The AIM account identity no longer matches this binding.",
    action: "Update the target and start a new root session tree.",
  }),
  no_eligible_account: Object.freeze({
    message: "No eligible AIM account is available.",
    action: "Inspect AIM status or select an exact eligible label.",
  }),
});

export class HarnessCredentialError extends Error {
  constructor(code, options = {}) {
    const detail = HARNESS_CREDENTIAL_ERROR_DETAILS[code]
      ?? HARNESS_CREDENTIAL_ERROR_DETAILS.coordination_unavailable;
    super(detail.message, options);
    this.name = "HarnessCredentialError";
    this.code = Object.hasOwn(HARNESS_CREDENTIAL_ERROR_DETAILS, code)
      ? code
      : "coordination_unavailable";
    this.action = HARNESS_CREDENTIAL_ERROR_DETAILS[this.code].action;
  }
}

function fail(code, cause) {
  throw new HarnessCredentialError(code, cause ? { cause } : undefined);
}

function throwIfAborted(signal) {
  if (signal?.aborted) fail("helper_timeout", signal.reason);
}

function remainingMs(deadlineMs, fallbackMs) {
  if (!Number.isFinite(deadlineMs)) return fallbackMs;
  return Math.max(0, Math.min(fallbackMs, Math.floor(deadlineMs - Date.now())));
}

function immutableIdentityBasis(provider, identity) {
  if (!isObject(identity)) fail("credential_incomplete");
  if (provider === OPENAI_CODEX_PROVIDER) {
    const accountId = typeof identity.accountId === "string" ? identity.accountId.trim() : "";
    if (!accountId) fail("credential_incomplete");
    return Object.freeze({ accountId });
  }
  if (provider === ANTHROPIC_PROVIDER) {
    // Claude's account UUID is the provider-stable account identity. Email,
    // organization, and other enrichment may change without rebinding a tree.
    const accountUuid = typeof identity.accountUuid === "string" ? identity.accountUuid.trim() : "";
    if (!accountUuid) fail("credential_incomplete");
    return Object.freeze({ accountUuid });
  }
  fail("provider_mismatch");
}

/**
 * Returns an opaque AIM-owned stable identity binding. Harnesses compare this
 * byte-for-byte and must never derive or parse provider identity themselves.
 */
export function buildHarnessIdentityFingerprint(record) {
  const provider = normalizeProviderId(record?.provider);
  const identity = immutableIdentityBasis(provider, record?.identity);
  const digest = createHash("sha256")
    .update(JSON.stringify(["aimgr-identity-v1", provider, identity]))
    .digest("base64url");
  return `aimgr-id-v1:${digest}`;
}

function findExactRecord(snapshot, { provider, label }) {
  const exact = findCredentialRecord(snapshot, { provider, label });
  if (exact) return exact;
  const otherProvider = (snapshot?.credentials ?? []).some((record) => record.label === label);
  fail(otherProvider ? "provider_mismatch" : "unknown_label");
}

function credentialView(record) {
  return record.provider === ANTHROPIC_PROVIDER
    ? getAnthropicCredentialView(record.credential)
    : record.credential;
}

function validateRecord(record, { nowMs, requireFresh = false } = {}) {
  if (record?.policy?.reauth?.blockedReason === "oauth_reauth_required") {
    fail("reauth_required");
  }
  const credential = credentialView(record);
  const accessToken = typeof credential?.access === "string" ? credential.access.trim() : "";
  const expiresAt = parseExpiresAtToMs(credential?.expiresAt);
  const complete = record.provider === OPENAI_CODEX_PROVIDER
    ? Boolean(
        accessToken
        && typeof credential?.refresh === "string"
        && credential.refresh.trim()
        && typeof credential?.accountId === "string"
        && credential.accountId.trim()
        && expiresAt,
      )
    : record.provider === ANTHROPIC_PROVIDER
      ? Boolean(accessToken && expiresAt && hasCompleteClaudeNativeBundle(record.credential))
      : false;
  if (!complete) fail("credential_incomplete");
  const storedIdentity = immutableIdentityBasis(record.provider, record.identity);
  const derivedIdentity = immutableIdentityBasis(
    record.provider,
    buildStableIdentityForCredential(record.provider, record.credential),
  );
  if (JSON.stringify(storedIdentity) !== JSON.stringify(derivedIdentity)) fail("identity_conflict");
  const identityFingerprint = buildHarnessIdentityFingerprint(record);
  if (requireFresh && expiresAt <= nowMs + HARNESS_CREDENTIAL_FRESHNESS_FLOOR_MS) {
    fail("credential_expired");
  }
  return { accessToken, expiresAt, identityFingerprint };
}

function isDue(record, nowMs) {
  const expiresAt = parseExpiresAtToMs(credentialView(record)?.expiresAt);
  return expiresAt === null || expiresAt <= nowMs + HARNESS_CREDENTIAL_FRESHNESS_FLOOR_MS;
}

export function inspectHarnessCredentialRecord(record, { nowMs = Date.now() } = {}) {
  const validated = validateRecord(record, { nowMs });
  return Object.freeze({
    provider: record.provider,
    binding: record.label,
    identityFingerprint: validated.identityFingerprint,
    expiresAt: validated.expiresAt,
    due: isDue(record, nowMs),
  });
}

async function publishCodexReauthRequired(runtime, record, observedAt) {
  const result = await publishCredential(runtime.store, {
    expectedVersion: record.version,
    updatedBy: runtime.updatedBy,
    observedAt,
    credentialRecord: {
      ...record,
      policy: {
        ...(isObject(record.policy) ? record.policy : {}),
        reauth: {
          ...(isObject(record.policy?.reauth) ? record.policy.reauth : {}),
          blockedReason: "oauth_reauth_required",
        },
      },
    },
  });
  if (!result.ok) fail("coordination_unavailable");
}

/** Refreshes one exact Codex record under the existing provider/label lease and CAS owner. */
export async function maintainRedisCodexCredential(context, {
  runtime,
  label,
  force = false,
  incompleteMeansReauth = false,
  signal = context?.signal,
  deadlineMs = context?.deadlineMs,
} = {}) {
  const normalizedLabel = normalizeLabel(label);
  throwIfAborted(signal);
  let lease;
  try {
    lease = await acquireRedisCredentialLease(runtime.store, {
      provider: OPENAI_CODEX_PROVIDER,
      label: normalizedLabel,
    });
  } catch (error) {
    fail("coordination_unavailable", error);
  }
  if (!lease) return Object.freeze({ outcome: "skipped", reason: "lease_busy" });

  let failure = null;
  let result = null;
  try {
    throwIfAborted(signal);
    await refreshRedisRuntimeState(runtime);
    const record = findExactRecord(runtime.snapshot, {
      provider: OPENAI_CODEX_PROVIDER,
      label: normalizedLabel,
    });
    const missingRefreshMaterial = typeof record?.credential?.refresh !== "string"
      || !record.credential.refresh.trim()
      || typeof record?.credential?.accountId !== "string"
      || !record.credential.accountId.trim();
    if (incompleteMeansReauth && missingRefreshMaterial) {
      throwIfAborted(signal);
      if (await lease.renew() !== true) fail("coordination_unavailable");
      await publishCodexReauthRequired(runtime, record, new Date().toISOString());
      result = Object.freeze({ outcome: "reauth_required", reason: "refresh_material_missing" });
    } else {
      validateRecord(record, { nowMs: Date.now() });
    }
    if (result) {
      // The durable reauth transition above is the complete maintenance result.
    } else if (!force && !isDue(record, Number.isFinite(context?.nowMs) ? context.nowMs : Date.now())) {
      result = Object.freeze({ outcome: "unchanged", reason: "not_due" });
    } else {
      const fetchTimeoutMs = remainingMs(deadlineMs, 8_000);
      if (fetchTimeoutMs < 1) fail("helper_timeout");
      let nextCredential;
      try {
        nextCredential = await refreshCodexWithoutBrowser({
          credential: record.credential,
          fetchJsonWithTimeoutImpl: context.fetchJsonWithTimeoutImpl,
          nowMs: Number.isFinite(context?.nowMs) ? context.nowMs : Date.now(),
          signal,
          timeoutMs: fetchTimeoutMs,
        });
      } catch (error) {
        if (!(error instanceof CodexRefreshInvalidGrantError)) throw error;
        throwIfAborted(signal);
        if (await lease.renew() !== true) fail("coordination_unavailable");
        await publishCodexReauthRequired(runtime, record, new Date().toISOString());
        result = Object.freeze({ outcome: "reauth_required", reason: "refresh_rejected" });
      }
      if (nextCredential) {
        throwIfAborted(signal);
        if (await lease.renew() !== true) fail("coordination_unavailable");
        const published = await publishCredential(runtime.store, {
          expectedVersion: record.version,
          updatedBy: runtime.updatedBy,
          observedAt: new Date().toISOString(),
          credentialRecord: {
            ...record,
            credential: nextCredential,
            health: { status: "ready", reason: null },
            provenance: {
              ...(isObject(record.provenance) ? record.provenance : {}),
              lastSourceType: "login-maintenance",
            },
          },
        });
        if (!published.ok) fail("coordination_unavailable");
        result = Object.freeze({ outcome: "refreshed", reason: "credential_rotated" });
      }
    }
  } catch (error) {
    failure = error;
  }

  const released = await lease.release().catch(() => false);
  if (failure) throw failure;
  if (!released) fail("coordination_unavailable");
  return result ?? Object.freeze({ outcome: "retryable", reason: "maintenance_failed" });
}

function mapClaudeMaintenanceResult(result) {
  if (result?.outcome === "refreshed" || result?.outcome === "unchanged") return;
  if (result?.outcome === "reauth_required") fail("reauth_required");
  if (result?.reason === "lease_busy") fail("lease_busy");
  if (result?.reason === "client_timeout" || result?.reason === "client_signaled") fail("helper_timeout");
  if (result?.reason === "credential_missing" || result?.reason === "refresh_material_missing") {
    fail("credential_incomplete");
  }
  fail("coordination_unavailable");
}

/**
 * Resolves access for one exact binding. Fresh reads are lock-free; due or
 * explicitly rejected material delegates to the existing provider maintainer.
 */
export async function resolveHarnessAccessCredential(context, {
  runtime,
  provider,
  binding,
  expectedIdentityFingerprint,
  rejectedCredentialVersion,
  signal = context?.signal,
  deadlineMs = context?.deadlineMs,
} = {}) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(binding);
  if (normalizedProvider !== OPENAI_CODEX_PROVIDER && normalizedProvider !== ANTHROPIC_PROVIDER) {
    fail("provider_mismatch");
  }
  throwIfAborted(signal);
  let record = findExactRecord(runtime.snapshot, {
    provider: normalizedProvider,
    label: normalizedLabel,
  });
  let validated = validateRecord(record, {
    nowMs: Number.isFinite(context?.nowMs) ? context.nowMs : Date.now(),
  });
  if (validated.identityFingerprint !== expectedIdentityFingerprint) fail("identity_conflict");

  const rejectedCurrentVersion = Number.isInteger(rejectedCredentialVersion)
    && rejectedCredentialVersion >= record.version;
  if (isDue(record, Number.isFinite(context?.nowMs) ? context.nowMs : Date.now()) || rejectedCurrentVersion) {
    throwIfAborted(signal);
    if (normalizedProvider === OPENAI_CODEX_PROVIDER) {
      const maintenance = await maintainRedisCodexCredential(context, {
        runtime,
        label: normalizedLabel,
        force: rejectedCurrentVersion,
        signal,
        deadlineMs,
      });
      if (maintenance?.reason === "lease_busy") fail("lease_busy");
      if (maintenance?.outcome === "reauth_required") fail("reauth_required");
    } else {
      const maintenance = await maintainRedisClaudeCredential({
        ...context,
        signal,
        deadlineMs,
      }, {
        runtime,
        label: normalizedLabel,
        force: rejectedCurrentVersion,
        signal,
        deadlineMs,
      });
      mapClaudeMaintenanceResult(maintenance);
    }
    throwIfAborted(signal);
    await refreshRedisRuntimeState(runtime);
    record = findExactRecord(runtime.snapshot, {
      provider: normalizedProvider,
      label: normalizedLabel,
    });
    validated = validateRecord(record, {
      nowMs: Number.isFinite(context?.nowMs) ? context.nowMs : Date.now(),
      requireFresh: true,
    });
    if (validated.identityFingerprint !== expectedIdentityFingerprint) fail("identity_conflict");
  } else {
    validateRecord(record, {
      nowMs: Number.isFinite(context?.nowMs) ? context.nowMs : Date.now(),
      requireFresh: true,
    });
  }

  return Object.freeze({
    schemaVersion: HARNESS_CREDENTIAL_SCHEMA_VERSION,
    ok: true,
    provider: normalizedProvider,
    binding: normalizedLabel,
    identityFingerprint: validated.identityFingerprint,
    credentialVersion: record.version,
    accessToken: validated.accessToken,
    expiresAt: validated.expiresAt,
  });
}
