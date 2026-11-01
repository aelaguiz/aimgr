import net from "node:net";
export const CLAUDE_ROUTE_ERROR_CODES = new Set([
  "missing_proxy_assignment", "invalid_proxy_assignment", "proxy_profile_unavailable",
  "invalid_proxy_profile", "proxy_unavailable", "proxy_exit_mismatch", "operation_closed",
  "invalid_account", "native_proxy_unavailable", "native_proxy_platform_unverified",
  "chrome_binding_mismatch", "browser_unavailable", "invalid_login_url", "native_proxy_mismatch",
]);

export class ClaudeRouteError extends Error {
  constructor(code, { label, profileRef, cause } = {}) {
    const detail = code === "proxy_unavailable" ? "assigned proxy stopped. Repair it, then explicitly resume"
      : code === "proxy_exit_mismatch" ? "assigned proxy has an unexpected public IP. Repair the binding before resuming"
      : code.replaceAll("_", " ");
    super(`Claude${label ? ` ${label}` : ""}: ${detail}${profileRef ? ` (${profileRef})` : ""}.`, { cause });
    this.name = "ClaudeRouteError";
    this.code = code;
    this.label = label;
    this.profileRef = profileRef;
  }
}

export function normalizeEgressPolicy(value) {
  if (value === undefined || value === null) return null;
  const profileRef = typeof value?.profileRef === "string" ? value.profileRef.trim().toLowerCase() : "";
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(profileRef) || ["default", "direct"].includes(profileRef)) {
    throw new ClaudeRouteError("invalid_proxy_assignment");
  }
  // Only the reference travels with credentials. Machine paths and secrets do not.
  return { profileRef };
}

export function resolveClaudeEgressProfile({ label, account, profiles }) {
  const assignment = normalizeEgressPolicy(account?.egress ?? account?.policy?.egress);
  if (!assignment) throw new ClaudeRouteError("missing_proxy_assignment", { label });
  const { profileRef } = assignment;
  const raw = profiles?.[profileRef];
  if (!raw || typeof raw !== "object") {
    throw new ClaudeRouteError("proxy_profile_unavailable", { label, profileRef });
  }
  const host = raw.socksHost ?? "127.0.0.1";
  if (!["127.0.0.1", "::1"].includes(host) || !Number.isInteger(raw.socksPort)
      || raw.socksPort < 1 || raw.socksPort > 65535) {
    throw new ClaudeRouteError("invalid_proxy_profile", { label, profileRef });
  }
  if (!Array.isArray(raw.expectedExits) || raw.expectedExits.length === 0 || !raw.expectedExits.every((ip) => net.isIP(ip))) {
    throw new ClaudeRouteError("invalid_proxy_profile", { label, profileRef });
  }
  return Object.freeze({
    label,
    profileRef,
    socksHost: host,
    socksPort: raw.socksPort,
    expectedExits: Object.freeze([...raw.expectedExits]),
    ...(raw.chrome ? { chrome: Object.freeze({ ...raw.chrome }) } : {}),
  });
}
