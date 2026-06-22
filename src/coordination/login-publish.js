import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, SAKANA_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { getClaudeNativeBundleIdentity } from "../credentials/claude-native.js";
import { buildSakanaKeyFingerprint } from "../providers/sakana.js";
import { buildSharedBrowserPolicy } from "./browser-policy.js";
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

export async function publishMaintainedCredential({
  store,
  snapshot,
  state,
  label,
  provider,
  updatedBy = "aimgr-cli",
  observedAt = new Date().toISOString(),
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
          ...(isObject(currentCredential?.provenance) ? currentCredential.provenance : {}),
          lastSourceType: "login-maintenance",
        },
      },
  });
  return {
    ok: result.ok,
    credential: result,
  };
}
