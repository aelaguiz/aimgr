// Synthetic design proof, not production code or a replacement for native parity tests.
// Pass the installed toml-eslint-parser 1.0.3 entrypoint as argv[2].
import assert from 'node:assert/strict';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const { parseTOML, getStaticTOMLValue } = await import(pathToFileURL(process.argv[2]));
const parse = text => parseTOML(text, { tomlVersion: '1.0.0' });
const value = text => getStaticTOMLValue(parse(text));

function strings(text) {
  const leaves = [];
  function visit(node, keys = []) {
    if (node.type === 'TOMLKeyValue') {
      visit(node.value, [...keys, ...node.key.keys.map(k => k.name ?? k.value)]);
    } else if (node.type === 'TOMLTable') {
      node.body.forEach(child => visit(child, node.resolvedKey));
    } else if (node.type === 'TOMLArray') {
      node.elements.forEach((child, index) => visit(child, [...keys, index]));
    } else if (node.type === 'TOMLValue' && node.kind === 'string') {
      leaves.push({ keys, text: node.value, range: node.range });
    } else if (Array.isArray(node.body)) {
      node.body.forEach(child => visit(child, keys));
    }
  }
  visit(parse(text));
  return leaves;
}

// Deliberately a subset of the release manifest: test the AST/span mechanism.
function isPath(keys) {
  let k = keys;
  if (k[0] === 'profiles' && k.length >= 3) k = k.slice(2);
  return (k.length === 1 && ['model_instructions_file', 'sqlite_home', 'log_dir',
    'model_catalog_json', 'experimental_compact_prompt_file'].includes(k[0])) ||
    (k.length === 3 && k[0] === 'agents' && k[2] === 'config_file') ||
    (k.length === 4 && k[0] === 'skills' && k[1] === 'config' && k[3] === 'path') ||
    (k.length === 3 && k[0] === 'sandbox_workspace_write' && k[1] === 'writable_roots');
}

function patch(text, edits) {
  return edits.sort((a, b) => b.range[0] - a.range[0]).reduce(
    (result, edit) => result.slice(0, edit.range[0]) + JSON.stringify(edit.text) +
      result.slice(edit.range[1]), text);
}
function project(text, sourceFile) {
  return patch(text, strings(text).filter(leaf => isPath(leaf.keys)).map(leaf => ({
    ...leaf, text: path.posix.resolve(path.posix.dirname(sourceFile), leaf.text),
  })));
}
function retainAuthoredPaths(nativeText, originalText, originalView) {
  const key = leaf => JSON.stringify(leaf.keys);
  const originals = new Map(strings(originalText).map(leaf => [key(leaf), leaf]));
  const views = new Map(strings(originalView).map(leaf => [key(leaf), leaf]));
  return patch(nativeText, strings(nativeText).filter(leaf =>
    isPath(leaf.keys) && originals.has(key(leaf)) &&
    leaf.text === views.get(key(leaf))?.text,
  ).map(leaf => ({ ...leaf, text: originals.get(key(leaf)).text })));
}

const source = `# synthetic settings; a comment with Unicode: α
model = "original"
model_instructions_file = './instructions.md' # keep this comment
unknown_path = "do/not/interpret"
[skills]
config = [{path="./skills/one",enabled=true}, {path="../two",enabled=false}]
[agents.reviewer]
config_file = "../roles/reviewer.toml"
[mcp_servers.example]
cwd = "./mcp working dir"
[sandbox_workspace_write]
writable_roots = [".", "./", "../../", "/absolute"]
`;
const origin = '/synthetic/shared settings/config.toml';
const projected = project(source, origin);
const p = value(projected);
assert.equal(p.model_instructions_file, '/synthetic/shared settings/instructions.md');
assert.equal(p.skills.config[1].path, '/synthetic/two');
assert.equal(p.agents.reviewer.config_file, '/synthetic/roles/reviewer.toml');
// This native field is LegacyAppPathString, not source-rooted AbsolutePathBuf.
assert.equal(p.mcp_servers.example.cwd, './mcp working dir');
assert.deepEqual(p.sandbox_workspace_write.writable_roots,
  ['/synthetic/shared settings', '/synthetic/shared settings', '/', '/absolute']);
assert.equal(p.unknown_path, 'do/not/interpret');
assert.ok(projected.includes('# keep this comment'));
assert.equal(project(projected, origin), projected);

const native = projected.replace('enabled=true', 'enabled=false').replace('"original"', '"changed"');
const written = retainAuthoredPaths(native, source, projected);
assert.equal(value(written).skills.config[0].path, './skills/one');
assert.equal(value(written).skills.config[0].enabled, false);
assert.equal(value(written).model, 'changed');
assert.equal(project(written, origin), native);

const profile = 'model_instructions_file = "./profile.md"\n';
assert.equal(value(project(profile, '/synthetic/profiles/work.config.toml')).model_instructions_file,
  '/synthetic/profiles/profile.md');
const arrayTable = '[[skills.config]]\npath="../alpha"\nenabled=true\n[[skills.config]]\npath="./beta"\nenabled=false\n';
assert.equal(value(project(arrayTable, origin)).skills.config[1].path, '/synthetic/shared settings/beta');
assert.throws(() => project('model = [', origin));
assert.equal(project('', origin), '');

console.log(JSON.stringify({
  path_span_projection: 'pass', authored_relative_path_round_trip: 'pass',
  native_like_skill_and_model_edits: 'pass', separate_profile_origin: 'pass',
  inline_and_array_tables: 'pass', invalid_and_empty_input: 'pass',
  scope: 'synthetic subset; no native loader, concurrency or durability certification',
  vendor_execution: false, real_settings_touched: false,
}, null, 2));
