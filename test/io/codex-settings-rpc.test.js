import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexSettingsView, reconcileCodexSettings } from "../../src/io/codex-settings.js";
import { prepareCodexSettingsRequest, settleCodexSettingsRequest } from "../../src/io/codex-settings-intents.js";
import { parseCodexSettings } from "../../src/io/codex-settings-toml.js";

async function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-rpc-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, "original", "config.toml");
  fs.mkdirSync(path.dirname(source)); fs.writeFileSync(source, 'model="old"\n');
  const entry = codexSettingsView({ base: path.join(root, "aim"), source, home: root });
  await reconcileCodexSettings(entry);
  const read = file => parseCodexSettings(fs.readFileSync(file, "utf8")).value;
  return { root, source, entry, read };
}
function request(value = "./instructions.md") {
  return { id: "1", method: "config/batchWrite", params: { expectedVersion: "native-version", reloadUserConfig: true,
    edits: [{ keyPath: "model", value: "new", mergeStrategy: "replace" },
      { keyPath: "model_instructions_file", value, mergeStrategy: "upsert" }] } };
}

for (const status of ["ok", "okOverridden"]) test(`mixed RPC normalizes before native reload and restores spelling on ${status}`, async t => {
  const { source, entry, read } = await fixture(t);
  const original = request(), next = prepareCodexSettingsRequest(original, entry);
  assert.equal(next.request.params.edits[1].value, path.join(path.dirname(source), "instructions.md"));
  assert.deepEqual(next.request.params.edits[0], original.params.edits[0]);
  assert.equal(next.request.id, "1");
  assert.equal(next.request.params.expectedVersion, original.params.expectedVersion);
  assert.equal(next.request.params.reloadUserConfig, true);
  assert.equal(JSON.parse(fs.readFileSync(next.intent.file)).outcome, "pending");
  fs.writeFileSync(entry.view, `model="new"\nmodel_instructions_file=${JSON.stringify(next.request.params.edits[1].value)}\n`);
  // The watcher can publish the actual native edit before its response arrives.
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model_instructions_file, next.request.params.edits[1].value);
  settleCodexSettingsRequest(next.intent, { result: { status } });
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model, "new");
  assert.equal(read(source).model_instructions_file, "./instructions.md");
  assert.equal(read(entry.view).model_instructions_file, next.request.params.edits[1].value);
  assert.equal(fs.existsSync(next.intent.file), false);
  // A later intentional absolute spelling must not be rewritten by stale intent.
  fs.writeFileSync(source, `model_instructions_file=${JSON.stringify(next.request.params.edits[1].value)}\n`);
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model_instructions_file, next.request.params.edits[1].value);
});

for (const code of ["configLayerReadonly", "configRequirementReadonly", "configVersionConflict", "configValidationError"]) {
  test(`pre-write ${code} cannot apply hints even when the view already matches`, async t => {
    const { source, entry, read } = await fixture(t);
    const target = path.join(path.dirname(source), "instructions.md");
    fs.writeFileSync(source, `model_instructions_file=${JSON.stringify(target)}\n`);
    await reconcileCodexSettings(entry);
    const next = prepareCodexSettingsRequest(request(), entry);
    await reconcileCodexSettings(entry);
    assert.equal(read(source).model_instructions_file, target);
    settleCodexSettingsRequest(next.intent, { error: { data: { config_write_error_code: code } } });
    await reconcileCodexSettings(entry);
    assert.equal(read(source).model_instructions_file, target);
    assert.equal(fs.existsSync(next.intent.file), false);
  });
}

for (const response of [undefined, { error: { data: { config_write_error_code: "userLayerNotFound" } } }]) {
  test(`lost or post-write response preserves observed values without replay`, async t => {
    const { source, entry, read } = await fixture(t);
    const next = prepareCodexSettingsRequest(request(), entry), target = next.request.params.edits[1].value;
    fs.writeFileSync(entry.view, `model="new"\nmodel_instructions_file=${JSON.stringify(target)}\n`);
    settleCodexSettingsRequest(next.intent, response);
    await reconcileCodexSettings(entry);
    assert.equal(read(source).model, "new");
    assert.equal(read(source).model_instructions_file, target);
    assert.equal(JSON.parse(fs.readFileSync(next.intent.file)).outcome, "uncertain");
    fs.writeFileSync(source, 'model="author"\n');
    await reconcileCodexSettings(entry);
    assert.deepEqual(read(source), { model: "author" });
  });
}

test("a concurrent authored winner cannot be replaced by accepted path intent", async t => {
  const { source, entry, read } = await fixture(t);
  const next = prepareCodexSettingsRequest(request(), entry);
  fs.writeFileSync(source, 'model="author"\nmodel_instructions_file="./author.md"\n');
  fs.writeFileSync(entry.view, `model="new"\nmodel_instructions_file=${JSON.stringify(next.request.params.edits[1].value)}\n`);
  settleCodexSettingsRequest(next.intent, { result: { status: "ok" } });
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model_instructions_file, "./author.md");
  assert.equal(read(source).model, "author");
});

test("whole array and quoted table writes normalize only typed leaves", async t => {
  const { source, entry } = await fixture(t);
  const original = { id: 4, method: "config/value/write", params: { keyPath: 'agents."review.v2"', mergeStrategy: "upsert",
    filePath: "/native-still-validates-this.toml", value: { config_file: "./review.toml", description: "./literal" } } };
  const next = prepareCodexSettingsRequest(original, entry);
  assert.deepEqual(next.request.params.value, { config_file: path.join(path.dirname(source), "review.toml"), description: "./literal" });
  assert.equal(next.request.params.filePath, original.params.filePath);
  const array = request(); array.params.edits = [{ keyPath: "skills", mergeStrategy: "replace", value: { config: [{ path: "./skill", enabled: false }] } }];
  const normalized = prepareCodexSettingsRequest(array, entry);
  assert.equal(normalized.request.params.edits[0].value.config[0].enabled, false);
  assert.equal(normalized.request.params.edits[0].value.config[0].path, path.join(path.dirname(source), "skill"));
  const malformed = request(); malformed.params.edits[0].keyPath = '"broken';
  assert.equal(prepareCodexSettingsRequest(malformed, entry).request, malformed);
  const deleted = request(); deleted.params.edits[1].value = null;
  assert.equal(prepareCodexSettingsRequest(deleted, entry).request, deleted);
});

test("normalization does not depend on an existing parseable view", async t => {
  const { entry } = await fixture(t);
  fs.unlinkSync(entry.view);
  const next = prepareCodexSettingsRequest(request(), entry);
  assert.ok(path.isAbsolute(next.request.params.edits[1].value));
  fs.writeFileSync(entry.view, 'model=[');
  assert.ok(path.isAbsolute(prepareCodexSettingsRequest(request(), entry).request.params.edits[1].value));
});

test("the last ordered batch edit owns its spelling, including an explicit absolute value", async t => {
  const { source, entry, read } = await fixture(t);
  for (const last of [path.join(path.dirname(source), "a.md"), "./sub/../a.md"]) {
    const original = request(); original.params.edits = [
      { keyPath: "model_instructions_file", value: "./a.md", mergeStrategy: "replace" },
      { keyPath: "model_instructions_file", value: last, mergeStrategy: "replace" },
    ];
    const next = prepareCodexSettingsRequest(original, entry);
    fs.writeFileSync(entry.view, `model_instructions_file=${JSON.stringify(path.join(path.dirname(source), "a.md"))}\n`);
    settleCodexSettingsRequest(next.intent, { result: { status: "ok" } });
    await reconcileCodexSettings(entry);
    assert.equal(read(source).model_instructions_file, last);
  }
});

test("committed intent consumption survives interruption before intent-file deletion", async t => {
  const { source, entry, read } = await fixture(t);
  const next = prepareCodexSettingsRequest(request(), entry), target = next.request.params.edits[1].value;
  fs.writeFileSync(entry.view, `model_instructions_file=${JSON.stringify(target)}\n`);
  settleCodexSettingsRequest(next.intent, { result: { status: "ok" } });
  await assert.rejects(reconcileCodexSettings(entry, { fault: point => { if (point === "after-baseline") throw new Error("synthetic crash"); } }));
  fs.writeFileSync(source, `model_instructions_file=${JSON.stringify(target)}\n`);
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model_instructions_file, target);
  assert.equal(fs.existsSync(next.intent.file), false);
});
