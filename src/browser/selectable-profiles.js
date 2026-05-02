import { discoverOpenclawBrowserProfiles } from "./openclaw.js";
import {
  buildChromeProfileChoiceLabel,
  discoverChromeProfiles,
  formatChromeBrowserTarget,
  resolveChromeLocalStatePath,
  resolveOpenclawStateDir,
} from "./chrome.js";
import { normalizeLabel } from "../core/normalize.js";

export function normalizeBrowserDiscoveryMatchKey(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function discoverSelectableChromeBindings({ homeDir, label }) {
  const normalizedLabel = normalizeLabel(label);
  const labelToken = normalizeBrowserDiscoveryMatchKey(normalizedLabel);
  const agentLabelToken = normalizeBrowserDiscoveryMatchKey(`agent-${normalizedLabel}`);
  const openclawStateDir = resolveOpenclawStateDir({ homeDir });
  const candidates = [
    ...discoverOpenclawBrowserProfiles({ openclawStateDir }).map((profile) => ({
      ...profile,
      source: "openclaw-browser",
      browserName: "OpenClaw browser",
      profileDirectory: null,
    })),
    ...discoverChromeProfiles({ homeDir }).map((profile) => ({
      ...profile,
      source: "host-chrome",
    })),
  ];

  return candidates.toSorted((a, b) => {
    const aSignedIn = Boolean(a.userName || a.gaiaName);
    const bSignedIn = Boolean(b.userName || b.gaiaName);
    const aSource = String(a.source ?? "").trim();
    const bSource = String(b.source ?? "").trim();
    const aProfileKey = normalizeBrowserDiscoveryMatchKey(
      aSource === "openclaw-browser" ? a.profileId : a.profileDirectory,
    );
    const bProfileKey = normalizeBrowserDiscoveryMatchKey(
      bSource === "openclaw-browser" ? b.profileId : b.profileDirectory,
    );
    const aRelevant = aProfileKey === labelToken || aProfileKey === agentLabelToken;
    const bRelevant = bProfileKey === labelToken || bProfileKey === agentLabelToken;

    if (aRelevant !== bRelevant) return aRelevant ? -1 : 1;
    if (aSource !== bSource) {
      if (aSource === "openclaw-browser") return -1;
      if (bSource === "openclaw-browser") return 1;
    }
    if (aSignedIn !== bSignedIn) return aSignedIn ? -1 : 1;
    const byLabel = buildChromeProfileChoiceLabel(a).localeCompare(buildChromeProfileChoiceLabel(b));
    if (byLabel !== 0) return byLabel;
    return String(a.userDataDir ?? "").localeCompare(String(b.userDataDir ?? ""));
  });
}

export function buildChromeSetupOptionDetails({ label, homeDir }) {
  const normalizedLabel = normalizeLabel(label);
  const profiles = discoverSelectableChromeBindings({ homeDir, label: normalizedLabel });
  if (profiles.length === 0) {
    return [
      `Will scan local Chrome and OpenClaw browser homes on this Mac, let you pick a discovered profile if one exists, or let you enter one manually for ${normalizedLabel}.`,
    ];
  }

  const openclawCount = profiles.filter((profile) => String(profile.source ?? "").trim() === "openclaw-browser").length;
  const hostCount = profiles.length - openclawCount;
  const sourceSummary = [
    openclawCount > 0 ? `${openclawCount} OpenClaw browser home${openclawCount === 1 ? "" : "s"}` : null,
    hostCount > 0 ? `${hostCount} host Chrome profile${hostCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean);

  const preview = profiles.slice(0, 3).flatMap((profile, index) => [
    `Option ${index + 1}: ${buildChromeProfileChoiceLabel(profile)}.`,
    `Would save ${formatChromeBrowserTarget({
      userDataDir: profile.userDataDir,
      profileDirectory: profile.profileDirectory,
      fallback: "the discovered Chrome profile",
    })}.`,
  ]);

  return [
    `Next screen will offer ${profiles.length} discovered Chrome profile${profiles.length === 1 ? "" : "s"} on this Mac and let you pick one.`,
    ...(sourceSummary.length > 0 ? [`Includes ${sourceSummary.join(" and ")}.`] : []),
    ...preview,
    ...(profiles.length > 3 ? [`Plus ${profiles.length - 3} more discovered Chrome profiles.`] : []),
    `If none match, AIM will let you enter another Chrome user-data-dir and profile-directory manually for ${normalizedLabel}.`,
  ];
}
