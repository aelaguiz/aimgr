import { getRedisConfig, readAimgrConfig } from "../config/aimgr-config.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { loadLocalState, writeLocalState } from "../state/local-state.js";
import { buildLocalBrowserBindingsFromState, buildSharedBrowserPolicy } from "./browser-policy.js";
import {
  assertCredentialPublicationFreshness,
  buildStableIdentityForCredential,
  identitiesAreCompatible,
  withoutClaudeRotationProvenance,
} from "./login-publish.js";
import { hasCredentialMaterial } from "./records.js";
import { buildCoordinationView, findCredentialRecord } from "./snapshot.js";
import {
  closeRedisStore,
  connectRedisStore,
  publishCredential,
  readSnapshot,
  REDIS_CONNECTION_POLICY_ONE_SHOT,
} from "./redis-store.js";

const REDIS_UPDATED_BY = "aimgr-cli";

export function isRedisConfigured({ homeDir }) {
  return Boolean(readAimgrConfig({ homeDir }).config.redis.url);
}

export async function loadRedisRuntime({
  homeDir,
  connectRedisStoreImpl = connectRedisStore,
  provider = null,
  now = new Date(),
  connectionPolicy = REDIS_CONNECTION_POLICY_ONE_SHOT,
}) {
  const { redis } = getRedisConfig({ homeDir });
  const store = await connectRedisStoreImpl({ ...redis, connectionPolicy });
  const snapshot = await readSnapshot(store);
  const localState = loadLocalState({ homeDir });
  const state = buildCoordinationView(snapshot, {
    localState,
    provider,
  });
  return {
    redis,
    store,
    updatedBy: REDIS_UPDATED_BY,
    snapshot,
    localState,
    state,
    providerScope: normalizeProviderId(provider),
  };
}

export async function closeRedisRuntime(runtime) {
  await closeRedisStore(runtime?.store);
}

export function writeRedisLocalStateFromView({ homeDir, state, localState }) {
  const targets = structuredClone(state.targets);
  if (isObject(targets?.claudeCli)) {
    delete targets.claudeCli.projectionReceiptsByLabel;
  }
  const nextLocalState = {
    ...localState,
    targets,
    pool: state.pool,
    browserBindings: buildLocalBrowserBindingsFromState(state),
  };
  const written = writeLocalState({
    homeDir,
    localState: nextLocalState,
  });
  if (isObject(localState)) {
    Object.assign(localState, structuredClone(nextLocalState));
  }
  return written;
}

function findConflictingCredential(snapshot, { provider, label }) {
  return (snapshot?.credentials ?? []).find((record) => record.label === label && record.provider !== provider) ?? null;
}

export async function refreshRedisRuntimeSnapshot(runtime) {
  runtime.snapshot = await readSnapshot(runtime.store);
  return runtime.snapshot;
}

export async function refreshRedisRuntimeState(runtime) {
  await refreshRedisRuntimeSnapshot(runtime);
  runtime.state = buildCoordinationView(runtime.snapshot, {
    localState: runtime.localState,
    provider: runtime.providerScope,
  });
  return runtime.state;
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
  const credential = isObject(currentCredential?.credential) ? currentCredential.credential : {};
  const result = await publishCredential(runtime.store, {
    expectedVersion: currentCredential?.version ?? null,
    updatedBy: runtime.updatedBy,
    observedAt,
    credentialRecord: {
      ...(currentCredential ?? {}),
      provider,
      label: normalizedLabel,
      identity: isObject(currentCredential?.identity) ? currentCredential.identity : {},
      credential,
      policy: {
        expect: isObject(account.expect) ? account.expect : {},
        reauth: isObject(account.reauth) ? account.reauth : {},
        browser: buildSharedBrowserPolicy(account.browser),
        pool: isObject(account.pool) ? account.pool : { enabled: true },
      },
      health: isObject(currentCredential?.health)
        ? currentCredential.health
        : hasCredentialMaterial(credential)
          ? { status: "ready", reason: null }
          : { status: "candidate", reason: "credential_missing" },
      provenance: withoutClaudeRotationProvenance(currentCredential?.provenance),
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
  assertCredentialPublicationFreshness({
    provider: normalizedProvider,
    label: normalizedLabel,
    currentRecord: currentCredential,
    nextCredential: credential,
    nextIdentity: identity,
  });
  const account = isObject(state?.accounts?.[normalizedLabel]) ? state.accounts[normalizedLabel] : {};
  const currentProvenance = withoutClaudeRotationProvenance(currentCredential?.provenance);
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
        ...currentProvenance,
        lastSourceType: lineageMode,
      },
    },
  });
  if (!result.ok) {
    throw new Error(
      `Redis stale_version while publishing ${normalizedProvider}.${normalizedLabel}; reload and retry.`,
    );
  }
  const credentials = (runtime.snapshot?.credentials ?? [])
    .filter((record) => record.provider !== normalizedProvider || record.label !== normalizedLabel);
  // Keep the runtime's CAS/freshness baseline detached from the mutable state
  // view. Callers often rotate the next credential in that view in place.
  credentials.push(structuredClone(result.record));
  credentials.sort((left, right) =>
    `${left.provider}:${left.label}`.localeCompare(`${right.provider}:${right.label}`));
  runtime.snapshot = {
    ...(runtime.snapshot ?? {}),
    credentials,
    observedAt: result.record.updatedAt,
  };
  return result.record;
}

export async function publishCodexReconciliation({ runtime, state, reconciliation }) {
  if (reconciliation?.status !== "local_newer" || !reconciliation.label) {
    return null;
  }
  return publishRedisStateCredential({
    runtime,
    state,
    provider: OPENAI_CODEX_PROVIDER,
    label: reconciliation.label,
    observedAt: new Date().toISOString(),
    lineageMode: "local-rotation",
  });
}
