import { OPENAI_CODEX_PROVIDER, REAUTH_MODE_MANUAL_CALLBACK, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { normalizeInteractiveOAuthMode, resolveBrowserBinding } from "./account-shape.js";
import { getImportedCodexLabels as getAuthorityImportedCodexLabels } from "./authority-codex.js";
import { ensureStateShape } from "./schema.js";

export function getAccountRecord(state, label, { create = false } = {}) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const existing = state.accounts[normalizedLabel];
  if (isObject(existing)) {
    return existing;
  }
  if (!create) return null;
  state.accounts[normalizedLabel] = {};
  return state.accounts[normalizedLabel];
}

export function getAccountBrowserState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  if (create && !isObject(account.browser)) {
    account.browser = {};
  }
  return account.browser;
}

export function getAccountReauthState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  if (create && !isObject(account.reauth)) {
    account.reauth = {};
  }
  return account.reauth;
}

export function getAccountPoolState(state, label, { create = false } = {}) {
  const account = getAccountRecord(state, label, { create });
  if (!account) return null;
  if (create && !isObject(account.pool)) {
    account.pool = {};
  }
  return account.pool;
}

export function getOpenclawTargetState(state) {
  ensureStateShape(state);
  return state.targets.openclaw;
}

export function getOpenclawAgentDemandState(state) {
  ensureStateShape(state);
  return state.pool.openaiCodex.agentDemand;
}

export function getHermesFleetState(state) {
  ensureStateShape(state);
  return state.pool.openaiCodex.hermesFleet;
}

export function getHermesFleetDemandState(state) {
  return getHermesFleetState(state).demandByHome;
}

export function getOpenclawAssignments(state) {
  return getOpenclawTargetState(state).assignments;
}

export function getOpenclawPins(state) {
  return getOpenclawAssignments(state);
}

export function getOpenclawExclusions(state) {
  return getOpenclawTargetState(state).exclusions;
}

export function discoverStatusConfiguredOpenclawCodexAgents(state) {
  const exclusions = getOpenclawExclusions(state);
  const demandAgents = Object.keys(getOpenclawAgentDemandState(state) ?? {});
  const assignmentAgents = Object.entries(getOpenclawAssignments(state) ?? {})
    .filter(([, labelRaw]) => {
      if (typeof labelRaw !== "string") return false;
      const label = normalizeLabel(labelRaw);
      return normalizeProviderId(getAccountRecord(state, label)?.provider) === OPENAI_CODEX_PROVIDER;
    })
    .map(([agentIdRaw]) => normalizeAgentId(agentIdRaw));

  return [...new Set([...demandAgents, ...assignmentAgents])]
    .filter((agentId) => !(typeof exclusions?.[agentId] === "string" && exclusions[agentId].trim()))
    .toSorted((a, b) => a.localeCompare(b));
}

export function getInteractiveOAuthBindingForLabel(state, label) {
  ensureStateShape(state);
  const reauth = getAccountReauthState(state, label);
  if (!reauth) return null;
  const mode = normalizeInteractiveOAuthMode(reauth.mode);
  const account = getAccountRecord(state, label);
  const browserBinding = resolveBrowserBinding({ account, label });
  return {
    ...(mode ? { mode } : {}),
    ...(browserBinding ? { binding: browserBinding } : {}),
  };
}

export function setInteractiveOAuthBindingForLabel(state, label, binding) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const mode = normalizeInteractiveOAuthMode(binding?.mode);
  if (!mode) {
    throw new Error(`Unsupported interactive OAuth mode for label=${normalizedLabel}.`);
  }
  const reauth = getAccountReauthState(state, normalizedLabel, { create: true });
  reauth.mode = mode;
  if (mode === REAUTH_MODE_MANUAL_CALLBACK || mode === REAUTH_MODE_NATIVE_CLAUDE) {
    state.accounts[normalizedLabel].browser = null;
  }
}

export function getCodexTargetState(state) {
  ensureStateShape(state);
  return state.targets.codexCli;
}

export function getCodexDesktopTargetState(state) {
  ensureStateShape(state);
  return state.targets.codexDesktop;
}

export function getClaudeTargetState(state) {
  ensureStateShape(state);
  return state.targets.claudeCli;
}

export function getPiTargetState(state) {
  ensureStateShape(state);
  return state.targets.piCli;
}

export function getPrimeTargetState(state) {
  ensureStateShape(state);
  return state.targets.primeAgent;
}

export function getImportedCodexLabels(state) {
  return getAuthorityImportedCodexLabels(state);
}

export function hasImportedCodexReplica(state) {
  return getImportedCodexLabels(state).length > 0;
}
