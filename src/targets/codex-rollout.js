import fs from "node:fs";
import path from "node:path";

export const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export function isCodexSessionId(value) {
  return CODEX_SESSION_ID_PATTERN.test(String(value ?? "").trim());
}

function walkFiles(dirPath, predicate, files = []) {
  let entries = [];
  try {
    entries = fs.readdirSync(dirPath, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return files;
    throw err;
  }
  for (const entry of entries) {
    const entryPath = path.join(dirPath, entry.name);
    if (entry.isDirectory()) {
      walkFiles(entryPath, predicate, files);
    } else if (entry.isFile() && predicate(entryPath, entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

export function listRolloutFiles(sessionsDir) {
  return walkFiles(sessionsDir, (_filePath, name) => /^rollout-.*\.jsonl$/.test(name)).sort();
}

export function readCompleteJsonlRecords(filePath, { offset = 0 } = {}) {
  let fd = null;
  try {
    fd = fs.openSync(filePath, "r");
    const stat = fs.fstatSync(fd);
    const start = Math.max(0, Math.min(Number(offset) || 0, stat.size));
    const length = stat.size - start;
    if (length <= 0) {
      return { records: [], nextOffset: stat.size };
    }
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, start);
    let raw = buffer.toString("utf8");
    let nextOffset = stat.size;
    if (!raw.endsWith("\n")) {
      const lastNewline = raw.lastIndexOf("\n");
      if (lastNewline === -1) {
        return { records: [], nextOffset: start };
      }
      const completeBytes = Buffer.byteLength(raw.slice(0, lastNewline + 1), "utf8");
      raw = raw.slice(0, lastNewline + 1);
      nextOffset = start + completeBytes;
    }
    const records = [];
    for (const line of raw.split(/\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        records.push(JSON.parse(trimmed));
      } catch {
        // Ignore corrupt or partially-written records; complete future records can still be read.
      }
    }
    return { records, nextOffset };
  } catch (err) {
    if (err?.code === "ENOENT") {
      return { records: [], nextOffset: 0 };
    }
    throw err;
  } finally {
    if (fd !== null) fs.closeSync(fd);
  }
}

export function readRolloutMeta(filePath) {
  const { records } = readCompleteJsonlRecords(filePath);
  const first = records[0] ?? null;
  if (first?.type !== "session_meta") return null;
  const payload = first.payload ?? {};
  return {
    id: String(payload.id ?? "").trim(),
    originator: String(payload.originator ?? "").trim(),
    source: String(payload.source ?? "").trim(),
    threadSource: String(payload.thread_source ?? payload.threadSource ?? "").trim(),
    raw: payload,
  };
}

export function goalFromRecord(record) {
  if (record?.type !== "event_msg") return null;
  const payload = record.payload ?? {};
  const payloadType = String(payload.type ?? "");
  if (!payloadType.startsWith("thread_goal_")) return null;
  const goal = payload.goal ?? null;
  if (!goal || typeof goal !== "object") return null;
  return {
    ...goal,
    threadId: payload.threadId ?? payload.thread_id ?? goal.threadId ?? goal.thread_id ?? null,
  };
}

export function latestGoalFromRecords(records, { threadId } = {}) {
  let latest = null;
  for (const record of records) {
    const goal = goalFromRecord(record);
    if (!goal) continue;
    const eventThreadId = String(goal.threadId ?? "").trim();
    if (eventThreadId && threadId && eventThreadId !== threadId) continue;
    latest = goal;
  }
  return latest;
}

function isTopLevelCandidate(meta, { originator } = {}) {
  if (!meta || !isCodexSessionId(meta.id)) return false;
  if (originator && meta.originator !== originator) return false;
  return meta.threadSource === "user" && meta.source === "cli";
}

export function findTaggedGoalRollouts({ sessionsDir, originator, startedAtMs = 0 }) {
  const candidates = [];
  for (const filePath of listRolloutFiles(sessionsDir)) {
    const stat = fs.statSync(filePath);
    if (startedAtMs && stat.mtimeMs < startedAtMs - 1000) {
      const maybeMeta = readRolloutMeta(filePath);
      if (maybeMeta?.originator !== originator) continue;
    }
    const meta = readRolloutMeta(filePath);
    if (!isTopLevelCandidate(meta, { originator })) continue;
    const { records } = readCompleteJsonlRecords(filePath);
    const goal = latestGoalFromRecords(records, { threadId: meta.id });
    if (!goal) continue;
    candidates.push({
      threadId: meta.id,
      rolloutPath: filePath,
      goal,
      meta,
      mtimeMs: stat.mtimeMs,
    });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || a.rolloutPath.localeCompare(b.rolloutPath));
  return candidates;
}

export function resolveOwnedThreadFromRunTag({ sessionsDir, originator, startedAtMs = 0 }) {
  const candidates = findTaggedGoalRollouts({ sessionsDir, originator, startedAtMs });
  if (candidates.length === 0) {
    return { status: "missing", candidates: [] };
  }
  const unique = [];
  for (const candidate of candidates) {
    if (!unique.some((existing) => existing.threadId === candidate.threadId)) {
      unique.push(candidate);
    }
  }
  if (unique.length > 1) {
    return { status: "ambiguous", candidates: unique };
  }
  return { status: "bound", ...unique[0] };
}

export function resolveRolloutForThreadId({ sessionsDir, threadId }) {
  const normalized = String(threadId ?? "").trim();
  if (!isCodexSessionId(normalized)) {
    return { status: "invalid", threadId: normalized };
  }
  const files = listRolloutFiles(sessionsDir);
  const filenameMatches = files.filter((filePath) => path.basename(filePath).endsWith(`-${normalized}.jsonl`));
  for (const filePath of filenameMatches) {
    const meta = readRolloutMeta(filePath);
    if (meta?.id === normalized) {
      return { status: "found", threadId: normalized, rolloutPath: filePath, meta };
    }
  }
  for (const filePath of files) {
    const meta = readRolloutMeta(filePath);
    if (meta?.id === normalized) {
      return { status: "found", threadId: normalized, rolloutPath: filePath, meta };
    }
  }
  return { status: "missing", threadId: normalized };
}

export function tailGoalStatus({ rolloutPath, threadId, offset = 0 }) {
  const result = readCompleteJsonlRecords(rolloutPath, { offset });
  const goal = latestGoalFromRecords(result.records, { threadId });
  return {
    offset: result.nextOffset,
    goal,
    status: goal?.status ?? null,
  };
}
