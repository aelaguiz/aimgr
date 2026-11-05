import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { ClaudeRouteError } from "./claude-egress-policy.js";
import { checkClaudeRouteExit } from "./claude-transport.js";
import { readAimgrConfig } from "../config/aimgr-config.js";
import { resolveOptionalClaudeEgressProfile } from "./claude-egress-policy.js";
import { rememberClaudeProtection } from "./claude-offline-binding.js";
import { CodexRouteError } from "./route-error.js";
import { checkCodexRouteExit } from "./codex-egress.js";

const helper = fileURLToPath(new URL("../../native/claude/linux_proxy.py", import.meta.url));
const exec = promisify(execFile);

export function resolveNativeAccountProfile({ homeDir, state, label }) {
  const account = state?.accounts?.[label];
  const binding = rememberClaudeProtection(homeDir, label, account);
  return resolveOptionalClaudeEgressProfile({ label, account,
    previouslyProtected: binding !== null,
    profiles: readAimgrConfig({ homeDir }).config.claudeProxyProfiles });
}

export async function assertLocalClaudeProfileStopped(profileRef, { cgroupRoot = "/sys/fs/cgroup/aimgr-claude", platform = process.platform } = {}) {
  if (!profileRef) return;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(profileRef)) throw new Error("Invalid native Claude profile.");
  if (platform === "darwin") {
    try { await fs.access(`/opt/aimgr-claude-proxy/${profileRef}.json`); }
    catch (cause) { throw new Error(`Claude proxy ${profileRef}: cannot verify stopped native work because installed metadata is unavailable. Repair the installation before changing its assignment.`, { cause }); }
    try { await exec("/usr/bin/python3", ["-I", "/opt/aimgr-claude-proxy/darwin_proxy.py", "check-stopped", profileRef]); }
    catch (error) { throw new Error(error.stderr?.trim() || `Claude proxy ${profileRef}: cannot verify stopped native work.`, { cause: error }); }
    return;
  }
  let events;
  try { events = await fs.readFile(`${cgroupRoot}/${profileRef}/cgroup.events`, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (/^populated 1$/m.test(events)) {
    throw new Error(`Claude proxy ${profileRef} still has local native work. Stop it before changing the assignment.`);
  }
}

// R3/R5/R6: this JS preflight proves the assigned SOCKS route, not the native
// enforcement boundary. The helper repeats the binding check under its lock
// and probes the actual cgroup or PF/GID/TUN path before executing any child.
// nativeCommand must name Claude itself even when command is its Node supervisor:
// otherwise an existing unwrapped --bg daemon could receive the new work.
// Regressions: claude-native-route.test.js and claude-native-background.test.js.
async function prepareAccountNativeRoute({ profile, command, args, nativeCommand = command, approvedPrivacyEntry = false, signal, deadlineMs, platform = process.platform },
  { codex = false, RouteError = ClaudeRouteError, checkExit = checkClaudeRouteExit } = {}) {
  if (!profile) throw new RouteError("missing_proxy_assignment");
  if (!["linux", "darwin"].includes(platform)) throw new RouteError("native_proxy_platform_unverified", profile);
  if (codex && (!/^\/opt\/aimgr-codex-runtime\/artifacts\/[a-f0-9]{64}\/launcher$/.test(command)
    || args[0] !== "assigned-v1")) throw new RouteError("native_proxy_unavailable", profile);
  let installed;
  try { installed = JSON.parse(await fs.readFile(`/opt/aimgr-claude-proxy/${profile.profileRef}.json`, "utf8")); }
  catch (cause) { throw new RouteError("native_proxy_unavailable", { ...profile, cause }); }
  if (installed.socksHost !== profile.socksHost || installed.socksPort !== profile.socksPort
      || JSON.stringify([...(installed.expectedExits ?? [])].sort()) !== JSON.stringify([...profile.expectedExits].sort())
      || (codex && (installed.httpPort !== profile.httpPort || installed.exitCheckFormat !== profile.exitCheckFormat
        || installed.exitCheckUrl !== profile.exitCheckUrl))) {
    throw new RouteError("native_proxy_mismatch", profile);
  }
  const timeoutMs = Number.isFinite(deadlineMs) ? Math.max(1, Math.min(8000, deadlineMs - Date.now())) : 8000;
  // Codex's native entry owns admission and its bounded transient recovery.
  // A separate one-shot JS probe would reject the launch before that wait.
  if (!codex) await checkExit(profile, { timeoutMs, signal });
  const binding = JSON.stringify({ label: profile.label, socksHost: profile.socksHost, socksPort: profile.socksPort,
    expectedExits: profile.expectedExits, nativeCommand,
    ...(codex ? { provider: "openai-codex", httpPort: profile.httpPort } : {}) });
  if (platform === "darwin") {
    if (approvedPrivacyEntry || codex) {
      if (!codex && (!/^\/opt\/aimgr-claude-runtime\/artifacts\/[a-f0-9]{64}\/launcher$/.test(command)
        || args[0] !== "v1" || args[1] !== "protected")) throw new ClaudeRouteError("native_proxy_unavailable", profile);
      return { command, args: ["route-v1", profile.profileRef, binding, "--", ...args] };
    }
    return { command: "/opt/aimgr-claude-proxy/darwin_launch", args: [profile.profileRef, binding, "--", command, ...args] };
  }
  return { command: "/usr/bin/python3", args: [helper, "run", profile.profileRef, binding, "--", command, ...args] };
}

export const prepareClaudeNativeRoute = options => prepareAccountNativeRoute(options);
export const prepareCodexNativeRoute = options => prepareAccountNativeRoute(options,
  { codex: true, RouteError: CodexRouteError, checkExit: checkCodexRouteExit });

export function codexProxyEnvironment(env, profile) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key.toLowerCase())) delete next[key];
  }
  // A parent tool's marker describes that tool, not the fresh vendor process.
  // Preserve the actual native sandbox and every ordinary tool environment.
  delete next.CODEX_SANDBOX;
  const proxy = `http://${profile.socksHost === "::1" ? "[::1]" : profile.socksHost}:${profile.httpPort}`;
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY"]) next[key] = next[key.toLowerCase()] = proxy;
  next.NO_PROXY = next.no_proxy = "localhost,127.0.0.1,::1";
  return next;
}

// R0/R7: apply only after explicit protection is resolved, never in common
// launch preparation. Clearing conflicting proxy variables is not enforcement;
// the native boundary owns routing. Keep all other environment, including user
// OpenTelemetry integrations, intact. These two flags opt out of Anthropic's
// optional analytics/error reports, not ordinary task context.
// Regressions: claude-optional-privacy.test.js, claude-telemetry.test.js and
// inspect-native-error-optout.mjs (all under test/network).
export function nativeProxyEnvironment(env) {
  const next = { ...env };
  for (const key of Object.keys(next)) {
    if (["http_proxy", "https_proxy", "all_proxy", "no_proxy"].includes(key.toLowerCase())) delete next[key];
  }
  next.DISABLE_TELEMETRY = "1";
  next.DISABLE_ERROR_REPORTING = "1";
  return next;
}
