import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import {
  buildCodexDesktopIdentityFingerprint,
  CodexDesktopReservedError,
} from "../../src/coordination/codex-identity.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import { applyOpenclawFromState } from "../../src/openclaw/apply.js";
import {
  assertCodexStateCredentialUseAllowed,
  isCodexStateCredentialUseAllowed,
  resolveCodexAuthEntryAccountId,
} from "../../src/targets/codex-desktop-drain.js";
import {
  buildHarnessExternalDescriptor,
  installHarnessProvider,
  uninstallHarnessProvider,
} from "../../src/targets/harness-auth.js";
import { writeHermesAuthFromState } from "../../src/targets/hermes-auth.js";
import {
  assertCodexIdentityWriteAllowed,
  readReservedCodexIdentityIndex,
} from "../../src/coordination/codex-identity.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { registerCliRedisFixture, runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson, writeOpenclawAuthStore } from "../helpers/files.js";

const DESKTOP_ACCOUNT_ID = "acct_desktop";
const RESERVED_FINGERPRINT = buildCodexDesktopIdentityFingerprint(DESKTOP_ACCOUNT_ID);

function codexJwt(accountId) {
  return makeFakeJwt({
    email: `${accountId}@example.com`,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "pro" },
  });
}

function reservedDesktopRecord() {
  return {
    provider: "openai-codex",
    label: "desktop",
    credential: {},
    identity: { accountId: DESKTOP_ACCOUNT_ID },
    policy: {
      expect: {
        codexDesktop: {
          reserved: true,
          ownerHost: "test-host",
          identityFingerprint: RESERVED_FINGERPRINT,
          reservedAt: new Date().toISOString(),
        },
      },
      reauth: {},
      browser: {},
      pool: { enabled: false, disabledReason: "codex_desktop_reserved" },
    },
    health: { status: "native_owned", reason: "codex_desktop_reserved" },
  };
}

function codexRecord(label, accountId, { expiresInMs = 3 * 24 * 3600_000 } = {}) {
  const access = codexJwt(accountId);
  return {
    provider: "openai-codex",
    label,
    credential: {
      access,
      refresh: `REFRESH_${label.toUpperCase()}`,
      idToken: access,
      expiresAt: new Date(Date.now() + expiresInMs).toISOString(),
      accountId,
    },
    identity: { accountId },
    policy: { expect: {}, reauth: {}, browser: {}, pool: { enabled: true } },
    health: { status: "ready", reason: null },
  };
}

function defaultRecords() {
  return [
    reservedDesktopRecord(),
    codexRecord("worker", "acct_worker"),
    // Alias: a different label carrying the reserved immutable account.
    codexRecord("shadow", DESKTOP_ACCOUNT_ID),
  ];
}

function viewState(records = defaultRecords()) {
  return buildCoordinationView({ credentials: records });
}

async function attachRedisFixture(homeDir, records = defaultRecords()) {
  const client = new FakeRedisClient();
  const keyPrefix = `aimgr:test:${path.basename(homeDir)}:`;
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fake:6379", keyPrefix } } });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(
    store,
    { credentials: records },
    { updatedBy: "test-fixture", observedAt: new Date().toISOString() },
  );
  writeLocalState({ homeDir, localState: { targets: {}, pool: {}, browserBindings: {} } });
  const connectRedisStoreImpl = () => connectRedisStore({ client, keyPrefix });
  registerCliRedisFixture(homeDir, { connectRedisStoreImpl });
  return { store, connectRedisStoreImpl };
}

function snapshotTree(rootDir) {
  const entries = new Map();
  if (!fs.existsSync(rootDir)) return entries;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else entries.set(full, fs.readFileSync(full, "utf8"));
    }
  };
  walk(rootDir);
  return entries;
}

test("state-level gate rejects reserved labels and same-account aliases, allows others", () => {
  const state = viewState();
  assert.equal(isCodexStateCredentialUseAllowed(state, { label: "desktop" }), false);
  assert.equal(
    isCodexStateCredentialUseAllowed(state, { label: "shadow", accountId: DESKTOP_ACCOUNT_ID }),
    false,
  );
  assert.equal(
    isCodexStateCredentialUseAllowed(state, { label: "worker", accountId: "acct_worker" }),
    true,
  );
  assert.throws(
    () => assertCodexStateCredentialUseAllowed(state, { label: "desktop", operation: "test" }),
    (error) => error instanceof CodexDesktopReservedError && error.code === "codex_desktop_reserved",
  );
});

test("state-level gate fails closed on a corrupted reservation without a fingerprint", () => {
  const record = reservedDesktopRecord();
  delete record.policy.expect.codexDesktop.identityFingerprint;
  const state = buildCoordinationView({ credentials: [record, codexRecord("worker", "acct_worker")] });
  assert.throws(
    () => isCodexStateCredentialUseAllowed(state, { label: "worker", accountId: "acct_worker" }),
    /no identity fingerprint/,
  );
});

test("openclaw apply refuses reserved and alias codex labels with zero writes", () => {
  const home = mkTempHome();
  writeOpenclawAuthStore(home, "main", {
    version: 1,
    profiles: { "anthropic:keep": { type: "oauth", provider: "anthropic", access: "A", refresh: "R", expires: 9 } },
  });
  const before = snapshotTree(path.join(home, ".openclaw"));

  for (const label of ["desktop", "shadow"]) {
    assert.throws(
      () => applyOpenclawFromState({ homeDir: home }, viewState(), {
        pinsOverride: { agent_a: label },
      }),
      (error) => error instanceof CodexDesktopReservedError,
      `label=${label} must be refused`,
    );
  }
  assert.deepEqual(snapshotTree(path.join(home, ".openclaw")), before);

  // Sanity: a non-reserved label still materializes.
  const applied = applyOpenclawFromState({ homeDir: home }, viewState(), {
    pinsOverride: { agent_a: "worker" },
  });
  assert.ok(applied.wrote.length > 0);
});

test("hermes auth write refuses reserved and alias labels with zero writes", () => {
  const home = mkTempHome();
  const hermesDir = path.join(home, ".hermes", "profiles", "home1");
  fs.mkdirSync(hermesDir, { recursive: true });
  const authPath = path.join(hermesDir, "auth.json");
  writeJson(authPath, { version: 3, providers: {} });
  const before = fs.readFileSync(authPath, "utf8");

  for (const label of ["desktop", "shadow"]) {
    assert.throws(
      () => writeHermesAuthFromState({ label, authPath }, viewState()),
      (error) => error instanceof CodexDesktopReservedError,
      `label=${label} must be refused`,
    );
  }
  assert.equal(fs.readFileSync(authPath, "utf8"), before);

  const written = writeHermesAuthFromState({ label: "worker", authPath }, viewState());
  assert.equal(written.status, "applied");
});

test("pi codex binding refuses reserved and alias labels with zero writes", async () => {
  for (const label of ["desktop", "shadow"]) {
    const home = mkTempHome();
    const piAgentDir = path.join(home, ".pi", "agent");
    const authPath = path.join(piAgentDir, "auth.json");
    writeJson(authPath, { anthropic: { type: "api_key", key: "KEEP" } });
    await attachRedisFixture(home);
    const beforeAuth = fs.readFileSync(authPath, "utf8");
    const beforeLocal = fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8");

    await assert.rejects(
      runCli(["pi", "use", "--codex", label, "--home", home], { env: { HOME: home } }),
      /codex_desktop_reserved|Codex Desktop/,
    );
    assert.equal(fs.readFileSync(authPath, "utf8"), beforeAuth);
    assert.equal(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"), beforeLocal);
  }
});

test("harness uninstall refuses restoring a reserved displaced codex backup and keeps everything", async () => {
  const home = mkTempHome();
  const { store } = await attachRedisFixture(home);
  const agentDir = path.join(home, ".pi", "agent");
  fs.mkdirSync(agentDir, { recursive: true });
  const authPath = path.join(agentDir, "auth.json");
  const native = {
    type: "oauth",
    access: codexJwt(DESKTOP_ACCOUNT_ID),
    refresh: "NATIVE_REFRESH",
    accountId: DESKTOP_ACCOUNT_ID,
    expires: 123,
  };
  writeJson(authPath, { "openai-codex": native });
  const targetState = {};
  const descriptor = buildHarnessExternalDescriptor({
    binding: "worker",
    expectedIdentityFingerprint: `aimgr-id-v1:${"A".repeat(43)}`,
  });
  const installed = await installHarnessProvider({
    targetId: "pi",
    targetState,
    authPath,
    homeDir: home,
    provider: "openai-codex",
    descriptor,
    replaceNativeAuth: true,
  });
  assert.equal(installed.displacedNative, true);
  const backupBefore = fs.readFileSync(installed.backupPath, "utf8");
  const authBefore = fs.readFileSync(authPath, "utf8");
  const targetStateBefore = structuredClone(targetState);
  // Same gate shape the CLI wires for uninstall restores.
  const assertRestoredEntryAllowed = async ({ provider, entry }) => {
    if (provider !== "openai-codex") return;
    const accountId = resolveCodexAuthEntryAccountId(entry);
    if (!accountId) return;
    assertCodexIdentityWriteAllowed({
      index: await readReservedCodexIdentityIndex(store),
      accountId,
      operation: "pi uninstall auth restore",
    });
  };

  await assert.rejects(
    uninstallHarnessProvider({
      targetId: "pi",
      targetState,
      authPath,
      provider: "openai-codex",
      assertRestoredEntryAllowed,
    }),
    (error) => error instanceof CodexDesktopReservedError,
  );
  assert.equal(fs.readFileSync(authPath, "utf8"), authBefore);
  assert.equal(fs.readFileSync(installed.backupPath, "utf8"), backupBefore);
  assert.deepEqual(targetState, targetStateBefore);

  // A non-reserved displaced backup still restores through the same gate.
  const otherState = {};
  const otherAgentDir = path.join(home, ".prime", "agent");
  fs.mkdirSync(otherAgentDir, { recursive: true });
  const otherAuthPath = path.join(otherAgentDir, "auth.json");
  const otherNative = {
    type: "oauth",
    access: codexJwt("acct_other"),
    refresh: "OTHER_REFRESH",
    accountId: "acct_other",
    expires: 456,
  };
  writeJson(otherAuthPath, { "openai-codex": otherNative });
  await installHarnessProvider({
    targetId: "prime",
    targetState: otherState,
    authPath: otherAuthPath,
    homeDir: home,
    provider: "openai-codex",
    descriptor,
    replaceNativeAuth: true,
  });
  const restored = await uninstallHarnessProvider({
    targetId: "prime",
    targetState: otherState,
    authPath: otherAuthPath,
    provider: "openai-codex",
    assertRestoredEntryAllowed,
  });
  assert.equal(restored.status, "restored_native");
  assert.deepEqual(JSON.parse(fs.readFileSync(otherAuthPath, "utf8"))["openai-codex"], otherNative);
});

test("auth maintain skips Desktop-reserved codex records with the fixed reason and no refresh attempt", async () => {
  const home = mkTempHome();
  await attachRedisFixture(home, [
    reservedDesktopRecord(),
    codexRecord("worker", "acct_worker"),
    codexRecord("shadow", DESKTOP_ACCOUNT_ID, { expiresInMs: -60_000 }),
  ]);
  const out = await runCli(["auth", "maintain", "--home", home], {
    env: { HOME: home },
    fetchJsonWithTimeoutImpl: async () => {
      throw new Error("network must not be touched for reserved identities");
    },
  });
  const lines = out.trim().split("\n");
  assert.ok(lines.some((line) => line.includes("label=desktop outcome=skipped reason=codex_desktop_reserved")), out);
  assert.ok(lines.some((line) => line.includes("label=shadow outcome=skipped reason=codex_desktop_reserved")), out);
  assert.ok(lines.some((line) => line.includes("label=worker outcome=skipped reason=not_due")), out);
  assert.ok(lines.at(-1).includes("skipped=3"), out);
});

test("aim auth write hermes refuses reserved and alias labels on a fresh raw read", async () => {
  const home = mkTempHome();
  await attachRedisFixture(home);
  const hermesDir = path.join(home, ".hermes", "profiles", "home1");
  fs.mkdirSync(hermesDir, { recursive: true });
  const authPath = path.join(hermesDir, "auth.json");
  writeJson(authPath, { version: 3, providers: {} });
  const before = fs.readFileSync(authPath, "utf8");

  for (const label of ["desktop", "shadow"]) {
    await assert.rejects(
      runCli(["auth", "write", "hermes", label, "--home", home, "--auth-file", authPath], {
        env: { HOME: home },
      }),
      /codex_desktop_reserved|Codex Desktop/,
    );
  }
  assert.equal(fs.readFileSync(authPath, "utf8"), before);

  const out = JSON.parse(await runCli(
    ["auth", "write", "hermes", "worker", "--home", home, "--auth-file", authPath],
    { env: { HOME: home } },
  ));
  assert.equal(out.ok, true);
});
