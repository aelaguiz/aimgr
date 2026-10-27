import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { writeJsonFileIfChanged } from "../io/json-store.js";

const HOOK_PATH = fileURLToPath(new URL("./claude-hook.js", import.meta.url));

// Amir, 2026-09-24: finished scheduled jobs held Claude accounts for up to a
// day. The job says how it ended so AIM can release the account; the first
// idle turn is not the end, because jobs keep working through background agents.
export const CLAUDE_ROUTINE_STATUS_RULE = [
  "This session is an AIM scheduled job. AIM releases this Claude account when the job ends, so it needs to know how the job ended.",
  "When the job is completely finished and nothing you started is still running (background agents, background shells, monitors, scheduled wakeups), make the last line of your final message exactly one of:",
  "AIM-JOB: done",
  "AIM-JOB: needs-input <the question the user must answer>",
  "AIM-JOB: blocked <what stopped the job>",
  "Use needs-input only when the job cannot finish without a reply. Never write this line before the job is finished. If the user replies later, end your final message with the line again when that work is finished.",
].join("\n");

const JOB_STATUS_LINE = /^[\s>*_`#-]*AIM-JOB:\s*(done|needs-input|blocked)\b[\s:—–-]*(.*?)[\s*_`]*$/i;

export function parseClaudeRoutineJobStatus(text) {
  if (typeof text !== "string" || !text) return null;
  const lines = text.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const match = JOB_STATUS_LINE.exec(lines[index]);
    if (match) return { state: match[1].toLowerCase(), detail: match[2].trim().slice(0, 300) || null };
  }
  return null;
}

export function claudeRoutineArgs(routine) {
  return [
    "--model", routine.model, "--effort", routine.thinking, "--dangerously-skip-permissions",
    "--append-system-prompt", CLAUDE_ROUTINE_STATUS_RULE,
  ];
}

const PARK_HEADLINES = {
  done: "finished",
  "needs-input": "needs your reply",
  blocked: "is blocked",
  failed: "stopped on an error",
  quiet: "went quiet without saying it was finished",
  stuck: "sat waiting on background work with no activity",
  idle: "sat idle after your last message",
};

export function formatClaudeRoutineParkNotice({ routineId, reason, detail, label, sessionId, at }) {
  const when = new Date(at).toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  return [
    "",
    `[aim] ${routineId} ${PARK_HEADLINES[reason] ?? reason}. Claude was stopped and account ${label} was released at ${when}.`,
    ...(detail ? [`[aim] ${detail}`] : []),
    `[aim] Continue this conversation: aim claude resume ${sessionId}`,
    "",
  ].join("\n");
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
