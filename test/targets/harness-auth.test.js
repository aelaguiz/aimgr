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

test("native auth is passively backed up, AIM labels switch freely, and uninstall restores native auth", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "NATIVE_ACCESS", refresh: "NATIVE_REFRESH", expires: 123 };
  writeJson(fixture.authPath, {
    anthropic: native,
    unrelated: { type: "api_key", key: "UNCHANGED" },
  });

  const installed = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro8"),
  });
  assert.equal(installed.displacedNative, true);
  assert.equal(fs.statSync(installed.backupPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(path.dirname(installed.backupPath)).mode & 0o777, 0o700);
  const firstBackup = fs.readFileSync(installed.backupPath, "utf8");

  await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro7", "B"),
  });
  assert.equal(fs.readFileSync(installed.backupPath, "utf8"), firstBackup);
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath)).anthropic.binding, "pro7");

  const restored = await uninstallHarnessProvider({ ...fixture, provider: "anthropic" });
  assert.equal(restored.status, "restored_native");
  assert.equal(fs.existsSync(installed.backupPath), false);
  const finalAuth = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.deepEqual(finalAuth.anthropic, native);
  assert.deepEqual(finalAuth.unrelated, { type: "api_key", key: "UNCHANGED" });
  assert.equal(fixture.targetState.providers, undefined);
});

test("stale ownership receipts never gate an AIM descriptor switch or uninstall", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "NATIVE", refresh: "REFRESH" };
  writeJson(fixture.authPath, { anthropic: native });
  const first = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro8"),
  });

  fixture.targetState.providers = {
    anthropic: {
      binding: "pro8",
      lastInstalledDescriptor: descriptor("pro8"),
      backupPath: first.backupPath,
      pendingTransition: {
        schemaVersion: 1,
        operation: "uninstall",
        phase: "prepared",
      },
    },
  };
  writeJson(fixture.authPath, { anthropic: descriptor("pro7", "B") });

  const switched = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro2", "C"),
  });
  assert.equal(switched.wrote, true);
  assert.equal(JSON.parse(fs.readFileSync(fixture.authPath)).anthropic.binding, "pro2");
  assert.equal(fixture.targetState.providers, undefined);

  fixture.targetState.providers = {
    anthropic: {
      binding: "stale",
      lastInstalledDescriptor: descriptor("stale", "D"),
      pendingTransition: { schemaVersion: 1, operation: "uninstall", phase: "prepared" },
    },
  };
  const removed = await uninstallHarnessProvider({ ...fixture, provider: "anthropic" });
  assert.equal(removed.status, "restored_native");
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath)).anthropic, native);
  assert.equal(fixture.targetState.providers, undefined);
});

test("uninstall leaves a native or foreign live entry untouched and clears passive AIM bookkeeping", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "FIRST_NATIVE" };
  const operator = { type: "api_key", key: "OPERATOR_CURRENT" };
  writeJson(fixture.authPath, { anthropic: native });
  const installed = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro8"),
  });
  writeJson(fixture.authPath, { anthropic: operator });
  fixture.targetState.providers = {
    anthropic: {
      lastInstalledDescriptor: descriptor("pro8"),
      pendingTransition: { schemaVersion: 1, operation: "uninstall", phase: "prepared" },
    },
  };

  const result = await uninstallHarnessProvider({ ...fixture, provider: "anthropic" });
  assert.equal(result.status, "already_unmanaged");
  assert.equal(result.wrote, false);
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath)).anthropic, operator);
  assert.equal(fs.existsSync(installed.backupPath), false);
  assert.equal(fixture.targetState.providers, undefined);
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

test("an orphan passive backup is recovered from its deterministic path", async () => {
  const fixture = targetFixture("prime");
  const native = { type: "oauth", access: "ORIGINAL" };
  const backupPath = path.join(
    fixture.homeDir,
    ".aimgr",
    "backups",
    "harness-auth",
    "prime-anthropic.json",
  );
  writeJson(backupPath, {
    schemaVersion: 1,
    target: "prime",
    provider: "anthropic",
    entry: native,
  });
  fs.chmodSync(path.dirname(backupPath), 0o700);
  fs.chmodSync(backupPath, 0o600);
  writeJson(fixture.authPath, { anthropic: descriptor("pro8") });

  const installed = await installHarnessProvider({
    ...fixture,
    provider: "anthropic",
    descriptor: descriptor("pro7", "B"),
  });
  assert.equal(installed.backupPath, backupPath);
  await uninstallHarnessProvider({ ...fixture, provider: "anthropic" });
  assert.deepEqual(JSON.parse(fs.readFileSync(fixture.authPath)).anthropic, native);
});

test("target transaction waits on the harness auth lock and preserves an unrelated concurrent login", async () => {
  const fixture = targetFixture("pi");
  writeJson(fixture.authPath, {});
  const release = await lockfile.lock(fixture.authPath, { stale: 30_000 });
  const pending = installHarnessProvider({
    ...fixture,
    provider: "openai-codex",
    descriptor: descriptor("alpha"),
  });
  writeJson(fixture.authPath, { unrelated: { type: "api_key", key: "LOGIN_WRITE" } });
  await release();
  await pending;
  const auth = JSON.parse(fs.readFileSync(fixture.authPath));
  assert.equal(auth["openai-codex"].binding, "alpha");
  assert.deepEqual(auth.unrelated, { type: "api_key", key: "LOGIN_WRITE" });
});

test("descriptor preflight rejects group/world-writable executables and parent paths", () => {
  const fixture = targetFixture("prime");
  const executable = path.join(fixture.homeDir, "bin", "aimgr.js");
  fs.mkdirSync(path.dirname(executable), { recursive: true, mode: 0o700 });
  fs.writeFileSync(executable, "#!/usr/bin/env node\n", { mode: 0o755 });
  fs.chmodSync(executable, 0o775);
  assert.throws(() => resolveTrustedAimExecutable({ executable }), /owner-trusted/);
  fs.chmodSync(executable, 0o755);
  fs.chmodSync(path.dirname(executable), 0o777);
  assert.throws(() => resolveTrustedAimExecutable({ executable }), /owner-trusted/);
});

test("malformed provider entries still fail loudly", async () => {
  const fixture = targetFixture("prime");
  writeJson(fixture.authPath, { anthropic: "broken" });
  await assert.rejects(
    installHarnessProvider({ ...fixture, provider: "anthropic", descriptor: descriptor("pro8") }),
    /malformed/,
  );
  await assert.rejects(
    uninstallHarnessProvider({ ...fixture, provider: "anthropic" }),
    /malformed/,
  );
});
