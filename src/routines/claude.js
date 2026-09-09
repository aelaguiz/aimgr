import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonFileIfChanged } from "../io/json-store.js";

const HOOK_PATH = fileURLToPath(new URL("./claude-hook.js", import.meta.url));

export function claudeRoutineArgs(routine) {
  return ["--model", routine.model, "--effort", routine.thinking, "--dangerously-skip-permissions"];
}

export async function runClaudeRoutineSession(context, options) {
  const [{ loadCommandDefaultDeps }, { runAutomaticClaudeSession }] = await Promise.all([
    import("../cli/deps.js"),
    import("../cli/commands/claude.js"),
  ]);
  return runAutomaticClaudeSession({ ...await loadCommandDefaultDeps("claude"), ...context }, options);
}

function readOptionalObject(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch (error) {
    if (error.code === "ENOENT") return {};
    throw error;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// Transfer only this already-trusted project, while the account lease is held.
// A newly selected account must not lose the user's existing MCP trust decision.
export function inheritClaudeRoutineTrust({ userHomeDir, configDir, cwd }) {
  const source = readOptionalObject(path.join(userHomeDir, ".claude.json"));
  const canonicalCwd = fs.realpathSync(cwd);
  const trusted = source.projects?.[cwd]?.hasTrustDialogAccepted === true
    || source.projects?.[canonicalCwd]?.hasTrustDialogAccepted === true;
  if (!trusted) return false;
  const appStatePath = path.join(configDir, ".claude.json");
  const current = readOptionalObject(appStatePath);
  const projects = { ...current.projects };
  for (const projectPath of new Set([cwd, canonicalCwd])) {
    projects[projectPath] = { ...projects[projectPath], hasTrustDialogAccepted: true };
  }
  writeJsonFileIfChanged(appStatePath, {
    ...current,
    projects,
  }, { mode: 0o600 });
  return true;
}

export function prepareInteractiveClaudeRoutine({ launch, routine, sessionId, eventsPath }) {
  fs.closeSync(fs.openSync(eventsPath, "wx", 0o600));
  inheritClaudeRoutineTrust({ userHomeDir: launch.userHomeDir, configDir: launch.configDir, cwd: routine.cwd });
  const userSettings = readOptionalObject(path.join(launch.userHomeDir, ".claude", "settings.json"));
  const overlay = launch.preparedLaunch.userHooksPath ? readOptionalObject(launch.preparedLaunch.userHooksPath) : {};
  const command = [process.execPath, HOOK_PATH, eventsPath, sessionId].map(shellQuote).join(" ");
  const hooks = { ...overlay.hooks };
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]) {
    hooks[event] = [...(hooks[event] ?? []), { hooks: [{ type: "command", command, timeout: 5 }] }];
  }
  const settingsPath = eventsPath.replace(/\.jsonl$/, ".settings.json");
  writeJsonFileIfChanged(settingsPath, {
    ...overlay,
    ...(userSettings.skipDangerousModePermissionPrompt === true ? { skipDangerousModePermissionPrompt: true } : {}),
    hooks,
  }, { mode: 0o600 });
  return {
    ...launch,
    preparedLaunch: { ...launch.preparedLaunch, userHooksPath: settingsPath },
    args: [...claudeRoutineArgs(routine), "--session-id", sessionId],
  };
}

// Observation must never terminate the interactive session. Ignore incomplete
// writes, unrelated messages, and malformed observer records; Claude owns its UI.
export function readClaudeRoutineEvents(eventsPath) {
  const source = fs.readFileSync(eventsPath, "utf8");
  return source.slice(0, source.lastIndexOf("\n") + 1).split("\n").flatMap((line) => {
    try {
      const value = line ? JSON.parse(line) : null;
      return value && typeof value === "object" && !Array.isArray(value) ? [value] : [];
    } catch { return []; }
  });
}
