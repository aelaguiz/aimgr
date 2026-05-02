import { isObject, normalizeLabel } from "../core/normalize.js";
import { resolveHermesProfilesRoot } from "../io/paths.js";
import { buildWarningsFromHermesHomeStatus, discoverHermesHomes, readHermesHomeStatus } from "../pool/token-usage.js";
import { getHermesFleetState } from "../state/accounts.js";
import { normalizeDemandWeight, roundDemandWeight } from "../state/demand.js";
import { ensureStateShape } from "../state/schema.js";

export function buildHermesFleetSpread(homes) {
  const spread = new Map();
  for (const home of Array.isArray(homes) ? homes : []) {
    const label = typeof home?.currentLabel === "string" ? normalizeLabel(home.currentLabel) : "";
    if (!label) continue;
    const current = spread.get(label) ?? { label, carriedHomeCount: 0, carriedDemandWeight: 0 };
    current.carriedHomeCount += 1;
    current.carriedDemandWeight = roundDemandWeight(
      current.carriedDemandWeight + normalizeDemandWeight(home?.demand?.demandWeight, 0),
    );
    spread.set(label, current);
  }
  return Array.from(spread.values()).toSorted((a, b) => a.label.localeCompare(b.label));
}

export function readHermesFleetStatus({ state, homeDir }) {
  ensureStateShape(state);
  const fleet = getHermesFleetState(state);
  const homes = discoverHermesHomes({ homeDir }).map((home) => {
    const status = readHermesHomeStatus({ state, homeDir, homeId: home.homeId });
    return {
      ...status,
      warnings: buildWarningsFromHermesHomeStatus(status),
    };
  });
  return {
    profilesRoot: resolveHermesProfilesRoot(homeDir),
    homeCount: homes.length,
    mappedHomeCount: homes.filter((home) => typeof home.currentLabel === "string" && home.currentLabel.trim()).length,
    warningHomeCount: homes.filter((home) => Array.isArray(home.warnings) && home.warnings.length > 0).length,
    spread: buildHermesFleetSpread(homes),
    homes,
    lastApplyReceipt: isObject(fleet.lastApplyReceipt) ? fleet.lastApplyReceipt : null,
    lastWatchReceipt: isObject(fleet.lastWatchReceipt) ? fleet.lastWatchReceipt : null,
    lastRebalancedAt: typeof fleet.lastRebalancedAt === "string" ? fleet.lastRebalancedAt.trim() || null : null,
  };
}

export function buildWarningsFromHermesFleetStatus(status) {
  const warnings = [];
  for (const home of Array.isArray(status?.homes) ? status.homes : []) {
    warnings.push(...buildWarningsFromHermesHomeStatus(home));
  }
  return warnings;
}
