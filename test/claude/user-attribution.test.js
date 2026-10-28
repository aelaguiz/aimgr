import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { syncManagedClaudeUserSettings } from "../../src/targets/claude-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

test("managed accounts inherit disabled attribution without copying account-sensitive settings", (t) => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".aimgr", "claude-homes", "new-account", ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  const attribution = { commit: "", pr: "", sessionUrl: false };
  writeJson(path.join(home, ".claude", "settings.json"), {
    attribution,
    includeCoAuthoredBy: false,
    env: { ANTHROPIC_API_KEY: "must-not-copy" },
    apiKeyHelper: "must-not-copy",
  });
  const overlay = syncManagedClaudeUserSettings({ userHomeDir: home, configDir });
  const actual = JSON.parse(fs.readFileSync(overlay, "utf8"));
  assert.deepEqual(actual.attribution, attribution);
  assert.equal(actual.includeCoAuthoredBy, false);
  assert.equal(actual.env, undefined);
  assert.equal(actual.apiKeyHelper, undefined);
  assert.equal(actual.statusLine.type, "command");

  writeJson(path.join(home, ".claude", "settings.json"), {});
  syncManagedClaudeUserSettings({ userHomeDir: home, configDir });
  const reset = JSON.parse(fs.readFileSync(overlay, "utf8"));
  assert.equal(reset.attribution, undefined);
  assert.equal(reset.includeCoAuthoredBy, undefined);
});
