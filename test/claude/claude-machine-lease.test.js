import test from "node:test";
import assert from "node:assert/strict";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import {
  joinMachineClaudeLease,
  leaveMachineClaudeLease,
  readMachineClaudeSessionCounts,
} from "../../src/targets/claude-machine-lease.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { mkTempHome } from "../helpers/files.js";

function leaseEntry(client) {
  return [...client.values.entries()].find(([key]) => key.includes(":lease:credential:anthropic:pro7")) ?? null;
}

async function setup() {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  return { home, client, store, options: { homeDir: home, store, provider: "anthropic", label: "pro7" } };
}

test("sessions on one machine share an account lease and the last one out releases it", async () => {
  const { home, client, options } = await setup();
  const alive = new Set([101, 102]);
  const isAliveImpl = (pid) => alive.has(pid);

  const first = await joinMachineClaudeLease({ ...options, pid: 101, isAliveImpl });
  const second = await joinMachineClaudeLease({ ...options, pid: 102, isAliveImpl });
  assert.equal(first.siblings, 0);
  assert.equal(second.siblings, 1);
  assert.equal(readMachineClaudeSessionCounts({ homeDir: home, isAliveImpl }).get("pro7"), 2);

  assert.deepEqual(
    await leaveMachineClaudeLease({ homeDir: home, label: "pro7", lease: first.lease, pid: 101, isAliveImpl }),
    { released: false, remaining: 1 },
  );
  alive.delete(101);
  assert.notEqual(leaseEntry(client), null);
  assert.equal(readMachineClaudeSessionCounts({ homeDir: home, isAliveImpl }).get("pro7"), 1);

  assert.deepEqual(
    await leaveMachineClaudeLease({ homeDir: home, label: "pro7", lease: second.lease, pid: 102, isAliveImpl }),
    { released: true, remaining: 0 },
  );
  assert.equal(leaseEntry(client), null);
  assert.equal(readMachineClaudeSessionCounts({ homeDir: home, isAliveImpl }).size, 0);
});

test("a crashed session is pruned and another owner's lease is never joined", async () => {
  const { home, client, store, options } = await setup();
  await joinMachineClaudeLease({ ...options, pid: 201, isAliveImpl: () => true });
  // 201 died without leaving. 202 reuses the token and does not count 201.
  const onlyAlive = (pid) => pid === 202;
  const next = await joinMachineClaudeLease({ ...options, pid: 202, isAliveImpl: onlyAlive });
  assert.equal(next.siblings, 0);

  // The lease expires while this machine sleeps, and another machine takes it.
  client.values.delete(leaseEntry(client)[0]);
  const otherMachine = await acquireRedisCredentialLease(store, { provider: "anthropic", label: "pro7" });
  assert.equal(await joinMachineClaudeLease({ ...options, pid: 203, isAliveImpl: () => true }), null);

  // The stale local session cannot release the other machine's lease.
  assert.deepEqual(
    await leaveMachineClaudeLease({ homeDir: home, label: "pro7", lease: next.lease, pid: 202, isAliveImpl: onlyAlive }),
    { released: false, remaining: 0 },
  );
  assert.notEqual(leaseEntry(client), null);
  assert.equal(await otherMachine.release(), true);
});
