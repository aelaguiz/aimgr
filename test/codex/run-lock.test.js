import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  acquireCodexRunLock,
  CodexRunLockHeldError,
  readCodexRunLockStatus,
  resolveCodexRunLockDir,
} from "../../src/targets/codex-run-lock.js";
import { mkTempHome } from "../helpers/files.js";

function managedHome() {
  return path.join(mkTempHome(), ".aimgr", "codex-cli");
}

/** killImpl stub: pids in `dead` raise ESRCH, pids in `eperm` raise EPERM, everything else is alive. */
function fakeKill({ dead = [], eperm = [] } = {}) {
  return (pid) => {
    if (dead.includes(pid)) {
      const err = new Error("ESRCH");
      err.code = "ESRCH";
      throw err;
    }
    if (eperm.includes(pid)) {
      const err = new Error("EPERM");
      err.code = "EPERM";
      throw err;
    }
  };
}

test("a held run lock blocks a second acquire until released", () => {
  const home = managedHome();
  const lock = acquireCodexRunLock({ managedCodexHome: home });
  assert.throws(
    () => acquireCodexRunLock({ managedCodexHome: home }),
    (err) => {
      assert.ok(err instanceof CodexRunLockHeldError);
      assert.equal(err.code, "codex_run_lock_held");
      assert.equal(err.reason, "manager_alive");
      return true;
    },
  );
  assert.equal(lock.release(), true);
  const relock = acquireCodexRunLock({ managedCodexHome: home });
  assert.equal(relock.release(), true);
});

test("markSpawning/recordChildPid/release drive the owner metadata lifecycle", () => {
  const home = managedHome();
  const lock = acquireCodexRunLock({ managedCodexHome: home, nowIso: "2026-08-07T00:00:00.000Z" });
  assert.equal(lock.readOwner().phase, "selecting");
  assert.equal(lock.readOwner().childPid, null);
  assert.equal(lock.readOwner().createdAt, "2026-08-07T00:00:00.000Z");

  lock.markSpawning();
  assert.equal(lock.readOwner().phase, "spawning");

  assert.throws(() => lock.recordChildPid(0), /invalid Codex child pid/);
  lock.recordChildPid(12345);
  assert.equal(lock.readOwner().phase, "running");
  assert.equal(lock.readOwner().childPid, 12345);

  lock.markSpawnFailed();
  assert.equal(lock.readOwner().phase, "selecting");
  assert.equal(lock.readOwner().childPid, null);

  assert.equal(lock.release(), true);
  assert.equal(fs.existsSync(resolveCodexRunLockDir(home)), false);
  // Double release is a no-op.
  assert.equal(lock.release(), false);
});

test("recovery removes a stale lock only when manager and child are proven dead", () => {
  const home = managedHome();
  const stale = acquireCodexRunLock({
    managedCodexHome: home,
    managerPid: 900001,
    killImpl: fakeKill(),
  });
  stale.markSpawning();
  stale.recordChildPid(900002);

  // Live child under a dead manager stays held.
  assert.throws(
    () => acquireCodexRunLock({ managedCodexHome: home, killImpl: fakeKill({ dead: [900001] }) }),
    (err) => err instanceof CodexRunLockHeldError && err.reason === "child_alive",
  );

  // Both proven dead: the lock may be recovered.
  const recovered = acquireCodexRunLock({
    managedCodexHome: home,
    killImpl: fakeKill({ dead: [900001, 900002] }),
  });
  assert.notEqual(recovered.nonce, stale.nonce);
  // The displaced handle must not delete the recovered owner's live lock.
  assert.equal(stale.release(), false);
  assert.equal(fs.existsSync(resolveCodexRunLockDir(home)), true);
  assert.equal(recovered.release(), true);
});

test("EPERM liveness ambiguity counts as alive and fails closed", () => {
  const home = managedHome();
  acquireCodexRunLock({ managedCodexHome: home, managerPid: 900010, killImpl: fakeKill() });
  assert.throws(
    () => acquireCodexRunLock({ managedCodexHome: home, killImpl: fakeKill({ eperm: [900010] }) }),
    (err) => err instanceof CodexRunLockHeldError && err.reason === "manager_alive",
  );
});

test("a dead manager mid-spawn with no recorded child is ambiguous and stays held", () => {
  const home = managedHome();
  const lock = acquireCodexRunLock({ managedCodexHome: home, managerPid: 900020, killImpl: fakeKill() });
  lock.markSpawning();
  assert.throws(
    () => acquireCodexRunLock({ managedCodexHome: home, killImpl: fakeKill({ dead: [900020] }) }),
    (err) => err instanceof CodexRunLockHeldError && err.reason === "spawn_outcome_unknown",
  );
});

test("unreadable owner metadata is never stolen", () => {
  const home = managedHome();
  const lockDir = resolveCodexRunLockDir(home);
  fs.mkdirSync(path.dirname(lockDir), { recursive: true });
  fs.mkdirSync(lockDir);
  fs.writeFileSync(path.join(lockDir, "owner.json"), "not json");
  assert.throws(
    () => acquireCodexRunLock({ managedCodexHome: home, killImpl: fakeKill() }),
    (err) => err instanceof CodexRunLockHeldError && err.reason === "owner_metadata_unreadable",
  );
});

test("readCodexRunLockStatus reports safe booleans only", () => {
  const home = managedHome();
  assert.deepEqual(readCodexRunLockStatus({ managedCodexHome: home }), {
    locked: false,
    lockDir: resolveCodexRunLockDir(home),
  });

  const lock = acquireCodexRunLock({
    managedCodexHome: home,
    managerPid: 900030,
    nowIso: "2026-08-07T00:00:00.000Z",
    killImpl: fakeKill(),
  });
  lock.markSpawning();
  lock.recordChildPid(900031);

  const held = readCodexRunLockStatus({ managedCodexHome: home, killImpl: fakeKill() });
  assert.equal(held.locked, true);
  assert.equal(held.ownerReadable, true);
  assert.equal(held.phase, "running");
  assert.equal(held.createdAt, "2026-08-07T00:00:00.000Z");
  assert.equal(held.managerAlive, true);
  assert.equal(held.childRecorded, true);
  assert.equal(held.childAlive, true);
  assert.equal(held.recoverable, false);
  assert.equal(held.reason, "manager_alive");

  const recoverable = readCodexRunLockStatus({
    managedCodexHome: home,
    killImpl: fakeKill({ dead: [900030, 900031] }),
  });
  assert.equal(recoverable.managerAlive, false);
  assert.equal(recoverable.childAlive, false);
  assert.equal(recoverable.recoverable, true);
  assert.equal(recoverable.reason, "owner_processes_proven_dead");

  lock.release();
});
