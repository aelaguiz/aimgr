import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { spawn } from "node:child_process";
import { resolveSqlite3Command } from "../io/process.js";

// Codex thread and rollout helpers.
//
// A Codex "thread" is one JSONL rollout file:
//   <codexHome>/sessions/YYYY/MM/DD/rollout-<local wallclock>-<thread-id>.jsonl
// `thread/revert` keeps the thread id and adds `_<rollout-id>` to the basename.
// Cold rollouts may be compressed to `<name>.jsonl.zst`.
//
// These helpers only read and locate rollouts. The identifier rewrite lives in
// codex-thread-copy.js.

export const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const CODEX_SESSIONS_SUBDIR = "sessions";
export const CODEX_ARCHIVED_SESSIONS_SUBDIR = "archived_sessions";

export function isCodexSessionId(value) {
  return CODEX_SESSION_ID_PATTERN.test(String(value ?? "").trim());
}

export function resolveCodexSessionsDir({ codexHome }) {
  return path.join(codexHome, CODEX_SESSIONS_SUBDIR);
}

export function resolveCodexArchivedSessionsDir({ codexHome }) {
  return path.join(codexHome, CODEX_ARCHIVED_SESSIONS_SUBDIR);
}

export function codexRolloutRoots({ codexHome }) {
  return [
    { archived: false, dir: resolveCodexSessionsDir({ codexHome }) },
    { archived: true, dir: resolveCodexArchivedSessionsDir({ codexHome }) },
  ];
}

/** Parse `rollout-<ts>-<threadId>[_<rolloutId>].jsonl[.zst]`. */
export function parseRolloutFileName(name) {
  const base = path.basename(String(name ?? ""));
  const plain = base.endsWith(".zst") ? base.slice(0, -".zst".length) : base;
  if (!plain.startsWith("rollout-") || !plain.endsWith(".jsonl")) return null;
  const core = plain.slice("rollout-".length, -".jsonl".length);
  const stamp = core.slice(0, 19);
  if (core.slice(19, 20) !== "-") return null;
  const ids = core.slice(20);
  const [threadId, rolloutId] = ids.includes("_") ? ids.split("_", 2) : [ids, ids];
  if (!isCodexSessionId(threadId)) return null;
  return {
    fileName: base,
    compressed: base.endsWith(".zst"),
    threadId: threadId.toLowerCase(),
    rolloutId: isCodexSessionId(rolloutId) ? rolloutId.toLowerCase() : threadId.toLowerCase(),
    timestamp: stamp,
  };
}

function listDayDirectories(dir, { fsImpl = fs } = {}) {
  let years = [];
  try {
    years = fsImpl.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const days = [];
  for (const year of years) {
    if (!year.isDirectory()) continue;
    const yearPath = path.join(dir, year.name);
    for (const month of fsImpl.readdirSync(yearPath, { withFileTypes: true })) {
      if (!month.isDirectory()) continue;
      const monthPath = path.join(yearPath, month.name);
      for (const day of fsImpl.readdirSync(monthPath, { withFileTypes: true })) {
        if (!day.isDirectory()) continue;
        days.push(path.join(monthPath, day.name));
      }
    }
  }
  // Newest first: rollout directories are date-named, so a reverse sort finds
  // recent threads without walking the whole tree.
  return days.sort().reverse();
}

function listRolloutFilesInDay(dayDir, { fsImpl = fs } = {}) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(dayDir, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const parsed = parseRolloutFileName(entry.name);
    if (!parsed) continue;
    files.push({ ...parsed, path: path.join(dayDir, entry.name) });
  }
  return files;
}

/** Locate the newest rollout file owned by a thread id, without SQLite. */
export function findRolloutPathById({ codexHome, threadId, fsImpl = fs } = {}) {
  const wanted = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(wanted)) return null;
  for (const root of codexRolloutRoots({ codexHome })) {
    for (const dayDir of listDayDirectories(root.dir, { fsImpl })) {
      const match = listRolloutFilesInDay(dayDir, { fsImpl })
        .filter((file) => file.threadId === wanted)
        .sort((a, b) => b.fileName.localeCompare(a.fileName))[0];
      if (match) return { path: match.path, archived: root.archived, fileName: match.fileName };
    }
  }
  return null;
}

/** Every rollout file for one thread id (thread/revert can leave several). */
export function listRolloutPathsForThreadId({ codexHome, threadId, fsImpl = fs, includeArchived = true } = {}) {
  const wanted = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(wanted)) return [];
  const found = [];
  for (const root of codexRolloutRoots({ codexHome })) {
    if (root.archived && !includeArchived) continue;
    for (const dayDir of listDayDirectories(root.dir, { fsImpl })) {
      for (const file of listRolloutFilesInDay(dayDir, { fsImpl })) {
        if (file.threadId === wanted) found.push({ path: file.path, archived: root.archived, fileName: file.fileName });
      }
    }
  }
  return found.sort((a, b) => b.fileName.localeCompare(a.fileName));
}

export function listRolloutFiles({ codexHome, fsImpl = fs, limit = Number.POSITIVE_INFINITY } = {}) {
  const files = [];
  for (const root of codexRolloutRoots({ codexHome })) {
    for (const dayDir of listDayDirectories(root.dir, { fsImpl })) {
      for (const file of listRolloutFilesInDay(dayDir, { fsImpl })) {
        files.push({ ...file, archived: root.archived });
        if (files.length >= limit) return files;
      }
    }
  }
  return files;
}

function openRolloutReadStream(filePath, { fsImpl = fs } = {}) {
  if (!filePath.endsWith(".zst")) return fsImpl.createReadStream(filePath);
  // Compressed rollouts are read through `zstd -d`; the plain path is the
  // normal case and never pays this cost.
  const child = spawn("zstd", ["-dc", filePath], { stdio: ["ignore", "pipe", "ignore"] });
  return child.stdout;
}

/** Stream a rollout file line by line, for any representation. */
export async function forEachRolloutLine(filePath, onLine, { fsImpl = fs } = {}) {
  const stream = openRolloutReadStream(filePath, { fsImpl });
  const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of rl) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const stop = await onLine(trimmed);
      if (stop === false) break;
    }
  } finally {
    rl.close();
    stream.destroy?.();
  }
}

export function readCompleteJsonlRecords(filePath, { offset = 0, fsImpl = fs } = {}) {
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, "r");
    const stat = fsImpl.fstatSync(fd);
    const start = Math.max(0, Math.min(Number(offset) || 0, stat.size));
    const length = stat.size - start;
    if (length <= 0) return { records: [], nextOffset: stat.size };
    const buffer = Buffer.alloc(length);
    fsImpl.readSync(fd, buffer, 0, length, start);
    let raw = buffer.toString("utf8");
    let nextOffset = stat.size;
    if (!raw.endsWith("\n")) {
      const lastNewline = raw.lastIndexOf("\n");
      if (lastNewline === -1) return { records: [], nextOffset: start };
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
        // Ignore a partially written final record; callers only read the head.
      }
    }
    return { records, nextOffset };
  } catch (err) {
    if (err?.code === "ENOENT") return { records: [], nextOffset: 0 };
    throw err;
  } finally {
    if (fd !== null) fsImpl.closeSync(fd);
  }
}

export function readRolloutMeta(filePath, { fsImpl = fs } = {}) {
  const { records } = readCompleteJsonlRecords(filePath, { fsImpl });
  const first = records[0] ?? null;
  if (first?.type !== "session_meta") return null;
  const payload = first.payload ?? {};
  return {
    id: String(payload.id ?? "").trim().toLowerCase(),
    sessionId: String(payload.session_id ?? payload.sessionId ?? payload.id ?? "").trim().toLowerCase(),
    historyMode: String(payload.history_mode ?? payload.historyMode ?? "legacy").trim().toLowerCase(),
    forkedFromId: payload.forked_from_id ?? null,
    parentThreadId: payload.parent_thread_id ?? null,
    historyBase: payload.history_base ?? null,
    source: payload.source ?? null,
    cwd: String(payload.cwd ?? "").trim(),
    originator: String(payload.originator ?? "").trim(),
    raw: payload,
  };
}

export async function readRolloutMetaAsync(filePath, { fsImpl = fs } = {}) {
  let first = null;
  await forEachRolloutLine(filePath, (line) => {
    first = line;
    return false;
  }, { fsImpl });
  if (!first) return null;
  let parsed = null;
  try {
    parsed = JSON.parse(first);
  } catch {
    return null;
  }
  if (parsed?.type !== "session_meta") return null;
  const payload = parsed.payload ?? {};
  return {
    id: String(payload.id ?? "").trim().toLowerCase(),
    sessionId: String(payload.session_id ?? payload.sessionId ?? payload.id ?? "").trim().toLowerCase(),
    historyMode: String(payload.history_mode ?? payload.historyMode ?? "legacy").trim().toLowerCase(),
    forkedFromId: payload.forked_from_id ?? null,
    parentThreadId: payload.parent_thread_id ?? null,
    historyBase: payload.history_base ?? null,
    source: payload.source ?? null,
    cwd: String(payload.cwd ?? "").trim(),
    originator: String(payload.originator ?? "").trim(),
    raw: payload,
  };
}

/** Highest-numbered `state_<n>.sqlite` in the Codex home, if any. */
export function resolveCodexStateDbPath({ codexHome, fsImpl = fs } = {}) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(codexHome, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^state_\d+\.sqlite$/.test(entry.name))
    .map((entry) => ({ name: entry.name, version: Number(entry.name.match(/^state_(\d+)\.sqlite$/)[1]) }))
    .sort((a, b) => b.version - a.version);
  return candidates.length > 0 ? path.join(codexHome, candidates[0].name) : null;
}

export function resolveCodexGoalsDbPath({ codexHome, fsImpl = fs } = {}) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(codexHome, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const candidates = entries
    .filter((entry) => entry.isFile() && /^goals_\d+\.sqlite$/.test(entry.name))
    .map((entry) => ({ name: entry.name, version: Number(entry.name.match(/^goals_(\d+)\.sqlite$/)[1]) }))
    .sort((a, b) => b.version - a.version);
  return candidates.length > 0 ? path.join(codexHome, candidates[0].name) : null;
}

function spawnSqliteSync({ command, dbPath, sql, spawnSyncImpl }) {
  const args = ["-readonly", "-noheader", "-separator", "\t", dbPath, sql];
  const result = spawnSyncImpl(command, args, { encoding: "utf8" });
  if (result?.error) throw new Error(`Failed to run sqlite3 for ${dbPath}: ${String(result.error.message ?? result.error)}`);
  if (result?.status !== 0) {
    throw new Error(`Failed to query sqlite3 for ${dbPath}: ${String(result?.stderr ?? "").trim() || `exit ${result?.status}`}`);
  }
  return String(result?.stdout ?? "");
}

/** Ask the Codex state DB for a thread's rollout path. */
export function readStateDbRolloutPath({ codexHome, threadId, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(id)) return null;
  const sql = `select rollout_path from threads where id = '${id}' limit 1;`;
  const out = spawnSqliteSync({
    command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
    dbPath,
    sql,
    spawnSyncImpl,
  });
  const value = out.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  return value ? { path: value, sqlite: true } : null;
}

/** Most recent thread id for a working directory, from the state DB. */
export function readMostRecentThreadIdForCwd({ codexHome, cwd, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const escaped = String(cwd ?? "").replace(/'/g, "''");
  if (!escaped) return null;
  const sql =
    "select id from threads where cwd = '" + escaped + "' and archived_at is null "
    + "order by coalesce(recency_at, updated_at, created_at) desc limit 1;";
  const out = spawnSqliteSync({
    command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
    dbPath,
    sql,
    spawnSyncImpl,
  });
  const value = out.split("\n").map((line) => line.trim()).filter(Boolean)[0];
  return isCodexSessionId(value) ? value.toLowerCase() : null;
}

export function hasSpawnedSubagents({ codexHome, threadId, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(id)) return null;
  const sql = `select count(*) from thread_spawn_edges where parent_thread_id = '${id}';`;
  try {
    const out = spawnSqliteSync({
      command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
      dbPath,
      sql,
      spawnSyncImpl,
    });
    const value = Number(out.trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Resolve one thread id to its rollout file.
 *
 * Mirrors Codex's own order: the state DB row first, then a filename scan. A
 * thread with no row is resolvable (Codex read-repairs the row on resume).
 */
export function resolveRolloutForThreadId({
  codexHome,
  threadId,
  fsImpl = fs,
  spawnSyncImpl,
  homeDir,
  includeArchived = true,
} = {}) {
  const normalized = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(normalized)) {
    return { status: "invalid", threadId: String(threadId ?? "") };
  }
  const dbHit = readStateDbRolloutPath({ codexHome, threadId: normalized, spawnSyncImpl, homeDir, fsImpl });
  if (dbHit) {
    const exists = fsImpl.existsSync(dbHit.path) || fsImpl.existsSync(`${dbHit.path}.zst`);
    if (exists) {
      const meta = readRolloutMeta(dbHit.path, { fsImpl });
      if (!meta || meta.id === normalized) {
        return { status: "found", threadId: normalized, rolloutPath: dbHit.path, meta, source: "state-db" };
      }
    }
  }
  const fileHit = findRolloutPathById({ codexHome, threadId: normalized, fsImpl });
  if (fileHit && (!fileHit.archived || includeArchived)) {
    const meta = readRolloutMeta(fileHit.path, { fsImpl });
    if (meta?.id === normalized) {
      return { status: "found", threadId: normalized, rolloutPath: fileHit.path, meta, source: "filename" };
    }
  }
  const stale = dbHit?.path ?? null;
  return { status: "missing", threadId: normalized, staleRolloutPath: stale };
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
