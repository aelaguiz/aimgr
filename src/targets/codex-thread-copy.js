import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveSqlite3Command } from "../io/process.js";
import {
  isCodexSessionId,
  readRolloutMeta,
  resolveCodexGoalsDbPath,
  resolveCodexSessionsDir,
  resolveRolloutForThreadId,
} from "./codex-rollout.js";

// Copy one Codex thread into a brand-new, unlinked thread.
//
// Three passes over the data:
//   1. scan   - read the source once, collect every retired identifier
//   2. copy   - rewrite the header, remap ids at any depth, drop server blobs
//   3. verify - read the written file, fail hard on identifier residue
//
// The rules that matter (all learned from the Codex source, not guessed):
//   * `TokenUsageRecord.response_id` is a REQUIRED String, so it is blanked, never deleted;
//     deleting it makes the whole `token_usage_record` line (and any `compacted` line holding
//     one) undecodable, which silently drops the compaction base on resume.
//   * A modern `compacted` record keeps its pre-compaction memory only inside the encrypted
//     `compaction` item of `replacement_history`; `message` is empty. Dropping that item loses
//     the model's memory, so compacted sources are refused under the default scrub.
//   * Window ids must be UUIDv7: `parse_uuid_v7` silently discards anything else.
//   * `create_time` is a join key and is stripped unconditionally, even when blobs are kept.

export const DROP_ITEM_TYPES = new Set(["reasoning", "compaction", "context_compaction"]);
export const ENCRYPTED_KEYS = new Set(["encrypted_content", "encrypted_function_args"]);
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
export const ID_KEYS = new Set([
  "id",
  "call_id",
  "item_id",
  "turn_id",
  "root_turn_id",
  "thread_id",
  "agent_thread_id",
  "parent_thread_id",
  "window_id",
  "first_window_id",
  "previous_window_id",
  "response_id",
  "compaction_response_id",
]);
// Prefixes observed as real Codex id values in live rollouts (`call`, `rs`, `ctc`, `ctco`, `resp`,
// `msg`, `amsg`, `fc`, `fco`, `cmp`). A value is only retired when its key is id-ish, it is a bare
// UUID, or it carries one of these prefixes: structural values like `custom_tool_call` must never
// be rewritten.
export const ID_PREFIXES = new Set(["amsg", "call", "cmp", "ctc", "ctco", "fc", "fco", "msg", "resp", "rs"]);
export const CONTENT_PATH_PATTERN = /(^|\/)(content|text|summary|summary_text|message|input|output|arguments|stdout|stderr|aggregated_output|formatted_output|command|result|diff|changes|patch|body|note|notes|raw_content|state)(\/|\[|$)/i;
export const MAX_COPY_MB_DEFAULT = 128;

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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function randomToken(length, { randomBytesImpl = randomBytes } = {}) {
  const alphabet = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789";
  const bytes = Buffer.from(randomBytesImpl(Math.max(1, length)));
  let out = "";
  for (let i = 0; i < length; i += 1) out += alphabet[bytes[i % bytes.length] % alphabet.length];
  return out;
}

function hexOfLength(length, { nowMs, randomBytesImpl }) {
  let hex = generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
  while (hex.length < length) hex += generateUuidV7({ nowMs, randomBytesImpl }).replace(/-/g, "");
  return hex.slice(0, length);
}

/**
 * Rebuild an id with the same prefix and the same suffix shape.
 * A bare UUID becomes a fresh UUIDv7. `msg_<uuid>` stays a uuid, `rs_<hex>` stays hex of the
 * same length, `call_<base62>` stays base62. No suffix-length rule: real rollouts contain
 * short ids like `msg_00f3a1`.
 */
const SEPARATOR_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,31})([_-])(.+)$/;

/**
 * True when a value identifies this thread's work: a bare UUID, or `prefix<suffix>` whose suffix
 * is a UUID or hex, or a known server id prefix. Positional ids like `item-1` are not identifying
 * and must be left alone (they exist in every thread).
 */
export function isIdentifyingId(value) {
  const text = String(value ?? "").trim();
  if (!text) return false;
  if (UUID_PATTERN.test(text)) return true;
  const match = text.match(SEPARATOR_PATTERN);
  if (!match) return false;
  const [, prefix, , suffix] = match;
  if (UUID_PATTERN.test(suffix)) return true;
  if (/^[0-9a-f]{6,}$/i.test(suffix)) return true;
  return ID_PREFIXES.has(prefix.toLowerCase());
}

/**
 * Rebuild an id, keeping the prefix and the separator and the suffix shape.
 * `msg_<uuid>` stays a uuid, `rs_<hex>` stays hex of the same length, `exec-<uuid>` stays a
 * dash-separated uuid, `call_<base62>` stays base62. No suffix-length rule: real rollouts
 * contain short ids like `msg_00f3a1`.
 */
export function remapIdValue(value, { nowMs, randomBytesImpl } = {}) {
  const text = String(value);
  if (UUID_PATTERN.test(text)) return generateUuidV7({ nowMs, randomBytesImpl });
  const match = text.match(SEPARATOR_PATTERN);
  if (!match) return null;
  const [, prefix, separator, suffix] = match;
  if (UUID_PATTERN.test(suffix)) {
    return `${prefix}${separator}${generateUuidV7({ nowMs, randomBytesImpl })}`;
  }
  if (/^[0-9a-f]+$/i.test(suffix)) {
    return `${prefix}${separator}${hexOfLength(suffix.length, { nowMs, randomBytesImpl })}`;
  }
  return `${prefix}${separator}${randomToken(suffix.length, { randomBytesImpl })}`;
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

/**
 * First pass: read the source once, collect every retired identifier, and describe what the
 * file carries. Read-only, so `--dry-run` can use it. The raw lines are returned so the copy
 * pass does not read the file a second time.
 */
export function scanThreadRollout({ plan, fsImpl = fs } = {}) {
  const text = fsImpl.readFileSync(plan.sourcePath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  const ids = new Map();
  const lineTypes = {};
  const agentItemTypes = new Set();
  let compactedLines = 0;
  let droppedItemLines = 0;
  let encryptedBlobs = 0;
  let createTimes = 0;
  let subagentSpawnCount = 0;
  let sessionId = plan.sourceId;

  const collect = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    const lower = text.toLowerCase();
    if (ids.has(lower)) return;
    ids.set(lower, text);
  };
  const collectStructural = (value) => {
    const text = String(value ?? "").trim();
    if (!text) return;
    if (isIdentifyingId(text)) collect(text);
  };

  const walk = (node, nodePath, parentKey) => {
    if (typeof node === "string") {
      if (CONTENT_PATH_PATTERN.test(nodePath)) return;
      collectStructural(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${nodePath}[${index}]`, parentKey));
      return;
    }
    if (!isObject(node)) return;
    const type = typeof node.type === "string" ? node.type : null;
    if (type && DROP_ITEM_TYPES.has(type)) {
      droppedItemLines += 1;
      if (nodePath.includes("item_completed") || nodePath.includes("item/")) agentItemTypes.add(type);
    }
    for (const [key, value] of Object.entries(node)) {
      const childPath = nodePath ? `${nodePath}/${key}` : key;
      if (ENCRYPTED_KEYS.has(key)) encryptedBlobs += 1;
      if (key === PASSTHROUGH_CREATE_TIME_KEY && nodePath.endsWith("internal_chat_message_metadata_passthrough")) {
        createTimes += 1;
      }
      if (ID_KEYS.has(key) && typeof value === "string") {
        if (isIdentifyingId(value)) collect(value);
      } else if (typeof value === "string" && !CONTENT_PATH_PATTERN.test(childPath)) {
        collectStructural(value);
      }
      walk(value, childPath, key);
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
    if (type === "compacted") compactedLines += 1;
    if (type === "session_meta") {
      sessionId = String(payload.session_id ?? payload.id ?? plan.sourceId).trim().toLowerCase();
      collect(payload.id);
      if (typeof payload.session_id === "string") collect(payload.session_id);
      for (const key of LINEAGE_KEYS) if (typeof payload[key] === "string") collect(payload[key]);
      if (isObject(payload.context_window) && typeof payload.context_window.window_id === "string") {
        collect(payload.context_window.window_id);
      }
      continue;
    }
    if (type === "event_msg" && typeof payload.type === "string" && payload.type.toLowerCase().includes("sub_agent")) {
      subagentSpawnCount += 1;
    }
    if (type === "event_msg" && payload.type === "item_completed" && isObject(payload.item)) {
      const itemType = String(payload.item.type ?? "");
      if (itemType) agentItemTypes.add(itemType);
    }
    walk(payload, type);
  }

  return {
    threadId: plan.sourceId,
    sessionId,
    bytesRead: Buffer.byteLength(text, "utf8"),
    lineCount: lines.length,
    lines,
    lineTypes,
    ids: [...ids.values()],
    compactedLines,
    agentItemTypes: [...agentItemTypes],
    createTimes,
    encryptedBlobs,
    droppedItemLines,
    subagentSpawnCount,
  };
}

/** Refuse sources whose memory lives in a server blob when the scrub is on. */
export function assertCompactionPolicy({ scan, dropServerBlobs, allowContextLoss } = {}) {
  if (!scan?.compactedLines) return;
  if (!dropServerBlobs || allowContextLoss) return;
  throw new CodexThreadCopyError(
    "Source thread was compacted: its pre-compaction memory lives in a server-side blob inside "
    + "the `compacted` record, and the default scrub drops that blob. Pass --keep-server-blobs to carry the "
    + "memory (the server can then link the sessions by that blob), or --allow-context-loss to copy anyway and "
    + "start the new thread without the pre-compaction memory.",
    { code: "source_compacted", details: { compactedLines: scan.compactedLines } },
  );
}

export function buildRewriteMap({ scan, newId, nowMs = Date.now(), randomBytesImpl = randomBytes } = {}) {
  const map = new Map();
  const reserve = (value, generated) => {
    const key = String(value ?? "").trim().toLowerCase();
    if (!key) return;
    map.set(key, generated);
  };
  reserve(scan.threadId, newId);
  reserve(scan.sessionId, newId);
  let index = 0;
  for (const id of scan.ids ?? []) {
    const lower = String(id).trim().toLowerCase();
    if (map.has(lower)) continue;
    if (lower === String(scan.threadId ?? "").toLowerCase()) continue;
    const remapped = remapIdValue(id, { nowMs: nowMs + index, randomBytesImpl });
    if (remapped === null) continue;
    index += 1;
    reserve(id, remapped);
  }
  return map;
}

function rewriteValue(value, map) {
  if (typeof value !== "string") return value;
  return map.get(value) ?? map.get(value.toLowerCase()) ?? value;
}

/**
 * Rewrite one JSON record. Returns null when the whole line is dropped (a reasoning or
 * compaction item whose value is the server's encrypted blob).
 */
export function rewriteRecord(record, map, { dropServerBlobs = true } = {}) {
  const walk = (node, parentKey, inBlobItem) => {
    if (Array.isArray(node)) {
      const out = [];
      for (const entry of node) {
        const rewritten = walk(entry, parentKey, inBlobItem);
        if (rewritten === null) continue;
        out.push(rewritten);
      }
      return out;
    }
    if (!isObject(node)) return node;
    const isBlobItem = typeof node.type === "string" && DROP_ITEM_TYPES.has(node.type);
    if (dropServerBlobs && isBlobItem) return null;
    // With blobs kept, the blob-bearing item is left intact: remapping the ids it was minted
    // with could stop the server from using its own encrypted content.
    const keepIntact = inBlobItem || (!dropServerBlobs && isBlobItem);
    const out = {};
    for (const [key, value] of Object.entries(node)) {
      if (dropServerBlobs && ENCRYPTED_KEYS.has(key)) continue;
      if (key === "compaction_response_id") continue;
      if (key === PASSTHROUGH_CREATE_TIME_KEY
        && String(parentKey ?? "").endsWith("internal_chat_message_metadata_passthrough")) {
        continue;
      }
      if (key === "response_id") {
        // `TokenUsageRecord.response_id` is a required String: blank it, never delete it.
        out[key] = "";
        continue;
      }
      if (!keepIntact && ID_KEYS.has(key)) {
        const remapped = typeof value === "string" ? map.get(value) ?? map.get(value.toLowerCase()) : null;
        out[key] = remapped ?? walk(value, key, keepIntact);
        continue;
      }
      if (key === "type" || key === "role" || key === "name" || key === "status") {
        out[key] = value;
        continue;
      }
      out[key] = walk(value, key, keepIntact);
    }
    return out;
  };
  if (dropServerBlobs && typeof record?.payload?.type === "string" && DROP_ITEM_TYPES.has(record.payload.type)) {
    return null;
  }
  const rewritten = walk(record, null, false);
  if (rewritten && typeof rewritten.payload === "object" && rewritten.payload !== null) {
    // Catch-all: any remaining non-content string that is still a retired id.
    const sweep = (node, nodePath, inBlobItem) => {
      if (Array.isArray(node)) return node.map((entry, index) => sweep(entry, `${nodePath}[${index}]`, inBlobItem));
      if (!isObject(node)) return node;
      const isBlobItem = typeof node.type === "string" && DROP_ITEM_TYPES.has(node.type);
      const childBlob = inBlobItem || isBlobItem;
      const out = {};
      for (const [key, value] of Object.entries(node)) {
        const childPath = nodePath ? `${nodePath}/${key}` : key;
        if (key === "type" || key === "role" || key === "name" || key === "status") {
          out[key] = value;
        } else if (typeof value === "string" && value) {
          // A kept blob keeps the ids it was minted with: remapping them could stop the server
          // from using its own encrypted content.
          const mapped = childBlob ? null : map.get(value) ?? map.get(value.toLowerCase());
          out[key] = mapped ?? value;
        } else {
          out[key] = sweep(value, childPath, childBlob);
        }
      }
      return out;
    };
    if (map.size > 0) return sweep(rewritten, String(rewritten.type ?? "unknown"), false);
  }
  return rewritten;
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
    payload.context_window = {
      ...payload.context_window,
      window_id: generateUuidV7({ nowMs }),
    };
  }
  return payload;
}

function assertSourceSnapshotUnchanged({ plan, scan, fsImpl }) {
  const stat = fsImpl.statSync(plan.sourcePath);
  const bytes = Number(stat.size);
  const grew = bytes > Number(scan.bytesRead ?? plan.sourceBytes);
  const shrank = bytes < Number(scan.bytesRead ?? plan.sourceBytes);
  if (shrank) {
    throw new CodexThreadCopyError(
      "Source rollout changed while it was being copied (it shrank); refusing to write a torn copy",
      { code: "source_changed" },
    );
  }
  return { grew, bytes, written: scan.bytesRead ?? plan.sourceBytes };
}

/** Copy the source rollout into a new, scrubbed rollout file. */
export function copyThreadRollout({
  plan,
  scan,
  map,
  nowMs = plan.nowMs ?? Date.now(),
  fsImpl = fs,
  dropServerBlobs = true,
  randomBytesImpl = randomBytes,
} = {}) {
  const rewriteMap = map ?? buildRewriteMap({ scan, newId: plan.newId, nowMs, randomBytesImpl });
  const snapshot = assertSourceSnapshotUnchanged({ plan, scan, fsImpl });
  fsImpl.mkdirSync(plan.targetDir, { recursive: true, mode: 0o755 });
  if (fsImpl.existsSync(plan.targetPath) || fsImpl.existsSync(`${plan.targetPath}.zst`)) {
    throw new CodexThreadCopyError(`Refusing to overwrite existing rollout ${plan.targetPath}`, { code: "target_exists" });
  }
  const tempPath = `${plan.targetPath}.tmp-${process.pid}`;
  const chunks = [];
  let ordinal = 0;
  let kept = 0;
  let dropped = 0;
  for (const line of scan.lines ?? []) {
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
    const rewritten = rewriteRecord(record, rewriteMap, { dropServerBlobs });
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
  const afterWrite = assertSourceSnapshotUnchanged({ plan, scan, fsImpl });
  fsImpl.renameSync(tempPath, plan.targetPath);
  return {
    targetPath: plan.targetPath,
    lines: kept,
    dropped,
    bytes: Buffer.byteLength(body),
    newId: plan.newId,
    dropServerBlobs,
    sourceGrew: snapshot.grew || afterWrite.grew,
    sourceBytesCopied: afterWrite.written,
    sourceBytesNow: afterWrite.bytes,
  };
}

function classifyHit({ path: hitPath, exact, inBlobItem }) {
  // A kept blob item is allowed to keep the ids it was minted with, so it is checked before the
  // exact-match rule: that rule exists to catch id fields the rewriter missed elsewhere.
  if (inBlobItem) return "blob-item";
  if (exact) return "identifier";
  return CONTENT_PATH_PATTERN.test(hitPath) ? "content" : "identifier";
}

/**
 * Third pass: prove the written file has no identifier residue.
 * Hard failures must be empty; content mentions and kept-blob mentions are reported.
 */
export function verifyCopiedRollout({ plan, scan, fsImpl = fs, dropServerBlobs = true } = {}) {
  const text = fsImpl.readFileSync(plan.targetPath, "utf8");
  const lines = text.split("\n").filter((line) => line.trim());
  const retired = new Set();
  for (const id of [plan.sourceId, scan.sessionId, ...(scan.ids ?? [])]) {
    const value = String(id ?? "").trim().toLowerCase();
    if (value && value !== plan.newId) retired.add(value);
  }
  const failures = [];
  const contentMentions = [];
  const blobMentions = [];
  let header = null;
  let ordinal = -1;
  let dense = true;
  const typeCounts = {};

  const TOKEN_SPLIT = /[^A-Za-z0-9_-]+/;
  const inspect = (value, nodePath, inBlobItem) => {
    if (typeof value !== "string" || !value || retired.size === 0) return;
    const lower = value.toLowerCase();
    // Look up candidate tokens instead of scanning the retired set for every string: a big
    // thread can carry thousands of ids and tens of thousands of strings.
    const candidates = new Set([lower]);
    if (!retired.has(lower)) {
      for (const token of lower.split(TOKEN_SPLIT)) {
        if (token && retired.has(token)) candidates.add(token);
      }
    }
    for (const id of candidates) {
      if (!retired.has(id)) continue;
      const exact = lower === id;
      const verdict = classifyHit({ path: nodePath, exact, inBlobItem });
      const hit = { id, path: nodePath, value, class: verdict };
      if (verdict === "identifier") failures.push({ check: "identifier-residue", path: nodePath, message: `retired id ${id}` });
      else if (verdict === "blob-item") blobMentions.push(hit);
      else contentMentions.push(hit);
    }
  };
  const walk = (node, nodePath, inBlobItem) => {
    if (typeof node === "string") {
      inspect(node, nodePath, inBlobItem);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach((entry, index) => walk(entry, `${nodePath}[${index}]`, inBlobItem));
      return;
    }
    if (!isObject(node)) return;
    const isBlobItem = typeof node.type === "string" && DROP_ITEM_TYPES.has(node.type);
    const childBlob = inBlobItem || isBlobItem;
    for (const [key, value] of Object.entries(node)) {
      const childPath = nodePath ? `${nodePath}/${key}` : key;
      if (ENCRYPTED_KEYS.has(key) && dropServerBlobs) {
        failures.push({ check: "encrypted-blob", path: childPath, message: "encrypted field survived" });
      }
      if (key === PASSTHROUGH_CREATE_TIME_KEY && nodePath.endsWith("internal_chat_message_metadata_passthrough")) {
        failures.push({ check: "passthrough-create-time", path: childPath, message: "create_time survived" });
      }
      if (key === "compaction_response_id") {
        failures.push({ check: "compaction-response-id", path: childPath, message: "compaction_response_id survived" });
      }
      walk(value, childPath, childBlob);
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
    const type = String(record.type ?? "unknown");
    typeCounts[type] = (typeCounts[type] ?? 0) + 1;
    if (record.ordinal !== ordinal) dense = false;
    if (index === 0) header = record;
    if (dropServerBlobs && record.type === "response_item" && DROP_ITEM_TYPES.has(record.payload?.type)) {
      failures.push({ check: "dropped-item", path: `line ${index + 1}`, message: `line type ${record.payload?.type} survived` });
    }
    walk(record, type, false);
  });

  if (!header || header.type !== "session_meta") {
    failures.push({ check: "header", path: plan.targetPath, message: "first line is not session_meta" });
  } else {
    const payload = header.payload ?? {};
    if (payload.id !== plan.newId) failures.push({ check: "header-id", path: "payload.id", message: `expected ${plan.newId}` });
    if (payload.session_id !== plan.newId) failures.push({ check: "header-session-id", path: "payload.session_id", message: `expected ${plan.newId}` });
    if (!isUuidV7(payload.id)) failures.push({ check: "uuidv7", path: "payload.id", message: "thread id is not a UUIDv7" });
    for (const key of LINEAGE_KEYS) {
      if (payload[key] !== undefined) failures.push({ check: "lineage-field", path: `payload.${key}`, message: "lineage field survived" });
    }
    const windowId = payload.context_window?.window_id;
    if (windowId && !isUuidV7(windowId)) {
      failures.push({ check: "window-id-version", path: "payload.context_window.window_id", message: "window id is not a UUIDv7" });
    }
  }
  if (!dense) failures.push({ check: "ordinals", path: plan.targetPath, message: "ordinals are not dense from 0" });
  return {
    ok: failures.length === 0,
    failures,
    contentMentions,
    blobMentions,
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
    "insert or replace into thread_goals (thread_id, goal_id, objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, updated_at_ms) "
      + `select '${target}', '${goalId}', objective, status, token_budget, tokens_used, time_used_seconds, created_at_ms, ${encoded} `
      + `from thread_goals where thread_id = '${source}';`,
    "select changes();",
  ].join("\n");
  const command = resolveSqlite3Command({ homeDir, spawnImpl: spawnSyncImpl });
  const result = spawnSyncImpl(command, [dbPath, sql], { encoding: "utf8" });
  if (result?.error) return { carried: false, reason: "sqlite_error", error: String(result.error.message ?? result.error) };
  if (result?.status !== 0) {
    return { carried: false, reason: "sqlite_error", error: String(result?.stderr ?? "").trim() || `exit ${result?.status}` };
  }
  const rows = String(result?.stdout ?? "")
    .split("\n")
    .map((line) => line.split("\t"))
    .flat()
    .map((value) => value.trim())
    .filter((value) => /^\d+$/.test(value));
  const carried = rows.length > 0 && Number(rows[rows.length - 1]) > 0;
  return { carried, reason: carried ? "carried" : "no_goal", goalId: carried ? goalId : null, dbPath };
}

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
