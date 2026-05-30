import { getRedisConfig, readAimgrConfig } from "../config/aimgr-config.js";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { loadLocalState, writeLocalState } from "../state/local-state.js";
import { buildLocalBrowserBindingsFromState, buildSharedBrowserPolicy } from "./browser-policy.js";
import { buildStableIdentityForCredential, identitiesAreCompatible } from "./login-publish.js";
import { buildCoordinationView, findCredentialRecord } from "./snapshot.js";
import { closeRedisStore, connectRedisStore, publishCredential, readSnapshot } from "./redis-store.js";

const REDIS_UPDATED_BY = "aimgr-cli";

export function isRedisConfigured({ homeDir }) {
  return Boolean(readAimgrConfig({ homeDir }).config.redis.url);
}

export async function loadRedisRuntime({
  homeDir,
  connectRedisStoreImpl = connectRedisStore,
  now = new Date(),
}) {
  const { redis } = getRedisConfig({ homeDir });
  const store = await connectRedisStoreImpl(redis);
  const snapshot = await readSnapshot(store);
  const localState = loadLocalState({ homeDir });
  const state = buildCoordinationView(snapshot, {
    localState,
  });
  return {
    redis,
    store,
    updatedBy: REDIS_UPDATED_BY,
    snapshot,
    localState,
    state,
  };
}

export async function closeRedisRuntime(runtime) {
  await closeRedisStore(runtime?.store);
}

export function writeRedisLocalStateFromView({ homeDir, state, localState }) {
  return writeLocalState({
    homeDir,
    localState: {
      ...localState,
      targets: state.targets,
      pool: state.pool,
      browserBindings: buildLocalBrowserBindingsFromState(state),
    },
  });
}

function findConflictingCredential(snapshot, { provider, label }) {
  return (snapshot?.credentials ?? []).find((record) => record.label === label && record.provider !== provider) ?? null;
}

export async function refreshRedisRuntimeSnapshot(runtime) {
  runtime.snapshot = await readSnapshot(runtime.store);
  return runtime.snapshot;
}

export async function publishRedisCredentialPolicyFromState({
  runtime,
  state = runtime?.state,
  label,
  observedAt = new Date().toISOString(),
}) {
  const normalizedLabel = normalizeLabel(label);
  const account = isObject(state?.accounts?.[normalizedLabel]) ? state.accounts[normalizedLabel] : null;
  const provider = normalizeProviderId(account?.provider);
  if (!provider) {
    throw new Error(`Cannot publish Redis label policy without a provider for label=${normalizedLabel}.`);
  }
  const conflicting = findConflictingCredential(runtime.snapshot, { provider, label: normalizedLabel });
  if (conflicting) {
    throw new Error(
      `Redis credential label=${normalizedLabel} already exists for provider=${conflicting.provider}; refusing to create provider=${provider}.`,
    );
  }
  const currentCredential = findCredentialRecord(runtime.snapshot, { provider, label: normalizedLabel });
  const result = await publishCredential(runtime.store, {
    expectedVersion: currentCredential?.version ?? null,
    updatedBy: runtime.updatedBy,
    observedAt,
    credentialRecord: {
      ...(currentCredential ?? {}),
      provider,
      label: normalizedLabel,
      identity: isObject(currentCredential?.identity) ? currentCredential.identity : {},
      credential: isObject(currentCredential?.credential) ? currentCredential.credential : {},
      policy: {
        expect: isObject(account.expect) ? account.expect : {},
        reauth: isObject(account.reauth) ? account.reauth : {},
        browser: buildSharedBrowserPolicy(account.browser),
        pool: isObject(account.pool) ? account.pool : { enabled: true },
      },
    },
  });
  if (!result.ok) {
    throw new Error(`Redis stale_version while publishing credential policy for ${provider}:${normalizedLabel}; reload and retry.`);
  }
  await refreshRedisRuntimeSnapshot(runtime);
  return result.record;
}

function getStateCredential(state, provider, label) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  return state?.credentials?.[normalizedProvider]?.[normalizedLabel] ?? null;
}

export async function publishRedisStateCredential({
  runtime,
  state = runtime?.state,
  provider,
  label,
  observedAt = new Date().toISOString(),
  lineageMode = "local-rotation",
}) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  const credential = getStateCredential(state, normalizedProvider, normalizedLabel);
  if (!credential) {
    throw new Error(`Cannot publish Redis credential without ${normalizedProvider}.${normalizedLabel} credentials.`);
  }
  const currentCredential = findCredentialRecord(runtime.snapshot, { provider: normalizedProvider, label: normalizedLabel });
  const identity = buildStableIdentityForCredential(normalizedProvider, credential);
  if (!identitiesAreCompatible(currentCredential?.identity, identity)) {
    throw new Error(
      `Redis credential identity mismatch for ${normalizedProvider}:${normalizedLabel}. ` +
        "Use `aim label rebind <label> --provider <provider> --confirm` only after confirming the account identity.",
    );
  }
  const account = isObject(state?.accounts?.[normalizedLabel]) ? state.accounts[normalizedLabel] : {};
  const result = await publishCredential(runtime.store, {
    expectedVersion: currentCredential?.version ?? null,
    updatedBy: runtime.updatedBy,
    observedAt,
    credentialRecord: {
      ...(currentCredential ?? {}),
      provider: normalizedProvider,
      label: normalizedLabel,
      credential,
      identity,
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
        lastSourceType: lineageMode,
      },
    },
  });
  if (!result.ok) {
    throw new Error(
      `Redis stale_version while publishing ${normalizedProvider}.${normalizedLabel}; reload and retry.`,
    );
  }
  return result.record;
}

export async function publishCodexPreserveResult({ runtime, state, preserved }) {
  if (preserved?.status !== "updated" || !preserved.label) {
    return null;
  }
  return publishRedisStateCredential({
    runtime,
    state,
    provider: OPENAI_CODEX_PROVIDER,
    label: preserved.label,
    observedAt: new Date().toISOString(),
    lineageMode: "local-rotation",
  });
}
