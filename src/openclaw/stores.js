import fs from "node:fs";
import path from "node:path";
import { resolveOpenclawAuthStorePath } from "../io/paths.js";

export function discoverOpenclawAgentIdsWithAuthStores(homeDir) {
  const agentsRoot = path.join(homeDir, ".openclaw", "agents");
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  const ids = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    if (fs.existsSync(resolveOpenclawAuthStorePath(homeDir, agentId))) {
      ids.push(agentId);
    }
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function discoverOpenclawAgentIdsWithSessionStores(homeDir) {
  const agentsRoot = path.join(homeDir, ".openclaw", "agents");
  if (!fs.existsSync(agentsRoot)) {
    return [];
  }
  const ids = [];
  for (const entry of fs.readdirSync(agentsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const agentId = entry.name;
    if (fs.existsSync(resolveOpenclawSessionsStorePath(homeDir, agentId))) {
      ids.push(agentId);
    }
  }
  return ids.toSorted((a, b) => a.localeCompare(b));
}

export function resolveOpenclawSessionsStorePath(homeDir, agentId) {
  return path.join(homeDir, ".openclaw", "agents", agentId, "sessions", "sessions.json");
}
