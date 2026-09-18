import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveSqlite3Command } from "../io/process.js";
import {
  codexRolloutRoots,
  isCodexSessionId,
  readRolloutMeta,
  resolveCodexGoalsDbPath,
  resolveCodexSessionsDir,
  resolveRolloutForThreadId,
} from "./codex-rollout.js";

// Copy one Codex thread into a brand-new, unlinked thread.
//
// The copy retires every identifier the old account ever saw, in two passes:
//   1. scan   - collect every retired id and classify what the file contains
//   2. copy   - rewrite the header, remap ids at any depth, drop server blobs
// A third pass (`verifyCopiedRollout`) scans the written file and fails hard on
// any identifier residue that is not literal conversation content.

export const DROP_ITEM_TYPES = new Set(["reasoning", "compaction", "context_compaction"]);
export const ENCRYPTED_KEYS = new Set(["encrypted_content", "encrypted_function_args"]);
export const DELETED_KEYS = new Set(["compaction_response_id", "response_id"]);
export const PASSTHROUGH_CREATE_TIME_KEY = "create_time";
export const LINEAGE_KEYS = [
  "forked_from_id",
  "forked_from_ordinal_exclusive",
  "parent_thread_id",
  "history_base",
  "subagent_history_start_ordinal",
  "agent_nickname",
  "agent_role",
  "agent_path",
];
export const CONTENT_PATH_PATTERN = /(^|\/)(content|text|summary|message|input|output|arguments|stdout|stderr|aggregated_output|formatted_output|command)(\/|\[|$)/i;
export const MAX_COPY_MB_DEFAULT = 256;

export class CodexThreadCopyError extends Error {
  constructor(message, { code = "thread_copy_failed", details = {} } = {}) {
    super(message);
    this.name = "CodexThreadCopyError";
    this.code = code;
    this.details = details;
  }
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/** Generate a version-7 UUID. Node's `randomUUID` cannot do this (it ignores `{version}`). */
export function generateUuidV7({ nowMs = Date.now(), randomBytesImpl = randomBytes } = {}) {
  const bytes = Buffer.from(randomBytesImpl(10));
  const out = Buffer.alloc(16);
  const timestamp = BigInt(Math.max(0, Math.floor(Number(nowMs) || 0)));
  out[0] = Number((timestamp >> 40n) & 0xffn);
  out[1] = Number((timestamp >> 32n) & 0xffn);
  out[2] = Number((timestamp >> 24n) & 0xffn);
  out[3] = Number((timestamp >> 16n) & 0xffn);
  out[4] = Number((timestamp >> 8n) & 0xffn);
  out[5] = Number(timestamp & 0xffn);
  out[6] = (bytes[0] & 0x0f) | 0x70;
  out[7] = bytes[1];
  out[8] = (bytes[2] & 0x3f) | 0x80;
  out[9] = bytes[3];
  for (let i = 4; i < 10; i += 1) out[i + 6] = bytes[i];
  const hex = out.toString("hex");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function isUuidV7(value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!isCodexSessionId(text)) return false;
  return text[14] === "7" && /[89ab]/.test(text[19]);
}

function randomToken(length, { randomBytesImpl = randomBytes } = {}) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = Buffer.from(randomBytesImpl(Math.max(1, length)));
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i % bytes.length] % alphabet.length];
  return out;
}

/**
 * Rebuild an id with the same prefix and the same suffix shape.
 * `msg_<uuid>` stays a uuid, `rs_<48 hex>` stays 48 hex, `call_<base62>` stays base62.
 */
export function remapIdValue(value, { nowMs, randomBytesImpl } = {}) {
  const text = String(value);
  const underscore = text.indexOf("_");
  if (underscore <= 0 || underscore === text.length - 1) return null;
  const prefix = text.slice(0, underscore);
  const suffix = text.slice(underscore + 1);
  if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(suffix)) {
    return `${prefix}_${generateUuidV7({ nowMs, randomBytesImpl })}`;
  }
  if (/^[0-9a-f]{16,}$/i.test(suffix) && suffix.length % 2 === 0) {
    // Server-issued hex ids vary in length (`rs_` is 50 hex, `ctc_` 48, some are 32).
    // Keep the exact length so the shape looks untouched.
    const wanted = suffix.length;
    let hex = generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
    while (hex.length < wanted) {
      hex += generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
    }
    return `${prefix}_${hex.slice(0, wanted)}`;
  }
  if (/^[0-9a-f]{16,}$/i.test(suffix)) {
    const wanted = suffix.length;
    let hex = generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
    while (hex.length < wanted) {
      hex += generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
    }
    return `${prefix}_${hex.slice(0, wanted)}`;
  }
  return `${prefix}_${randomToken(suffix.length, { randomBytesImpl })}`;
}

const ID_VALUE_PATTERN = /^[A-Za-z]{2,8}_[A-Za-z0-9_-]{8,}$/;

function looksLikeServerId(value) {
  const text = String(value ?? "");
  if (!ID_VALUE_PATTERN.test(text)) return false;
  const [, suffix] = text.split("_", 2);
  return /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(suffix) || /^[0-9a-f]{24,}$/i.test(suffix) || suffix.length >= 8;
}

function timestampNowIso(nowMs) {
  return new Date(nowMs).toISOString();
}

function localDayParts(nowMs) {
  const date = new Date(nowMs);
  const pad = (value) => String(value).padStart(2, "0");
  return {
    year: String(date.getFullYear()),
    month: pad(date.getMonth() + 1),
    day: pad(date.getDate()),
    stamp: `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
      + `T${pad(date.getHours())}-${pad(date.getMinutes())}-${pad(date.getSeconds())}`,
  };
}

/** Plan a copy: resolve the source, refuse unsafe sources, name the target. */
export function planThreadCopy({
  codexHome,
  sourceId,
  nowMs = Date.now(),
  maxCopyMb = MAX_COPY_MB_DEFAULT,
  randomBytesImpl = randomBytes,
  spawnSyncImpl,
  homeDir,
  fsImpl = fs,
} = {}) {
  const resolved = resolveRolloutForThreadId({ codexHome, threadId: sourceId, fsImpl, spawnSyncImpl, homeDir });
  if (resolved.status === "invalid") {
    throw new CodexThreadCopyError(`Not a Codex thread id: ${String(sourceId ?? "").trim()}`, { code: "invalid_thread_id" });
  }
  if (resolved.status !== "found") {
    throw new CodexThreadCopyError(
      `No rollout found for thread ${resolved.threadId}`
      + (resolved.staleRolloutPath ? ` (state DB points at a missing file: ${resolved.staleRolloutPath})` : ""),
      { code: "source_missing", details: { threadId: resolved.threadId, staleRolloutPath: resolved.staleRolloutPath ?? null } },
    );
  }
  const sourcePath = resolved.rolloutPath;
  const meta = resolved.meta ?? readRolloutMeta(sourcePath, { fsImpl });
  if (!meta || meta.id !== resolved.threadId) {
    throw new CodexThreadCopyError(`Rollout at ${sourcePath} does not declare thread id ${resolved.threadId}`, {
      code: "source_mismatch",
    });
  }
  if (meta.historyBase) {
    throw new CodexThreadCopyError(
      "Source thread is a paginated fork segment (history_base); multi-segment copies are not implemented yet",
      { code: "source_multi_segment" },
    );
  }
  if (meta.parentThreadId || isObject(meta.source)) {
    throw new CodexThreadCopyError("Source thread is a subagent thread; only top-level user threads can be carried", {
      code: "source_subagent",
    });
  }
  const stat = fsImpl.statSync(sourcePath);
  const bytes = Number(stat.size);
  const maxBytes = Number(maxCopyMb) > 0 ? Number(maxCopyMb) * 1024 * 1024 : Number.POSITIVE_INFINITY;
  if (bytes > maxBytes) {
    throw new CodexThreadCopyError(
      `Source rollout is ${(bytes / (1024 * 1024)).toFixed(1)} MiB, above the ${maxCopyMb} MiB limit; raise --max-copy-mb to continue`,
      { code: "source_too_large", details: { bytes, maxCopyMb } },
    );
  }
  const newId = generateUuidV7({ nowMs, randomBytesImpl });
  if (newId === resolved.threadId) {
    throw new CodexThreadCopyError("Refusing to reuse the source thread id", { code: "id_collision" });
  }
  const day = localDayParts(nowMs);
  const targetDir = path.join(resolveCodexSessionsDir({ codexHome }), day.year, day.month, day.day);
  const targetPath = path.join(targetDir, `rollout-${day.stamp}-${newId}.jsonl`);
  return {
    sourceId: resolved.threadId,
    sourcePath,
    sourceSource: resolved.source,
    sourceBytes: bytes,
    sourceMtimeMs: Number(stat.mtimeMs),
    meta,
    historyMode: meta.historyMode,
    newId,
    targetDir,
    targetPath,
    nowMs,
    maxCopyMb,
  };
}

function pushUnique(list, seen, value) {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text || seen.has(text)) return;
  seen.add(text);
  list.push(text);
}

/**
 * First pass: collect every retired identifier and the file's composition.
 * Read-only; safe to run for `--dry-run`.
 */
export async function scanThreadRollout({ plan, fsImpl = fs } = {}) {
  const text = fsImpl.readFileSync(plan.sourcePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  const turnIds = [];
  const itemIds = [];
  const responseIds = [];
  const windowIds = [];
  const seenTurn = new Set();
  const seenItem = new Set();
  const seenResponse = new Set();
  const seenWindow = new Set();
  const lineTypes = {};
  let reasoningLines = 0;
  let encryptedBlobs = 0;
  let createTimes = 0;
  let subagentSpawnCount = 0;
  let sessionId = plan.sourceId;

  const visit = (node, keyPath) => {
    if (Array.isArray(node)) {
      for (const entry of node) visit(entry, keyPath);
      return;
    }
    if (!isObject(node)) return;
    const type = typeof node.type === "string" ? node.type : null;
    if (type && DROP_ITEM_TYPES.has(type)) reasoningLines += 1;
    for (const [key, value] of Object.entries(node)) {
      const childPath = keyPath ? `${keyPath}/${key}` : key;
      if (ENCRYPTED_KEYS.has(key) && typeof value === "string") encryptedBlobs += 1;
      if (key === PASSTHROUGH_CREATE_TIME_KEY && keyPath.endsWith("internal_chat_message_metadata_passthrough")) {
        createTimes += 1;
      }
      if (key === "turn_id" || key === "root_turn_id") pushUnique(turnIds, seenTurn, value);
      if (key === "id" || key === "call_id" || key === "item_id") {
        if (typeof value === "string" && looksLikeServerId(value)) pushUnique(itemIds, seenItem, value);
      }
      if (key === "response_id" || key === "compaction_response_id") pushUnique(responseIds, seenResponse, value);
      if (key === "window_id" || key === "first_window_id" || key === "previous_window_id") {
        pushUnique(windowIds, seenWindow, value);
      }
      if (key === "agent_thread_id") pushUnique(itemIds, seenItem, value);
      visit(value, childPath);
    }
  };

  for (const line of lines) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      throw new CodexThreadCopyError(`Corrupt rollout record in ${plan.sourcePath}; refusing to copy blind`, {
        code: "source_corrupt",
      });
    }
    const type = String(record?.type ?? "unknown");
    lineTypes[type] = (lineTypes[type] ?? 0) + 1;
    const payload = record?.payload ?? {};
    if (type === "session_meta") {
      sessionId = String(payload.session_id ?? payload.id ?? plan.sourceId).trim().toLowerCase();
      continue;
    }
    if (type === "event_msg" && typeof payload.type === "string" && payload.type.includes("sub_agent")) {
      subagentSpawnCount += 1;
    }
    visit(payload, type);
  }

  return {
    threadId: plan.sourceId,
    lineCount: lines.length,
    lineTypes,
    sessionId,
    turnIds,
    itemIds,
    responseIds,
    windowIds,
    createTimes,
    encryptedBlobs,
    droppedItemLines: reasoningLines,
    subagentSpawnCount,
    goal: null,
  };
}

function rewriteValue(value, map, { nowMs, randomBytesImpl }) {
  if (typeof value === "string") {
    if (map.has(value)) return map.get(value);
    const lower = value.toLowerCase();
    if (map.has(lower)) return map.get(lower);
    return value;
  }
  return value;
}

/**
 * Rewrite one JSON record. Returns the rewritten record, or null when the whole
 * line must be dropped (a reasoning or compaction marker whose value is the
 * server's encrypted blob).
 */
export function rewriteRecord(record, map, { nowMs, randomBytesImpl, dropServerBlobs = true } = {}) {
  const walk = (node, parentKey) => {
    if (Array.isArray(node)) {
      const out = [];
      for (const entry of node) {
        const rewritten = walk(entry, parentKey);
        if (rewritten === null) continue;
        out.push(rewritten);
      }
      return out;
    }
    if (!isObject(node)) return node;
    if (dropServerBlobs && typeof node.type === "string" && DROP_ITEM_TYPES.has(node.type)) {
      return null;
    }
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (dropServerBlobs && ENCRYPTED_KEYS.has(key)) continue;
      if (DELETED_KEYS.has(key)) continue;
      if (
        dropServerBlobs
        && key === PASSTHROUGH_CREATE_TIME_KEY
        && String(parentKey ?? "").endsWith("internal_chat_message_metadata_passthrough")
      ) {
        continue;
      }
      if (key === "call_id" || key === "item_id" || key === "id" || key === "response_id" || key === "agent_thread_id") {
        const remapped = typeof value === "string" ? map.get(value) ?? map.get(value.toLowerCase()) : null;
        out[key] = remapped ?? walk(value, key);
        continue;
      }
      out[key] = walk(rewriteValue(value, map, { nowMs, randomBytesImpl }), key);
    }
    return out;
  };
  if (dropServerBlobs && typeof record?.payload?.type === "string" && DROP_ITEM_TYPES.has(record.payload.type)) {
    return null;
  }
  return walk(record, null);
}

export function buildRewriteMap({ scan, newId, nowMs = Date.now(), randomBytesImpl = randomBytes } = {}) {
  const map = new Map();
  map.set(String(scan.threadId ?? "").toLowerCase(), newId);
  map.set(String(scan.sourceId ?? "").toLowerCase(), newId);
  map.set(String(scan.sessionId ?? "").toLowerCase(), newId);
  for (const id of scan.turnIds ?? []) map.set(id, generateUuidV7({ nowMs, randomBytesImpl }));
  for (const id of scan.itemIds ?? []) map.set(id, remapIdValue(id, { nowMs, randomBytesImpl }));
  for (const id of scan.windowIds ?? []) map.set(id, generateUuidV7({ nowMs, randomBytesImpl }));
  for (const id of scan.responseIds ?? []) map.set(id, generateUuidV7({ nowMs, randomBytesImpl }));
  map.delete("");
  for (const [key, value] of [...map.entries()]) if (value === undefined) map.delete(key);
  return map;
}

function rewriteHeader({ meta, newId, nowMs, map }) {
  const payload = JSON.parse(JSON.stringify(meta.raw ?? {}));
  for (const key of LINEAGE_KEYS) delete payload[key];
  const sessionId = String(payload.session_id ?? "").trim().toLowerCase();
  if (sessionId && sessionId !== String(meta.id).toLowerCase()) {
    throw new CodexThreadCopyError(
      "Source rollout shares a session id with another thread (subagent family); refusing to carry it",
      { code: "source_shared_session" },
    );
  }
  payload.id = newId;
  payload.session_id = newId;
  payload.timestamp = timestampNowIso(nowMs);
  if (isObject(payload.context_window) && payload.context_window.window_id) {
    payload.context_window = { ...payload.context_window, window_id: map.get(String(payload.context_window.window_id).toLowerCase()) ?? generateUuidV7({ nowMs }) };
  }
  return payload;
}

/** Copy the source rollout into a new, scrubbed rollout file. */
export async function copyThreadRollout({
  plan,
  scan,
  map,
  nowMs = plan.nowMs ?? Date.now(),
  fsImpl = fs,
  dropServerBlobs = true,
  randomBytesImpl = randomBytes,
} = {}) {
  const sourceText = fsImpl.readFileSync(plan.sourcePath, "utf8");
  const sourceLines = sourceText.split("\n").filter((line) => line.trim());
  const rewriteMap = map ?? buildRewriteMap({ scan, newId: plan.newId, nowMs, randomBytesImpl });
  fsImpl.mkdirSync(plan.targetDir, { recursive: true, mode: 0o755 });
  if (fsImpl.existsSync(plan.targetPath) || fsImpl.existsSync(`${plan.targetPath}.zst`)) {
    throw new CodexThreadCopyError(`Refusing to overwrite existing rollout ${plan.targetPath}`, { code: "target_exists" });
  }
  const tempPath = `${plan.targetPath}.tmp-${process.pid}`;
  const chunks = [];
  let ordinal = 0;
  let kept = 0;
  let dropped = 0;
  for (const line of sourceLines) {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      throw new CodexThreadCopyError(`Corrupt rollout record in ${plan.sourcePath}; refusing to copy blind`, {
        code: "source_corrupt",
      });
    }
    if (record?.type === "session_meta") {
      chunks.push(JSON.stringify({
        timestamp: timestampNowIso(nowMs),
        ordinal: ordinal++,
        type: "session_meta",
        payload: rewriteHeader({ meta: plan.meta, newId: plan.newId, nowMs, map: rewriteMap }),
      }));
      kept += 1;
      continue;
    }
    const rewritten = rewriteRecord(record, rewriteMap, { nowMs, randomBytesImpl, dropServerBlobs });
    if (rewritten === null) {
      dropped += 1;
      continue;
    }
    rewritten.timestamp = record.timestamp ?? timestampNowIso(nowMs);
    rewritten.ordinal = ordinal++;
    chunks.push(JSON.stringify(rewritten));
    kept += 1;
  }
  const body = `${chunks.join("\n")}\n`;
  fsImpl.writeFileSync(tempPath, body, { mode: 0o644 });
  const fd = fsImpl.openSync(tempPath, "r+");
  try {
    fsImpl.fsyncSync(fd);
  } finally {
    fsImpl.closeSync(fd);
  }
  fsImpl.renameSync(tempPath, plan.targetPath);
  return {
    targetPath: plan.targetPath,
    lines: kept,
    dropped,
    bytes: Buffer.byteLength(body),
    newId: plan.newId,
    dropServerBlobs,
  };
}

function classifyHit(recordPath) {
  return CONTENT_PATH_PATTERN.test(recordPath) ? "content" : "identifier";
}

/**
 * Third pass: prove the written file has no identifier residue.
 * Returns hard failures (must be empty) and content mentions (reported, not fatal).
 */
export function verifyCopiedRollout({
  plan,
  scan,
  fsImpl = fs,
  dropServerBlobs = true,
} = {}) {
  const text = fsImpl.readFileSync(plan.targetPath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  const retired = new Set();
  for (const id of [
    plan.sourceId,
    scan.sessionId,
    ...(scan.turnIds ?? []),
    ...(scan.itemIds ?? []),
    ...(scan.responseIds ?? []),
    ...(scan.windowIds ?? []),
  ]) {
    const value = String(id ?? "").trim().toLowerCase();
    if (value && value !== plan.newId) retired.add(value);
  }
  const failures = [];
  const contentMentions = [];
  let header = null;
  let ordinal = -1;
  const typeCounts = {};
  let dense = true;
  let v7Violations = 0;
  let createTimeLeft = 0;
  let blobLeft = 0;

  const hitsFor = (value, path) => {
    const found = [];
    if (typeof value !== "string" || !value) return found;
    const lower = value.toLowerCase();
    for (const id of retired) {
      if (lower.includes(id)) found.push({ id, path, value, class: classifyHit(path) });
    }
    return found;
  };
  const walk = (node, nodePath, sink) => {
    if (typeof node === "string") {
      sink.push(...hitsFor(node, nodePath));
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${nodePath}[${index}]`, sink));
      return;
    }
    if (!isObject(node)) return;
    for (const [key, value] of Object.entries(node)) {
      const childPath = nodePath ? `${nodePath}/${key}` : key;
      if (ENCRYPTED_KEYS.has(key)) blobLeft += 1;
      if (key === PASSTHROUGH_CREATE_TIME_KEY && nodePath.endsWith("internal_chat_message_metadata_passthrough")) createTimeLeft += 1;
      walk(value, childPath, sink);
    }
  };

  lines.forEach((line, index) => {
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      failures.push({ check: "parse", path: `${plan.targetPath}:${index + 1}`, message: "unparseable line" });
      return;
    }
    ordinal += 1;
    typeCounts[String(record.type ?? "unknown")] = (typeCounts[String(record.type ?? "unknown")] ?? 0) + 1;
    if (record.ordinal !== ordinal) dense = false;
    if (index === 0) header = record;
    if (dropServerBlobs && record.type === "response_item" && DROP_ITEM_TYPES.has(record.payload?.type)) {
      failures.push({ check: "dropped-item", path: `line ${index + 1}`, message: `line type ${record.payload?.type} survived` });
    }
    const sink = [];
    walk(record, String(record.type ?? "unknown"), sink);
    for (const hit of sink) {
      if (hit.class === "identifier") failures.push({ check: "identifier-residue", path: hit.path, message: `retired id ${hit.id}` });
      else contentMentions.push(hit);
    }
  });

  if (!header || header.type !== "session_meta") {
    failures.push({ check: "header", path: plan.targetPath, message: "first line is not session_meta" });
  } else {
    const payload = header.payload ?? {};
    if (payload.id !== plan.newId) failures.push({ check: "header-id", path: "payload.id", message: `expected ${plan.newId}` });
    if (payload.session_id !== plan.newId) failures.push({ check: "header-session-id", path: "payload.session_id", message: `expected ${plan.newId}` });
    if (!isUuidV7(payload.id)) v7Violations += 1;
    for (const key of LINEAGE_KEYS) {
      if (payload[key] !== undefined) failures.push({ check: "lineage-field", path: `payload.${key}`, message: "lineage field survived" });
    }
    const windowId = payload.context_window?.window_id;
    if (windowId && !isUuidV7(windowId)) {
      failures.push({ check: "window-id-version", path: "payload.context_window.window_id", message: "window id is not a UUIDv7" });
    }
  }
  if (!dense) failures.push({ check: "ordinals", path: plan.targetPath, message: "ordinals are not dense from 0" });
  if (v7Violations > 0) failures.push({ check: "uuidv7", path: plan.targetPath, message: `${v7Violations} non-v7 id(s)` });
  if (dropServerBlobs && createTimeLeft > 0) {
    failures.push({ check: "passthrough-create-time", path: plan.targetPath, message: `${createTimeLeft} create_time value(s) survived` });
  }
  if (dropServerBlobs && blobLeft > 0) {
    failures.push({ check: "encrypted-blob", path: plan.targetPath, message: `${blobLeft} encrypted field(s) survived` });
  }
  return {
    ok: failures.length === 0,
    failures,
    contentMentions,
    lines: lines.length,
    header,
    scanLineCount: scan.lineCount,
    typeCounts,
  };
}

/** Carry a thread goal onto the new thread id with a fresh goal_id. */
export function carryThreadGoal({
  codexHome,
  sourceId,
  newId,
  nowMs = Date.now(),
  spawnSyncImpl = spawnSync,
  homeDir,
  randomBytesImpl = randomBytes,
  fsImpl = fs,
} = {}) {
  const dbPath = resolveCodexGoalsDbPath({ codexHome, fsImpl });
  if (!dbPath) return { carried: false, reason: "no_goals_db" };
  const source = String(sourceId ?? "").trim().toLowerCase();
  const target = String(newId ?? "").trim().toLowerCase();
  if (!isCodexSessionId(source) || !isCodexSessionId(target)) return { carried: false, reason: "invalid_id" };
  const goalId = generateUuidV7({ nowMs, randomBytesImpl });
  const encoded = Math.floor(Number(nowMs) || Date.now());
  const sql = [
    "pragma foreign_keys=off;",
    `insert or replace into thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms) `
      + `select '${target}', '${goalId}', objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, ${encoded} `
      + `from thread_goals where thread_id = '${source}';`,
    `select changes();`,
  ].join("\n");
  const command = resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl });
  const result = spawnSyncImpl(command, [dbPath, sql], { encoding: "utf8" });
  if (result?.error) return { carried: false, reason: "sqlite_error", error: String(result.error.message ?? result.error) };
  if (result?.status !== 0) {
    return { carried: false, reason: "sqlite_error", error: String(result?.stderr ?? "").trim() || `exit ${result?.status}` };
  }
  const text = String(result?.stdout ?? "");
  const rows = text
    .split("\n")
    .map((line) => line.split("\t"))
    .flat()
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
  const carried = rows.length > 0 && Number(rows[rows.length - 1]) > 0;
  return { carried, reason: carried ? "carried" : "no_goal", goalId: carried ? goalId : null, dbPath };
}

/**
 * Ensure the Codex profile that aim launches with disables analytics.
 * Only the profile file (`<codexHome>/<profile>.config.toml`) is touched, and only
 * when the setting is missing; the user's base `config.toml` is never modified.
 */
export function parseTomlSectionEnabled(text, section = "analytics") {
  const lines = String(text ?? "").split("\n");
  const header = `[${section}]`;
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim() === header) {
      start = i;
      break;
    }
  }
  if (start === -1) return { found: false, enabledLine: -1, value: null };
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
      end = i;
      break;
    }
  }
  for (let i = start + 1; i < end; i += 1) {
    const match = lines[i].match(/^\s*enabled\s*=\s*(true|false)\s*$/);
    if (match) return { found: true, enabledLine: i, value: match[1] === "true", sectionStart: start, sectionEnd: end };
  }
  return { found: true, enabledLine: -1, value: null, sectionStart: start, sectionEnd: end };
}

/**
 * Ensure the Codex profile that aim launches with disables analytics.
 * Only the profile file (`<codexHome>/<profile>.config.toml`) is touched; the
 * user's base `config.toml` is never modified.
 */
export function ensureCodexProfileAnalyticsDisabled({ codexHome, profile = "yolo", fsImpl = fs } = {}) {
  const profilePath = path.join(codexHome, `${profile}.config.toml`);
  const existing = fsImpl.existsSync(profilePath) ? fsImpl.readFileSync(profilePath, "utf8") : "";
  const parsed = parseTomlSectionEnabled(existing, "analytics");
  if (parsed.found && parsed.value === false) return { changed: false, path: profilePath };

  let lines = existing.split("\n");
  if (parsed.found) {
    if (parsed.enabledLine >= 0) lines[parsed.enabledLine] = "enabled = false";
    else lines.splice(parsed.sectionStart + 1, 0, "enabled = false");
  } else {
    const suffix = lines.length > 0 && lines[lines.length - 1] === "" ? [] : [""];
    lines = [...lines, ...suffix, "[analytics]", "enabled = false"];
  }
  const body = lines.join("\n");
  fsImpl.mkdirSync(codexHome, { recursive: true, mode: 0o755 });
  fsImpl.writeFileSync(profilePath, body.endsWith("\n") ? body : `${body}\n`, { mode: 0o600 });
  return { changed: true, path: profilePath };
}

/** True when the profile file disables Codex analytics. */
export function analyticsDisabledInProfile({ codexHome, profile = "yolo", fsImpl = fs } = {}) {
  const profilePath = path.join(codexHome, `${profile}.config.toml`);
  if (!fsImpl.existsSync(profilePath)) return false;
  return parseTomlSectionEnabled(fsImpl.readFileSync(profilePath, "utf8"), "analytics").value === false;
}
