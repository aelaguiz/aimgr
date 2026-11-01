import { createEmptyState } from "../state/empty.js";
import { normalizeProviderId } from "../core/normalize.js";
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

export function buildCoordinationView(snapshot, { localState = null, provider = null } = {}) {
  const state = createEmptyState();
  const local = ensureLocalStateShape(localState ?? {});
  const providerScope = normalizeProviderId(provider);
  state.targets = local.targets;
  state.pool = local.pool;
  // A different provider may reuse the same label and overwrite the legacy map
  // while Claude credentials remain. Protected request owners use this qualified
  // map so that collision cannot erase the Claude account's route assignment.
  // Regression: test/network/claude-optional-privacy.test.js (provider collision).
  state.accountsByProvider = {};

  for (const record of snapshot?.credentials ?? []) {
    if (providerScope && record.provider !== providerScope) continue;
    state.accounts[record.label] = {
      provider: record.provider,
      ...(record.policy?.egress ? { egress: structuredClone(record.policy.egress) } : {}),
      expect: record.policy?.expect ?? {},
      reauth: record.policy?.reauth ?? {},
      browser: {
        ...(record.policy?.browser ?? {}),
        ...(local.browserBindings?.[record.label] ?? {}),
      },
      pool: record.policy?.pool ?? { enabled: true },
    };
    state.accountsByProvider[record.provider] ??= {};
    state.accountsByProvider[record.provider][record.label] = state.accounts[record.label];
    if (hasCredentialMaterial(record.credential)) {
      state.credentials[record.provider] = state.credentials[record.provider] ?? {};
      state.credentials[record.provider][record.label] = record.credential;
    }
  }

  ensureStateShape(state);
  return state;
}
