import fs from "node:fs";
import path from "node:path";
import { isAbsoluteExistingDirectory, listDirectories } from "./chrome.js";
import { BROWSER_MODE_AGENT_BROWSER } from "../core/constants.js";
import { isObject, normalizeAbsolutePath, normalizeLabel } from "../core/normalize.js";
import { resolveAgentsRepoRoot } from "../io/paths.js";

export function normalizeDiscoveryToken(value) {
  return String(value ?? "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

export function readAgentBrowserConfigFromWorkspace(workspacePath, { agentId, agentName } = {}) {
  const workspace = normalizeAbsolutePath(workspacePath);
  if (!workspace || !fs.existsSync(workspace)) return null;
  const configPath = path.join(workspace, "agent-browser.json");
  if (!fs.existsSync(configPath)) return null;

  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
  if (!isObject(parsed)) return null;

  const session = String(parsed.session ?? "").trim();
  const profile = normalizeAbsolutePath(parsed.profile);
  if (!session || !profile || !isAbsoluteExistingDirectory(profile)) {
    return null;
  }

  return {
    agentId: String(agentId ?? "").trim() || path.basename(workspace),
    agentName: String(agentName ?? "").trim() || null,
    workspace,
    configPath,
    agentBrowserSession: session,
    agentBrowserProfile: profile,
  };
}

export function readRepoAgentBrowserConfigs({ repoRoot, agentsList }) {
  const entries = [];
  const seenWorkspaces = new Set();
  const list = Array.isArray(agentsList) ? agentsList : [];

  for (const agent of list) {
    if (!isObject(agent)) continue;
    const candidate = readAgentBrowserConfigFromWorkspace(agent.workspace, {
      agentId: agent.id,
      agentName: agent.name,
    });
    if (!candidate) continue;
    if (seenWorkspaces.has(candidate.workspace)) continue;
    seenWorkspaces.add(candidate.workspace);
    entries.push(candidate);
  }

  const resolvedRepoRoot = resolveAgentsRepoRoot({ repoRoot });
  const agentsDir = path.join(resolvedRepoRoot, "agents");
  for (const dirName of listDirectories(agentsDir)) {
    const workspace = path.join(agentsDir, dirName);
    const candidate = readAgentBrowserConfigFromWorkspace(workspace, {
      agentId: dirName,
    });
    if (!candidate) continue;
    if (seenWorkspaces.has(candidate.workspace)) continue;
    seenWorkspaces.add(candidate.workspace);
    entries.push(candidate);
  }

  return entries;
}

export function buildSuggestedAgentBrowserDisplay(candidate) {
  const agentName = String(candidate.agentName ?? "").trim();
  const agentId = String(candidate.agentId ?? "").trim();
  const identity = agentName || agentId || path.basename(String(candidate.workspace ?? "").trim());
  return `agent-browser · ${identity} · session=${candidate.agentBrowserSession}`;
}

export function formatAgentBrowserTarget({ session, profile, fallback = "agent-browser" }) {
  const trimmedSession = String(session ?? "").trim();
  const trimmedProfile = String(profile ?? "").trim();
  if (trimmedSession && trimmedProfile) {
    return `agent-browser session "${trimmedSession}" using profile ${trimmedProfile}`;
  }
  if (trimmedSession) {
    return `agent-browser session "${trimmedSession}"`;
  }
  if (trimmedProfile) {
    return `agent-browser profile ${trimmedProfile}`;
  }
  return fallback;
}

export function describeSuggestedAgentBrowserSource(candidate, label) {
  const normalizedLabel = normalizeLabel(label);
  const agentId = String(candidate?.agentId ?? "").trim() || "unknown-agent";
  const configPath = String(candidate?.configPath ?? "").trim();
  if (candidate?.source === "openclaw-binding") {
    return `AIM found it from exact OpenClaw binding ${normalizedLabel} -> ${agentId}${configPath ? ` in ${configPath}` : ""}.`;
  }
  if (candidate?.source === "workspace-session-match") {
    return `AIM found it because session "${candidate.agentBrowserSession}" exactly matches ${normalizedLabel}${configPath ? ` in ${configPath}` : ""}.`;
  }
  if (candidate?.source === "workspace-profile-match") {
    return `AIM found it because profile "${path.basename(candidate.agentBrowserProfile)}" exactly matches ${normalizedLabel}${configPath ? ` in ${configPath}` : ""}.`;
  }
  return configPath ? `AIM found it in ${configPath}.` : "AIM found it from repo browser config.";
}

export function buildSuggestedAgentBrowserDetails(candidate, { label, prefix = "Will use" } = {}) {
  if (!candidate) return [];
  const target = formatAgentBrowserTarget({
    session: candidate.agentBrowserSession,
    profile: candidate.agentBrowserProfile,
  });
  return [
    `${prefix} ${target}.`,
    describeSuggestedAgentBrowserSource(candidate, label),
  ];
}

export function discoverSuggestedBrowserBindings({
  label,
  repoRoot,
  bindings,
  agentsList,
}) {
  const normalizedLabel = normalizeLabel(label);
  const labelToken = normalizeDiscoveryToken(normalizedLabel);
  const agentPrefixedToken = normalizeDiscoveryToken(`agent-${normalizedLabel}`);
  const bindingList = Array.isArray(bindings) ? bindings : [];
  const agentBrowserConfigs = readRepoAgentBrowserConfigs({ repoRoot, agentsList });
  const matchedBindingsByAgentId = new Map();

  for (const binding of bindingList) {
    if (!isObject(binding)) continue;
    if (String(binding?.match?.channel ?? "").trim() !== "slack") continue;
    const accountId = String(binding?.match?.accountId ?? "").trim();
    const agentId = String(binding?.agentId ?? "").trim();
    if (!agentId) continue;
    if (normalizeDiscoveryToken(accountId) === labelToken) {
      matchedBindingsByAgentId.set(agentId, binding);
    }
  }

  const deduped = new Map();
  for (const candidate of agentBrowserConfigs) {
    const sessionToken = normalizeDiscoveryToken(candidate.agentBrowserSession);
    const profileToken = normalizeDiscoveryToken(path.basename(candidate.agentBrowserProfile));
    let source = null;
    let confidence = null;
    let rank = null;

    if (matchedBindingsByAgentId.has(candidate.agentId)) {
      source = "openclaw-binding";
      confidence = "strong";
      rank = 0;
    } else if (sessionToken === labelToken || sessionToken === agentPrefixedToken) {
      source = "workspace-session-match";
      confidence = "secondary";
      rank = 1;
    } else if (profileToken === labelToken || profileToken === agentPrefixedToken) {
      source = "workspace-profile-match";
      confidence = "secondary";
      rank = 2;
    }

    if (!source) continue;

    const key = `${candidate.agentBrowserProfile}\u0000${candidate.agentBrowserSession}`;
    const existing = deduped.get(key);
    const next = {
      mode: BROWSER_MODE_AGENT_BROWSER,
      agentId: candidate.agentId,
      agentName: candidate.agentName,
      workspace: candidate.workspace,
      configPath: candidate.configPath,
      agentBrowserProfile: candidate.agentBrowserProfile,
      agentBrowserSession: candidate.agentBrowserSession,
      source,
      confidence,
      rank,
      display: buildSuggestedAgentBrowserDisplay(candidate),
    };
    if (!existing || next.rank < existing.rank || (next.rank === existing.rank && next.agentId.localeCompare(existing.agentId) < 0)) {
      deduped.set(key, next);
    }
  }

  return [...deduped.values()].toSorted((a, b) => {
    if (a.rank !== b.rank) return a.rank - b.rank;
    return a.agentId.localeCompare(b.agentId);
  });
}
