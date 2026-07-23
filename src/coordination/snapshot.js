import { createEmptyState } from "../state/empty.js";
import { ensureStateShape } from "../state/schema.js";
import { ensureLocalStateShape } from "../state/local-state.js";
import { hasCredentialMaterial } from "./records.js";

export function findCredentialRecord(snapshot, { provider, label }) {
  return (snapshot?.credentials ?? []).find((record) => record.provider === provider && record.label === label) ?? null;
}

export function listPoolLabels(snapshot, provider) {
  return (snapshot?.credentials ?? [])
    .filter((record) => record.provider === provider && record.policy?.pool?.enabled !== false)
    .map((record) => record.label)
    .sort();
}

export function buildCoordinationView(snapshot, { localState = null } = {}) {
  const state = createEmptyState();
  const local = ensureLocalStateShape(localState ?? {});
  state.targets = local.targets;
  state.pool = local.pool;

  for (const record of snapshot?.credentials ?? []) {
    state.accounts[record.label] = {
      provider: record.provider,
      expect: record.policy?.expect ?? {},
      reauth: record.policy?.reauth ?? {},
      browser: {
        ...(record.policy?.browser ?? {}),
        ...(local.browserBindings?.[record.label] ?? {}),
      },
      pool: record.policy?.pool ?? { enabled: true },
    };
    if (hasCredentialMaterial(record.credential)) {
      state.credentials[record.provider] = state.credentials[record.provider] ?? {};
      state.credentials[record.provider][record.label] = record.credential;
    }
  }

  ensureStateShape(state);
  return state;
}
