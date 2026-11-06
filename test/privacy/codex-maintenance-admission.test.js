import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { assertCodexMaintenanceClear } from "../../src/privacy/codex-maintenance.js";
import { handleCodex } from "../../src/cli/commands/codex.js";

const enabled = process.env.AIMGR_TEST_CODEX_MAINTENANCE === "1";
test("pending explicit maintenance refuses CLI account selection before Redis or refresh", { skip: !enabled }, async () => {
  assert.notEqual(process.getuid(), 0);
  assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
  const pending = `/opt/aimgr-codex-runtime/users/${process.getuid()}/maintenance/pending.json`;
  assert.ok(!fs.existsSync(pending));
  assertCodexMaintenanceClear();
  fs.writeFileSync(pending, '{"synthetic":true}\n', { flag: "wx", mode: 0o600 });
  try {
    for (const command of ["use", "run", "watch", "resume", "resume-fresh"]) {
      // No runtime/account/auth dependencies are provided: refusal precedes
      // every one of them, including a routine's `aim codex use` selector.
      await assert.rejects(handleCodex({ positional: ["codex", command] }), /maintenance is pending/);
    }
    assert.throws(() => assertCodexMaintenanceClear(), /maintenance is pending/);
    fs.unlinkSync(pending);
    fs.symlinkSync(path.join(path.dirname(pending), "absent-target"), pending);
    assert.throws(() => assertCodexMaintenanceClear(), /maintenance is pending/);
  } finally { fs.unlinkSync(pending); }
  assertCodexMaintenanceClear();
});
