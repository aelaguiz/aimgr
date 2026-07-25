import test from "node:test";
import assert from "node:assert/strict";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import {
  acquireRedisCredentialLease,
  DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS,
  readHeldRedisCredentialLeaseLabels,
  renewOrReacquireRedisCredentialLease,
} from "../../src/coordination/redis-credential-lease.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

function leaseKey(client) {
  return [...client.values.keys()].find((key) => key.includes(":lease:credential:"));
}

test("credential lease uses SET NX PX and returns an opaque lease", async () => {
  const client = new FakeRedisClient();
  let setOptions = null;
  let connectCalls = 0;
  const setImpl = client.set.bind(client);
  client.set = async (key, value, options) => {
    setOptions = options;
    return setImpl(key, value, options);
  };
  client.connect = async () => {
    connectCalls += 1;
    throw new Error("lease must use the supplied connection");
  };
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });

  const lease = await acquireRedisCredentialLease(store, {
    provider: "ANTHROPIC",
    label: "Pro_7",
  });

  assert.ok(lease);
  assert.equal(Object.isFrozen(lease), true);
  assert.deepEqual(Object.keys(lease).sort(), ["release", "renew"]);
  assert.equal("token" in lease, false);
  assert.equal("key" in lease, false);
  assert.deepEqual(setOptions, {
    condition: "NX",
    expiration: { type: "PX", value: DEFAULT_REDIS_CREDENTIAL_LEASE_TTL_MS },
  });
  assert.equal(leaseKey(client), "aimgr:test:lease:credential:anthropic:pro_7");
  assert.match(client.values.get(leaseKey(client)), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(connectCalls, 0);
});

test("credential lease contends per normalized provider and label", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });

  const first = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 500,
  });
  const blocked = await acquireRedisCredentialLease(store, {
    provider: "ANTHROPIC",
    label: "PRO7",
    ttlMs: 500,
  });
  const otherLabel = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro8",
    ttlMs: 500,
  });

  assert.ok(first);
  assert.equal(blocked, null);
  assert.ok(otherLabel);
});

test("credential lease status reports only live labels without exposing owners", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });

  assert.deepEqual(
    [...await readHeldRedisCredentialLeaseLabels(store, {
      provider: "anthropic",
      labels: ["PRO7", "pro8"],
    })],
    ["pro7"],
  );

  client.advanceTime(101);
  assert.deepEqual(
    [...await readHeldRedisCredentialLeaseLabels(store, {
      provider: "anthropic",
      labels: ["pro7", "pro8"],
    })],
    [],
  );
});

test("credential lease renews its TTL and expires without a renewal", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  const first = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });

  client.advanceTime(75);
  assert.equal(await first.renew(), true);
  client.advanceTime(75);
  assert.equal(await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  }), null);
  client.advanceTime(26);
  const replacement = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  assert.ok(replacement);
  assert.equal(await first.renew(), false);
});

test("sleep-tolerant lease recovery reclaims only an expired unowned lease", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  const lease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  const key = leaseKey(client);
  const opaqueOwner = client.values.get(key);

  client.advanceTime(101);
  assert.equal(await client.get(key), null);
  assert.equal(await renewOrReacquireRedisCredentialLease(lease), true);
  assert.equal(await client.get(key), opaqueOwner);
  assert.equal(await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  }), null);
  assert.equal(await lease.release(), true);
});

test("sleep-tolerant lease recovery never steals from a replacement owner", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  const stale = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });

  client.advanceTime(101);
  const replacement = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  assert.ok(replacement);
  assert.equal(await renewOrReacquireRedisCredentialLease(stale), false);
  assert.equal(await replacement.renew(), true);
  assert.equal(await replacement.release(), true);
});

test("credential lease release only deletes a lease still owned by that caller", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  const lease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  const key = leaseKey(client);

  await client.set(key, "newer-owner", { expiration: { type: "PX", value: 100 } });
  assert.equal(await lease.release(), false);
  assert.equal(await client.get(key), "newer-owner");

  const cleanClient = new FakeRedisClient();
  const cleanStore = await connectRedisStore({ client: cleanClient, keyPrefix: "aimgr:test" });
  const ownedLease = await acquireRedisCredentialLease(cleanStore, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  const ownedKey = leaseKey(cleanClient);
  assert.equal(await ownedLease.release(), true);
  assert.equal(await cleanClient.get(ownedKey), null);
  assert.equal(await ownedLease.release(), false);
  assert.equal(await ownedLease.renew(), false);
});

test("credential lease rejects unsafe targets and invalid TTLs before Redis mutation", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });

  await assert.rejects(
    acquireRedisCredentialLease(store, { provider: "anthropic:other", label: "pro7" }),
    /Invalid Redis credential lease provider/,
  );
  await assert.rejects(
    acquireRedisCredentialLease(store, { provider: "anthropic", label: "../pro7" }),
    /Invalid label/,
  );
  await assert.rejects(
    acquireRedisCredentialLease(store, { provider: "anthropic", label: "pro7", ttlMs: 0 }),
    /Invalid Redis credential lease TTL/,
  );
  await assert.rejects(
    acquireRedisCredentialLease(store, { provider: "anthropic", label: "pro7", ttlMs: 3_600_001 }),
    /Invalid Redis credential lease TTL/,
  );
  assert.equal(client.values.size, 0);
});

test("credential lease failures do not expose Redis error details or ownership tokens", async () => {
  const acquisitionClient = new FakeRedisClient();
  acquisitionClient.set = async () => {
    throw new Error("backend accidentally included credential material");
  };
  const acquisitionStore = await connectRedisStore({ client: acquisitionClient, keyPrefix: "aimgr:test" });
  await assert.rejects(
    acquireRedisCredentialLease(acquisitionStore, { provider: "anthropic", label: "pro7" }),
    (error) => error.message === "Redis credential lease acquisition failed.",
  );

  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test" });
  const lease = await acquireRedisCredentialLease(store, {
    provider: "anthropic",
    label: "pro7",
    ttlMs: 100,
  });
  client.eval = async (_script, options) => {
    throw new Error(`backend leaked ${options.arguments[0]}`);
  };
  await assert.rejects(lease.renew(), (error) => error.message === "Redis credential lease renewal failed.");
  await assert.rejects(
    renewOrReacquireRedisCredentialLease(lease),
    (error) => error.message === "Redis credential lease recovery failed.",
  );
  await assert.rejects(lease.release(), (error) => error.message === "Redis credential lease release failed.");
});
