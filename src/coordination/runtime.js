import { getRedisConfig, readAimgrConfig } from "../config/aimgr-config.js";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { loadLocalState, writeLocalState } from "../state/local-state.js";
import { buildLocalBrowserBindingsFromState, buildSharedBrowserPolicy } from "./browser-policy.js";
import { buildLocalMachineInfo } from "./machine.js";
import { buildStableIdentityForCredential } from "./login-publish.js";
import { buildCoordinationView, findLabelRecord, findMachineSession } from "./snapshot.js";
import { closeRedisStore, connectRedisStore, publishLabel, publishSession, readSnapshot, registerMachine } from "./redis-store.js";

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
  const machine = buildLocalMachineInfo({ homeDir, now });
  await registerMachine(store, machine);
  const snapshot = await readSnapshot(store);
  const localState = loadLocalState({ homeDir });
  const state = buildCoordinationView(snapshot, {
    machineId: machine.machineId,
    localState,
  });
  return {
    redis,
    store,
    machine,
    machineId: machine.machineId,
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

function findConflictingLabel(snapshot, { provider, label }) {
  return (snapshot?.labels ?? []).find((record) => record.label === label && record.provider !== provider) ?? null;
}

export async function refreshRedisRuntimeSnapshot(runtime) {
  runtime.snapshot = await readSnapshot(runtime.store);
  return runtime.snapshot;
}

export async function publishRedisLabelPolicyFromState({
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
  const conflicting = findConflictingLabel(runtime.snapshot, { provider, label: normalizedLabel });
  if (conflicting) {
    throw new Error(
      `Redis label=${normalizedLabel} already exists for provider=${conflicting.provider}; refusing to create provider=${provider}.`,
    );
  }
  const currentLabel = findLabelRecord(runtime.snapshot, { provider, label: normalizedLabel });
  const result = await publishLabel(runtime.store, {
    expectedVersion: currentLabel?.version ?? null,
    machineId: runtime.machineId,
    observedAt,
    labelRecord: {
      ...(currentLabel ?? {}),
      provider,
      label: normalizedLabel,
      stableIdentity: isObject(currentLabel?.stableIdentity) ? currentLabel.stableIdentity : {},
      expect: isObject(account.expect) ? account.expect : {},
      reauth: isObject(account.reauth) ? account.reauth : {},
      browser: buildSharedBrowserPolicy(account.browser),
      pool: isObject(account.pool) ? account.pool : { enabled: true },
    },
  });
  if (!result.ok) {
    throw new Error(`Redis stale_version while publishing label policy for ${provider}:${normalizedLabel}; reload and retry.`);
  }
  await refreshRedisRuntimeSnapshot(runtime);
  return result.record;
}

function getStateCredential(state, provider, label) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  return state?.credentials?.[normalizedProvider]?.[normalizedLabel] ?? null;
}

export async function publishRedisStateSession({
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
    throw new Error(`Cannot publish Redis session without ${normalizedProvider}.${normalizedLabel} credentials.`);
  }
  const currentSession = findMachineSession(runtime.snapshot, {
    provider: normalizedProvider,
    label: normalizedLabel,
    machineId: runtime.machineId,
  });
  const identity = buildStableIdentityForCredential(normalizedProvider, credential);
  const result = await publishSession(runtime.store, {
    expectedVersion: currentSession?.version ?? null,
    machineId: runtime.machineId,
    observedAt,
    sessionRecord: {
      provider: normalizedProvider,
      label: normalizedLabel,
      machineId: runtime.machineId,
      credential,
      identity,
      lineage: {
        ...(currentSession?.lineage ?? {}),
        mode: lineageMode,
      },
      health: {
        status: "ready",
        reason: null,
      },
    },
  });
  if (!result.ok) {
    throw new Error(
      `Redis stale_version while publishing ${normalizedProvider}.${normalizedLabel} for ${runtime.machineId}; reload and retry.`,
    );
  }
  return result.record;
}

export async function publishCodexPreserveResult({ runtime, state, preserved }) {
  if (preserved?.status !== "updated" || !preserved.label) {
    return null;
  }
  return publishRedisStateSession({
    runtime,
    state,
    provider: OPENAI_CODEX_PROVIDER,
    label: preserved.label,
    observedAt: new Date().toISOString(),
    lineageMode: "local-rotation",
  });
}
