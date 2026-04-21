import { resolveOpenclawProfileIdForProviderLabel } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, OPENCLAW_ENFORCED_ANTHROPIC_MODEL, OPENCLAW_ENFORCED_CODEX_MODEL } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { readJsonFile } from "../io/json-store.js";
import { resolveHomeDir } from "../io/paths.js";
import { restartOpenclawGateway } from "../io/process.js";
import { applyOpenclawFromState } from "./apply.js";
import { applyOpenclawModelSyncOps, readOpenclawAgentsListFromConfig } from "./config.js";
import { buildOpenclawAgentIndexById, buildOpenclawModelSyncOps, extractOpenclawConfigAgentModelPrimary, partitionOpenclawPinsByConfiguredAgents } from "./models.js";
import { applyOpenclawSessionsDiskResets, parseProviderModelRef, scanOpenclawSessionsStoreForKeysNeedingModelReset } from "./sessions.js";
import { discoverOpenclawAgentIdsWithSessionStores, resolveOpenclawSessionsStorePath } from "./stores.js";
import { discoverConfiguredOpenclawCodexAgents } from "../pool/weighted-planner.js";
import { getOpenclawExclusions, getOpenclawPins } from "../state/accounts.js";

export async function syncOpenclawFromState(params, state) {
  let agentsList = null;
  let activeAssignments = getOpenclawPins(state);
  let staleAssignmentWarnings = [];
  let configuredCodexAgentIds = [];

  if (!params.home) {
    agentsList = readOpenclawAgentsListFromConfig();
    const partition = partitionOpenclawPinsByConfiguredAgents({
      pinsByAgentId: getOpenclawPins(state),
      agentsList,
    });
    activeAssignments = partition.activePins;
    staleAssignmentWarnings = partition.stalePins.map(({ agentId, label }) => ({
      kind: "assignment_points_to_missing_config_agent",
      system: "openclaw",
      agentId,
      label,
    }));
    configuredCodexAgentIds = discoverConfiguredOpenclawCodexAgents({
      agentsList,
      exclusions: getOpenclawExclusions(state),
    });
  }

  const auth = applyOpenclawFromState(params, state, {
    pinsOverride: activeAssignments,
    managedAgentIds: configuredCodexAgentIds,
  });

  // Config/model sync is intentionally skipped in sandbox mode to keep `--home`
  // as a safe dev/test escape hatch (and to avoid requiring `openclaw` in CI).
  if (params.home) {
    return {
      auth,
      models: { skipped: true, reason: "home_override" },
      sessions: { skipped: true, reason: "home_override" },
      restart: { skipped: true, reason: "home_override" },
      warnings: staleAssignmentWarnings,
    };
  }

  const accounts = isObject(state.accounts) ? state.accounts : {};
  const assignments = activeAssignments;
  const assignedAgentIds = Object.keys(assignments);
  const desiredModelRefByAgentId = {};
  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const account = accounts[label];
    if (!isObject(account)) {
      throw new Error(`Assignment references missing account: agent=${agentId} label=${label}`);
    }
    const provider = normalizeProviderId(account.provider);
    if (provider === OPENAI_CODEX_PROVIDER) {
      desiredModelRefByAgentId[agentId] = OPENCLAW_ENFORCED_CODEX_MODEL;
      continue;
    }
    if (provider === ANTHROPIC_PROVIDER) {
      desiredModelRefByAgentId[agentId] = OPENCLAW_ENFORCED_ANTHROPIC_MODEL;
      continue;
    }
    throw new Error(`Assignment references unsupported provider: agent=${agentId} label=${label} provider=${provider}`);
  }

  const ops =
    assignedAgentIds.length > 0
      ? buildOpenclawModelSyncOps({ agentsList, pinnedAgentIds: assignedAgentIds, modelRefByAgentId: desiredModelRefByAgentId })
      : [];
  const applied = ops.length > 0 ? applyOpenclawModelSyncOps(ops) : [];

  const homeDir = typeof params.homeDir === "string" && params.homeDir.trim()
    ? params.homeDir
    : resolveHomeDir(params.home, { env: params.env });
  const perAgentScan = [];
  const patchOps = [];
  const desiredSessionByAgentId = {};
  const agentIndexById = buildOpenclawAgentIndexById(agentsList);

  for (const [agentIdRaw, labelRaw] of Object.entries(assignments)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    const desiredModelRef = typeof desiredModelRefByAgentId[agentId] === "string" ? desiredModelRefByAgentId[agentId] : "";
    if (!desiredModelRef) {
      throw new Error(`Missing desired modelRef for assigned agent: ${agentId}`);
    }
    const parsedDesired = parseProviderModelRef(desiredModelRef);
    if (!parsedDesired?.provider || !parsedDesired?.model) {
      throw new Error(`Invalid desired model ref for agent=${agentId}: ${desiredModelRef}`);
    }
    desiredSessionByAgentId[agentId] = {
      ...parsedDesired,
      modelRef: desiredModelRef,
      desiredAuthProfileId: resolveOpenclawProfileIdForProviderLabel(parsedDesired.provider, label),
    };
  }

  for (const agentIdRaw of configuredCodexAgentIds) {
    const agentId = normalizeAgentId(agentIdRaw);
    if (desiredSessionByAgentId[agentId]) continue;
    const configIdx = agentIndexById.get(agentId);
    const currentModelRef =
      configIdx === undefined ? null : extractOpenclawConfigAgentModelPrimary(agentsList[configIdx]?.model);
    const parsedCurrent = currentModelRef ? parseProviderModelRef(currentModelRef) : null;
    desiredSessionByAgentId[agentId] = {
      ...(parsedCurrent?.provider && parsedCurrent?.model
        ? {
            provider: parsedCurrent.provider,
            model: parsedCurrent.model,
            modelRef: currentModelRef,
          }
        : {}),
      desiredAuthProfileId: null,
      clearManagedAuthProfile: true,
    };
  }

  const sessionAgentIds = [...new Set([
    ...Object.keys(desiredSessionByAgentId),
    ...discoverOpenclawAgentIdsWithSessionStores(homeDir),
  ])].toSorted((a, b) => a.localeCompare(b));

  for (const agentIdRaw of sessionAgentIds) {
    const agentId = normalizeAgentId(agentIdRaw);
    const desired = desiredSessionByAgentId[agentId];
    if (!desired) continue;

    const storePath = resolveOpenclawSessionsStorePath(homeDir, agentId);
    const existing = readJsonFile(storePath);

    if (!existing) {
      perAgentScan.push({
        agentId,
        storePath,
        exists: false,
        sessionsTotal: 0,
        sessionsWouldChange: 0,
      });
      continue;
    }
    if (!isObject(existing)) {
      throw new Error(`OpenClaw sessions store is not an object map: ${storePath}`);
    }

    const keys = scanOpenclawSessionsStoreForKeysNeedingModelReset({
      store: existing,
      desiredProvider: desired.provider,
      desiredModel: desired.model,
      desiredAuthProfileId: desired.desiredAuthProfileId,
      clearManagedAuthProfile: desired.clearManagedAuthProfile,
    });

    perAgentScan.push({
      agentId,
      storePath,
      exists: true,
      sessionsTotal: Object.keys(existing).length,
      sessionsWouldChange: keys.length,
    });

    for (const key of keys) {
      if (typeof desired.modelRef === "string" && desired.modelRef.trim()) {
        patchOps.push({ key, modelRef: desired.modelRef, agentId });
      }
    }
  }

  const totalSessionsWouldChange = perAgentScan.reduce(
    (sum, scan) => sum + (Number.isFinite(Number(scan.sessionsWouldChange)) ? Number(scan.sessionsWouldChange) : 0),
    0,
  );
  if (totalSessionsWouldChange === 0) {
    const restartNeeded = auth.wrote.length > 0 || applied.length > 0;
    const restart =
      restartNeeded
        ? restartOpenclawGateway({ timeoutMs: 30000 })
        : { skipped: true, reason: "no_runtime_changes" };
    if (restart.ok === false) {
      throw new Error(
        `openclaw gateway restart failed (${restart.reason})` +
          `${restart.status ? ` exit=${restart.status}` : ""}` +
          `${restart.stderr ? `: ${restart.stderr}` : restart.error ? `: ${restart.error}` : ""}`,
      );
    }
    return {
      auth,
      models:
        assignedAgentIds.length > 0
          ? { desiredByAgentId: desiredModelRefByAgentId, ops: applied }
          : { skipped: true, reason: "no_assignments" },
      sessions: { skipped: true, reason: "no_session_changes_needed" },
      restart,
      warnings: staleAssignmentWarnings,
    };
  }

  const gateway =
    patchOps.length > 0
      ? { attempted: false, ok: false, reason: "restart_applies_runtime" }
      : { attempted: false, ok: false, reason: "no_model_patch_ops" };

  // Restart is the live apply mechanism; patch disk first so the fresh gateway reads the canonical session state.
  const perAgentDisk = [];
  let filesChanged = 0;
  let sessionsChanged = 0;
  for (const scan of perAgentScan) {
    if (!scan.sessionsWouldChange) continue;
    const agentId = normalizeAgentId(scan.agentId);
    const desired = desiredSessionByAgentId[agentId];
    if (!desired) continue;
    const result = applyOpenclawSessionsDiskResets({
      homeDir,
      agentId,
      desiredProvider: desired.provider,
      desiredModel: desired.model,
      desiredAuthProfileId: desired.desiredAuthProfileId,
      clearManagedAuthProfile: desired.clearManagedAuthProfile,
    });
    perAgentDisk.push({ agentId, ...result });
    if (result.sessionsChanged > 0) {
      filesChanged += 1;
      sessionsChanged += result.sessionsChanged;
    }
  }

  const restart = restartOpenclawGateway({ timeoutMs: 30000 });
  if (restart.ok === false) {
    throw new Error(
      `openclaw gateway restart failed (${restart.reason})` +
        `${restart.status ? ` exit=${restart.status}` : ""}` +
        `${restart.stderr ? `: ${restart.stderr}` : restart.error ? `: ${restart.error}` : ""}`,
    );
  }

  return {
    auth,
    models:
      assignedAgentIds.length > 0
        ? { desiredByAgentId: desiredModelRefByAgentId, ops: applied }
        : { skipped: true, reason: "no_assignments" },
    sessions: {
      mode: "disk",
      gateway,
      filesChanged,
      sessionsChanged,
      sessionsWouldChange: totalSessionsWouldChange,
      perAgent: perAgentDisk.filter((p) => p.sessionsWouldChange > 0),
    },
    restart,
    warnings: staleAssignmentWarnings,
  };
}
