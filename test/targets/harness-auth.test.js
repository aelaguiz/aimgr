import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  buildHarnessExternalDescriptor,
  installHarnessProvider,
  resolveTrustedAimExecutable,
  uninstallHarnessProvider,
} from "../../src/targets/harness-auth.js";
import { isRecognizedAimLegacyPiProjection } from "../../src/targets/pi-cli.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

function descriptor(binding, fingerprintChar = "A") {
  return buildHarnessExternalDescriptor({
    binding,
    expectedIdentityFingerprint: `aimgr-id-v1:${fingerprintChar.repeat(43)}`,
  });
}

function targetFixture(targetId = "pi") {
  const homeDir = mkTempHome();
  const agentDir = path.join(homeDir, `.${targetId}`, "agent");
  const authPath = path.join(agentDir, "auth.json");
  const targetState = {};
  fs.mkdirSync(agentDir, { recursive: true });
  return { homeDir, agentDir, authPath, targetState, targetId };
}

test("native replacement creates one private backup, switches without overwriting it, and restores exactly", async () => {
  const fixture = targetFixture("pi");
  const native = { type: "oauth", access: "NATIVE_ACCESS", refresh: "NATIVE_REFRESH", expires: 123 };
  writeJson(fixture.authPath, {
    "openai-codex": native,
    unrelated: { type: "api_key", key: "UNCHANGED" },
  });

  await assert.rejects(
    installHarnessProvider({
      ...fixture,
      provider: "openai-codex",
      descriptor: descriptor("alpha"),
    }),
    /--replace-native-auth/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath)), {
    "openai-codex": native,
    unrelated: { type: "api_key", key: "UNCHANGED" },
  });

  const installed = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha"),
    replaceNativeAuth: true,
  });
  assert.equal(installed.displacedNative, true);
  assert.equal(fs.statSync(installed.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(installed.backupPath)).mode & 0o777, 0o700);
  const firstBackup = fs.readFileSync(installed.backupPath, "utf8");

  await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("beta", "B"),
  });
  assert.equal(fs.readFileSync(installed.backupPath, "utf8"), firstBackup);
  const managed = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.equal(managed["openai-codex"].binding, "beta");
  assert.deepEqual(managed.unrelated, { type: "api_key", key: "UNCHANGED" });
  assert.doesNotMatch(JSON.stringify(managed["openai-codex"]), /NATIVE_ACCESS|NATIVE_REFRESH/);

  const restored = await uninstallHarnessProvider({
    ...fixture,
    provider: "openai-codex",
  });
  assert.equal(restored.status, "restored_native");
  assert.equal(fs.existsSync(installed.backupPath), false);
  const finalAuth = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.deepEqual(finalAuth["openai-codex"], native);
  assert.deepEqual(finalAuth.unrelated, { type: "api_key", key: "UNCHANGED" });
});

test("an existing AIM descriptor switches labels without a separate ownership receipt", async () => {
  const fixture = targetFixture("prime");
  writeJson(fixture.authPath, { "openai-codex": descriptor("alpha") });

  const installed = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("beta", "B"),
  });

  assert.equal(installed.wrote, true);
  assert.equal(installed.recoveredInstallReceipt, true);
  assert.equal(installed.backupPath, null);
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"].binding, "beta");
  assert.equal(fixture.targetState.providers["openai-codex"].binding, "beta");
});

test("uninstall refuses any edit away from the exact last installed descriptor", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "api_key", key: "NATIVE" };
  writeJson(fixture.authPath, { anthropic: native });
  const installed = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("fable"),
    replaceNativeAuth: true,
  });
  const auth = JSON.parse(fs.readFileSync(fixture.authPath));
  auth.anthropic.binding = "operator-edit";
  writeJson(fixture.authPath, auth);
  await assert.rejects(
    uninstallHarnessProvider({ ...fixture, provider: "anthropic" }),
    /does not equal AIM's last installed descriptor/,
  );
  assert.equal(fs.existsSync(installed.backupPath), true);
  assert.deepEqual(JSON.parse(fs.readFileSync(installed.backupPath)).entry, native);
});

test("recognized AIM legacy Pi projection migrates without preserving a secret backup", async () => {
  const fixture = targetFixture("pi");
  const expiresAt = new Date(Date.now() + 60_000).toISOString();
  const record = {
    provider: "openai-codex",
    label: "alpha",
    credential: {
      access: "LEGACY_ACCESS",
      refresh: "LEGACY_REFRESH",
      expiresAt,
      accountId: "acct_alpha",
    },
  };
  fixture.targetState.activeLabel = "alpha";
  fixture.targetState.expectedAccountId = "acct_alpha";
  writeJson(fixture.authPath, {
    "openai-codex": {
      type: "oauth",
      access: record.credential.access,
      refresh: record.credential.refresh,
      expires: Date.parse(expiresAt),
      accountId: record.credential.accountId,
    },
  });
  const result = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha"),
    recognizeLegacyEntry: (entry) => isRecognizedAimLegacyPiProjection({
      entry,
      targetState: fixture.targetState,
      record,
    }),
  });
  assert.equal(result.migratedLegacy, true);
  assert.equal(result.backupPath, null);
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"].type, "external");
  assert.equal(fs.existsSync(path.join(fixture.homeDir, ".aimgr", "backups")), false);
});

test("target transaction waits on the harness proper-lockfile lock and preserves a concurrent unrelated login", async () => {
  const fixture = targetFixture("pi");
  writeJson(fixture.authPath, {});
  const release = await lockfile.lock(fixture.authPath, { stale: 30_000 });
  const pending = installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha"),
  });
  // This write represents a harness /login mutation while it owns the exact
  // same proper-lockfile lock. AIM must read it only after the lock releases.
  writeJson(fixture.authPath, { unrelated: { type: "api_key", key: "LOGIN_WRITE" } });
  await release();
  await pending;
  const auth = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.equal(auth["openai-codex"].binding, "alpha");
  assert.deepEqual(auth.unrelated, { type: "api_key", key: "LOGIN_WRITE" });
});


test("descriptor preflight rejects group/world-writable executables and parent paths", () => {
  const home = mkTempHome();
  const trustedDir = path.join(home, "trusted-bin");
  const executable = path.join(trustedDir, "aim");
  fs.mkdirSync(trustedDir, { mode: 0o700 });
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  assert.equal(resolveTrustedAimExecutable({ executable }), fs.realpathSync(executable));
  fs.chmodSync(executable, 0o722);
  assert.throws(() => resolveTrustedAimExecutable({ executable }), /owner-trusted/);
  fs.chmodSync(executable, 0o700);
  fs.chmodSync(trustedDir, 0o722);
  assert.throws(() => resolveTrustedAimExecutable({ executable }), /owner-trusted/);
});


test("install recovers a descriptor and native backup written before its local receipt", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "native-access", refresh: "native-refresh" };
  writeJson(fixture.authPath, { "openai-codex": native });
  const installedDescriptor = descriptor("alpha", "R");
  const first = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: installedDescriptor,
    replaceNativeAuth: true,
  });
  delete fixture.targetState.providers;
  const recovered = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: installedDescriptor,
  });
  assert.equal(recovered.wrote, false);
  assert.equal(recovered.recoveredInstallReceipt, true);
  assert.equal(recovered.backupPath, first.backupPath);
  const removed = await uninstallHarnessProvider({
    ...fixture,
    provider: "openai-codex",
  });
  assert.equal(removed.status, "restored_native");
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"], native);
});


test("install recovers an orphan backup left before the prepared receipt", async () => {
  const fixture = targetFixture("pi");
  const native = { type: "oauth", access: "orphan-access", refresh: "orphan-refresh" };
  writeJson(fixture.authPath, { "openai-codex": native });
  const backupPath = path.join(
    fixture.homeDir,
    ".aimgr",
    "backups",
    "harness-auth",
    "pi-openai-codex.json",
  );
  writeJson(backupPath, {
    schemaVersion: 1,
    target: "pi",
    provider: "openai-codex",
    entry: native,
  });
  fs.chmodSync(path.dirname(backupPath), 0o700);
  fs.chmodSync(backupPath, 0o600);
  const originalBackup = fs.readFileSync(backupPath, "utf8");
  const installed = await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha", "O"),
    replaceNativeAuth: true,
  });
  assert.equal(installed.backupPath, backupPath);
  assert.equal(fs.readFileSync(backupPath, "utf8"), originalBackup);
  await uninstallHarnessProvider({ ...fixture, provider: "openai-codex" });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"], native);
});

test("install finalizes from a durable prepared receipt after the descriptor switch", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "switch-access", refresh: "switch-refresh" };
  writeJson(fixture.authPath, { "openai-codex": native });
  const receiptPath = path.join(fixture.homeDir, "target-receipt.json");
  let persists = 0;
  await assert.rejects(
    installHarnessProvider({
      ...fixture,
      provider: "openai-codex",
      descriptor: descriptor("alpha", "S"),
      replaceNativeAuth: true,
      persistTargetState: async () => {
        persists += 1;
        if (persists === 2) throw new Error("crash after descriptor switch");
        writeJson(receiptPath, fixture.targetState);
      },
    }),
    /crash after descriptor switch/,
  );
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"].type, "external");
  const recoveredTargetState = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(
    recoveredTargetState.providers["openai-codex"].pendingTransition.operation,
    "install",
  );
  const recoveredFixture = { ...fixture, targetState: recoveredTargetState };
  const recovered = await installHarnessProvider({
    ...recoveredFixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha", "S"),
    persistTargetState: async () => writeJson(receiptPath, recoveredTargetState),
  });
  assert.equal(recovered.wrote, false);
  assert.equal(recoveredTargetState.providers["openai-codex"].pendingTransition, undefined);
  await uninstallHarnessProvider({
    ...recoveredFixture,
    provider: "openai-codex",
    persistTargetState: async () => writeJson(receiptPath, recoveredTargetState),
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"], native);
});

test("uninstall resumes after auth restore lands before its phase receipt", async () => {
  const fixture = targetFixture("pi");
  const native = { type: "oauth", access: "restore-access", refresh: "restore-refresh" };
  writeJson(fixture.authPath, { "openai-codex": native });
  const receiptPath = path.join(fixture.homeDir, "target-receipt.json");
  await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha", "T"),
    replaceNativeAuth: true,
    persistTargetState: async () => writeJson(receiptPath, fixture.targetState),
  });
  let persists = 0;
  await assert.rejects(
    uninstallHarnessProvider({
      ...fixture,
      provider: "openai-codex",
      persistTargetState: async () => {
        persists += 1;
        if (persists === 2) throw new Error("crash after auth restore");
        writeJson(receiptPath, fixture.targetState);
      },
    }),
    /crash after auth restore/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"], native);
  const recoveredTargetState = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(
    recoveredTargetState.providers["openai-codex"].pendingTransition.phase,
    "prepared",
  );
  await uninstallHarnessProvider({
    ...fixture,
    targetState: recoveredTargetState,
    provider: "openai-codex",
    persistTargetState: async () => writeJson(receiptPath, recoveredTargetState),
  });
  assert.equal(recoveredTargetState.providers, undefined);
});

test("uninstall finishes from auth-restored state after the only backup was deleted", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "delete-access", refresh: "delete-refresh" };
  writeJson(fixture.authPath, { "openai-codex": native });
  const receiptPath = path.join(fixture.homeDir, "target-receipt.json");
  await installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha", "D"),
    replaceNativeAuth: true,
    persistTargetState: async () => writeJson(receiptPath, fixture.targetState),
  });
  const backupPath = fixture.targetState.providers["openai-codex"].backupPath;
  let persists = 0;
  await assert.rejects(
    uninstallHarnessProvider({
      ...fixture,
      provider: "openai-codex",
      persistTargetState: async () => {
        persists += 1;
        if (persists === 3) throw new Error("crash after backup deletion");
        writeJson(receiptPath, fixture.targetState);
      },
    }),
    /crash after backup deletion/,
  );
  assert.equal(fs.existsSync(backupPath), false);
  const recoveredTargetState = JSON.parse(fs.readFileSync(receiptPath));
  assert.equal(
    recoveredTargetState.providers["openai-codex"].pendingTransition.phase,
    "auth_restored",
  );
  const recovered = await uninstallHarnessProvider({
    ...fixture,
    targetState: recoveredTargetState,
    provider: "openai-codex",
    persistTargetState: async () => writeJson(receiptPath, recoveredTargetState),
  });
  assert.equal(recovered.status, "restored_native_cleanup");
  assert.equal(recoveredTargetState.providers, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath))["openai-codex"], native);
});
