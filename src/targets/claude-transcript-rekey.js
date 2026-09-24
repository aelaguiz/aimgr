import { randomBytes, randomUUID } from "node:crypto";

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const GENERATED_ID_PATTERN = /^(?:toolu|msg|req)_[A-Za-z0-9_-]{8,}$/;
const GENERATED_ID_TOKEN = /(?:toolu|msg|req)_[A-Za-z0-9_-]{8,}/g;
const IDENTIFIER_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Za-z][A-Za-z0-9]*_[A-Za-z0-9_-]{8,}/gi;
const IDENTIFIER_FIELD = /(?:^|_)(?:id|uuid)$|(?:Id|ID|Uuid|UUID)$/;
const PREFIXED_ID_PATTERN = /^([A-Za-z][A-Za-z0-9]*_)[A-Za-z0-9_-]{8,}$/;
const CONTENT_FIELDS = new Set(["message", "toolUseResult", "attachment", "wireToolInputs"]);

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
  return value.replace(IDENTIFIER_TOKEN, (match) => mapping.get(match) ?? match);
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
  const rewritten = entries.map((entry) => {
    const copy = rewriteValue(entry, mapping);
    if (copy.type === "custom-title" && typeof copy.customTitle === "string") {
      copy.customTitle = copy.customTitle.replace(/^(?:\[fork from [^\]]+\]\s*)+/i, "") || "Continued session";
    }
    return JSON.stringify(copy);
  });
  return Object.freeze({
    sourceSessionId,
    stagedSessionId,
    content: `${rewritten.join("\n")}\n`,
    mapping,
  });
}
