import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { connectRedisStore, readSnapshot } from "../../src/coordination/redis-store.js";
import { resolveAimgrMachineIdPath } from "../../src/io/paths.js";
import {
  applyRedisMigrationPlan,
  buildRedisMigrationPlan,
  collectRedisMigrationBundle,
} from "../../src/migration/redis-migration.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

class FakeRedisClient {
  constructor() {
    this.values = new Map();
    this.sets = new Map();
    this.isOpen = true;
  }

  async get(key) {
    return this.values.get(key) ?? null;
  }

  async set(key, value) {
    this.values.set(key, value);
    return "OK";
  }

  async sAdd(key, member) {
    const set = this.sets.get(key) ?? new Set();
    const had = set.has(member);
    set.add(member);
    this.sets.set(key, set);
    return had ? 0 : 1;
  }

  async sMembers(key) {
    return [...(this.sets.get(key) ?? new Set())];
  }

  async mGet(keys) {
    return keys.map((key) => this.values.get(key) ?? null);
  }

  async watch() {
    return "OK";
  }

  async unwatch() {
    return "OK";
  }

  multi() {
    const ops = [];
    const client = this;
    const tx = {
      set(key, value) {
        ops.push(["set", key, value]);
        return tx;
      },
      sAdd(key, member) {
        ops.push(["sAdd", key, member]);
        return tx;
      },
      async exec() {
        const results = [];
        for (const [op, key, value] of ops) {
          results.push(op === "set" ? await client.set(key, value) : await client.sAdd(key, value));
        }
        return results;
      },
    };
    return tx;
  }
}

function writeMachineId(home, machineId) {
  const machineIdPath = resolveAimgrMachineIdPath({ homeDir: home });
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
  fs.writeFileSync(machineIdPath, `${machineId}\n`, "utf8");
}

function codexCredential(accountId, expSeconds = Math.floor(Date.now() / 1000) + 3600) {
  const token = makeFakeJwt({
    exp: expSeconds,
    email: `${accountId}@example.com`,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
  return {
    access: token,
    refresh: `refresh-${accountId}`,
    idToken: token,
    accountId,
    expiresAt: new Date(expSeconds * 1000).toISOString(),
  };
}

function writeLegacyCodexState(home, { label = "boss", accountId = "acct_1", credential = null } = {}) {
  const cred = credential ?? codexCredential(accountId);
  writeJson(path.join(home, ".aimgr", "secrets.json"), {
    schemaVersion: "0.2",
    accounts: {
      [label]: {
        provider: "openai-codex",
        expect: { email: `${accountId}@example.com` },
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        [label]: cred,
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          labels: [label],
          labelsByName: {
            [label]: {
              importedAt: "2026-05-30T10:00:00.000Z",
              baseAccountId: accountId,
              dirtyLocal: true,
            },
          },
        },
        anthropic: { labels: [], labelsByName: {} },
      },
    },
    pool: { openaiCodex: { history: [] } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
  });
  return cred;
}

function collectHome(home, machineId) {
  writeMachineId(home, machineId);
  return collectRedisMigrationBundle({
    homeDir: home,
    machineId,
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
}

test("migration collect reads legacy state candidates and enforces machine id", () => {
  const home = mkTempHome();
  writeMachineId(home, "studio");
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1" });

  assert.throws(
    () => collectRedisMigrationBundle({ homeDir: home, machineId: "laptop" }),
    /Migration machine mismatch/,
  );

  const bundle = collectRedisMigrationBundle({
    homeDir: home,
    machineId: "studio",
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
  assert.equal(bundle.kind, "aimgr.redisMigration.bundle.v1");
  assert.equal(bundle.machine.machineId, "studio");
  assert.equal(bundle.summary.candidateCount, 1);
  assert.equal(bundle.candidates[0].provider, "openai-codex");
  assert.equal(bundle.candidates[0].label, "boss");
  assert.equal(bundle.candidates[0].validation.ok, true);
  assert.equal(bundle.candidates[0].validation.fresh, true);
  assert.equal(bundle.candidates[0].authorityMeta.dirtyLocal, true);
});

test("migration plan blocks provider label identity conflicts", async () => {
  const firstHome = mkTempHome();
  const secondHome = mkTempHome();
  writeLegacyCodexState(firstHome, { label: "boss", accountId: "acct_1" });
  writeLegacyCodexState(secondHome, { label: "boss", accountId: "acct_2" });

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(firstHome, "studio"), collectHome(secondHome, "laptop")],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(plan.summary.blockedCount, 1);
  assert.equal(plan.blocked[0].reason, "identity_conflict");
  assert.equal(plan.labels[0].status, "blocked");
});

test("migration plan keeps one same-fingerprint lineage instead of importing cloned sessions", async () => {
  const firstHome = mkTempHome();
  const secondHome = mkTempHome();
  const credential = codexCredential("acct_1");
  writeLegacyCodexState(firstHome, { label: "boss", accountId: "acct_1", credential });
  writeLegacyCodexState(secondHome, { label: "boss", accountId: "acct_1", credential });

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(firstHome, "studio"), collectHome(secondHome, "laptop")],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(plan.summary.importLabelCount, 1);
  assert.equal(plan.summary.importSessionCount, 1);
  assert.equal(plan.summary.clonedCount, 1);
  assert.equal(plan.labels[0].status, "import");
});

test("migration plan attempts controlled refresh before marking expired candidates unusable", async () => {
  const home = mkTempHome();
  const now = new Date("2026-05-30T14:00:00.000Z");
  const expired = codexCredential("acct_1", Math.floor(now.getTime() / 1000) - 3600);
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1", credential: expired });
  const refreshed = codexCredential("acct_1", Math.floor(now.getTime() / 1000) + 3600);

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(home, "studio")],
    now,
    refreshCandidateImpl: async (candidate) => {
      assert.equal(candidate.label, "boss");
      return { credential: refreshed };
    },
  });

  assert.equal(plan.summary.importLabelCount, 1);
  assert.equal(plan.summary.reloginRequiredCount, 0);
  assert.equal(plan.candidates[0].refreshAttempt.status, "refreshed");
  assert.equal(plan.candidates[0].validation.fresh, true);
});

test("migration apply imports labels and sessions into an empty Redis prefix", async () => {
  const home = mkTempHome();
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1" });
  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(home, "studio")],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:migration-test" });

  const applied = await applyRedisMigrationPlan(store, plan, {
    machineId: "studio",
    observedAt: "2026-05-30T14:01:00.000Z",
  });

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.counts, { machines: 1, labels: 1, sessions: 1 });
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.meta.cutover.breakingNonReverseCompatible, true);
  assert.equal(snapshot.labels[0].label, "boss");
  assert.equal(snapshot.sessions[0].machineId, "studio");
  assert.equal(snapshot.sessions[0].credential.accountId, "acct_1");
});
