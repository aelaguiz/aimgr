import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { joinLocalClaudeSessions, readMachineClaudeSessionCounts } from "../../src/targets/claude-machine-lease.js";
import { mkTempHome } from "../helpers/files.js";

test("local sessions share informational counts, prune dead processes, and release independently", async t => {
  const homeDir = mkTempHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const alive = new Set([101, 102, 103]);
  const options = { homeDir, label: "pro7", isAliveImpl: pid => alive.has(pid) };
  const leaveOne = await joinLocalClaudeSessions({ ...options, pid: 101 });
  const leaveTwo = await joinLocalClaudeSessions({ ...options, pid: 102 });
  assert.deepEqual([...readMachineClaudeSessionCounts(options)], [["pro7", 2]]);
  alive.delete(101);
  assert.deepEqual([...readMachineClaudeSessionCounts(options)], [["pro7", 1]]);
  const leaveThree = await joinLocalClaudeSessions({ ...options, pid: 103 });
  assert.deepEqual([...readMachineClaudeSessionCounts(options)], [["pro7", 2]]);
  await leaveOne();
  await leaveTwo();
  assert.deepEqual([...readMachineClaudeSessionCounts(options)], [["pro7", 1]]);
  await leaveThree();
  assert.deepEqual([...readMachineClaudeSessionCounts(options)], []);
});

test("local-prefixed labels remain distinct and separate homes can use the same account", async t => {
  const first = mkTempHome(), second = mkTempHome();
  t.after(() => { for (const home of [first, second]) fs.rmSync(home, { recursive: true, force: true }); });
  const isAliveImpl = () => true;
  const leaveFirst = await joinLocalClaudeSessions({ homeDir: first, label: "pro7", pid: 201, isAliveImpl });
  const leavePrefixed = await joinLocalClaudeSessions({ homeDir: first, label: "local-pro7", pid: 202, isAliveImpl });
  const leaveSecond = await joinLocalClaudeSessions({ homeDir: second, label: "pro7", pid: 203, isAliveImpl });
  assert.deepEqual(Object.fromEntries(readMachineClaudeSessionCounts({ homeDir: first, isAliveImpl })), { "local-pro7": 1, pro7: 1 });
  assert.deepEqual(Object.fromEntries(readMachineClaudeSessionCounts({ homeDir: second, isAliveImpl })), { pro7: 1 });
  await leaveFirst(); await leavePrefixed(); await leaveSecond();
});

test("retired remote lease receipts do not count as local sessions", async t => {
  const homeDir = mkTempHome();
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const dir = path.join(homeDir, ".aimgr", "runtime", "claude-leases");
  fs.mkdirSync(dir, { recursive: true });
  for (const name of ["pro7.json", "local-pro8.json"]) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify({ token: "old-redis-lease-token", members: [301] }));
  }
  assert.deepEqual([...readMachineClaudeSessionCounts({ homeDir, isAliveImpl: () => true })], []);
});
