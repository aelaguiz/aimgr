import { OPENCLAW_ENFORCED_CODEX_MODEL } from "../core/constants.js";
import { isObject, normalizeAgentId, normalizeLabel } from "../core/normalize.js";

export function extractOpenclawConfigAgentModelPrimary(rawModel) {
  if (!rawModel) return null;
  if (typeof rawModel === "string") {
    const trimmed = rawModel.trim();
    return trimmed ? trimmed : null;
  }
  if (!isObject(rawModel)) return null;
  const primary = rawModel.primary;
  if (typeof primary !== "string") return null;
  const trimmed = primary.trim();
  return trimmed ? trimmed : null;
}

export function buildOpenclawModelSyncOps({ agentsList, pinnedAgentIds, modelRefByAgentId }) {
  const list = Array.isArray(agentsList) ? agentsList : [];
  const ids = Array.isArray(pinnedAgentIds) ? pinnedAgentIds : [];
  const desired = isObject(modelRefByAgentId) ? modelRefByAgentId : null;

  const indexById = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!isObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id) continue;
    if (!indexById.has(id)) {
      indexById.set(id, i);
    }
  }

  const ops = [];
  for (const agentIdRaw of ids) {
    const agentId = normalizeAgentId(agentIdRaw);
    const desiredModelRef = typeof desired?.[agentId] === "string" ? desired[agentId].trim() : OPENCLAW_ENFORCED_CODEX_MODEL;
    if (!desiredModelRef) {
      throw new Error(`Missing desired modelRef for pinned agent: ${agentId}`);
    }
    const idx = indexById.get(agentId);
    if (idx === undefined) {
      throw new Error(`OpenClaw agent id not found in config agents.list: ${agentId}`);
    }
    const entry = list[idx];
    const currentPrimary = extractOpenclawConfigAgentModelPrimary(entry?.model);
    if (currentPrimary === desiredModelRef) {
      continue;
    }

    const modelValue = entry?.model;
    if (isObject(modelValue)) {
      ops.push({
        path: `agents.list[${idx}].model.primary`,
        value: JSON.stringify(desiredModelRef),
      });
      if (Object.hasOwn(modelValue, "fallbacks")) {
        ops.push({ path: `agents.list[${idx}].model.fallbacks`, value: "[]" });
      }
      continue;
    }

    ops.push({
      path: `agents.list[${idx}].model`,
      value: JSON.stringify(desiredModelRef),
    });
  }

  return ops;
}

export function buildOpenclawAgentIndexById(agentsList) {
  const list = Array.isArray(agentsList) ? agentsList : [];
  const indexById = new Map();
  for (let i = 0; i < list.length; i += 1) {
    const entry = list[i];
    if (!isObject(entry)) continue;
    const id = typeof entry.id === "string" ? entry.id.trim() : "";
    if (!id || indexById.has(id)) continue;
    indexById.set(id, i);
  }
  return indexById;
}

export function partitionOpenclawPinsByConfiguredAgents({ pinsByAgentId, agentsList }) {
  const pins = isObject(pinsByAgentId) ? pinsByAgentId : {};
  const indexById = buildOpenclawAgentIndexById(agentsList);
  const activePins = {};
  const stalePins = [];

  for (const [agentIdRaw, labelRaw] of Object.entries(pins)) {
    const agentId = normalizeAgentId(agentIdRaw);
    const label = normalizeLabel(labelRaw);
    if (indexById.has(agentId)) {
      activePins[agentId] = label;
      continue;
    }
    stalePins.push({ agentId, label });
  }

  return {
    activePins,
    stalePins: stalePins.toSorted((a, b) => a.agentId.localeCompare(b.agentId)),
  };
}
