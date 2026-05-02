import fs from "node:fs";
import path from "node:path";
import { listDirectories, readChromeDefaultProfileInfoFromLocalState, resolveAimBrowserLocalStatePath, resolveAimBrowserRootDir, resolveAimBrowserUserDataDir, resolveOpenclawBrowserProfileLocalStatePath, resolveOpenclawBrowserUserDataDir } from "./chrome.js";
import { normalizeLabel } from "../core/normalize.js";

export function discoverOpenclawBrowserProfiles({ openclawStateDir }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  if (!baseDir) return [];

  const browserRoot = path.join(baseDir, "browser");
  const profileIds = listDirectories(browserRoot);

  const profiles = profileIds
    .map((profileId) => {
      const userDataDir = resolveOpenclawBrowserUserDataDir({ openclawStateDir: baseDir, profileId });
      if (!fs.existsSync(userDataDir)) return null;

      const info = readChromeDefaultProfileInfoFromLocalState(
        resolveOpenclawBrowserProfileLocalStatePath({ openclawStateDir: baseDir, profileId }),
      );
      const name = typeof info?.name === "string" ? String(info.name).trim() : "";
      const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
      const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";

      return {
        source: "openclaw-browser",
        browserName: "OpenClaw browser",
        profileId,
        userDataDir,
        name: name || null,
        userName: userName || null,
        gaiaName: gaiaName || null,
      };
    })
    .filter(Boolean);

  return profiles.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName);
    const bSignedIn = Boolean(b.userName);
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    return a.profileId.localeCompare(b.profileId);
  });
}

export function readAimBrowserFacts({ homeDir, label }) {
  const userDataDir = resolveAimBrowserUserDataDir({ homeDir, label });
  if (!fs.existsSync(userDataDir)) {
    return {
      label: normalizeLabel(label),
      exists: false,
      userDataDir,
      name: null,
      userName: null,
      gaiaName: null,
    };
  }

  const info = readChromeDefaultProfileInfoFromLocalState(resolveAimBrowserLocalStatePath({ homeDir, label }));
  const name = typeof info?.name === "string" ? String(info.name).trim() : "";
  const userName = typeof info?.user_name === "string" ? String(info.user_name).trim() : "";
  const gaiaName = typeof info?.gaia_name === "string" ? String(info.gaia_name).trim() : "";

  return {
    label: normalizeLabel(label),
    exists: true,
    userDataDir,
    name: name || null,
    userName: userName || null,
    gaiaName: gaiaName || null,
  };
}

export function discoverAimBrowserProfiles({ homeDir }) {
  const browserRoot = resolveAimBrowserRootDir({ homeDir });
  const labels = listDirectories(browserRoot);
  return labels
    .map((labelRaw) => {
      try {
        const label = normalizeLabel(labelRaw);
        return readAimBrowserFacts({ homeDir, label });
      } catch {
        return null;
      }
    })
    .filter(Boolean)
    .toSorted((a, b) => a.label.localeCompare(b.label));
}

export function formatOpenclawBrowserProfileChoice(profile) {
  const parts = [profile.profileId];
  const name = profile.name && profile.name !== profile.profileId ? profile.name : null;
  const email = profile.userName || null;
  const gaia = profile.gaiaName || null;

  if (name) parts.push(name);
  if (email) parts.push(email);
  if (gaia && gaia !== name && gaia !== email) parts.push(gaia);
  return parts.join(" — ");
}

export function openclawBrowserProfileExists({ openclawStateDir, profileId }) {
  const baseDir = String(openclawStateDir ?? "").trim();
  const id = String(profileId ?? "").trim();
  if (!baseDir || !id) return false;
  return fs.existsSync(resolveOpenclawBrowserUserDataDir({ openclawStateDir: baseDir, profileId: id }));
}

export function resolveOpenclawBrowserProfileFromInput({ input, profiles }) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) {
    const idx = Number(raw);
    if (!Number.isFinite(idx) || idx < 1 || idx > profiles.length) return null;
    return profiles[idx - 1].profileId;
  }

  const byLower = new Map();
  for (const profile of profiles) {
    byLower.set(profile.profileId.toLowerCase(), profile.profileId);
  }
  const direct = byLower.get(raw.toLowerCase());
  if (direct) return direct;

  return raw;
}
