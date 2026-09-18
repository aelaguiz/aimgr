import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { resolveSqlite3Command } from "../io/process.js";

// Codex thread and rollout helpers.
//
// A Codex "thread" is one JSONL rollout file:
//   <codexHome>/sessions/YYYY/MM/DD/rollout-<local wallclock>-<thread-id>.jsonl
// `thread/revert` keeps the thread id and adds `_<rollout-id>` to the basename.
// Cold rollouts may be compressed to `<name>.jsonl.zst`.
//
// These helpers only locate and read rollouts. The identifier rewrite lives in
// codex-thread-copy.js.

export const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
export const CODEX_SESSIONS_SUBDIR = "sessions";
export const CODEX_ARCHIVED_SESSIONS_SUBDIR = "archived_sessions";
const HEADER_READ_BYTES = 512 * 1024;

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

function readFirstLine(filePath, { fsImpl = fs } = {}) {
  let fd = null;
  try {
    fd = fsImpl.openSync(filePath, "r");
    const buffer = Buffer.alloc(HEADER_READ_BYTES);
    const read = fsImpl.readSync(fd, buffer, 0, HEADER_READ_BYTES, 0);
    const raw = buffer.subarray(0, read).toString("utf8");
    const newline = raw.indexOf("\n");
    return newline === -1 ? raw : raw.slice(0, newline);
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  } finally {
    if (fd !== null) fsImpl.closeSync(fd);
  }
}

/**
 * Read a rollout header. Only the first line is read: a rollout can be gigabytes
 * long, and the header is always line 0.
 */
export function readRolloutMeta(filePath, { fsImpl = fs } = {}) {
  const first = readFirstLine(filePath, { fsImpl });
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
  return highestVersionedDb({ codexHome, prefix: "state", fsImpl });
}

export function resolveCodexGoalsDbPath({ codexHome, fsImpl = fs } = {}) {
  return highestVersionedDb({ codexHome, prefix: "goals", fsImpl });
}

function highestVersionedDb({ codexHome, prefix, fsImpl = fs } = {}) {
  let entries = [];
  try {
    entries = fsImpl.readdirSync(codexHome, { withFileTypes: true });
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
  const pattern = new RegExp(`^${prefix}_(\\d+)\\.sqlite$`);
  const candidates = entries
    .filter((entry) => entry.isFile() && pattern.test(entry.name))
    .map((entry) => ({ name: entry.name, version: Number(entry.name.match(pattern)[1]) }))
    .sort((a, b) => b.version - a.version);
  return candidates.length > 0 ? path.join(codexHome, candidates[0].name) : null;
}

function querySqlite({ command, dbPath, sql, spawnSyncImpl }) {
  const result = spawnSyncImpl(command, ["-readonly", "-noheader", "-separator", "\t", dbPath, sql], { encoding: "utf8" });
  if (result?.error) throw new Error(`Failed to run sqlite3 for ${dbPath}: ${String(result.error.message ?? result.error)}`);
  if (result?.status !== 0) {
    throw new Error(`Failed to query sqlite3 for ${dbPath}: ${String(result?.stderr ?? "").trim() || `exit ${result?.status}`}`);
  }
  return String(result?.stdout ?? "");
}

function firstLineValue(output) {
  return output.split("\n").map((line) => line.trim()).filter(Boolean)[0] ?? "";
}

function escapeSqlString(value) {
  return String(value ?? "").replace(/'/g, "''");
}

/** Ask the Codex state DB for a thread's rollout path. */
export function readStateDbRolloutPath({ codexHome, threadId, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(id)) return null;
  const value = firstLineValue(querySqlite({
    command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
    dbPath,
    sql: `select rollout_path from threads where id = '${escapeSqlString(id)}' limit 1;`,
    spawnSyncImpl,
  }));
  return value ? { path: value, sqlite: true } : null;
}

/** Most recent thread id for a working directory, from the state DB. */
export function readMostRecentThreadIdForCwd({ codexHome, cwd, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const escaped = escapeSqlString(cwd);
  if (!escaped) return null;
  const value = firstLineValue(querySqlite({
    command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
    dbPath,
    sql: "select id from threads where cwd = '" + escaped + "' and archived_at is null "
      + "order by coalesce(recency_at, updated_at, created_at) desc limit 1;",
    spawnSyncImpl,
  }));
  return isCodexSessionId(value) ? value.toLowerCase() : null;
}

/** How many subagents the thread spawned, per the state DB. */
export function countSpawnedSubagents({ codexHome, threadId, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return null;
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(id)) return null;
  try {
    const value = Number(firstLineValue(querySqlite({
      command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
      dbPath,
      sql: `select count(*) from thread_spawn_edges where parent_thread_id = '${escapeSqlString(id)}';`,
      spawnSyncImpl,
    })));
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

/** The child thread ids the thread spawned, per the state DB (empty when unknown). */
export function listSpawnedSubagentIds({ codexHome, threadId, spawnSyncImpl, homeDir, fsImpl = fs } = {}) {
  const dbPath = resolveCodexStateDbPath({ codexHome, fsImpl });
  if (!dbPath || typeof spawnSyncImpl !== "function") return [];
  const id = String(threadId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(id)) return [];
  try {
    const output = querySqlite({
      command: resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl }),
      dbPath,
      sql: `select child_thread_id from thread_spawn_edges where parent_thread_id = '${escapeSqlString(id)}';`,
      spawnSyncImpl,
    });
    return output
      .split("\n")
      .map((line) => line.trim().toLowerCase())
      .filter((line) => isCodexSessionId(line) && line !== id);
  } catch {
    return [];
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
  return { status: "missing", threadId: normalized, staleRolloutPath: dbHit?.path ?? null };
}

/** Read a compressed rollout through `zstd -d`. Used only for `.zst` sources. */
export function openCompressedRollout(filePath) {
  return spawn("zstd", ["-dc", filePath], { stdio: ["ignore", "pipe", "ignore"] }).stdout;
}
