import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, SAKANA_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { getClaudeNativeBundleIdentity } from "../credentials/claude-native.js";
import { buildSakanaKeyFingerprint } from "../providers/sakana.js";
import { buildSharedBrowserPolicy } from "./browser-policy.js";
import { buildRedisClaudeRotationFenceProvenance } from "./redis-claude-rotation-fence.js";
import { hasCredentialMaterial } from "./records.js";
import { findCredentialRecord } from "./snapshot.js";
import { publishCredential } from "./redis-store.js";

export function buildStableIdentityForCredential(provider, credential) {
  if (provider === OPENAI_CODEX_PROVIDER) {
    return typeof credential?.accountId === "string" && credential.accountId.trim()
      ? { accountId: credential.accountId.trim() }
      : {};
  }
  if (provider === ANTHROPIC_PROVIDER) {
    const nativeIdentity = getClaudeNativeBundleIdentity(credential);
    return {
      ...(nativeIdentity.accountUuid ? { accountUuid: nativeIdentity.accountUuid } : {}),
      ...(typeof credential?.emailAddress === "string" && credential.emailAddress.trim()
        ? { emailAddress: credential.emailAddress.trim().toLowerCase() }
        : {}),
      ...(typeof credential?.organizationUuid === "string" && credential.organizationUuid.trim()
        ? { organizationUuid: credential.organizationUuid.trim() }
        : {}),
    };
  }
  if (provider === SAKANA_PROVIDER) {
    return typeof credential?.apiKey === "string" && credential.apiKey.trim()
      ? { keyFingerprint: buildSakanaKeyFingerprint(credential.apiKey) }
      : {};
  }
  return {};
}

function getCredentialForProvider(state, provider, label) {
  if (provider === OPENAI_CODEX_PROVIDER) return getCodexCredential(state, label);
  if (provider === ANTHROPIC_PROVIDER) return getAnthropicCredential(state, label);
  return null;
}

function compactIdentity(identity) {
  if (!isObject(identity)) return {};
  return Object.fromEntries(
    Object.entries(identity)
      .map(([key, value]) => [key, typeof value === "string" ? value.trim().toLowerCase() : value])
      .filter(([, value]) => value !== null && value !== undefined && value !== ""),
  );
}

export function identitiesAreCompatible(currentIdentity, nextIdentity) {
  const current = compactIdentity(currentIdentity);
  const next = compactIdentity(nextIdentity);
  const keys = Object.keys(current);
  if (keys.length === 0) return true;
  return keys.every((key) => next[key] !== undefined && next[key] === current[key]);
}

function anthropicTokenLineage(credential) {
  return {
    access: typeof credential?.access === "string" ? credential.access.trim() : "",
    refresh: typeof credential?.refresh === "string" ? credential.refresh.trim() : "",
    expiresAt: typeof credential?.expiresAt === "string" ? credential.expiresAt.trim() : "",
    expiresAtMs: parseExpiresAtToMs(credential?.expiresAt),
  };
}

function resolveRecordIdentity(provider, record) {
  const storedIdentity = compactIdentity(record?.identity);
  return Object.keys(storedIdentity).length > 0
    ? storedIdentity
    : compactIdentity(buildStableIdentityForCredential(provider, record?.credential));
}

export function assertCredentialPublicationFreshness({
  provider,
  label,
  currentRecord,
  nextCredential,
  nextIdentity = null,
}) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  if (normalizedProvider !== ANTHROPIC_PROVIDER || !hasCredentialMaterial(currentRecord?.credential)) {
    return;
  }

  const currentIdentity = resolveRecordIdentity(normalizedProvider, currentRecord);
  const resolvedNextIdentity = isObject(nextIdentity)
    ? nextIdentity
    : buildStableIdentityForCredential(normalizedProvider, nextCredential);
  if (
    Object.keys(currentIdentity).length === 0
    || !identitiesAreCompatible(currentIdentity, resolvedNextIdentity)
  ) {
    return;
  }

  const current = anthropicTokenLineage(currentRecord.credential);
  const next = anthropicTokenLineage(nextCredential);
  const sameTokens = current.access === next.access && current.refresh === next.refresh;
  const sameRawExpiry = current.expiresAt === next.expiresAt;
  const sameParsedExpiry = current.expiresAtMs !== null
    && next.expiresAtMs !== null
    && current.expiresAtMs === next.expiresAtMs;

  // Identical token lineage is safe even when the caller is only enriching
  // metadata or adding a native Claude bundle around the same credentials.
  if (sameTokens && (sameRawExpiry || sameParsedExpiry)) {
    return;
  }

  if (current.expiresAtMs === null || next.expiresAtMs === null) {
    throw new Error(
      `Refusing ambiguous Anthropic credential replacement for ${normalizedProvider}:${normalizedLabel}; `
        + "credential freshness cannot be established.",
    );
  }
  if (next.expiresAtMs < current.expiresAtMs) {
    throw new Error(
      `Refusing to publish older Anthropic credentials for ${normalizedProvider}:${normalizedLabel}; `
        + "reload current Redis state before retrying.",
    );
  }
  if (next.expiresAtMs === current.expiresAtMs) {
    throw new Error(
      `Refusing ambiguous Anthropic credential replacement for ${normalizedProvider}:${normalizedLabel}; `
        + "token material differs at the same expiry.",
    );
  }
}

export async function publishMaintainedCredential({
  store,
  snapshot,
  state,
  label,
  provider,
  updatedBy = "aimgr-cli",
  observedAt = new Date().toISOString(),
  rotationFence = null,
}) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedProvider = normalizeProviderId(provider);
  const account = isObject(state?.accounts?.[normalizedLabel]) ? state.accounts[normalizedLabel] : {};
  const credential = getCredentialForProvider(state, normalizedProvider, normalizedLabel);
  if (!credential) {
    throw new Error(`Cannot publish Redis credential without ${normalizedProvider}.${normalizedLabel} credentials.`);
  }
  const stableIdentity = buildStableIdentityForCredential(normalizedProvider, credential);
  const currentCredential = findCredentialRecord(snapshot, { provider: normalizedProvider, label: normalizedLabel });
  if (!identitiesAreCompatible(currentCredential?.identity, stableIdentity)) {
    throw new Error(
      `Redis credential identity mismatch for ${normalizedProvider}:${normalizedLabel}. ` +
        "Use `aim label rebind <label> --provider <provider> --confirm` only after confirming the account identity.",
    );
  }
  assertCredentialPublicationFreshness({
    provider: normalizedProvider,
    label: normalizedLabel,
    currentRecord: currentCredential,
    nextCredential: credential,
    nextIdentity: stableIdentity,
  });
  const currentProvenance = isObject(currentCredential?.provenance) ? currentCredential.provenance : {};
  const result = await publishCredential(store, {
    expectedVersion: currentCredential?.version ?? null,
    updatedBy,
    observedAt,
    credentialRecord: {
      ...(currentCredential ?? {}),
      provider: normalizedProvider,
      label: normalizedLabel,
      credential,
      identity: stableIdentity,
      policy: {
        expect: isObject(account.expect) ? account.expect : {},
        reauth: isObject(account.reauth) ? account.reauth : {},
        browser: buildSharedBrowserPolicy(account.browser),
        pool: isObject(account.pool) ? account.pool : { enabled: true },
      },
      health: {
        status: "ready",
        reason: null,
      },
      provenance: {
        ...(normalizedProvider === ANTHROPIC_PROVIDER
          ? buildRedisClaudeRotationFenceProvenance(currentProvenance, rotationFence)
          : currentProvenance),
        lastSourceType: "login-maintenance",
      },
    },
  });
  return {
    ok: result.ok,
    credential: result,
  };
}
