import { isAgyConnectionInUse, isAgyLabel, listAgyConnections, readAgyConnection, validateAgyLabel } from "../credentials/agy-local.js";
import { checkAgyNativeRouteConfiguration } from "../network/agy-native-route.js";
import { hasAgyRuntime, supportsAgyPlatform } from "../privacy/agy-artifacts.js";
import { parseAgyObservation, readAgyObservation } from "./agy-observation.js";

export const AGY_STATUS_STALE_MS = 5 * 60 * 1000;

export const AGY_GRANT_STATE_TEXT = Object.freeze({
  ready: "local grant present",
  "needs-sign-in": "sign-in required",
  "not-enrolled": "not enrolled here",
  "invalid-state": "invalid local state",
  unknown: "unknown",
});

const availabilityStates = new Set([
  ...Object.keys(AGY_GRANT_STATE_TEXT),
  "in-use", "limited", "unsupported", "runtime-missing", "route-error",
]);

function grantAvailability(status, runtime) {
  if (status === "unknown") return status;
  return runtime === "unsupported" ? "unsupported" : status;
}

function readConnectionAvailability(connection, { config, platform, runtime, runtimeInstalled, checkRoute }) {
  const { label, status, accountHome, profileRef } = connection;
  const availability = grantAvailability(status, runtime);
  if (availability !== "ready") return { availability };
  try {
    if (isAgyConnectionInUse(accountHome)) return { availability: "in-use" };
  } catch {
    return { availability: "unknown" };
  }
  if (!runtimeInstalled) return { availability: "runtime-missing" };
  try {
    const routed = checkRoute({ config, label, profileRef, platform });
    return { availability, ...(routed ? { route: "unverified" } : {}) };
  } catch {
    return { availability: "route-error" };
  }
}

export function readLocalAgyStatus(homeDir, {
  config,
  label,
  platform = process.platform,
  arch = process.arch,
  runtimeRoot,
  checkRoute = checkAgyNativeRouteConfiguration,
} = {}) {
  if (label !== undefined) validateAgyLabel(label);
  const supported = supportsAgyPlatform(platform, arch);
  const localRuntime = supported
    ? { runtime: "supported", runtimeInstalled: hasAgyRuntime({ runtimeRoot }) }
    : { runtime: "unsupported" };
  let localConnections;
  try {
    localConnections = label === undefined ? listAgyConnections(homeDir) : [readAgyConnection(homeDir, label)];
  } catch {
    const connections = label === undefined ? [] : [{ label, status: "unknown", availability: "unknown" }];
    return { ...localRuntime, localState: "unavailable", connections };
  }
  const connections = localConnections.map((connection) => {
    const { label, status, accountHome } = connection;
    const readiness = readConnectionAvailability(connection, { ...localRuntime, config, platform, checkRoute });
    const observation = accountHome ? readAgyObservation(accountHome) : null;
    return { label, status, ...readiness, ...(observation ? { observation } : {}) };
  });
  return { ...localRuntime, localState: "available", connections };
}

export function includeAgyRoster(status, roster) {
  const connections = new Map(status.connections.map((connection) => [connection.label, connection]));
  for (const { label } of roster) {
    if (!connections.has(label)) {
      const grantStatus = status.localState === "available" ? "not-enrolled" : "unknown";
      connections.set(label, { label, status: grantStatus, availability: grantAvailability(grantStatus, status.runtime) });
    }
  }
  return { ...status, connections: [...connections.values()].sort((a, b) => a.label.localeCompare(b.label)) };
}

export function parseAgyStatusReport(report) {
  if (!["supported", "unsupported"].includes(report?.runtime)
      || !["available", "unavailable"].includes(report.localState)
      || !Array.isArray(report.connections)) return null;
  const { runtime, runtimeInstalled, localState } = report;
  if (runtimeInstalled !== undefined && (runtime !== "supported" || typeof runtimeInstalled !== "boolean")) return null;
  const labels = new Set();
  const connections = [];
  for (const connection of report.connections) {
    const { label, status, availability, route } = connection ?? {};
    if (!isAgyLabel(label) || labels.has(label) || typeof status !== "string" || !Object.hasOwn(AGY_GRANT_STATE_TEXT, status)
        || ((status === "unknown") !== (localState === "unavailable"))) return null;
    if (availability !== undefined && (!availabilityStates.has(availability)
      || (status === "unknown" && availability !== "unknown")
      || (runtime === "unsupported" && status !== "unknown" && availability !== "unsupported"))) return null;
    if (route !== undefined && route !== "unverified") return null;
    const observation = status === "ready" ? parseAgyObservation(connection.observation) : null;
    labels.add(label);
    connections.push({ label, status,
      ...(availability === undefined ? {} : { availability }),
      ...(route === undefined ? {} : { route }),
      ...(observation ? { observation } : {}),
    });
  }
  return { runtime, ...(runtimeInstalled === undefined ? {} : { runtimeInstalled }), localState, connections };
}
