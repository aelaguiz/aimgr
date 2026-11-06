import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { durableCodexWrite, durableCodexMkdir } from "./codex-state-io.js";
import { codexConfigKeySegments, normalizeCodexSettingsValue, codexSettingsPathHints,
  restoreCodexPathHints } from "./codex-settings-toml.js";

const rejected = new Set(["configLayerReadonly", "configRequirementReadonly", "configVersionConflict", "configValidationError"]);
function write(file, record) {
  const staged = `${file}.${randomUUID()}`;
  durableCodexWrite(staged, JSON.stringify(record) + "\n", { exclusive: true });
  fs.renameSync(staged, file);
  flush(file);
}
function flush(file) {
  const fd = fs.openSync(path.dirname(file), "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function remove(file) { fs.unlinkSync(file); flush(file); }
function overwritten(keys, value, strategy) {
  if (strategy === "upsert" && value && typeof value === "object" && !Array.isArray(value)) {
    return Object.entries(value).flatMap(([key, item]) => overwritten([...keys, key], item, strategy));
  }
  return [keys];
}

/** Only the active native user layer determines the origin. Native still
 * validates filePath, the entire batch, and the client's expected version. */
export function prepareCodexSettingsRequest(request, entry) {
  if (!request || !Object.hasOwn(request, "id") || !["config/value/write", "config/batchWrite"].includes(request.method)
    || !request.params || typeof request.params !== "object") return { request };
  const edits = request.method === "config/value/write" ? [request.params] : request.params.edits;
  if (!Array.isArray(edits)) return { request };
  let hints = [], changed = false;
  const normalized = [];
  for (const edit of edits) {
    if (!edit || typeof edit !== "object" || !Object.hasOwn(edit, "value")) return { request };
    let keys;
    try { keys = codexConfigKeySegments(edit.keyPath); } catch { return { request }; }
    const replaced = overwritten(keys, edit.value, edit.mergeStrategy);
    hints = hints.filter(hint => !replaced.some(parent => parent.length <= hint.keys.length && parent.every((key, index) => key === hint.keys[index])));
    const nextHints = codexSettingsPathHints(edit.value, keys, entry.options);
    changed ||= nextHints.length > 0;
    hints.push(...nextHints);
    normalized.push({ ...edit, value: normalizeCodexSettingsValue(edit.value, keys, entry.options) });
  }
  if (!changed) return { request };
  const params = request.method === "config/value/write" ? normalized[0] : { ...request.params, edits: normalized };
  const forwarded = { ...request, params };
  if (!hints.length) return { request: forwarded };
  const directory = path.join(entry.directory, "intents");
  durableCodexMkdir(directory);
  const file = path.join(directory, `${randomUUID()}.json`);
  const record = { schema: 1, origin: entry.origin, outcome: "pending", hints };
  write(file, record);
  return { request: forwarded, intent: { file, record } };
}

export function settleCodexSettingsRequest(intent, response) {
  if (!intent) return;
  if (rejected.has(response?.error?.data?.config_write_error_code)) { remove(intent.file); return; }
  const accepted = ["ok", "okOverridden"].includes(response?.result?.status);
  write(intent.file, { ...intent.record, outcome: accepted ? "accepted" : "uncertain" });
}

export function applyCodexSettingsIntents(entry, text) {
  const directory = path.join(entry.directory, "intents");
  let files;
  try { files = fs.readdirSync(directory).filter(file => /^[a-f0-9-]+\.json$/.test(file)); }
  catch (error) { if (error.code === "ENOENT") return { source: text, consumed: [] }; throw error; }
  const hints = [], consumed = [];
  for (const name of files) {
    const record = JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"));
    if (record.schema !== 1 || record.origin !== entry.origin) throw new Error("Invalid Codex settings path intent.");
    if (record.outcome === "accepted") { hints.push(...record.hints); consumed.push(path.join(directory, name)); }
    // Pending/uncertain records preserve spelling for diagnosis, without
    // claiming a lost response accepted the write or replaying any values.
  }
  return { source: restoreCodexPathHints(text, hints, entry.options), consumed };
}

export function consumeCodexSettingsIntents(files) {
  for (const file of files) {
    try { remove(file); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}
