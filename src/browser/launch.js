import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { normalizeChromeProfileDirectory } from "./chrome.js";
import { BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { activateAgentBrowserApp, resolveAgentBrowserCommand } from "../io/process.js";

export function openChromeUserDataDirForUrl({ url, userDataDir, profileDirectory, spawnImpl = spawnSync }) {
  const u = String(url ?? "").trim();
  const dir = String(userDataDir ?? "").trim();
  const profile = normalizeChromeProfileDirectory(profileDirectory);
  if (!u) return { ok: false, reason: "missing_url" };
  if (!dir) return { ok: false, reason: "missing_user_data_dir" };
  if (process.platform !== "darwin") return { ok: false, reason: "unsupported_platform" };

  const chromeArgs = [`--user-data-dir=${dir}`];
  if (profile) {
    chromeArgs.push(`--profile-directory=${profile}`);
  }
  const result = spawnImpl(
    "open",
    ["-n", "-a", "Google Chrome", "--args", ...chromeArgs, u],
    { stdio: "ignore" },
  );
  if (result.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result.status !== 0) {
    return { ok: false, reason: "nonzero_exit", status: result.status };
  }
  return { ok: true };
}

export function spawnAgentBrowserOpen({ url, profile, session, cwd, spawnImpl = spawnSync }) {
  const resolvedUrl = String(url ?? "").trim();
  const resolvedProfile = String(profile ?? "").trim();
  const resolvedSession = String(session ?? "").trim();
  const resolvedCwd = String(cwd ?? "").trim();
  if (!resolvedUrl) return { ok: false, reason: "missing_url" };
  if (!resolvedProfile) return { ok: false, reason: "missing_agent_browser_profile" };
  if (!resolvedSession) return { ok: false, reason: "missing_agent_browser_session" };
  if (!resolvedCwd) return { ok: false, reason: "missing_launch_cwd" };

  const result = spawnImpl(
    resolveAgentBrowserCommand({ spawnImpl }),
    ["--profile", resolvedProfile, "--session-name", resolvedSession, "--headed", "open", resolvedUrl],
    { stdio: "ignore", cwd: resolvedCwd },
  );
  if (result?.error) {
    return { ok: false, reason: "spawn_error", error: String(result.error?.message ?? result.error) };
  }
  if (result?.status !== 0) {
    return { ok: false, reason: "nonzero_exit", status: result.status };
  }
  const activated = activateAgentBrowserApp({ spawnImpl });
  if (!activated.ok) {
    return activated;
  }
  return { ok: true };
}

export function launchBrowserBindingForUrl({ binding, url, homeDir, spawnImpl = spawnSync }) {
  const resolvedBinding = isObject(binding) ? binding : null;
  if (!resolvedBinding) {
    return { ok: false, reason: "missing_binding" };
  }
  if (resolvedBinding.mode === BROWSER_MODE_AIM_PROFILE || resolvedBinding.mode === BROWSER_MODE_CHROME_PROFILE) {
    const userDataDir = String(resolvedBinding.userDataDir ?? "").trim();
    const profileDirectory = normalizeChromeProfileDirectory(resolvedBinding.profileDirectory);
    if (!userDataDir) {
      return { ok: false, reason: "missing_user_data_dir" };
    }
    if (!fs.existsSync(userDataDir)) {
      return { ok: false, reason: "missing_browser_path", path: userDataDir };
    }
    return openChromeUserDataDirForUrl({ url, userDataDir, profileDirectory, spawnImpl });
  }
  if (resolvedBinding.mode === BROWSER_MODE_AGENT_BROWSER) {
    const profile = String(resolvedBinding.agentBrowserProfile ?? "").trim();
    const session = String(resolvedBinding.agentBrowserSession ?? "").trim();
    if (!profile) {
      return { ok: false, reason: "missing_agent_browser_profile" };
    }
    if (!fs.existsSync(profile)) {
      return { ok: false, reason: "missing_browser_path", path: profile };
    }
    if (!session) {
      return { ok: false, reason: "missing_agent_browser_session" };
    }
    return spawnAgentBrowserOpen({
      url,
      profile,
      session,
      cwd: homeDir,
      spawnImpl,
    });
  }
  return { ok: false, reason: "unsupported_binding_mode" };
}
