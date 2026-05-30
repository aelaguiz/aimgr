import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { connectRedisStore, readSnapshot } from "../../src/coordination/redis-store.js";
import {
  applyRedisMigrationPlan,
  buildRedisMigrationPlan,
  collectRedisMigrationBundle,
} from "../../src/migration/redis-migration.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

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

function buildLegacyCodexState({ label = "boss", accountId = "acct_1", credential = null } = {}) {
  const cred = credential ?? codexCredential(accountId);
  return {
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
  };
}

function writeLegacyCodexState(home, { label = "boss", accountId = "acct_1", credential = null } = {}) {
  const state = buildLegacyCodexState({ label, accountId, credential });
  writeJson(path.join(home, ".aimgr", "secrets.json"), state);
  const cred = state.credentials["openai-codex"][label];
  return cred;
}

function collectHome(home) {
  return collectRedisMigrationBundle({
    homeDir: home,
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
}

test("migration collect reads local legacy state candidates without requiring machine id", () => {
  const home = mkTempHome();
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1" });

  const bundle = collectRedisMigrationBundle({
    homeDir: home,
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
  assert.equal(bundle.kind, "aimgr.redisMigration.bundle.v1");
  assert.equal(bundle.source.hostname.length > 0, true);
  assert.equal(bundle.summary.candidateCount, 1);
  assert.equal(bundle.candidates[0].provider, "openai-codex");
  assert.equal(bundle.candidates[0].label, "boss");
  assert.equal(bundle.candidates[0].validation.ok, true);
  assert.equal(bundle.candidates[0].validation.fresh, true);
  assert.equal(bundle.candidates[0].authorityMeta.dirtyLocal, true);
});

test("migration collect reads local imported secrets snapshots when current secrets.json is absent", () => {
  const home = mkTempHome();
  writeJson(
    path.join(home, ".aimgr", "secrets.legacy-imported-redis-20260530T1521Z.json"),
    buildLegacyCodexState({ label: "snapshot", accountId: "acct_snapshot" }),
  );

  const bundle = collectRedisMigrationBundle({
    homeDir: home,
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(bundle.summary.candidateCount, 1);
  assert.equal(bundle.sources.legacyState.exists, false);
  assert.equal(bundle.sources.legacyStateSnapshots.length, 1);
  assert.match(bundle.candidates[0].sourcePath, /secrets\.legacy-imported-redis-/);
  assert.equal(bundle.candidates[0].provider, "openai-codex");
  assert.equal(bundle.candidates[0].label, "snapshot");
});

test("migration plan blocks provider label identity conflicts", async () => {
  const firstHome = mkTempHome();
  const secondHome = mkTempHome();
  writeLegacyCodexState(firstHome, { label: "boss", accountId: "acct_1" });
  writeLegacyCodexState(secondHome, { label: "boss", accountId: "acct_2" });

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(firstHome), collectHome(secondHome)],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(plan.summary.blockedCount, 1);
  assert.equal(plan.blocked[0].reason, "identity_conflict");
  assert.equal(plan.credentials[0].status, "blocked");
});

test("migration plan selects one best credential per provider and label", async () => {
  const firstHome = mkTempHome();
  const secondHome = mkTempHome();
  const credential = codexCredential("acct_1");
  writeLegacyCodexState(firstHome, { label: "boss", accountId: "acct_1", credential });
  writeLegacyCodexState(secondHome, { label: "boss", accountId: "acct_1", credential });

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(firstHome), collectHome(secondHome)],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(plan.summary.importCredentialCount, 1);
  assert.equal(plan.summary.supersededCount, 1);
  assert.equal(plan.credentials[0].status, "import");
});

test("migration collect ignores old Redis session rows as import input", async () => {
  const home = mkTempHome();
  const legacy = {
    keyPrefix: "aimgr:v1:",
    observedAt: "2026-05-30T14:00:00.000Z",
    labels: [{ provider: "openai-codex", label: "boss", pool: { enabled: true } }],
    sessions: [
      {
        provider: "openai-codex",
        label: "boss",
        sessionId: "openai-codex:boss:studio",
        credential: codexCredential("acct_1"),
        identity: { accountId: "acct_1" },
        updatedAt: "2026-05-30T13:59:00.000Z",
      },
    ],
    machines: [{ machineId: "studio" }],
  };
  const bundle = collectRedisMigrationBundle({
    homeDir: home,
    legacyRedisSnapshot: legacy,
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
  const plan = await buildRedisMigrationPlan({
    bundles: [bundle],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });

  assert.equal(bundle.candidates.some((candidate) => candidate.sourceType === "legacy-redis-session"), false);
  assert.equal(plan.summary.importCredentialCount, 0);
  assert.equal(plan.credentials.length, 0);
});

test("migration plan attempts controlled refresh before marking expired candidates unusable", async () => {
  const home = mkTempHome();
  const now = new Date("2026-05-30T14:00:00.000Z");
  const expired = codexCredential("acct_1", Math.floor(now.getTime() / 1000) - 3600);
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1", credential: expired });
  const refreshed = codexCredential("acct_1", Math.floor(now.getTime() / 1000) + 3600);

  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(home)],
    now,
    refreshCandidateImpl: async (candidate) => {
      assert.equal(candidate.label, "boss");
      return { credential: refreshed };
    },
  });

  assert.equal(plan.summary.importCredentialCount, 1);
  assert.equal(plan.summary.reloginRequiredCount, 0);
  assert.equal(plan.candidates[0].refreshAttempt.status, "refreshed");
  assert.equal(plan.candidates[0].validation.fresh, true);
});

test("migration apply imports one credential into an empty Redis prefix", async () => {
  const home = mkTempHome();
  writeLegacyCodexState(home, { label: "boss", accountId: "acct_1" });
  const plan = await buildRedisMigrationPlan({
    bundles: [collectHome(home)],
    now: new Date("2026-05-30T14:00:00.000Z"),
  });
  const store = await connectRedisStore({ client: new FakeRedisClient(), keyPrefix: "aimgr:migration-test" });

  const applied = await applyRedisMigrationPlan(store, plan, {
    updatedBy: "aimgr-cli",
    observedAt: "2026-05-30T14:01:00.000Z",
  });

  assert.equal(applied.ok, true);
  assert.deepEqual(applied.counts, { credentials: 1 });
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.meta.cutover.breakingNonReverseCompatible, true);
  assert.equal(snapshot.credentials[0].label, "boss");
  assert.equal(snapshot.credentials[0].credential.accountId, "acct_1");
  assert.equal(snapshot.credentials[0].provenance.lastSourceType, "migration-import");
});
