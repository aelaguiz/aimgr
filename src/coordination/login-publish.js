import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { getClaudeNativeBundleIdentity } from "../credentials/claude-native.js";
import { buildSharedBrowserPolicy } from "./browser-policy.js";
import { findLabelRecord, findMachineSession } from "./snapshot.js";
import { publishLabel, publishSession } from "./redis-store.js";

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

export async function publishMaintainedLabelSession({
  store,
  snapshot,
  state,
  label,
  provider,
  machineId,
  observedAt = new Date().toISOString(),
}) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedProvider = normalizeProviderId(provider);
  const account = isObject(state?.accounts?.[normalizedLabel]) ? state.accounts[normalizedLabel] : {};
  const credential = getCredentialForProvider(state, normalizedProvider, normalizedLabel);
  if (!credential) {
    throw new Error(`Cannot publish Redis session without ${normalizedProvider}.${normalizedLabel} credentials.`);
  }
  const stableIdentity = buildStableIdentityForCredential(normalizedProvider, credential);
  const currentLabel = findLabelRecord(snapshot, { provider: normalizedProvider, label: normalizedLabel });
  const currentSession = findMachineSession(snapshot, {
    provider: normalizedProvider,
    label: normalizedLabel,
    machineId,
  });
  if (!identitiesAreCompatible(currentLabel?.stableIdentity, stableIdentity)) {
    throw new Error(
      `Redis label identity mismatch for ${normalizedProvider}:${normalizedLabel}. ` +
        "Use `aim label rebind <label> --machine <machineId> --confirm` only after confirming the account identity.",
    );
  }
  const labelResult = await publishLabel(store, {
    expectedVersion: currentLabel?.version ?? null,
    machineId,
    observedAt,
      labelRecord: {
        provider: normalizedProvider,
        label: normalizedLabel,
        stableIdentity,
        expect: isObject(account.expect) ? account.expect : {},
        reauth: isObject(account.reauth) ? account.reauth : {},
        browser: buildSharedBrowserPolicy(account.browser),
        pool: isObject(account.pool) ? account.pool : { enabled: true },
      },
  });
  if (!labelResult.ok) return { ok: false, label: labelResult, session: null };

  const sessionResult = await publishSession(store, {
    expectedVersion: currentSession?.version ?? null,
    machineId,
    observedAt,
    sessionRecord: {
      provider: normalizedProvider,
      label: normalizedLabel,
      machineId,
      credential,
      identity: stableIdentity,
      lineage: {
        mode: "independent-login",
      },
      health: {
        status: "ready",
        reason: null,
      },
    },
  });
  return {
    ok: sessionResult.ok,
    label: labelResult,
    session: sessionResult,
  };
}
