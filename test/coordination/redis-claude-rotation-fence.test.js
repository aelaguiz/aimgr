import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { acquireRedisCredentialLease } from "../../src/coordination/redis-credential-lease.js";
import {
  AIMGR_CLAUDE_ROTATION_FENCE_KIND,
  buildRedisClaudeRotationFenceProvenance,
  clearRedisClaudeRotationFence,
  createRedisClaudeRotationFence,
  isRedisClaudeRotationFenceSuccessor,
  isRedisClaudeRotationSuccessorOfFingerprint,
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
  const provenance = buildRedisClaudeRotationFenceProvenance({
    retained: true,
    lastSourceType: "native-claude-rotation",
  }, fence);
  const candidate = { provider: "anthropic", label: "claude", version: 8, provenance };

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
  assert.equal(isRedisClaudeRotationSuccessorOfFingerprint(candidate, {
    label: "claude",
    baseTokenLineageFingerprint: HASH_B,
    tokenLineageFingerprint: HASH_A,
  }), true);
  assert.equal(isRedisClaudeRotationSuccessorOfFingerprint({ ...candidate, provider: "openai-codex" }, {
    label: "claude",
    baseTokenLineageFingerprint: HASH_B,
    tokenLineageFingerprint: HASH_A,
  }), false);
  assert.equal(isRedisClaudeRotationSuccessorOfFingerprint({
    ...candidate,
    provenance: { ...candidate.provenance, lastSourceType: "oauth-login" },
  }, {
    label: "claude",
    baseTokenLineageFingerprint: HASH_B,
    tokenLineageFingerprint: HASH_A,
  }), false);
  assert.equal(isRedisClaudeRotationSuccessorOfFingerprint(candidate, {
    label: "claude",
    baseTokenLineageFingerprint: HASH_A,
    tokenLineageFingerprint: HASH_B,
  }), false);
  assert.deepEqual(buildRedisClaudeRotationFenceProvenance(provenance, null), {
    retained: true,
    lastSourceType: "native-claude-rotation",
  });
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

test("Claude rotation fence records the creating host and still parses pre-host fences", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:fence-test" });
  const fence = await createRedisClaudeRotationFence(store, {
    label: "claude",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 7,
    observedAt: "2026-08-02T00:00:00.000Z",
  });

  assert.equal(fence.createdByHost, os.hostname());
  const readBack = await readRedisClaudeRotationFence(store, { label: "claude" });
  assert.equal(readBack.createdByHost, os.hostname());
  assert.deepEqual(readBack, fence);

  // Fences written before createdByHost existed remain valid and gain no key.
  await client.set("aimgr:fence-test:fence:claude-rotation:legacy", JSON.stringify({
    kind: AIMGR_CLAUDE_ROTATION_FENCE_KIND,
    version: 1,
    fenceId: "123e4567-e89b-42d3-a456-426614174000",
    label: "legacy",
    recoveryStorageId: HASH_A,
    baseTokenLineageFingerprint: HASH_B,
    baseCredentialVersion: 3,
    createdAt: "2026-07-30T00:00:00.000Z",
  }));
  const legacy = await readRedisClaudeRotationFence(store, { label: "legacy" });
  assert.equal(legacy.label, "legacy");
  assert.equal(legacy.baseCredentialVersion, 3);
  assert.equal(Object.hasOwn(legacy, "createdByHost"), false);
});
