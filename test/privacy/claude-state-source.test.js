import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { readClaudeActiveAppState } from "../../src/privacy/claude-state-source.js";

function fixture(t) {
  const configDir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-active-state-")));
  t.after(() => fs.rmSync(configDir, { recursive: true, force: true }));
  return { configDir, legacy: path.join(configDir, ".config.json"), canonical: path.join(configDir, ".claude.json") };
}

test("legacy byte-size selection cannot misattribute a canonical account's credentials", t => {
  const { configDir, legacy, canonical } = fixture(t);
  fs.writeFileSync(canonical, JSON.stringify({ oauthAccount: { accountUuid: "canonical" } }));
  fs.writeFileSync(legacy, JSON.stringify({ oauthAccount: { accountUuid: "native-selected" }, mcpServers: { required: true } }));
  const active = readClaudeActiveAppState({ configDir });
  assert.equal(active.file, legacy);
  assert.equal(active.state.oauthAccount.accountUuid, "native-selected");
  assert.deepEqual(active.state.mcpServers, { required: true });
  for (const invalid of [" ", "{invalid", "null", "[]"]) {
    fs.writeFileSync(legacy, invalid);
    assert.throws(() => readClaudeActiveAppState({ configDir }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
    assert.equal(JSON.parse(fs.readFileSync(canonical)).oauthAccount.accountUuid, "canonical");
  }
});

test("empty legacy state follows native write-bit and canonical-existence selection", t => {
  const { configDir, legacy, canonical } = fixture(t);
  assert.equal(readClaudeActiveAppState({ configDir }).exists, false);
  fs.writeFileSync(legacy, "", { mode: 0o600 });
  assert.equal(readClaudeActiveAppState({ configDir }).legacy, true);
  fs.chmodSync(legacy, 0o400);
  assert.equal(readClaudeActiveAppState({ configDir }).exists, false);
  fs.chmodSync(legacy, 0o600);
  fs.writeFileSync(canonical, '{"userID":"canonical-identity"}');
  assert.equal(readClaudeActiveAppState({ configDir }).legacy, false);
  assert.equal(readClaudeActiveAppState({ configDir }).state.userID, "canonical-identity");
});

test("a selected legacy symlink refuses and backups never become automatic identity sources", t => {
  const { configDir, legacy, canonical } = fixture(t);
  fs.writeFileSync(canonical + ".backup", '{"userID":"old-private-id"}');
  assert.deepEqual(readClaudeActiveAppState({ configDir }).state, {});
  fs.symlinkSync(canonical + ".backup", legacy);
  assert.throws(() => readClaudeActiveAppState({ configDir }), { code: "AIMGR_CLAUDE_PRIVATE_IDENTITY" });
});
