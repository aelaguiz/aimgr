import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import test from "node:test";
import { acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "aim-assignment-lock-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
const moduleUrl = new URL("../../src/network/claude-offline-binding.js", import.meta.url).href;
const supervisorPath = new URL("../../src/targets/claude-supervisor.js", import.meta.url).pathname;

test("the exited acquisition helper leaves concurrent shared locks owned by AIM", async t => {
  const root = home(t);
  const one = await acquireClaudeAssignmentLock(root, "a");
  const two = await acquireClaudeAssignmentLock(root, "a");
  const other = await acquireClaudeAssignmentLock(root, "b", { exclusive: true });
  try {
    one.assertOwned(); two.assertOwned(); other.assertOwned();
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
    await one.release();
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
    await two.release();
    const exclusive = await acquireClaudeAssignmentLock(root, "a", { exclusive: true });
    await exclusive.release();
  } finally { await one.release(); await two.release(); await other.release(); }
});

test("a trusted supervisor's inherited reference holds admission after parent release", async t => {
  const root = home(t), lock = await acquireClaudeAssignmentLock(root, "a");
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    'import fs from "node:fs"; fs.fstatSync(3); process.stdout.write("ready\\n"); process.stdin.resume();'],
  { stdio: ["pipe", "pipe", "pipe", lock.fd], env: { PATH: "/usr/bin:/bin" } });
  const closed = once(child, "close");
  try {
    assert.equal((await once(child.stdout, "data"))[0].toString(), "ready\n");
    await lock.release();
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
  } finally { child.stdin.end(); await closed; await lock.release(); }
  const next = await acquireClaudeAssignmentLock(root, "a", { exclusive: true });
  await next.release();
});

test("OS process death releases the last owned reference without a stale lock file", async t => {
  const root = home(t);
  const child = spawn(process.execPath, ["--input-type=module", "-e",
    `import { acquireClaudeAssignmentLock } from ${JSON.stringify(moduleUrl)};
     await acquireClaudeAssignmentLock(${JSON.stringify(root)}, "a", { exclusive: true });
     process.stdout.write("ready\\n"); process.stdin.resume();`],
  { stdio: ["pipe", "pipe", "pipe"], env: { PATH: "/usr/bin:/bin" } });
  const closed = once(child, "close");
  try {
    assert.equal((await once(child.stdout, "data"))[0].toString(), "ready\n");
    await assert.rejects(acquireClaudeAssignmentLock(root, "a"), /lock is unavailable/);
  } finally { child.kill("SIGKILL"); await closed; }
  const next = await acquireClaudeAssignmentLock(root, "a", { exclusive: true });
  await next.release();
});

test("the real supervisor holds coordination through disconnect without passing it to its child", async t => {
  const root = home(t), lock = await acquireClaudeAssignmentLock(root, "a");
  const identity = fs.fstatSync(lock.fd);
  const code = `const fs=require('fs'); let inherited=false;
    for(let fd=3;fd<64;fd++) { try { const s=fs.fstatSync(fd);
      if(s.dev===${identity.dev} && s.ino===${identity.ino}) inherited=true; } catch {} }
    process.on('SIGTERM',()=>{ process.stdout.write('terminating\\n'); const waiter=setInterval(()=>{if(fs.existsSync(${JSON.stringify(path.join(root, "release-child"))})){clearInterval(waiter);process.exit(0);}},10); });
    process.stdout.write(inherited?'lock-leaked\\n':'ready\\n'); setInterval(()=>{},1000);`;
  const child = spawn(process.execPath, [supervisorPath, process.execPath, "-e", code],
    { stdio: ["ignore", "pipe", "pipe", "ipc", lock.fd], env: { PATH: "/usr/bin:/bin" } });
  // This test deliberately disconnects IPC itself. Use the process-exit event
  // as the OS-lock lifetime evidence; some Node versions fail to emit close
  // after an explicit disconnect despite all streams ending and process exit.
  const closed = once(child, "exit");
  try {
    assert.equal((await once(child.stdout, "data"))[0].toString(), "ready\n");
    await lock.release();
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
    const terminating = once(child.stdout, "data");
    child.disconnect();
    assert.equal((await terminating)[0].toString(), "terminating\n");
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
    fs.writeFileSync(path.join(root, "release-child"), "ok");
    await closed;
    const next = await acquireClaudeAssignmentLock(root, "a", { exclusive: true });
    await next.release();
  } finally {
    fs.writeFileSync(path.join(root, "release-child"), "ok");
    if (child.connected) child.disconnect();
    await closed;
    await lock.release();
  }
});

test("unsafe or replaced inodes refuse without locking another file", async t => {
  const root = home(t), directory = path.join(root, ".aimgr/claude-egress");
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  const file = path.join(directory, "a.json.lock"), other = path.join(root, "other");
  fs.writeFileSync(other, "unchanged", { mode: 0o600 });
  fs.symlinkSync(other, file);
  await assert.rejects(acquireClaudeAssignmentLock(root, "a"), /lock is unavailable/);
  assert.equal(fs.readFileSync(other, "utf8"), "unchanged");
  fs.unlinkSync(file);
  const lock = await acquireClaudeAssignmentLock(root, "a");
  try {
    fs.renameSync(file, file + ".old");
    fs.writeFileSync(file, "", { mode: 0o600 });
    assert.throws(lock.assertOwned, /lock is unavailable/);
    assert.equal(lock.signal.aborted, true);
  } finally { await lock.release(); }
});

test("legacy public-mode lock upgrades in place without splitting a live shared holder", async t => {
  const root = home(t), holder = await acquireClaudeAssignmentLock(root, "a");
  const file = path.join(root, ".aimgr/claude-egress/a.json.lock");
  const before = fs.statSync(file);
  // Reproduce the old helper's usual umask-022 creation mode on the same inode.
  fs.chmodSync(file, 0o644);
  try {
    const next = await acquireClaudeAssignmentLock(root, "a");
    await next.release();
    assert.equal(fs.statSync(file).ino, before.ino);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    holder.assertOwned();
    await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/);
  } finally { await holder.release(); }
});


test("a launch waits for a short exclusive transition without weakening exclusivity", async t => {
  const root = home(t), exclusive = await acquireClaudeAssignmentLock(root, "a", { exclusive: true });
  const joining = acquireClaudeAssignmentLock(root, "a", { waitForTransition: true });
  let settled = false; joining.then(() => { settled = true; });
  await new Promise(resolve => setTimeout(resolve, 100)); assert.equal(settled, false);
  await exclusive.release(); const shared = await joining;
  try { shared.assertOwned(); await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }), /lock is unavailable/); }
  finally { await shared.release(); }
});
