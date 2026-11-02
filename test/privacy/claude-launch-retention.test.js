import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import test from "node:test";
import { retainClaudeLaunchFiles, retireClaudeLaunchFiles, hasRetainedClaudeLaunchFiles } from "../../src/privacy/claude-launch-retention.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-retention-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const configDir = path.join(root, ".claude"); fs.mkdirSync(configDir, { mode: 0o700 });
  const scratch = fs.mkdtempSync(path.join(configDir, ".aim-private-runtime-"));
  const settings = path.join(root, `.aim-claude-settings-${crypto.randomUUID()}.json`);
  fs.writeFileSync(settings, '{"private":"synthetic"}', { mode: 0o600 });
  return { configDir, scratch, settings, guard: { exclusive: true, assertOwned() {} } };
}

test("retained launch files remain until the exclusive stopped-owner transition", t => {
  const f = fixture(t); retainClaudeLaunchFiles(f);
  assert.ok(hasRetainedClaudeLaunchFiles(f.configDir));
  assert.throws(() => retireClaudeLaunchFiles({ ...f, guard: { ...f.guard, exclusive: false } }));
  assert.ok(fs.existsSync(f.settings)); assert.ok(fs.existsSync(f.scratch));
  retireClaudeLaunchFiles(f);
  assert.equal(fs.existsSync(f.settings), false); assert.equal(fs.existsSync(f.scratch), false);
  assert.equal(hasRetainedClaudeLaunchFiles(f.configDir), false);
});

test("cleanup preserves substituted user data and retries already removed files", t => {
  const f = fixture(t); retainClaudeLaunchFiles(f);
  fs.renameSync(f.settings, f.settings + ".original"); fs.writeFileSync(f.settings, "keep", { mode: 0o600 });
  assert.throws(() => retireClaudeLaunchFiles(f)); assert.equal(fs.readFileSync(f.settings, "utf8"), "keep");
  fs.unlinkSync(f.settings); // Model a prior successful deletion before interruption.
  retireClaudeLaunchFiles(f); assert.equal(hasRetainedClaudeLaunchFiles(f.configDir), false);
  assert.ok(fs.existsSync(f.settings + ".original"));
});


test("stopped saved jobs keep their snapshot and unknown ledger formats keep all snapshots", t => {
  const f = fixture(t); retainClaudeLaunchFiles(f);
  const job = path.join(f.configDir, "jobs/saved"); fs.mkdirSync(job, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(job, "state.json"), JSON.stringify({ state: "stopped", respawnFlags: ["--settings", f.settings] }), { mode: 0o600 });
  retireClaudeLaunchFiles(f); assert.ok(fs.existsSync(f.settings)); assert.ok(fs.existsSync(f.scratch));
  fs.writeFileSync(path.join(job, "state.json"), JSON.stringify({ version: 5, ref: "synthetic" }), { mode: 0o600 });
  retireClaudeLaunchFiles(f); assert.ok(fs.existsSync(f.settings));
  fs.writeFileSync(path.join(job, "state.json"), "null", { mode: 0o600 });
  retireClaudeLaunchFiles(f); assert.ok(fs.existsSync(f.settings));
  fs.rmSync(job, { recursive: true }); retireClaudeLaunchFiles(f);
  assert.equal(fs.existsSync(f.settings), false);
});

test("unpublished receipt fragments do not block subsequent launches", t => {
  const f = fixture(t); retainClaudeLaunchFiles(f);
  fs.writeFileSync(path.join(path.dirname(f.configDir), ".privacy-launches", crypto.randomUUID() + ".json.pending"), '{"schema":', { mode: 0o600 });
  retireClaudeLaunchFiles(f); assert.equal(hasRetainedClaudeLaunchFiles(f.configDir), false);
});
