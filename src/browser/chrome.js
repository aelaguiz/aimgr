import fs from "node:fs";
import path from "node:path";
import { isObject, normalizeLabel } from "../core/normalize.js";
import { readJsonFile } from "../io/json-store.js";
import { resolveAimgrStateDir } from "../io/paths.js";

export function resolveOpenclawStateDir({ homeDir }) {
  return path.join(homeDir, ".openclaw");
}

export function resolveAimBrowserRootDir({ homeDir }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "browser");
}

export function resolveAimBrowserUserDataDir({ homeDir, label }) {
  return path.join(resolveAimBrowserRootDir({ homeDir }), normalizeLabel(label), "user-data");
}

export function resolveAimBrowserLocalStatePath({ homeDir, label }) {
  return path.join(resolveAimBrowserUserDataDir({ homeDir, label }), "Local State");
}

export function resolveChromeLocalStatePath(userDataDir) {
  return path.join(String(userDataDir ?? "").trim(), "Local State");
}

export function normalizeChromeProfileDirectory(value) {
  const raw = String(value ?? "").trim();
  if (!raw) return null;
  return raw;
}

export function aimBrowserProfileExists({ homeDir, label }) {
  return fs.existsSync(resolveAimBrowserUserDataDir({ homeDir, label }));
}

export function isAbsoluteExistingDirectory(dirPath) {
  const raw = String(dirPath ?? "").trim();
  if (!raw || !path.isAbsolute(raw)) return false;
  try {
    return fs.statSync(raw).isDirectory();
  } catch {
    return false;
  }
}

export function openclawAgentExists({ openclawStateDir, agentId }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  const id = String(agentId ?? "").trim();
  if (!baseDir || !id) return false;
  return fs.existsSync(path.join(baseDir, "agents", id, "agent"));
}

export function inferOpenclawAgentIdForLabel({ openclawStateDir, label }) {
  const l = String(label ?? "").trim();
  if (!l) return null;

  const candidates = [];
  // Convention: label=boss -> agent_boss
  candidates.push(`agent_${l}`);
  // Allow label=growth-analyst to map to an existing agent_growth_analyst directory.
  const underscore = `agent_${l.replace(/-/g, "_")}`;
  if (underscore !== candidates[0]) candidates.push(underscore);

  for (const agentId of candidates) {
    if (openclawAgentExists({ openclawStateDir, agentId })) {
      return agentId;
    }
  }
  return null;
}

export function listDirectories(dirPath) {
  try {
    return fs
      .readdirSync(dirPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

export function resolveOpenclawBrowserUserDataDir({ openclawStateDir, profileId }) {
  return path.join(openclawStateDir, "browser", profileId, "user-data");
}

export function resolveOpenclawBrowserProfileLocalStatePath({ openclawStateDir, profileId }) {
  return path.join(resolveOpenclawBrowserUserDataDir({ openclawStateDir, profileId }), "Local State");
}

export function readChromeProfileInfoCacheFromLocalState(localStatePath) {
  const localState = readJsonFile(localStatePath);
  const cache = localState?.profile?.info_cache;
  return isObject(cache) ? cache : null;
}

export function readChromeProfileInfoFromLocalState(localStatePath, profileDirectory = "Default") {
  const cache = readChromeProfileInfoCacheFromLocalState(localStatePath);
  if (!cache) return null;
  const entry = cache[profileDirectory];
  return isObject(entry) ? entry : null;
}

export function readChromeDefaultProfileInfoFromLocalState(localStatePath) {
  return readChromeProfileInfoFromLocalState(localStatePath, "Default");
}

export function buildChromeProfileChoiceLabel(profile) {
  const browserName = String(profile.browserName ?? "").trim() || "Chrome";
  const source = String(profile.source ?? "").trim();
  const sourceId =
    source === "openclaw-browser"
      ? String(profile.profileId ?? "").trim()
      : "";
  const profileNameRaw = String(profile.name ?? "").trim();
  const profileName = sourceId && profileNameRaw === sourceId ? "" : profileNameRaw;
  const userName = String(profile.userName ?? "").trim() || String(profile.gaiaName ?? "").trim();
  const parts = [browserName];
  if (sourceId) parts.push(sourceId);
  if (profileName) parts.push(profileName);
  if (userName) parts.push(userName);
  return parts.join(" · ");
}

export function formatChromeBrowserTarget({ userDataDir, profileDirectory, fallback = "the saved Chrome profile" }) {
  const resolvedUserDataDir = String(userDataDir ?? "").trim();
  const resolvedProfileDirectory = normalizeChromeProfileDirectory(profileDirectory);
  if (resolvedUserDataDir && resolvedProfileDirectory) {
    return `Chrome user-data-dir ${resolvedUserDataDir} with profile-directory "${resolvedProfileDirectory}"`;
  }
  if (resolvedUserDataDir) {
    return `Chrome user-data-dir ${resolvedUserDataDir}`;
  }
  if (resolvedProfileDirectory) {
    return `Chrome profile-directory "${resolvedProfileDirectory}"`;
  }
  return fallback;
}

export function buildChromeProfileChoiceDetails(profile, { label, prefix = "Will save" } = {}) {
  const normalizedLabel = normalizeLabel(label);
  return [
    `${prefix} ${formatChromeBrowserTarget({
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      fallback: `the chosen Chrome profile for ${normalizedLabel}`,
    })}.`,
    ...(String(profile.source ?? "").trim() === "openclaw-browser" && String(profile.profileId ?? "").trim()
      ? [`This is OpenClaw browser profile "${String(profile.profileId).trim()}".`]
      : []),
    `AIM found it in ${resolveChromeLocalStatePath(profile.userDataDir)}.`,
  ];
}

export function discoverChromeProfiles({ homeDir }) {
  const baseHome = String(homeDir ?? "").trim();
  if (!baseHome) return [];
  const roots = [
    { browserName: "Google Chrome", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome") },
    { browserName: "Google Chrome Beta", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome Beta") },
    { browserName: "Google Chrome Canary", userDataDir: path.join(baseHome, "Library", "Application Support", "Google", "Chrome Canary") },
    { browserName: "Chromium", userDataDir: path.join(baseHome, "Library", "Application Support", "Chromium") },
  ];

  const profiles = [];
  for (const root of roots) {
    if (!isAbsoluteExistingDirectory(root.userDataDir)) continue;
    const localStatePath = resolveChromeLocalStatePath(root.userDataDir);
    const cache = readChromeProfileInfoCacheFromLocalState(localStatePath);
    if (!cache) continue;
    for (const [profileDirectory, info] of Object.entries(cache)) {
      if (!isObject(info)) continue;
      if (!isAbsoluteExistingDirectory(path.join(root.userDataDir, profileDirectory))) continue;
      const name = typeof info.name === "string" ? info.name.trim() : "";
      const userName = typeof info.user_name === "string" ? info.user_name.trim() : "";
      const gaiaName = typeof info.gaia_name === "string" ? info.gaia_name.trim() : "";
      profiles.push({
        browserName: root.browserName,
        userDataDir: root.userDataDir,
        profileDirectory,
        name: name || null,
        userName: userName || null,
        gaiaName: gaiaName || null,
      });
    }
  }

  return profiles.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName || a.gaiaName);
    const bSignedIn = Boolean(b.userName || b.gaiaName);
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    const byBrowser = a.browserName.localeCompare(b.browserName);
    if (byBrowser !== 0) return byBrowser;
    const byProfileName = String(a.name ?? "").localeCompare(String(b.name ?? ""));
    if (byProfileName !== 0) return byProfileName;
    return a.profileDirectory.localeCompare(b.profileDirectory);
  });
}
