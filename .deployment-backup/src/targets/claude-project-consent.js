import fs from "node:fs";
import path from "node:path";
import { writeJsonFileIfChanged } from "../io/json-store.js";

const MAX_APP_STATE_BYTES = 2 * 1024 * 1024;

function readAppState(filePath, { required = false } = {}) {
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_APP_STATE_BYTES) {
      throw new Error("Claude app state is not a safe regular file.");
    }
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("Claude app state is not a JSON object.");
    }
    return value;
  } catch (error) {
    if (error?.code === "ENOENT" && !required) return null;
    if (!required) return null;
    throw new Error("Could not read the selected Claude account's app state.", { cause: error });
  }
}

function sourceAppStatePaths(userHomeDir, selectedConfigDir) {
  const paths = [path.join(userHomeDir, ".claude.json")];
  const homesDir = path.join(userHomeDir, ".aimgr", "claude-homes");
  let labels;
  try {
    labels = fs.readdirSync(homesDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return paths;
    throw error;
  }
  for (const label of labels) {
    if (!label.isDirectory()) continue;
    const configDir = path.join(homesDir, label.name, ".claude");
    if (configDir !== selectedConfigDir) paths.push(path.join(configDir, ".claude.json"));
  }
  return paths;
}

// Only the user's positive decisions for this exact directory cross label
// boundaries. Never copy project tools, account identity, sessions, or history.
export function inheritClaudeProjectConsent({ userHomeDir, configDir, cwd }) {
  const projectPaths = [...new Set([path.resolve(cwd), fs.realpathSync(cwd)])];
  const selectedPath = path.join(configDir, ".claude.json");
  const selected = readAppState(selectedPath, { required: true });
  let trusted = false;
  let externalImportsApproved = false;
  for (const filePath of [selectedPath, ...sourceAppStatePaths(userHomeDir, configDir)]) {
    const state = filePath === selectedPath ? selected : readAppState(filePath);
    for (const projectPath of projectPaths) {
      const project = state?.projects?.[projectPath];
      if (project?.hasTrustDialogAccepted === true) trusted = true;
      if (project?.hasClaudeMdExternalIncludesApproved === true) externalImportsApproved = true;
    }
  }
  if (!trusted && !externalImportsApproved) return { wrote: false, trusted, externalImportsApproved };

  const projects = selected.projects === undefined ? {} : selected.projects;
  if (!projects || typeof projects !== "object" || Array.isArray(projects)) {
    throw new Error("The selected Claude account's project state is malformed.");
  }
  let changed = false;
  const nextProjects = { ...projects };
  for (const projectPath of projectPaths) {
    const current = projects[projectPath] ?? {};
    if (!current || typeof current !== "object" || Array.isArray(current)) {
      throw new Error("The selected Claude account's project state is malformed.");
    }
    const next = { ...current };
    let projectChanged = false;
    if (trusted && next.hasTrustDialogAccepted !== true) {
      next.hasTrustDialogAccepted = true;
      projectChanged = true;
    }
    if (externalImportsApproved) {
      if (next.hasClaudeMdExternalIncludesApproved !== true) {
        next.hasClaudeMdExternalIncludesApproved = true;
        projectChanged = true;
      }
      if (next.hasClaudeMdExternalIncludesWarningShown !== true) {
        next.hasClaudeMdExternalIncludesWarningShown = true;
        projectChanged = true;
      }
    }
    if (projectChanged) {
      nextProjects[projectPath] = next;
      changed = true;
    }
  }
  if (changed) writeJsonFileIfChanged(selectedPath, { ...selected, projects: nextProjects }, { mode: 0o600 });
  return { wrote: changed, trusted, externalImportsApproved };
}
