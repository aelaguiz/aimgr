import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { readFileLines } from "../io/file-lines.js";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATED_ID_PATTERN = /^(?:toolu|msg|req)_[A-Za-z0-9_-]{8,}$/;
const GENERATED_ID_TOKEN = /(?:toolu|msg|req)_[A-Za-z0-9_-]{8,}/g;
// Anchor prefixed IDs at the start of an alphanumeric run. Without this,
// a long payload with no underscore retries the greedy prefix at every byte
// and makes replacement quadratic. Preserve numeric text before an ID.
const IDENTIFIER_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|(?<![A-Za-z0-9])([0-9]*)([A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]{8,})/gi;
const IDENTIFIER_FIELD = /(?:^|_)(?:id|uuid)$|(?:Id|ID|Uuid|UUID)$/;
const PREFIXED_ID_PATTERN = /^([A-Za-z][A-Za-z0-9]*_)[A-Za-z0-9_-]{8,}$/;
const CONTENT_FIELDS = new Set(["message", "toolUseResult", "attachment", "wireToolInputs"]);
const THINKING_BLOCK_TYPES = new Set(["thinking", "redacted_thinking"]);
const UTF8 = new TextDecoder("utf-8", { fatal: true });

// Thinking blocks carry server-signed blobs bound to the account that produced
// them, so a fork staged for another account must not send them. Claude thinks
// afresh from the visible history instead. The entry itself stays, even when
// its content becomes empty, so parent chains and compaction references hold.
function stripThinkingBlocks(entry) {
  const content = entry?.message?.content;
  if (!Array.isArray(content) || !content.some((block) => THINKING_BLOCK_TYPES.has(block?.type))) {
    return entry;
  }
  return {
    ...entry,
    message: {
      ...entry.message,
      content: content.filter((block) => !THINKING_BLOCK_TYPES.has(block?.type)),
    },
  };
}

// Companion JSONL (subagent transcripts) is copied byte for byte, so only lines
// that hold thinking blocks are re-serialized; unparseable lines stay verbatim.
export function stripClaudeTranscriptThinkingBytes(buffer) {
  let changed = false;
  const lines = buffer.toString("latin1").split("\n").map((line) => {
    if (!line.includes("thinking")) return line;
    let entry;
    try {
      entry = JSON.parse(UTF8.decode(Buffer.from(line, "latin1")));
    } catch {
      return line;
    }
    const stripped = stripThinkingBlocks(entry);
    if (stripped === entry) return line;
    changed = true;
    return Buffer.from(JSON.stringify(stripped), "utf8").toString("latin1");
  });
  return changed ? Buffer.from(lines.join("\n"), "latin1") : buffer;
}

function newIdentifier(oldId) {
  if (UUID_PATTERN.test(oldId)) return randomUUID();
  const prefix = oldId.match(PREFIXED_ID_PATTERN)?.[1];
  if (!prefix) throw new Error("Claude transcript contains an unsupported identifier format.");
  const suffixLength = Math.max(12, oldId.length - prefix.length);
  return `${prefix}${randomBytes(Math.ceil(suffixLength / 2)).toString("hex").slice(0, suffixLength)}`;
}

function recordIdentifier(value, mapping, reserved) {
  if (typeof value !== "string" || mapping.has(value)) return;
  if (!UUID_PATTERN.test(value) && !PREFIXED_ID_PATTERN.test(value)) return;
  let replacement;
  do {
    replacement = newIdentifier(value);
  } while (reserved.has(replacement));
  reserved.add(replacement);
  mapping.set(value, replacement);
}

function collectStructuredIdentifiers(value, mapping, reserved, insideContent = false) {
  if (Array.isArray(value)) {
    for (const item of value) collectStructuredIdentifiers(item, mapping, reserved, insideContent);
    return;
  }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (GENERATED_ID_PATTERN.test(key)) recordIdentifier(key, mapping, reserved);
    if (!insideContent && typeof child === "string" && IDENTIFIER_FIELD.test(key)) {
      recordIdentifier(child, mapping, reserved);
    }
    collectStructuredIdentifiers(child, mapping, reserved, insideContent || CONTENT_FIELDS.has(key));
  }
}

export function replaceClaudeTranscriptIdentifiers(value, mapping) {
  if (typeof value !== "string" || mapping.size === 0) return value;
  return value.replace(IDENTIFIER_TOKEN, (match, digits, prefixedId) => (
    prefixedId ? `${digits}${mapping.get(prefixedId) ?? prefixedId}` : mapping.get(match) ?? match
  ));
}

function rewriteValue(value, mapping) {
  if (typeof value === "string") return replaceClaudeTranscriptIdentifiers(value, mapping);
  if (Array.isArray(value)) return value.map((item) => rewriteValue(item, mapping));
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => [
    replaceClaudeTranscriptIdentifiers(key, mapping),
    rewriteValue(child, mapping),
  ]));
}

function parseTranscriptLines(content) {
  const lines = content.split("\n");
  const lastNonblank = lines.findLastIndex((line) => line.trim());
  const entries = [];
  for (let index = 0; index <= lastNonblank; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error("invalid record");
      }
      entries.push(entry);
    } catch {
      // A live Claude process can leave an incomplete final JSONL record.
      // Earlier malformed records cannot be safely interpreted or rekeyed.
      if (index !== lastNonblank) {
        throw new Error(`Claude source transcript has malformed JSONL at line ${index + 1}.`);
      }
    }
  }
  if (entries.length === 0) throw new Error("Claude source transcript has no readable records.");
  return entries;
}

function* readTranscriptEntries(sourcePath) {
  let lineNumber = 0;
  let malformedLine = null;
  for (const bytes of readFileLines(sourcePath)) {
    lineNumber += 1;
    const line = UTF8.decode(bytes);
    if (!line.trim()) continue;
    if (malformedLine !== null) {
      throw new Error(`Claude source transcript has malformed JSONL at line ${malformedLine}.`);
    }
    let entry;
    try {
      entry = JSON.parse(line);
      if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error("invalid record");
    } catch {
      malformedLine = lineNumber;
      continue;
    }
    yield { entry, line };
  }
}

function rewriteEntry(entry, mapping) {
  const copy = rewriteValue(stripThinkingBlocks(entry), mapping);
  if (copy.type === "custom-title" && typeof copy.customTitle === "string") {
    copy.customTitle = copy.customTitle.replace(/^(?:\[fork from [^\]]+\]\s*)+/i, "") || "Continued session";
  }
  return JSON.stringify(copy);
}

// A first pass validates the history and collects identifiers, including forward
// references. A second pass rewrites one record at a time. Keep only the mapping,
// never the source, parsed history and rewritten history together in memory.
export function rekeyClaudeTranscriptFile({
  sourcePath, targetPath, expectedSessionId = null, stagedSessionId = randomUUID(),
}) {
  if (!UUID_PATTERN.test(stagedSessionId)) throw new Error("Cannot rekey an invalid Claude transcript.");
  const observedSessionIds = new Set();
  const mapping = new Map();
  const reserved = new Set([stagedSessionId]);
  let count = 0;
  for (const { entry, line } of readTranscriptEntries(sourcePath)) {
    count += 1;
    if (typeof entry.sessionId === "string" && UUID_PATTERN.test(entry.sessionId)) observedSessionIds.add(entry.sessionId);
    collectStructuredIdentifiers(entry, mapping, reserved);
    for (const match of line.matchAll(GENERATED_ID_TOKEN)) recordIdentifier(match[0], mapping, reserved);
  }
  if (!count) throw new Error("Claude source transcript has no readable records.");
  const normalizedIds = new Set([...observedSessionIds].map((value) => value.toLowerCase()));
  const sourceSessionId = expectedSessionId?.toLowerCase() ?? [...normalizedIds][0];
  if (!UUID_PATTERN.test(sourceSessionId ?? "") || !normalizedIds.has(sourceSessionId) || normalizedIds.size !== 1) {
    throw new Error("Claude source transcript does not have one consistent session ID.");
  }
  for (const value of observedSessionIds) mapping.set(value, stagedSessionId);
  mapping.set(sourceSessionId, stagedSessionId);
  const fd = fs.openSync(targetPath, "wx", 0o600);
  let complete = false;
  try {
    for (const { entry } of readTranscriptEntries(sourcePath)) {
      fs.writeFileSync(fd, `${rewriteEntry(entry, mapping)}\n`);
    }
    complete = true;
  } finally {
    fs.closeSync(fd);
    if (!complete) fs.unlinkSync(targetPath);
  }
  return Object.freeze({ sourceSessionId, stagedSessionId, mapping });
}

export function rekeyClaudeTranscript(content, {
  expectedSessionId = null,
  stagedSessionId = randomUUID(),
} = {}) {
  if (typeof content !== "string" || !UUID_PATTERN.test(stagedSessionId)) {
    throw new Error("Cannot rekey an invalid Claude transcript.");
  }
  const entries = parseTranscriptLines(content);
  const observedSessionIds = new Set(entries.map((entry) => entry.sessionId)
    .filter((value) => typeof value === "string" && UUID_PATTERN.test(value)));
  const normalizedSessionIds = new Set([...observedSessionIds].map((value) => value.toLowerCase()));
  const sourceSessionId = expectedSessionId?.toLowerCase() ?? [...normalizedSessionIds][0];
  if (
    !UUID_PATTERN.test(sourceSessionId ?? "")
    || !normalizedSessionIds.has(sourceSessionId)
    || normalizedSessionIds.size !== 1
  ) {
    throw new Error("Claude source transcript does not have one consistent session ID.");
  }
  const mapping = new Map([...observedSessionIds].map((value) => [value, stagedSessionId]));
  mapping.set(sourceSessionId, stagedSessionId);
  const reserved = new Set([sourceSessionId, stagedSessionId]);
  for (const entry of entries) collectStructuredIdentifiers(entry, mapping, reserved);
  for (const match of content.matchAll(GENERATED_ID_TOKEN)) {
    recordIdentifier(match[0], mapping, reserved);
  }
  const rewritten = entries.map((entry) => rewriteEntry(entry, mapping));
  return Object.freeze({
    sourceSessionId,
    stagedSessionId,
    content: `${rewritten.join("\n")}\n`,
    mapping,
  });
}
