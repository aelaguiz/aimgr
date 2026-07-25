import fs from "node:fs";
import path from "node:path";
import { normalizeLabel } from "../core/normalize.js";
import { formatDurationRough } from "../core/time.js";
import { resolveAimgrStateDir } from "../io/paths.js";
import { formatStatusTable } from "../status/table.js";

export const CLAUDE_RECENT_SESSION_LIMIT = 50;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function readDirectory(directory, { missingIsEmpty = false } = {}) {
  try {
    return fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (missingIsEmpty && error?.code === "ENOENT") return [];
    throw new Error("Could not read managed Claude sessions.");
  }
}

function normalizeThreadName(value) {
  const name = typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim()
    : "";
  return name || null;
}

function parseSessionFile({ filePath, account, threadId, fallbackTimestampMs }) {
  let content;
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch {
    throw new Error("Could not read managed Claude sessions.");
  }

  let cwd = null;
  let customTitle = null;
  let aiTitle = null;
  let lastUsedMs = null;
  for (const line of content.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      // Claude may be appending the final JSONL line while AIM reads it.
      continue;
    }
    if (typeof entry?.cwd === "string" && path.isAbsolute(entry.cwd)) {
      cwd = path.normalize(entry.cwd);
    }
    const timestampMs = Date.parse(String(entry?.timestamp ?? ""));
    if (Number.isFinite(timestampMs)) {
      lastUsedMs = lastUsedMs === null ? timestampMs : Math.max(lastUsedMs, timestampMs);
    }
    if (entry?.type === "custom-title" && Object.hasOwn(entry, "customTitle")) {
      const title = normalizeThreadName(entry.customTitle);
      if (title) customTitle = title;
    }
    if (entry?.type === "ai-title" && Object.hasOwn(entry, "aiTitle")) {
      const title = normalizeThreadName(entry.aiTitle);
      if (title) aiTitle = title;
    }
  }
  if (!cwd) return null;
  const observedAtMs = lastUsedMs ?? fallbackTimestampMs;
  if (!Number.isFinite(observedAtMs)) return null;
  const threadName = customTitle ?? aiTitle;
  return {
    account,
    threadId,
    threadName,
    thread: threadName ?? threadId,
    cwd,
    lastUsedAt: new Date(observedAtMs).toISOString(),
    lastUsedMs: observedAtMs,
  };
}

export function readManagedClaudeSessions({ homeDir }) {
  const homesRoot = path.join(resolveAimgrStateDir({ homeDir }), "claude-homes");
  const sessions = [];
  for (const labelEntry of readDirectory(homesRoot, { missingIsEmpty: true })) {
    if (!labelEntry.isDirectory() || labelEntry.isSymbolicLink()) continue;
    let account;
    try {
      account = normalizeLabel(labelEntry.name);
    } catch {
      continue;
    }
    const projectsRoot = path.join(homesRoot, labelEntry.name, ".claude", "projects");
    for (const projectEntry of readDirectory(projectsRoot, { missingIsEmpty: true })) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const projectDir = path.join(projectsRoot, projectEntry.name);
      for (const fileEntry of readDirectory(projectDir)) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        const threadId = fileEntry.name.slice(0, -".jsonl".length);
        if (!SESSION_ID_PATTERN.test(threadId)) continue;
        const filePath = path.join(projectDir, fileEntry.name);
        let fallbackTimestampMs;
        try {
          fallbackTimestampMs = fs.statSync(filePath).mtimeMs;
        } catch {
          throw new Error("Could not read managed Claude sessions.");
        }
        const session = parseSessionFile({
          filePath,
          account,
          threadId: threadId.toLowerCase(),
          fallbackTimestampMs,
        });
        if (session) sessions.push(session);
      }
    }
  }
  return sessions.sort((left, right) => (
    right.lastUsedMs - left.lastUsedMs
    || left.threadId.localeCompare(right.threadId)
  ));
}

export function listRecentManagedClaudeSessions({ homeDir }) {
  return readManagedClaudeSessions({ homeDir })
    .slice(0, CLAUDE_RECENT_SESSION_LIMIT)
    .map((session, index) => ({ ...session, rank: index + 1 }));
}

export function resolveManagedClaudeSession({ homeDir, selector }) {
  const value = String(selector ?? "").trim();
  if (!value) {
    throw new Error("Missing Claude session selector. Use a row number or thread ID.");
  }
  const sessions = readManagedClaudeSessions({ homeDir });
  let selected;
  if (/^\d+$/.test(value)) {
    const rank = Number(value);
    selected = Number.isSafeInteger(rank) && rank >= 1 && rank <= CLAUDE_RECENT_SESSION_LIMIT
      ? sessions[rank - 1]
      : null;
  } else if (SESSION_ID_PATTERN.test(value)) {
    const matches = sessions.filter((session) => session.threadId === value.toLowerCase());
    if (matches.length > 1) {
      throw new Error(`Claude thread ID ${value} exists under more than one managed account.`);
    }
    selected = matches[0] ?? null;
  } else {
    throw new Error("Invalid Claude session selector. Use a row number or thread ID.");
  }
  if (!selected) {
    throw new Error(`Claude session ${value} was not found in managed account homes.`);
  }
  let cwdStat;
  try {
    cwdStat = fs.statSync(selected.cwd);
  } catch {
    cwdStat = null;
  }
  if (!cwdStat?.isDirectory()) {
    throw new Error(`Claude session working directory is unavailable: ${selected.cwd}`);
  }
  return selected;
}

function displayWorkingDirectory(cwd, homeDir) {
  if (cwd === homeDir) return "~";
  const prefix = `${homeDir}${path.sep}`;
  return cwd.startsWith(prefix) ? `~/${cwd.slice(prefix.length)}` : cwd;
}

export function renderRecentManagedClaudeSessions(sessions, {
  homeDir,
  nowMs = Date.now(),
} = {}) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return "No managed Claude sessions found.\n";
  }
  const rows = [
    ["#", "last_used", "account", "thread", "working_directory"],
    ...sessions.map((session) => [
      session.rank,
      `${formatDurationRough(Math.max(0, nowMs - session.lastUsedMs))} ago`,
      session.account,
      session.thread,
      displayWorkingDirectory(session.cwd, homeDir),
    ]),
  ];
  return `${formatStatusTable(rows).join("\n")}\n`;
}
