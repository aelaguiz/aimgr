import { randomUUID } from "node:crypto";
import { AIMGR_LOCAL_STATE_VERSION } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { readJsonFile, writeJsonFileWithBackupIfChanged } from "../io/json-store.js";
import { resolveAimgrLocalStatePath } from "../io/paths.js";
import { pruneHermesFleetDemand, pruneOpenaiCodexAgentDemand, pruneOpenaiCodexHistory } from "./demand.js";

const INSTALLATION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createEmptyLocalState() {
  return {
    version: AIMGR_LOCAL_STATE_VERSION,
    targets: {
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
      codexDesktop: {},
      sakanaCodex: {},
      claudeCli: {},
      piCli: {},
      primeAgent: {},
    },
    pool: {
      openaiCodex: {
        history: [],
        agentDemand: {},
        hermesFleet: {
          demandByHome: {},
        },
      },
      anthropic: {
        history: [],
      },
    },
    browserBindings: {},
  };
}

export function ensureLocalStateShape(localState) {
  const state = isObject(localState) ? localState : createEmptyLocalState();
  state.version = AIMGR_LOCAL_STATE_VERSION;
  state.targets = isObject(state.targets) ? state.targets : {};
  state.targets.openclaw = isObject(state.targets.openclaw) ? state.targets.openclaw : {};
  state.targets.openclaw.assignments = isObject(state.targets.openclaw.assignments)
    ? state.targets.openclaw.assignments
    : {};
  state.targets.openclaw.exclusions = isObject(state.targets.openclaw.exclusions)
    ? state.targets.openclaw.exclusions
    : {};
  state.targets.codexCli = isObject(state.targets.codexCli) ? state.targets.codexCli : {};
  state.targets.codexDesktop = isObject(state.targets.codexDesktop) ? state.targets.codexDesktop : {};
  state.targets.sakanaCodex = isObject(state.targets.sakanaCodex) ? state.targets.sakanaCodex : {};
  state.targets.claudeCli = isObject(state.targets.claudeCli) ? state.targets.claudeCli : {};
  state.targets.piCli = isObject(state.targets.piCli) ? state.targets.piCli : {};
  state.targets.primeAgent = isObject(state.targets.primeAgent) ? state.targets.primeAgent : {};
  state.pool = isObject(state.pool) ? state.pool : {};
  state.pool.openaiCodex = isObject(state.pool.openaiCodex) ? state.pool.openaiCodex : {};
  state.pool.openaiCodex.history = pruneOpenaiCodexHistory(state.pool.openaiCodex.history);
  state.pool.openaiCodex.agentDemand = pruneOpenaiCodexAgentDemand(state.pool.openaiCodex.agentDemand);
  state.pool.openaiCodex.hermesFleet = isObject(state.pool.openaiCodex.hermesFleet)
    ? state.pool.openaiCodex.hermesFleet
    : {};
  state.pool.openaiCodex.hermesFleet.demandByHome = pruneHermesFleetDemand(
    state.pool.openaiCodex.hermesFleet.demandByHome,
  );
  state.pool.anthropic = isObject(state.pool.anthropic) ? state.pool.anthropic : {};
  state.pool.anthropic.history = pruneOpenaiCodexHistory(state.pool.anthropic.history);
  state.browserBindings = isObject(state.browserBindings) ? state.browserBindings : {};
  return state;
}

export function ensureLocalInstallationId(localState, { randomUUIDImpl = randomUUID } = {}) {
  const state = ensureLocalStateShape(localState);
  const current = typeof state.installationId === "string" ? state.installationId.trim() : "";
  if (INSTALLATION_ID_PATTERN.test(current)) {
    state.installationId = current.toLowerCase();
    return state.installationId;
  }
  const generated = String(randomUUIDImpl()).trim().toLowerCase();
  if (!INSTALLATION_ID_PATTERN.test(generated)) {
    throw new Error("Could not create a valid AIM installation identifier.");
  }
  state.installationId = generated;
  return generated;
}

export function loadLocalState({ homeDir }) {
  const localStatePath = resolveAimgrLocalStatePath({ homeDir });
  const raw = readJsonFile(localStatePath);
  return ensureLocalStateShape(raw ?? createEmptyLocalState());
}

export function writeLocalState({ homeDir, localState }) {
  const localStatePath = resolveAimgrLocalStatePath({ homeDir });
  const normalized = ensureLocalStateShape(localState);
  return writeJsonFileWithBackupIfChanged(localStatePath, normalized);
}
