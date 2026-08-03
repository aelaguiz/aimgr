import fs from "node:fs";
import path from "node:path";
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
const INVALID_JSON_LINE = Symbol("invalid-json-line");
const JSON_LINE_BREAK = 10;
// Search raw bytes first so listing does not decode or parse transcript message bodies.
// Every hit is still validated by parsing its complete containing JSONL record.
const SESSION_JSON_MARKERS = Object.freeze({
  cwd: Buffer.from('"cwd"'),
  timestamp: Buffer.from('"timestamp"'),
  customTitle: Buffer.from('"customTitle"'),
  aiTitle: Buffer.from('"aiTitle"'),
  effort: Buffer.from('"effort"'),
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

function parseJsonLineAt(content, markerIndex, cache) {
  const start = content.lastIndexOf(JSON_LINE_BREAK, markerIndex - 1) + 1;
  if (cache.has(start)) return { start, entry: cache.get(start) };
  const newlineIndex = content.indexOf(JSON_LINE_BREAK, markerIndex);
  const end = newlineIndex < 0 ? content.length : newlineIndex;
  let entry;
  try {
    entry = JSON.parse(content.toString("utf8", start, end));
  } catch {
    entry = INVALID_JSON_LINE;
  }
  cache.set(start, entry);
  return { start, entry };
}

function findLatestSessionValue(content, marker, cache, selectValue) {
  let searchBefore = content.length;
  while (searchBefore > 0) {
    const markerIndex = content.lastIndexOf(marker, searchBefore - 1);
    if (markerIndex < 0) return null;
    const { start, entry } = parseJsonLineAt(content, markerIndex, cache);
    if (entry !== INVALID_JSON_LINE) {
      const value = selectValue(entry);
      if (value !== undefined) return value;
    }
    searchBefore = start;
  }
  return null;
}

function parseSessionFile({ filePath, account, threadId, fallbackTimestampMs }) {
  let content;
  try {
    content = fs.readFileSync(filePath);
  } catch {
    throw new Error("Could not read managed Claude sessions.");
  }

  const parsedLines = new Map();
  const cwd = findLatestSessionValue(content, SESSION_JSON_MARKERS.cwd, parsedLines, (entry) => (
    typeof entry?.cwd === "string" && path.isAbsolute(entry.cwd)
      ? path.normalize(entry.cwd)
      : undefined
  ));
  const lastUsedMs = findLatestSessionValue(
    content,
    SESSION_JSON_MARKERS.timestamp,
    parsedLines,
    (entry) => {
      const timestampMs = Date.parse(String(entry?.timestamp ?? ""));
      return Number.isFinite(timestampMs) ? timestampMs : undefined;
    },
  );
  const customTitle = findLatestSessionValue(
    content,
    SESSION_JSON_MARKERS.customTitle,
    parsedLines,
    (entry) => {
      if (entry?.type !== "custom-title" || !Object.hasOwn(entry, "customTitle")) {
        return undefined;
      }
      return normalizeThreadName(entry.customTitle) ?? undefined;
    },
  );
  const aiTitle = customTitle ? null : findLatestSessionValue(
    content,
    SESSION_JSON_MARKERS.aiTitle,
    parsedLines,
    (entry) => {
      if (entry?.type !== "ai-title" || !Object.hasOwn(entry, "aiTitle")) {
        return undefined;
      }
      return normalizeThreadName(entry.aiTitle) ?? undefined;
    },
  );
  const runtime = findLatestSessionValue(content, SESSION_JSON_MARKERS.effort, parsedLines, (entry) => {
    const observedModel = typeof entry?.message?.model === "string"
      ? entry.message.model.trim()
      : "";
    const observedEffort = typeof entry?.effort === "string"
      ? entry.effort.trim().toLowerCase()
      : "";
    return entry?.type === "assistant"
      && entry?.isSidechain !== true
      && SESSION_MODEL_PATTERN.test(observedModel)
      && SESSION_EFFORT_LEVELS.has(observedEffort)
      ? { model: observedModel, effort: observedEffort }
      : undefined;
  });
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
    model: runtime?.model ?? null,
    effort: runtime?.effort ?? null,
    transcriptPath: filePath,
    lastUsedAt: new Date(observedAtMs).toISOString(),
    lastUsedMs: observedAtMs,
  };
}

function compareSessions(left, right) {
  return right.lastUsedMs - left.lastUsedMs
    || left.threadId.localeCompare(right.threadId);
}

function discoverManagedClaudeSessionCandidates({ homeDir }) {
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
    const projectsRoot = path.join(homesRoot, labelEntry.name, ".claude", "projects");
    for (const projectEntry of readDirectory(projectsRoot, { missingIsEmpty: true })) {
      if (!projectEntry.isDirectory() || projectEntry.isSymbolicLink()) continue;
      const projectDir = path.join(projectsRoot, projectEntry.name);
      for (const fileEntry of readDirectory(projectDir)) {
        if (!fileEntry.isFile() || !fileEntry.name.endsWith(".jsonl")) continue;
        const threadId = fileEntry.name.slice(0, -".jsonl".length);
        if (!SESSION_ID_PATTERN.test(threadId)) continue;
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

export function readManagedClaudeSessions({ homeDir }) {
  return discoverManagedClaudeSessionCandidates({ homeDir })
    .map(parseSessionCandidate)
    .filter(Boolean)
    .sort(compareSessions);
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

export function resolveManagedClaudeSession({ homeDir, selector }) {
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
    const matches = discoverManagedClaudeSessionCandidates({ homeDir })
      .filter((candidate) => candidate.threadId === value.toLowerCase())
      .map(parseSessionCandidate)
      .filter(Boolean);
    if (matches.length > 1) {
      throw new Error(`Claude thread ID ${value} exists under more than one managed account.`);
    }
    selected = matches[0] ?? null;
  }
  if (!selected && !/^\d+$/.test(value)) {
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
  const account = normalizeLabel(session?.account);
  const threadId = String(session?.threadId ?? "").toLowerCase();
  if (!SESSION_ID_PATTERN.test(threadId)) {
    throw new Error("Cannot fork an invalid managed Claude thread ID.");
  }
  const title = normalizeThreadName(session?.threadName) ?? threadId;
  return `[fork from ${account}/${threadId.slice(0, 8)}] ${title}`;
}

export function stageManagedClaudeSessionFork({ session, targetConfigDir }) {
  const sourcePath = typeof session?.transcriptPath === "string"
    ? path.resolve(session.transcriptPath)
    : null;
  const threadId = String(session?.threadId ?? "").toLowerCase();
  const resolvedTargetConfigDir = typeof targetConfigDir === "string"
    ? path.resolve(targetConfigDir)
    : null;
  if (
    !sourcePath
    || !resolvedTargetConfigDir
    || !SESSION_ID_PATTERN.test(threadId)
    || path.basename(sourcePath) !== `${threadId}.jsonl`
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

  const projectName = path.basename(path.dirname(sourcePath));
  if (!projectName || projectName === "." || projectName === path.sep) {
    throw new Error("Managed Claude source transcript has an invalid project directory.");
  }
  const targetProjectsRoot = path.join(resolvedTargetConfigDir, "projects");
  const targetProjectDir = path.join(targetProjectsRoot, projectName);
  const targetTranscriptPath = path.join(targetProjectDir, `${threadId}.jsonl`);
  const sourceCompanionPath = path.join(path.dirname(sourcePath), threadId);
  const targetCompanionPath = path.join(targetProjectDir, threadId);
  const targetMarkerPath = path.join(
    targetProjectDir,
    `${threadId}${STAGED_FORK_MARKER_SUFFIX}`,
  );
  if (
    fs.existsSync(targetTranscriptPath)
    || fs.existsSync(targetCompanionPath)
    || fs.existsSync(targetMarkerPath)
  ) {
    throw new Error(
      `Claude session ${threadId} already exists in the selected destination account.`,
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
    fs.copyFileSync(sourcePath, targetTranscriptPath, fs.constants.COPYFILE_EXCL);
    transcriptCreated = true;

    if (fs.existsSync(sourceCompanionPath)) {
      const companionStat = fs.lstatSync(sourceCompanionPath);
      if (!companionStat.isDirectory() || companionStat.isSymbolicLink()) {
        throw new Error("Managed Claude session companion is not a safe directory.");
      }
      companionCreated = true;
      fs.cpSync(sourceCompanionPath, targetCompanionPath, {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
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
    if (error?.message?.startsWith("Managed Claude")) throw error;
    throw new Error("Could not stage the managed Claude session fork.");
  }

  return Object.freeze({
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
