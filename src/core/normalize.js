import path from "node:path";

export { normalizeAgentId, normalizeHermesHomeId, normalizeLabel } from "./labels.js";
export { normalizeProviderId } from "./providers.js";

export function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function normalizeAbsolutePath(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  const resolved = path.resolve(raw);
  return path.isAbsolute(resolved) ? resolved : null;
}
