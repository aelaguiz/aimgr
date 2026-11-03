import { claudeEgressPolicy, normalizeEgressPolicy } from "../network/claude-egress-policy.js";
import { CLAUDE_PROXY_HEALTH_STATES } from "./claude-proxy-health.js";

// Report the account's assignment, not a promise that its route is healthy.
// Never expose the machine's browser path, endpoint, IP or credentials here.
export function describeClaudeEgress(account, profiles, { previouslyProtected = false } = {}) {
  try {
    const policy = normalizeEgressPolicy(claudeEgressPolicy(account));
    return policy ? { mode: "proxy", profileRef: policy.profileRef,
      ...(profiles !== undefined ? { localStatus: Object.hasOwn(profiles, policy.profileRef) ? "configured" : "not_configured" } : {}),
    } : { mode: previouslyProtected ? "missing_assignment" : "direct" };
  } catch {
    return { mode: "invalid" };
  }
}

// Old diagnostic caches have no assignment field. Absence is unknown; it must
// not be presented as evidence that an account is allowed to connect directly.
export function projectClaudeEgress(value) {
  if (value?.mode === "proxy") {
    const described = describeClaudeEgress({ egress: { profileRef: value.profileRef } });
    return described.mode === "proxy" ? { ...described,
      ...(["configured", "not_configured"].includes(value.localStatus) ? { localStatus: value.localStatus } : {}),
      ...(CLAUDE_PROXY_HEALTH_STATES.has(value.health) ? { health: value.health } : {}),
    } : { mode: "invalid" };
  }
  return { mode: ["direct", "invalid", "missing_assignment"].includes(value?.mode) ? value.mode : "unknown" };
}

export function hasNoLocalClaudeRoute(account) {
  return account?.egress?.mode === "proxy" && account.egress.localStatus === "not_configured";
}

export function formatClaudeEgress(value) {
  const egress = projectClaudeEgress(value);
  return egress.mode === "proxy" ? egress.profileRef : egress.mode === "direct" ? "none" : egress.mode;
}

export function formatClaudeProxyHealth(value) {
  const egress = projectClaudeEgress(value);
  if (egress.mode !== "proxy") return "--";
  if (egress.localStatus === "not_configured") return "no route";
  return (egress.health ?? "unknown").replaceAll("_", " ");
}

export function claudeProxyHealthProblem(account) {
  const egress = projectClaudeEgress(account?.egress);
  if (egress.mode !== "proxy" || !egress.health || egress.health === "running") return null;
  if (egress.health === "starting") return { status: "PROXY STARTING", next: "wait for assigned proxy" };
  if (egress.health === "unknown") return { status: "PROXY UNKNOWN", next: "check assigned proxy" };
  return { status: "PROXY DOWN", next: egress.health === "not_installed" ? "install assigned proxy" : "restart assigned proxy" };
}
