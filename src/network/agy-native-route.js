import fs from "node:fs";
import { isObject } from "../core/normalize.js";
import { normalizeEgressPolicy, resolveClaudeEgressProfile } from "./claude-egress-policy.js";
import { assertInstalledClaudeRouteMatches, claudeNativeRouteMetadataPath, prepareClaudeNativeRoute } from "./claude-native-route.js";
import { checkClaudeRouteExit } from "./claude-transport.js";

function normalizeProfileRef(profileRef, label) {
  try {
    return normalizeEgressPolicy({ profileRef }).profileRef;
  } catch (cause) {
    throw new Error(`Antigravity connection ${label} has an invalid proxy reference. Set agyProxyAssignments to a valid proxy profile for this connection.`, { cause });
  }
}

export function agyProfileRef(config, label) {
  if (!Object.hasOwn(config ?? {}, "agyProxyAssignments")) return undefined;
  const assignments = config.agyProxyAssignments;
  if (!isObject(assignments)) {
    throw new Error("Antigravity agyProxyAssignments must map connection labels to proxy profile names.");
  }
  return Object.hasOwn(assignments, label) ? normalizeProfileRef(assignments[label], label) : undefined;
}

function resolveAgyNativeRouteProfile({ config, label, profileRef, platform }) {
  const assigned = agyProfileRef(config, label);
  const ref = profileRef === undefined ? undefined : normalizeProfileRef(profileRef, label);
  if (assigned !== undefined && assigned !== ref) {
    const repair = ref === undefined
      ? "Remove this label from agyProxyAssignments or use a separate label for the routed connection."
      : `Restore ${ref} in agyProxyAssignments before retrying.`;
    throw new Error(`Antigravity connection ${label} has a different enrolled proxy binding. ${repair}`);
  }
  if (!["linux", "darwin"].includes(platform)) throw new Error("Antigravity requires an approved Linux or macOS privacy runtime.");
  if (ref === undefined) return null;

  let profile;
  try {
    const profiles = config?.agyProxyProfiles;
    profile = resolveClaudeEgressProfile({
      label,
      account: { egress: { profileRef: ref } },
      profiles: isObject(profiles) ? profiles : undefined,
    });
  } catch (cause) {
    throw new Error(`Antigravity proxy ${ref} for ${label} needs a valid agyProxyProfiles entry with a loopback SOCKS endpoint and expected exit IPs.`, { cause });
  }

  if (profile.socksPort === 53) throw new Error(`Antigravity proxy ${ref} cannot use TCP port 53. Choose a separate SOCKS listener port.`);
  if (platform === "darwin" && profile.socksHost !== "127.0.0.1") {
    throw new Error(`Antigravity proxy ${ref} requires a SOCKS listener at 127.0.0.1 on macOS.`);
  }
  return profile;
}

export function checkAgyNativeRouteConfiguration(options, { readFileSync = fs.readFileSync } = {}) {
  const profile = resolveAgyNativeRouteProfile(options);
  if (!profile) return false;
  if (options.platform === "linux") {
    const installed = JSON.parse(readFileSync(claudeNativeRouteMetadataPath(profile.profileRef), "utf8"));
    assertInstalledClaudeRouteMatches({ ...profile, denyDatagrams: true }, installed, options.platform);
  }
  return true;
}

export async function prepareAgyNativeRoute({ config, label, profileRef, artifact, args, platform = process.platform }, {
  prepareClaudeNativeRouteImpl = prepareClaudeNativeRoute,
  checkClaudeRouteExitImpl = checkClaudeRouteExit,
} = {}) {
  const profile = resolveAgyNativeRouteProfile({ config, label, profileRef, platform });
  const command = artifact.launcher;
  if (!profile) return { command, args };

  const host = profile.socksHost === "::1" ? "[::1]" : profile.socksHost;
  const proxyUrl = `socks5h://${host}:${profile.socksPort}`;
  try {
    if (platform === "darwin") {
      // The admitted macOS launcher restricts network access to this endpoint.
      await checkClaudeRouteExitImpl(profile);
      return { command, args, proxyUrl };
    }
    const launch = await prepareClaudeNativeRouteImpl({ profile: { ...profile, denyDatagrams: true }, command, args, platform });
    return { ...launch, proxyUrl };
  } catch (cause) {
    const repair = platform === "darwin"
      ? "Check its SOCKS tunnel and expected exit IPs"
      : "Check the installed Linux route with denyDatagrams enabled and its SOCKS tunnel";
    throw new Error(`Antigravity proxy ${profile.profileRef} for ${label} could not be verified. ${repair}, then retry.`, { cause });
  }
}
