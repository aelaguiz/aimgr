import { createEmptyState } from "../state/empty.js";
import { ensureStateShape } from "../state/schema.js";
import { ensureLocalStateShape } from "../state/local-state.js";

export function findLabelRecord(snapshot, { provider, label }) {
  return (snapshot?.labels ?? []).find((record) => record.provider === provider && record.label === label) ?? null;
}

export function findMachineSession(snapshot, { provider, label, machineId }) {
  return (snapshot?.sessions ?? []).find(
    (record) => record.provider === provider && record.label === label && record.machineId === machineId,
  ) ?? null;
}

export function listPoolLabels(snapshot, provider) {
  return (snapshot?.labels ?? [])
    .filter((record) => record.provider === provider && record.pool?.enabled !== false)
    .map((record) => record.label)
    .sort();
}

export function buildCoordinationView(snapshot, { machineId, localState = null } = {}) {
  const state = createEmptyState();
  const local = ensureLocalStateShape(localState ?? {});
  state.targets = local.targets;
  state.pool = local.pool;

  for (const labelRecord of snapshot?.labels ?? []) {
    state.accounts[labelRecord.label] = {
      provider: labelRecord.provider,
      expect: labelRecord.expect,
      reauth: labelRecord.reauth,
      browser: {
        ...(labelRecord.browser ?? {}),
        ...(local.browserBindings?.[labelRecord.label] ?? {}),
      },
      pool: labelRecord.pool,
    };
  }

  for (const session of snapshot?.sessions ?? []) {
    if (session.machineId !== machineId) continue;
    state.credentials[session.provider] = state.credentials[session.provider] ?? {};
    state.credentials[session.provider][session.label] = session.credential;
  }

  ensureStateShape(state);
  return state;
}
