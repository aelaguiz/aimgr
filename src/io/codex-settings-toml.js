import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { parseTOML, getStaticTOMLValue } from "toml-eslint-parser";

// Matches ConfigToml's present AbsolutePathBuf fields at the approved source.
// MCP cwd and other plain strings intentionally keep native interpretation.
const ROOT_PATHS = new Set(["model_instructions_file", "sqlite_home", "log_dir", "model_catalog_json", "experimental_compact_prompt_file", "js_repl_node_path"]);
const PROFILE_PATHS = new Set(["model_instructions_file", "model_catalog_json", "experimental_compact_prompt_file", "js_repl_node_path"]);
const TLS_PATHS = new Set(["ca-certificate", "client-certificate", "client-private-key"]);
const equal = isDeepStrictEqual;
const keyOf = keys => JSON.stringify(keys);
class TomlAtom {
  constructor(node, raw) {
    this.kind = node.kind;
    this.value = node.kind === "integer" ? node.bigint : node.value instanceof Date ? node.datetime.replace("t", "T").replace(" ", "T") : node.value;
    // Spelling belongs to rendering, not semantic conflict detection.
    Object.defineProperty(this, "raw", { value: raw });
  }
}
const object = value => value !== null && typeof value === "object" && !Array.isArray(value) && !(value instanceof Date) && !(value instanceof TomlAtom);
const copyValue = value => Array.isArray(value) ? value.map(copyValue) : object(value) ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, copyValue(v)])) : value;
const prefix = (parent, child) => parent.length <= child.length && parent.every((v, i) => v === child[i]);

export function codexSourcePath(keys) {
  if (keys[0] === "profiles" && keys.length >= 3) {
    const k = keys.slice(2);
    return (k.length === 1 && PROFILE_PATHS.has(k[0])) ||
      (k.length === 2 && k[0] === "js_repl_node_module_dirs" && Number.isInteger(k[1]));
  }
  return (keys.length === 1 && ROOT_PATHS.has(keys[0])) ||
    (keys.length === 2 && keys[0] === "js_repl_node_module_dirs" && Number.isInteger(keys[1])) ||
    (keys.length === 3 && keys[0] === "agents" && keys[2] === "config_file") ||
    (keys.length === 4 && keys[0] === "skills" && keys[1] === "config" && Number.isInteger(keys[2]) && keys[3] === "path") ||
    (keys.length === 4 && keys[0] === "model_providers" && keys[2] === "auth" && keys[3] === "cwd") ||
    (keys.length === 3 && keys[0] === "sandbox_workspace_write" && keys[1] === "writable_roots" && Number.isInteger(keys[2])) ||
    (keys.length === 5 && keys[0] === "otel" && ["exporter", "trace_exporter", "metrics_exporter"].includes(keys[1]) &&
      ["otlp-http", "otlp-grpc"].includes(keys[2]) && keys[3] === "tls" && TLS_PATHS.has(keys[4]));
}

function resolvePath(value, source, home) {
  if (value === "~" || value.startsWith("~/")) value = path.join(home, value.slice(2));
  return path.resolve(path.dirname(source), value);
}

export function parseCodexSettings(text) {
  const ast = parseTOML(text, { tomlVersion: "1.0.0" });
  return { ast, value: getStaticTOMLValue(ast) };
}

function inspect(text) {
  const { ast, value } = parseCodexSettings(text);
  const values = [], assignments = [], tables = [];
  function visit(node, keys = [], owner) {
    if (node.type === "TOMLKeyValue") {
      const full = [...keys, ...node.key.keys.map(k => k.name ?? k.value)];
      assignments.push({ keys: full, node, owner });
      visit(node.value, full, node);
    } else if (node.type === "TOMLTable") {
      tables.push({ keys: node.resolvedKey, node });
      node.body.forEach(child => visit(child, node.resolvedKey, node));
    } else if (node.type === "TOMLArray") {
      values.push({ keys, node });
      node.elements.forEach((child, i) => visit(child, [...keys, i], node));
    } else if (node.type === "TOMLInlineTable") {
      values.push({ keys, node });
      node.body.forEach(child => visit(child, keys, node));
    } else if (node.type === "TOMLValue") {
      values.push({ keys, node });
      if (!["string", "boolean"].includes(node.kind)) {
        let parent = value;
        for (const key of keys.slice(0, -1)) parent = parent[key];
        parent[keys.at(-1)] = new TomlAtom(node, text.slice(...node.range));
      }
    } else if (Array.isArray(node.body)) node.body.forEach(child => visit(child, keys, node));
  }
  visit(ast);
  return { value, values, assignments, tables, comments: ast.comments };
}

function edits(text, changes) {
  return changes.sort((a, b) => b.start - a.start || b.end - a.end).reduce(
    (result, edit) => result.slice(0, edit.start) + edit.text + result.slice(edit.end), text);
}

export function projectCodexSettings(text, { source, home }) {
  const parsed = inspect(text);
  return edits(text, parsed.values.filter(({ keys, node }) => codexSourcePath(keys) && node.kind === "string")
    .map(({ node }) => ({ start: node.range[0], end: node.range[1], text: JSON.stringify(resolvePath(node.value, source, home)) })));
}

export function normalizeCodexSettingsValue(value, keys, options) {
  if (typeof value === "string" && codexSourcePath(keys)) return resolvePath(value, options.source, options.home);
  if (Array.isArray(value)) return value.map((v, i) => normalizeCodexSettingsValue(v, [...keys, i], options));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, normalizeCodexSettingsValue(v, [...keys, k], options)]));
  return value;
}

export function codexSettingsPathHints(value, keys, options) {
  if (typeof value === "string" && codexSourcePath(keys)) {
    const target = resolvePath(value, options.source, options.home);
    return value === target ? [] : [{ keys, target, spelling: value }];
  }
  if (Array.isArray(value)) return value.flatMap((v, i) => codexSettingsPathHints(v, [...keys, i], options));
  if (object(value)) return Object.entries(value).flatMap(([k, v]) => codexSettingsPathHints(v, [...keys, k], options));
  return [];
}

/** Intent changes spelling only. A source-winning merge has already selected
 * every value, and no hint can add a field or change its resolved target. */
export function restoreCodexPathHints(text, hints, options) {
  const parsed = inspect(text), candidates = new Map();
  for (const hint of hints) {
    const id = keyOf([hint.keys.map(k => Number.isInteger(k) ? "[]" : k), hint.target]);
    if (!candidates.has(id)) candidates.set(id, hint.spelling);
    else if (candidates.get(id) !== hint.spelling) candidates.set(id, null);
  }
  return edits(text, parsed.values.flatMap(({ keys, node }) => {
    if (!codexSourcePath(keys) || node.kind !== "string" || !path.isAbsolute(node.value)) return [];
    const id = keyOf([keys.map(k => Number.isInteger(k) ? "[]" : k), node.value]);
    const spelling = candidates.get(id);
    if (!spelling || resolvePath(spelling, options.source, options.home) !== node.value) return [];
    return [{ start: node.range[0], end: node.range[1], text: JSON.stringify(spelling) }];
  }));
}

// Restore only unambiguous unchanged targets, also after native array reordering.
export function restoreCodexAuthorPaths(viewText, sourceText, options) {
  const original = inspect(sourceText), current = inspect(viewText), spellings = new Map();
  for (const { keys, node } of original.values) {
    if (!codexSourcePath(keys) || node.kind !== "string") continue;
    const family = keys.map(k => Number.isInteger(k) ? "[]" : k);
    const id = keyOf([family, resolvePath(node.value, options.source, options.home)]);
    const raw = sourceText.slice(...node.range);
    if (!spellings.has(id)) spellings.set(id, raw);
    else if (spellings.get(id) !== raw) spellings.set(id, null);
  }
  return edits(viewText, current.values.flatMap(({ keys, node }) => {
    if (!codexSourcePath(keys) || node.kind !== "string") return [];
    const id = keyOf([keys.map(k => Number.isInteger(k) ? "[]" : k), node.value]);
    return spellings.get(id) ? [{ start: node.range[0], end: node.range[1], text: spellings.get(id) }] : [];
  }));
}

function toml(value) {
  if (value instanceof TomlAtom) return value.raw;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean" || typeof value === "bigint") return String(value);
  if (typeof value === "number") return Number.isNaN(value) ? "nan" : value === Infinity ? "inf" : value === -Infinity ? "-inf" : String(value);
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return `[${value.map(toml).join(", ")}]`;
  if (object(value)) return `{ ${Object.entries(value).map(([k, v]) => `${JSON.stringify(k)} = ${toml(v)}`).join(", ")} }`;
  throw new Error("Unsupported TOML value in Codex settings edit.");
}

function get(value, keys) { return keys.reduce((v, k) => v?.[k], value); }

function tableText(keys, value) {
  let text = `\n[${keys.map(k => JSON.stringify(k)).join(".")}]\n`;
  for (const [key, child] of Object.entries(value)) {
    if (!object(child)) text += `${JSON.stringify(key)} = ${toml(child)}\n`;
  }
  for (const [key, child] of Object.entries(value)) {
    if (object(child)) text += tableText([...keys, key], child);
  }
  return text;
}

function changed(before, after, keys = []) {
  if (equal(before, after)) return [];
  if (object(before) && object(after)) return [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .flatMap(k => changed(before[k], after[k], [...keys, k]));
  return [{ keys, value: after }];
}

function applyValue(text, keys, value) {
  const parsed = inspect(text);
  const previous = get(parsed.value, keys);
  if (equal(previous, value)) return text;
  // Arrays remain atomic conflict units. After accepting an edit, patch only
  // changed children when the shape permits it, retaining literals/comments.
  if ((Array.isArray(previous) && Array.isArray(value) && previous.length === value.length) ||
      (object(previous) && object(value) && equal(Object.keys(previous).sort(), Object.keys(value).sort()))) {
    for (const key of Object.keys(value)) text = applyValue(text, [...keys, Array.isArray(value) ? Number(key) : key], value[key]);
    return text;
  }
  const exact = parsed.values.find(item => equal(item.keys, keys));
  if (exact && value !== undefined) {
    let replacement = toml(value);
    const comments = parsed.comments.filter(c => c.range[0] >= exact.node.range[0] && c.range[1] <= exact.node.range[1]);
    if (comments.length && Array.isArray(value)) replacement = "[\n" + comments.map(c => text.slice(...c.range)).join("\n") + "\n" + replacement.slice(1);
    return edits(text, [{ start: exact.node.range[0], end: exact.node.range[1], text: replacement }]);
  }
  // Prefer the outer assignment for arrays/inline tables: its replacement is
  // atomic and cannot introduce invalid commas or duplicate TOML declarations.
  const container = parsed.assignments.find(item => prefix(item.keys, keys));
  if (container) {
    const relative = keys.slice(container.keys.length);
    if (!relative.length) {
      const range = value === undefined ? container.node.range : container.node.value.range;
      return edits(text, [{ start: range[0], end: range[1], text: value === undefined ? "" : toml(value) }]);
    }
    const copy = copyValue(get(parsed.value, container.keys));
    let parent = copy;
    for (const key of relative.slice(0, -1)) parent = parent[key] ??= {};
    if (value === undefined) delete parent[relative.at(-1)]; else parent[relative.at(-1)] = value;
    return edits(text, [{ start: container.node.value.range[0], end: container.node.value.range[1], text: toml(copy) }]);
  }
  const descendants = parsed.assignments.filter(item => prefix(keys, item.keys));
  const tables = parsed.tables.filter(item => prefix(keys, item.keys));
  if (descendants.length || tables.length) {
    const roots = tables.filter(item => !tables.some(other => other !== item && other.node.range[0] < item.node.range[0] && other.node.range[1] >= item.node.range[1]));
    const removals = [...roots.map(item => item.node.range), ...descendants.filter(item => !roots.some(t => prefix(t.keys, item.keys))).map(item => item.node.range)];
    text = edits(text, removals.map(range => ({ start: range[0], end: range[1], text: "" })));
    return value === undefined ? text : applyValue(text, keys, value);
  }
  if (value === undefined) return text;
  // Newly added native tables must remain tables. Converting one to an inline
  // assignment changes toml_edit's later table-conversion path; native can
  // carry that assignment's newline decor inside an invalid table header.
  // Existing authored inline assignments were handled above and retain their
  // form. Append an explicit header so surrounding table scope is unchanged.
  if (object(value)) return text + tableText(keys, value);
  const parentTable = parsed.tables.filter(item => prefix(item.keys, keys) && item.keys.length < keys.length)
    .sort((a, b) => b.keys.length - a.keys.length)[0];
  const offset = parentTable ? parentTable.node.range[1] : (parsed.tables[0]?.node.range[0] ?? text.length);
  const key = keys.slice(parentTable?.keys.length ?? 0).map(k => JSON.stringify(k)).join(".");
  return text.slice(0, offset) + `\n${key} = ${toml(value)}\n` + text.slice(offset);
}

export function updateCodexSettings(text, changes) {
  for (const { keys, value } of changes) text = applyValue(text, keys, value);
  return text;
}

export function mergeCodexSettings({ baseSource, baseView, source, view, origin, home }) {
  const options = { source: origin, home };
  const sourceValue = inspect(projectCodexSettings(source, options)).value;
  const baseSourceValue = inspect(projectCodexSettings(baseSource, options)).value;
  const baseViewValue = inspect(baseView).value;
  const viewValue = inspect(projectCodexSettings(view, options)).value;
  const nativeEdits = changed(baseViewValue, viewValue);
  const sourceEdits = changed(baseSourceValue, sourceValue);
  const authoredNative = inspect(restoreCodexAuthorPaths(view, baseSource, options)).value;
  const conflicts = [];
  let result = source;
  for (const edit of nativeEdits) {
    if (equal(get(sourceValue, edit.keys), edit.value)) continue;
    if (sourceEdits.some(s => prefix(s.keys, edit.keys) || prefix(edit.keys, s.keys))) {
      conflicts.push(edit.keys);
      continue;
    }
    result = applyValue(result, edit.keys, get(authoredNative, edit.keys));
  }
  const projected = projectCodexSettings(result, options);
  return { source: result, view: projected, conflicts };
}

// Native's config_manager_service quoted-segment grammar, including escaped
// characters inside quotes. Validation errors still come from native Codex.
export function codexConfigKeySegments(input) {
  if (typeof input !== "string" || !input.trim()) throw new Error("Invalid Codex config key path.");
  const parts = []; let part = "", quoted = false, escaped = false;
  for (const char of input) {
    if (escaped) { part += char; escaped = false; }
    else if (quoted && char === "\\") escaped = true;
    else if (char === '"' && !part && !quoted) quoted = true;
    else if (char === '"' && quoted) quoted = false;
    else if (char === '"') throw new Error("Invalid Codex config key path.");
    else if (char === "." && !quoted) { if (!part) throw new Error("Invalid Codex config key path."); parts.push(part); part = ""; }
    else part += char;
  }
  if (quoted || escaped || !part) throw new Error("Invalid Codex config key path.");
  parts.push(part);
  return parts;
}
