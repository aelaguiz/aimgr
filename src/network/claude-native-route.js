import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { ClaudeRouteError } from "./claude-egress-policy.js";
import { checkClaudeRouteExit } from "./claude-transport.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { resolveOptionalClaudeEgressProfile } from "./claude-egress-policy.js";
import { rememberClaudeProtection } from "./claude-offline-binding.js";

const helper = fileURLToPath(new URL("../../native/claude/linux_proxy.py", import.meta.url));

export function resolveNativeAccountProfile({ homeDir, state, label }) {
  const account = state?.accounts?.[label];
  const binding = rememberClaudeProtection(homeDir, label, account);
  return resolveOptionalClaudeEgressProfile({ label, account,
    previouslyProtected: binding !== null,
    profiles: readAimgrConfig({ homeDir }).config.claudeProxyProfiles });
}

export async function assertLocalClaudeProfileStopped(profileRef, { cgroupRoot = "/sys/fs/cgroup/aimgr-claude" } = {}) {
  if (!profileRef) return;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(profileRef)) throw new Error("Invalid native Claude profile.");
  let events;
  try { events = await fs.readFile(`${cgroupRoot}/${profileRef}/cgroup.events`, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (/^populated 1$/m.test(events)) {
    throw new Error(`Claude proxy ${profileRef} still has local native work. Stop it before changing the assignment.`);
  }
}

export async function prepareClaudeNativeRoute({ profile, command, args, signal, deadlineMs, platform = process.platform }) {
  if (!profile) throw new ClaudeRouteError("missing_proxy_assignment");
  if (platform !== "linux") throw new ClaudeRouteError("native_proxy_platform_unverified", profile);
  let installed;
  try { installed = JSON.parse(await fs.readFile(`/opt/aimgr-claude-proxy/${profile.profileRef}.json`, "utf8")); }
  catch (cause) { throw new ClaudeRouteError("native_proxy_unavailable", { ...profile, cause }); }
  if (installed.socksHost !== profile.socksHost || installed.socksPort !== profile.socksPort
      || JSON.stringify([...(installed.expectedExits ?? [])].sort()) !== JSON.stringify([...profile.expectedExits].sort())) {
    throw new ClaudeRouteError("native_proxy_mismatch", profile);
  }
  const timeoutMs = Number.isFinite(deadlineMs) ? Math.max(1, Math.min(8000, deadlineMs - Date.now())) : 8000;
  await checkClaudeRouteExit(profile, { timeoutMs, signal });
  const binding = JSON.stringify({ label: profile.label, socksHost: profile.socksHost, socksPort: profile.socksPort, expectedExits: profile.expectedExits });
  return { command: "/usr/bin/python3", args: [helper, "run", profile.profileRef, binding, "--", command, ...args] };
}

export function nativeProxyEnvironment(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key.toLowerCase())) delete next[key];
  }
  next.DISABLE_TELEMETRY = "1";
  next.DISABLE_ERROR_REPORTING = "1";
  return next;
}
