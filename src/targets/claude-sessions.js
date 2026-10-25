import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { readFileLines } from "../io/file-lines.js";
import {
  rekeyClaudeTranscriptFile,
  replaceClaudeTranscriptIdentifiers,
  stripClaudeTranscriptThinkingBytes,
} from "./claude-transcript-rekey.js";
import { normalizeLabel } from "../core/normalize.js";
import { formatDurationRough } from "../core/time.js";
import { resolveAimgrStateDir } from "../io/paths.js";
import { formatStatusTable } from "../status/table.js";

export const CLAUDE_RECENT_SESSION_LIMIT = 50;

const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_MODEL_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SESSION_EFFORT_LEVELS = new Set(["low", "medium", "high", "xhigh", "max"]);
const STAGED_FORK_MARKER_SUFFIX = ".aimgr-staged-fork";
const RECENT_SESSION_CANDIDATE_MARGIN = 3;
// Search raw bytes first; only decode metadata hits or an untitled prompt preview.
// Every hit is still validated by parsing its complete containing JSONL record.
const SESSION_JSON_MARKERS = Object.freeze({
  cwd: Buffer.from('"cwd"'),
  timestamp: Buffer.from('"timestamp"'),
  customTitle: Buffer.from('"customTitle"'),
  aiTitle: Buffer.from('"aiTitle"'),
  effort: Buffer.from('"effort"'),
  message: Buffer.from('"message"'),
});

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

function parseJsonLine(line) {
  try { return JSON.parse(line.toString("utf8")); } catch { return null; }
}

function firstUserPromptPreview(filePath) {
  for (const line of readFileLines(filePath)) {
    if (!line.includes(SESSION_JSON_MARKERS.message)) continue;
    const entry = parseJsonLine(line);
    if (entry?.type !== "user" || entry.isMeta || entry.isSidechain) continue;
    const contentValue = entry.message?.content;
    const text = typeof contentValue === "string" ? contentValue
      : Array.isArray(contentValue)
        ? contentValue.filter((block) => block?.type === "text").map((block) => block.text).join(" ")
        : "";
    const preview = normalizeThreadName(text);
    if (preview) return preview.length > 160 ? `${preview.slice(0, 159)}…` : preview;
  }
  return null;
}

function parseSessionFile({ filePath, account, threadId, fallbackTimestampMs }) {
  let cwd = null;
  let lastUsedMs = null;
  let customTitle = null;
  let aiTitle = null;
  let runtime = null;
  try {
    for (const line of readFileLines(filePath, { reverse: true })) {
      if (!((!cwd && line.includes(SESSION_JSON_MARKERS.cwd))
        || (lastUsedMs === null && line.includes(SESSION_JSON_MARKERS.timestamp))
        || (!customTitle && line.includes(SESSION_JSON_MARKERS.customTitle))
        || (!customTitle && !aiTitle && line.includes(SESSION_JSON_MARKERS.aiTitle))
        || (!runtime && line.includes(SESSION_JSON_MARKERS.effort)))) continue;
      const entry = parseJsonLine(line);
      if (!cwd && typeof entry?.cwd === "string" && path.isAbsolute(entry.cwd)) {
        cwd = path.normalize(entry.cwd);
      }
      if (lastUsedMs === null) {
        const timestamp = Date.parse(String(entry?.timestamp ?? ""));
        if (Number.isFinite(timestamp)) lastUsedMs = timestamp;
      }
      if (!customTitle && entry?.type === "custom-title") customTitle = normalizeThreadName(entry.customTitle);
      if (!aiTitle && entry?.type === "ai-title") aiTitle = normalizeThreadName(entry.aiTitle);
      if (!runtime && entry?.type === "assistant" && entry.isSidechain !== true) {
        const model = typeof entry.message?.model === "string" ? entry.message.model.trim() : "";
        const effort = typeof entry.effort === "string" ? entry.effort.trim().toLowerCase() : "";
        if (SESSION_MODEL_PATTERN.test(model) && SESSION_EFFORT_LEVELS.has(effort)) runtime = { model, effort };
      }
      if (cwd && lastUsedMs !== null && customTitle && runtime) break;
    }
    if (!cwd) return null;
    const observedAtMs = lastUsedMs ?? fallbackTimestampMs;
    if (!Number.isFinite(observedAtMs)) return null;
    const threadName = customTitle ?? aiTitle;
    const description = threadName ?? firstUserPromptPreview(filePath);
    return {
      account, threadId, threadName, description,
      thread: threadName ?? threadId,
      cwd,
      model: runtime?.model ?? null,
      effort: runtime?.effort ?? null,
      transcriptPath: filePath,
      lastUsedAt: new Date(observedAtMs).toISOString(),
      lastUsedMs: observedAtMs,
    };
  } catch {
    throw new Error("Could not read managed Claude sessions.");
  }
}

function compareSessions(left, right) {
  return right.lastUsedMs - left.lastUsedMs
    || left.threadId.localeCompare(right.threadId);
}

function discoverManagedClaudeSessionCandidates({ homeDir, threadId: requestedId, account: requestedAccount }) {
  const homesRoot = path.join(resolveAimgrStateDir({ homeDir }), "claude-homes");
  const candidates = [];
  for (const labelEntry of readDirectory(homesRoot, { missingIsEmpty: true })) {
    if (!labelEntry.isDirectory() || labelEntry.isSymbolicLink()) continue;
    let account;
    try {
      account = normalizeLabel(labelEntry.name);
    } catch {
      continue;
    }
    if (requestedAccount !== undefined && account !== requestedAccount) continue;
    const projectsRoot = path.join(homesRoot, labelEntry.name, ".claude", "projects");
    for (const projectEntry of readDirectory(projectsRoot, { missingIsEmpty: true })) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const projectDir = path.join(projectsRoot, projectEntry.name);
      for (const fileEntry of readDirectory(projectDir)) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        const threadId = fileEntry.name.slice(0, -".jsonl".length);
        if (!SESSION_ID_PATTERN.test(threadId)) continue;
        if (requestedId !== undefined && threadId.toLowerCase() !== requestedId.toLowerCase()) continue;
        if (fs.existsSync(path.join(projectDir, `${threadId}${STAGED_FORK_MARKER_SUFFIX}`))) {
          continue;
        }
        const filePath = path.join(projectDir, fileEntry.name);
        let fallbackTimestampMs;
        try {
          fallbackTimestampMs = fs.statSync(filePath).mtimeMs;
        } catch {
          throw new Error("Could not read managed Claude sessions.");
        }
        candidates.push({
          filePath,
          account,
          threadId: threadId.toLowerCase(),
          fallbackTimestampMs,
        });
      }
    }
  }
  return candidates.sort((left, right) => (
    right.fallbackTimestampMs - left.fallbackTimestampMs
    || left.threadId.localeCompare(right.threadId)
  ));
}

function parseSessionCandidate(candidate) {
  return parseSessionFile(candidate);
}

function readRecentManagedClaudeSessions({ homeDir, limit }) {
  const candidates = discoverManagedClaudeSessionCandidates({ homeDir });
  const sessions = [];
  let cursor = 0;
  while (cursor < candidates.length) {
    const needed = Math.max(1, limit - sessions.length);
    const roundEnd = Math.min(
      candidates.length,
      cursor + needed + RECENT_SESSION_CANDIDATE_MARGIN,
    );
    for (; cursor < roundEnd; cursor += 1) {
      const session = parseSessionCandidate(candidates[cursor]);
      if (session) sessions.push(session);
    }
    sessions.sort(compareSessions);
    if (sessions.length < limit) continue;
    const nextCandidate = candidates[cursor];
    if (
      !nextCandidate
      || nextCandidate.fallbackTimestampMs < sessions[limit - 1].lastUsedMs
    ) {
      break;
    }
  }
  return sessions.slice(0, limit);
}

export function readManagedClaudeSessions({ homeDir, threadId, account }) {
  return discoverManagedClaudeSessionCandidates({ homeDir, threadId, account })
    .map(parseSessionCandidate)
    .filter(Boolean)
    .sort(compareSessions);
}

// Native --resume/--session-id already supplies the identity. Ownership lives
// in the managed directory and filename; inspecting conversation bodies adds
// no evidence. Fork staging validates the selected history before launching.
export function findManagedClaudeSessionFiles({ homeDir, threadId, account }) {
  if (!SESSION_ID_PATTERN.test(threadId ?? "")) return [];
  return discoverManagedClaudeSessionCandidates({ homeDir, threadId, account })
    .map(({ filePath, account: owner, threadId: id }) => ({
      transcriptPath: filePath, account: owner, threadId: id,
    }));
}

export function listRecentManagedClaudeSessions({
  homeDir,
  limit = CLAUDE_RECENT_SESSION_LIMIT,
}) {
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new Error("Claude session list count must be a positive integer.");
  }
  return readRecentManagedClaudeSessions({ homeDir, limit })
    .map((session, index) => ({ ...session, rank: index + 1 }));
}

export function resolveManagedClaudeSession({ homeDir, selector, account }) {
  const value = String(selector ?? "").trim();
  if (!value) {
    throw new Error("Missing Claude session selector. Use a row number, thread ID, or exact name.");
  }
  let selected;
  if (/^\d+$/.test(value)) {
    const rank = Number(value);
    selected = Number.isSafeInteger(rank) && rank >= 1
      ? readRecentManagedClaudeSessions({ homeDir, limit: rank })[rank - 1]
      : null;
  } else if (SESSION_ID_PATTERN.test(value)) {
    const matches = readManagedClaudeSessions({ homeDir, threadId: value, account });
    if (matches.length > 1) {
      throw new Error(`Claude thread ID ${value} exists under more than one managed account.`);
    }
    selected = matches[0] ?? null;
  }
  if (!selected && !/^\d+$/.test(value) && !SESSION_ID_PATTERN.test(value)) {
    const sessions = readManagedClaudeSessions({ homeDir });
    const normalizedName = normalizeThreadName(value)?.toLowerCase();
    const matches = normalizedName
      ? sessions.filter((session) => session.threadName?.toLowerCase() === normalizedName)
      : [];
    if (matches.length > 1) {
      throw new Error(
        `Claude session name "${normalizeThreadName(value)}" is ambiguous; use a row number or thread ID.`,
      );
    }
    selected = matches[0] ?? null;
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

export function buildManagedClaudeSessionForkName(session) {
  const threadId = String(session?.threadId ?? "").toLowerCase();
  if (!SESSION_ID_PATTERN.test(threadId)) {
    throw new Error("Cannot fork an invalid managed Claude thread ID.");
  }
  const title = normalizeThreadName(session?.threadName)
    ?.replace(/^(?:\[fork from [^\]]+\]\s*)+/i, "")
    .trim();
  return title && title !== threadId ? title : "Continued session";
}

const COMPANION_TEXT_EXTENSIONS = new Set([
  ".csv", ".json", ".jsonl", ".log", ".md", ".txt", ".yaml", ".yml",
]);

function copyRekeyedClaudeCompanion(sourceDir, targetDir, mapping) {
  fs.mkdirSync(targetDir, { mode: 0o700 });
  for (const entry of fs.readdirSync(sourceDir, { withFileTypes: true })) {
    const sourcePath = path.join(sourceDir, entry.name);
    const targetPath = path.join(
      targetDir,
      replaceClaudeTranscriptIdentifiers(entry.name, mapping),
    );
    const stat = fs.lstatSync(sourcePath);
    if (stat.isSymbolicLink()) {
      throw new Error("Managed Claude session companion contains a symbolic link.");
    }
    if (stat.isDirectory()) {
      copyRekeyedClaudeCompanion(sourcePath, targetPath, mapping);
    } else if (stat.isFile()) {
      const extension = path.extname(entry.name).toLowerCase();
      if (COMPANION_TEXT_EXTENSIONS.has(extension)) {
        const fd = fs.openSync(targetPath, "wx", stat.mode & 0o777);
        try {
          let position = 0;
          for (const source of readFileLines(sourcePath, { end: stat.size })) {
            position += source.length;
            const newline = position < stat.size;
            if (newline) position += 1;
            const original = extension === ".jsonl" ? stripClaudeTranscriptThinkingBytes(source) : source;
            // A Latin-1 byte view preserves captured tool output, including
            // invalid UTF-8. Identifier tokens cannot cross a line boundary.
            const rewritten = replaceClaudeTranscriptIdentifiers(original.toString("latin1"), mapping);
            fs.writeFileSync(fd, Buffer.from(rewritten + (newline ? "\n" : ""), "latin1"));
          }
        } finally {
          fs.closeSync(fd);
        }
      } else {
        fs.copyFileSync(sourcePath, targetPath, fs.constants.COPYFILE_EXCL);
      }
    } else {
      throw new Error("Managed Claude session companion contains an unsupported file.");
    }
  }
}

export function stageManagedClaudeSessionFork({ session, targetConfigDir }) {
  const sourcePath = typeof session?.transcriptPath === "string"
    ? path.resolve(session.transcriptPath)
    : null;
  const expectedSessionId = typeof session?.threadId === "string"
    ? session.threadId.toLowerCase()
    : null;
  const resolvedTargetConfigDir = typeof targetConfigDir === "string"
    ? path.resolve(targetConfigDir)
    : null;
  if (
    !sourcePath
    || !resolvedTargetConfigDir
    || path.extname(sourcePath) !== ".jsonl"
    || (expectedSessionId && !SESSION_ID_PATTERN.test(expectedSessionId))
  ) {
    throw new Error("Cannot stage an invalid managed Claude session fork.");
  }

  let sourceStat;
  try {
    sourceStat = fs.lstatSync(sourcePath);
  } catch {
    throw new Error("Could not read the managed Claude source transcript.");
  }
  if (!sourceStat.isFile() || sourceStat.isSymbolicLink()) {
    throw new Error("Managed Claude source transcript is not a safe regular file.");
  }
  const stagedSessionId = randomUUID();
  let sourceSessionId;

  const projectName = path.basename(path.dirname(sourcePath));
  if (!projectName || projectName === "." || projectName === path.sep) {
    throw new Error("Managed Claude source transcript has an invalid project directory.");
  }
  const targetProjectsRoot = path.join(resolvedTargetConfigDir, "projects");
  const targetProjectDir = path.join(targetProjectsRoot, projectName);
  const targetTranscriptPath = path.join(targetProjectDir, `${stagedSessionId}.jsonl`);
  const targetCompanionPath = path.join(targetProjectDir, stagedSessionId);
  const targetMarkerPath = path.join(
    targetProjectDir,
    `${stagedSessionId}${STAGED_FORK_MARKER_SUFFIX}`,
  );
  if (
    fs.existsSync(targetTranscriptPath)
    || fs.existsSync(targetCompanionPath)
    || fs.existsSync(targetMarkerPath)
  ) {
    throw new Error(
      `Claude staging ID ${stagedSessionId} already exists in the selected destination account.`,
    );
  }

  let projectDirectoryCreated = false;
  let markerCreated = false;
  let transcriptCreated = false;
  let companionCreated = false;
  const cleanup = () => {
    let failed = false;
    try {
      if (companionCreated && fs.existsSync(targetCompanionPath)) {
        fs.rmSync(targetCompanionPath, { recursive: true });
      }
      companionCreated = false;
    } catch {
      failed = true;
    }
    try {
      if (transcriptCreated && fs.existsSync(targetTranscriptPath)) {
        fs.unlinkSync(targetTranscriptPath);
      }
      transcriptCreated = false;
    } catch {
      failed = true;
    }
    try {
      if (markerCreated && fs.existsSync(targetMarkerPath)) {
        fs.unlinkSync(targetMarkerPath);
      }
      markerCreated = false;
    } catch {
      failed = true;
    }
    if (projectDirectoryCreated) {
      try {
        fs.rmdirSync(targetProjectDir);
        projectDirectoryCreated = false;
      } catch (error) {
        if (error?.code !== "ENOTEMPTY") failed = true;
      }
    }
    if (failed) {
      throw new Error("Could not clean the staged Claude session fork.");
    }
  };

  try {
    if (!fs.existsSync(targetProjectDir)) {
      fs.mkdirSync(targetProjectDir, { recursive: true });
      projectDirectoryCreated = true;
    }
    fs.writeFileSync(targetMarkerPath, "", { flag: "wx", mode: 0o600 });
    markerCreated = true;
    const rekeyed = rekeyClaudeTranscriptFile({ sourcePath, targetPath: targetTranscriptPath,
      expectedSessionId, stagedSessionId });
    transcriptCreated = true;
    sourceSessionId = rekeyed.sourceSessionId;
    const sourceCompanionPath = path.join(path.dirname(sourcePath), sourceSessionId);

    if (fs.existsSync(sourceCompanionPath)) {
      const companionStat = fs.lstatSync(sourceCompanionPath);
      if (!companionStat.isDirectory() || companionStat.isSymbolicLink()) {
        throw new Error("Managed Claude session companion is not a safe directory.");
      }
      companionCreated = true;
      copyRekeyedClaudeCompanion(sourceCompanionPath, targetCompanionPath, rekeyed.mapping);
    }

    const sourceStatAfter = fs.lstatSync(sourcePath);
    if (
      !sourceStatAfter.isFile()
      || sourceStatAfter.isSymbolicLink()
      || sourceStatAfter.dev !== sourceStat.dev
      || sourceStatAfter.ino !== sourceStat.ino
      || sourceStatAfter.size !== sourceStat.size
      || sourceStatAfter.mtimeMs !== sourceStat.mtimeMs
    ) {
      throw new Error("Managed Claude source transcript changed while staging the fork.");
    }
  } catch (error) {
    try {
      cleanup();
    } catch {
      throw new Error("Claude session fork staging failed and could not be cleaned safely.");
    }
    if (error?.message?.startsWith("Managed Claude") || error?.message?.startsWith("Claude source transcript")) throw error;
    throw new Error("Could not stage the managed Claude session fork.");
  }

  return Object.freeze({
    stagedSessionId,
    sourceSessionId,
    targetMarkerPath,
    targetTranscriptPath,
    targetCompanionPath: companionCreated ? targetCompanionPath : null,
    cleanup,
  });
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
