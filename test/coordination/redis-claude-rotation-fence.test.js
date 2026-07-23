import test from "node:test";
import assert from "node:assert/strict";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import {
  buildRedisClaudeRotationFenceProvenance,
  clearRedisClaudeRotationFence,
  createRedisClaudeRotationFence,
  isRedisClaudeRotationFenceSuccessor,
  readRedisClaudeRotationFence,
} from "../../src/coordination/redis-claude-rotation-fence.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

const HASH_A = `sha256:${"a".repeat(64)}`;
const HASH_B = `sha256:${"b".repeat(64)}`;

test("Claude rotation fence is durable, exclusive, and compare-owner cleared", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:fence-test" });
  const fence = await createRedisClaudeRotationFence(store, {
    label: "Claude",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 7,
    observedAt: "2026-07-22T20:00:00.000Z",
  });

  assert.ok(fence);
  assert.equal(fence.label, "claude");
  assert.equal(Object.isFrozen(fence), true);
  assert.equal(await createRedisClaudeRotationFence(store, {
    label: "claude",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 7,
  }), null);
  assert.deepEqual(await readRedisClaudeRotationFence(store, { label: "claude" }), fence);
  const lease = await acquireRedisCredentialLease(store, { provider: "anthropic", label: "claude" });
  assert.equal(await clearRedisClaudeRotationFence(store, {
    label: "claude",
    fenceId: "00000000-0000-4000-8000-000000000000",
    lease,
  }), false);
  assert.deepEqual(await readRedisClaudeRotationFence(store, { label: "claude" }), fence);
  assert.equal(await clearRedisClaudeRotationFence(store, { label: "claude", fenceId: fence.fenceId, lease }), true);
  assert.equal(await readRedisClaudeRotationFence(store, { label: "claude" }), null);
  assert.equal(await lease.release(), true);
});

test("Claude rotation fence clear is atomic with exact lease ownership", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:fence-test" });
  const fence = await createRedisClaudeRotationFence(store, {
    label: "claude",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 7,
  });
  const staleLease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "claude",
    ttlMs: 100,
  });
  client.advanceTime(101);
  const nextLease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "claude",
    ttlMs: 100,
  });

  assert.equal(await clearRedisClaudeRotationFence(store, {
    label: "claude",
    fenceId: fence.fenceId,
    lease: staleLease,
  }), false);
  assert.deepEqual(await readRedisClaudeRotationFence(store, { label: "claude" }), fence);
  assert.equal(await clearRedisClaudeRotationFence(store, {
    label: "claude",
    fenceId: fence.fenceId,
    lease: nextLease,
  }), true);
});

test("Claude rotation successor requires exact fence provenance and a later version", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:fence-test" });
  const fence = await createRedisClaudeRotationFence(store, {
    label: "claude",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 7,
  });
  const provenance = buildRedisClaudeRotationFenceProvenance({ retained: true }, fence);
  const candidate = { label: "claude", version: 8, provenance };

  assert.equal(isRedisClaudeRotationFenceSuccessor(candidate, {
    fence,
    tokenLineageFingerprint: HASH_A,
  }), true);
  assert.equal(isRedisClaudeRotationFenceSuccessor({ ...candidate, version: 7 }, {
    fence,
    tokenLineageFingerprint: HASH_A,
  }), false);
  assert.equal(isRedisClaudeRotationFenceSuccessor({ ...candidate, provenance: {} }, {
    fence,
    tokenLineageFingerprint: HASH_A,
  }), false);
  assert.equal(isRedisClaudeRotationFenceSuccessor(candidate, {
    fence,
    tokenLineageFingerprint: HASH_B,
  }), false);
  assert.deepEqual(buildRedisClaudeRotationFenceProvenance(provenance, null), { retained: true });
});

test("Claude rotation fence rejects malformed shared state without replacing it", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:fence-test" });
  const key = "aimgr:fence-test:fence:claude-rotation:claude";
  await client.set(key, JSON.stringify({ kind: "wrong", token: "PRIVATE" }));

  await assert.rejects(
    readRedisClaudeRotationFence(store, { label: "claude" }),
    (error) => error.message === "Redis Claude rotation fence is invalid.",
  );
  assert.match(await client.get(key), /PRIVATE/);
});
