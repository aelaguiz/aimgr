import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  buildClaudeNativeStorageDescriptor,
  buildManagedClaudeNativeStorageDescriptor,
  readManagedClaudeNativeBundleFromFiles,
  readClaudeNativeBundleFromStorage,
  readClaudeNativeKeychainOauth,
  readClaudeNativeOauthAccountAtPath,
  writeClaudeNativeKeychainOauth,
} from "../../src/credentials/claude-native-storage.js";
import {
  planClaudeNativeBundleReplacement,
  syncLiveClaudeRotationBackToLabelFromStorage,
  validateAnthropicNativeBundleForLabel,
} from "../../src/credentials/claude-native.js";
import {
  projectClaudeNativeBundleToManagedConfig,
  writeClaudeNativeProjectionPair,
} from "../../src/targets/claude-cli.js";
import { writeJsonFileIfChanged } from "../../src/io/json-store.js";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-22T18:00:00.000Z");
const ACCESS = "ACCESS_SECRET_SENTINEL_MUST_NOT_ESCAPE";
const REFRESH = "REFRESH_SECRET_SENTINEL_MUST_NOT_ESCAPE";
function oauth({
  accessToken = ACCESS,
  refreshToken = REFRESH,
  expiresAt = NOW_MS + 3_600_000,
} = {}) {
  return {
    accessToken,
    refreshToken,
    expiresAt,
    subscriptionType: "max",
    rateLimitTier: "max_20x",
    scopes: ["user:profile", "user:inference"],
  };
}

function account({ emailAddress = "alpha@example.com" } = {}) {
  return {
    accountUuid: "acct_alpha",
    displayName: "Alpha",
    emailAddress,
    organizationName: "Alpha Org",
    organizationUuid: "org_alpha",
  };
}

function credential({
  access = ACCESS,
  refresh = REFRESH,
  expiresAtMs = NOW_MS + 3_600_000,
  emailAddress = "alpha@example.com",
} = {}) {
  const value = buildAnthropicClaudeCredential({
    access,
    refresh,
    expiresAtMs,
    emailAddress,
    organizationName: "Alpha Org",
    organizationUuid: "org_alpha",
  });
  value.nativeClaudeBundle.oauthAccount = account({ emailAddress });
  return value;
}

function writeExactManagedBundle(configDir, value) {
  const bundle = value.nativeClaudeBundle;
  writeJson(path.join(configDir, ".credentials.json"), {
    claudeAiOauth: bundle.claudeAiOauth,
  });
  writeJson(path.join(configDir, ".claude.json"), {
    theme: "dark",
    oauthAccount: bundle.oauthAccount,
  });
  fs.chmodSync(path.join(configDir, ".credentials.json"), 0o600);
  fs.chmodSync(path.join(configDir, ".claude.json"), 0o600);
}

test("complete Keychain reader uses exact secret-free argv and wipes raw buffers", async () => {
  const calls = [];
  let stdoutBuffer;
  let stderrBuffer;
  const result = await readClaudeNativeKeychainOauth({
    service: "Claude Code-credentials-isolated",
    account: "test-user",
    execFileImpl: (file, args, options, callback) => {
      stdoutBuffer = Buffer.from(JSON.stringify({
        claudeAiOauth: {
          ...oauth(),
          ignoredSecret: "UNKNOWN_SECRET_MUST_NOT_ESCAPE",
        },
        wrapperSecret: "WRAPPER_SECRET_MUST_NOT_ESCAPE",
      }));
      stderrBuffer = Buffer.from("STDERR_SECRET_MUST_NOT_ESCAPE");
      calls.push({ file, args, options });
      callback(null, stdoutBuffer, stderrBuffer);
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.oauth.refreshToken, REFRESH);
  assert.deepEqual(calls[0].args, [
    "find-generic-password",
    "-a",
    "test-user",
    "-s",
    "Claude Code-credentials-isolated",
    "-w",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env, undefined);
  assert.doesNotMatch(JSON.stringify(calls[0].args), /SECRET_SENTINEL/);
  assert.doesNotMatch(JSON.stringify(result), /UNKNOWN_SECRET|WRAPPER_SECRET|STDERR_SECRET/);
  assert.ok(stdoutBuffer.every((byte) => byte === 0));
  assert.ok(stderrBuffer.every((byte) => byte === 0));
});

test("Keychain writer sends the complete bundle only through stdin and wipes it", () => {
  const calls = [];
  let inputReference;
  let copiedInput;
  const result = writeClaudeNativeKeychainOauth({
    service: "Claude Code-credentials-isolated",
    account: "test-user",
    oauth: oauth(),
    trustedApplicationPath: process.execPath,
    spawnSyncImpl: (file, args, options) => {
      inputReference = options.input;
      copiedInput = Buffer.from(options.input);
      calls.push({
        file,
        args,
        options: {
          ...options,
          input: "<stdin>",
        },
      });
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, ["-i"]);
  assert.equal(calls[0].options.env, undefined);
  assert.doesNotMatch(JSON.stringify(calls), /ACCESS_SECRET|REFRESH_SECRET/);
  const command = copiedInput.toString("utf8");
  assert.match(command, /^add-generic-password -U /);
  assert.match(command, /-a "test-user"/);
  assert.match(command, /-s "Claude Code-credentials-isolated"/);
  assert.match(command, /-T "\/usr\/bin\/security"/);
  assert.match(command, /-X [a-f0-9]+\n$/);
  assert.doesNotMatch(command, /(?:^|\s)-A(?:\s|$)/);
  assert.doesNotMatch(command, /ACCESS_SECRET|REFRESH_SECRET/);
  const encoded = command.match(/-X ([a-f0-9]+)\n$/)?.[1] ?? "";
  const decoded = Buffer.from(encoded, "hex").toString("utf8");
  assert.match(decoded, /ACCESS_SECRET_SENTINEL/);
  assert.match(decoded, /REFRESH_SECRET_SENTINEL/);
  assert.ok(inputReference.every((byte) => byte === 0));

  let invoked = false;
  assert.deepEqual(
    writeClaudeNativeKeychainOauth({
      service: "Claude Code-credentials-isolated",
      account: "test-user",
      oauth: oauth(),
      trustedApplicationPath: "relative/claude",
      spawnSyncImpl: () => {
        invoked = true;
        return { status: 0 };
      },
    }),
    { ok: false, errorKind: "keychain_write_invalid" },
  );
  assert.equal(invoked, false);
});

test("exact app-state reader rejects unsafe identity files and allowlists stable identity", () => {
  const home = mkTempHome();
  const appStatePath = path.join(home, "slot", ".claude.json");
  writeJson(appStatePath, {
    oauthAccount: {
      ...account(),
      billingSecret: "APP_STATE_SECRET_MUST_NOT_ESCAPE",
    },
    rootSecret: "ROOT_SECRET_MUST_NOT_ESCAPE",
  });
  fs.chmodSync(appStatePath, 0o600);

  const result = readClaudeNativeOauthAccountAtPath({
    appStatePath,
    expectedEmail: "ALPHA@example.com",
  });
  assert.equal(result.ok, true);
  assert.deepEqual(result.oauthAccount, account());
  assert.doesNotMatch(JSON.stringify(result), /APP_STATE_SECRET|ROOT_SECRET/);

  fs.chmodSync(appStatePath, 0o644);
  assert.deepEqual(
    readClaudeNativeOauthAccountAtPath({ appStatePath, expectedEmail: "alpha@example.com" }),
    { ok: false, errorKind: "app_state_unsafe" },
  );
});

test("managed descriptors isolate two labels and read only their private files", () => {
  const home = mkTempHome();
  const defaultConfigDir = path.join(home, ".claude");
  const alphaDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const betaDir = path.join(home, ".aimgr", "claude-homes", "beta", ".claude");
  const alpha = buildManagedClaudeNativeStorageDescriptor({
    configDir: alphaDir,
    defaultConfigDir,
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const beta = buildManagedClaudeNativeStorageDescriptor({
    configDir: betaDir,
    defaultConfigDir,
    expectedEmail: "beta@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  assert.equal(alpha.storageMode, CLAUDE_MANAGED_FILE_STORAGE_MODE);
  assert.equal(beta.storageMode, CLAUDE_MANAGED_FILE_STORAGE_MODE);
  assert.equal(alpha.service, undefined);
  assert.equal(beta.service, undefined);
  assert.notEqual(alpha.credentialsPath, beta.credentialsPath);
  assert.equal(Object.isFrozen(alpha), true);

  writeExactManagedBundle(alpha.configDir, credential());
  const captured = readManagedClaudeNativeBundleFromFiles({ descriptor: alpha });
  assert.equal(captured.ok, true);
  assert.equal(captured.source, "file");
  assert.equal(captured.nativeClaudeBundle.claudeAiOauth.refreshToken, REFRESH);
  assert.equal(captured.nativeClaudeBundle.oauthAccount.accountUuid, "acct_alpha");
  assert.deepEqual(
    readManagedClaudeNativeBundleFromFiles({ descriptor: beta }),
    { ok: false, errorKind: "native_storage_empty" },
  );
});

test("managed reader treats only Claude's exact empty-token tombstone as empty storage", () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const value = credential();
  value.nativeClaudeBundle.claudeAiOauth.accessToken = "";
  value.nativeClaudeBundle.claudeAiOauth.refreshToken = "";
  writeExactManagedBundle(configDir, value);

  assert.deepEqual(
    readManagedClaudeNativeBundleFromFiles({ descriptor }),
    { ok: false, errorKind: "native_storage_empty" },
  );

  for (const [accessToken, refreshToken] of [["", REFRESH], [ACCESS, ""]]) {
    value.nativeClaudeBundle.claudeAiOauth.accessToken = accessToken;
    value.nativeClaudeBundle.claudeAiOauth.refreshToken = refreshToken;
    writeExactManagedBundle(configDir, value);
    assert.deepEqual(
      readManagedClaudeNativeBundleFromFiles({ descriptor }),
      { ok: false, errorKind: "file_bundle_incomplete" },
    );
  }
});

test("strict replacement planning rejects stale, ambiguous, and different identities without mutation", () => {
  const current = credential({ access: "ACCESS_CURRENT", refresh: "REFRESH_CURRENT", expiresAtMs: NOW_MS + 120_000 });
  const stale = credential({ access: "ACCESS_STALE", refresh: "REFRESH_STALE", expiresAtMs: NOW_MS + 90_000 });
  const ambiguous = credential({ access: "ACCESS_OTHER", refresh: "REFRESH_OTHER", expiresAtMs: NOW_MS + 120_000 });
  const newer = credential({ access: "ACCESS_NEW", refresh: "REFRESH_NEW", expiresAtMs: NOW_MS + 180_000 });
  const expired = credential({ access: "ACCESS_EXPIRED", refresh: "REFRESH_STILL_PRESENT", expiresAtMs: NOW_MS - 1 });
  const different = credential({ emailAddress: "other@example.com", expiresAtMs: NOW_MS + 180_000 });
  different.nativeClaudeBundle.oauthAccount.accountUuid = "acct_other";
  different.nativeClaudeBundle.oauthAccount.organizationUuid = "org_other";
  const before = structuredClone(current);

  assert.equal(planClaudeNativeBundleReplacement({ currentBundle: current, candidateBundle: stale, nowMs: NOW_MS }).reason, "stale_candidate");
  assert.equal(planClaudeNativeBundleReplacement({ currentBundle: current, candidateBundle: ambiguous, nowMs: NOW_MS }).reason, "ambiguous_equal_expiry");
  assert.equal(planClaudeNativeBundleReplacement({ currentBundle: current, candidateBundle: different, nowMs: NOW_MS }).reason, "identity_conflict");
  assert.equal(planClaudeNativeBundleReplacement({ currentBundle: current, candidateBundle: newer, nowMs: NOW_MS }).action, "update");
  assert.equal(planClaudeNativeBundleReplacement({ currentBundle: null, candidateBundle: expired, nowMs: NOW_MS }).reason, "candidate_expired");
  assert.equal(planClaudeNativeBundleReplacement({
    currentBundle: null,
    candidateBundle: expired,
    nowMs: NOW_MS,
    allowExpiredCandidate: true,
  }).action, "create");
  assert.deepEqual(current, before);

  const state = {
    schemaVersion: "0.2",
    accounts: {
      alpha: { provider: "openai-codex", expect: { email: "alpha@example.com" } },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { "openai-codex": { history: [] }, anthropic: { history: [] } },
  };
  const stateBefore = structuredClone(state);
  assert.throws(
    () => validateAnthropicNativeBundleForLabel({ state, label: "alpha", nativeClaudeBundle: newer.nativeClaudeBundle }),
    /non-Anthropic/,
  );
  assert.deepEqual(state, stateBefore);

  const identityState = {
    ...stateBefore,
    accounts: {
      alpha: { provider: "anthropic", expect: { email: "expected-secret@example.com" } },
    },
  };
  assert.throws(
    () => validateAnthropicNativeBundleForLabel({
      state: identityState,
      label: "alpha",
      nativeClaudeBundle: newer.nativeClaudeBundle,
    }),
    (error) => {
      assert.match(error.message, /identity_mismatch/);
      assert.doesNotMatch(error.message, /expected-secret|alpha@example/);
      return true;
    },
  );
});

test("two-file projection restores app state when the credential write fails", () => {
  const home = mkTempHome();
  writeClaudeNativeBundle(home, {
    accessToken: "OLD_ACCESS",
    refreshToken: "OLD_REFRESH",
    expiresAtMs: NOW_MS + 120_000,
    appState: { theme: "dark" },
    oauthAccount: account(),
  });
  const credentialsPath = path.join(home, ".claude", ".credentials.json");
  const appStatePath = path.join(home, ".claude.json");
  const credentialsBefore = fs.readFileSync(credentialsPath, "utf8");
  const appStateBefore = fs.readFileSync(appStatePath, "utf8");

  assert.throws(
    () => writeClaudeNativeProjectionPair({
      homeDir: home,
      credential: credential(),
      writeJsonFileIfChangedImpl: (filePath, data, options) => {
        if (filePath === credentialsPath) throw new Error("simulated second write failure");
        return writeJsonFileIfChanged(filePath, data, options);
      },
    }),
    /simulated second write failure/,
  );
  assert.equal(fs.readFileSync(credentialsPath, "utf8"), credentialsBefore);
  assert.equal(fs.readFileSync(appStatePath, "utf8"), appStateBefore);
});

test("managed projection writes and verifies only the selected private files", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const result = await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: credential(),
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.storageMode, CLAUDE_MANAGED_FILE_STORAGE_MODE);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8")).claudeAiOauth.refreshToken, REFRESH);
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json"), "utf8")).oauthAccount.emailAddress, "alpha@example.com");
  assert.doesNotMatch(JSON.stringify(result), /ACCESS_SECRET|REFRESH_SECRET/);
});

test("managed projection accepts an expired access token when a complete refresh lineage exists", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const expired = credential({ expiresAtMs: NOW_MS - 60_000 });
  const result = await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: expired,
    nowMs: NOW_MS,
  });

  assert.equal(result.ok, true);
  const readback = readManagedClaudeNativeBundleFromFiles({ descriptor });
  assert.equal(readback.nativeClaudeBundle.claudeAiOauth.refreshToken, REFRESH);
  assert.equal(readback.nativeClaudeBundle.claudeAiOauth.expiresAt, NOW_MS - 60_000);
});

test("managed projection repairs unchanged credential files to private modes", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const options = {
    descriptor,
    credential: credential(),
    nowMs: NOW_MS,
  };
  await projectClaudeNativeBundleToManagedConfig(options);
  const credentialsPath = path.join(configDir, ".credentials.json");
  const appStatePath = path.join(configDir, ".claude.json");
  fs.chmodSync(credentialsPath, 0o644);
  fs.chmodSync(appStatePath, 0o644);

  const second = await projectClaudeNativeBundleToManagedConfig(options);
  assert.equal(second.wrote.credentials, false);
  assert.equal(second.wrote.appState, false);
  assert.equal(fs.statSync(credentialsPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(appStatePath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(configDir).mode & 0o777, 0o700);
});

test("managed projection rejects a symlinked AIM-owned directory before any file write", async () => {
  const home = mkTempHome();
  const external = path.join(home, "external");
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(home, ".aimgr"), "dir");
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  let wroteCredential = false;

  await assert.rejects(
    projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: credential(),
      nowMs: NOW_MS,
      writeJsonFileIfChangedImpl: () => {
        wroteCredential = true;
        throw new Error("must not write");
      },
    }),
    /unsafe managed Claude directory/,
  );
  assert.equal(wroteCredential, false);
  assert.equal(fs.readdirSync(external).length, 0);

  const read = readManagedClaudeNativeBundleFromFiles({
    descriptor,
  });
  assert.deepEqual(read, { ok: false, errorKind: "managed_storage_unsafe" });
  assert.equal(fs.readdirSync(external).length, 0);
});

test("managed projection restores both files after file-only readback fails", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const oldCredential = credential({ access: "OLD_ACCESS", refresh: "OLD_REFRESH", expiresAtMs: NOW_MS + 120_000 });
  const newCredential = credential({ access: "NEW_ACCESS", refresh: "NEW_REFRESH", expiresAtMs: NOW_MS + 180_000 });
  writeExactManagedBundle(configDir, oldCredential);
  const credentialsPath = path.join(configDir, ".credentials.json");
  const appStatePath = path.join(configDir, ".claude.json");
  const credentialsBefore = fs.readFileSync(credentialsPath, "utf8");
  const appStateBefore = fs.readFileSync(appStatePath, "utf8");

  await assert.rejects(
    () => projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: newCredential,
      nowMs: NOW_MS,
      writeJsonFileIfChangedImpl: (filePath, data, options) => {
        const result = writeJsonFileIfChanged(filePath, data, options);
        if (filePath === credentialsPath) {
          const corrupted = structuredClone(data);
          corrupted.claudeAiOauth.accessToken = "VERIFY_WRONG_ACCESS";
          fs.writeFileSync(filePath, `${JSON.stringify(corrupted, null, 2)}\n`, { mode: 0o600 });
        }
        return result;
      },
    }),
    /projection readback mismatch/,
  );
  assert.equal(fs.readFileSync(credentialsPath, "utf8"), credentialsBefore);
  assert.equal(fs.readFileSync(appStatePath, "utf8"), appStateBefore);
});

test("legacy explicit storage still blocks equal-expiry file and Keychain ambiguity", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    appStatePath: path.join(configDir, ".claude.json"),
    expectedEmail: "alpha@example.com",
  });
  writeExactManagedBundle(configDir, credential({ access: "FILE_ACCESS", refresh: "FILE_REFRESH" }));
  const result = await readClaudeNativeBundleFromStorage({
    descriptor,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: () => ({
      ok: true,
      oauth: oauth({ accessToken: "KEYCHAIN_ACCESS", refreshToken: "KEYCHAIN_REFRESH" }),
    }),
  });
  assert.deepEqual(result, { ok: false, errorKind: "native_storage_freshness_ambiguous" });
});

test("managed projection replaces a different disposable app-state identity from Redis", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  writeJson(descriptor.appStatePath, {
    oauthAccount: account({ emailAddress: "different@example.com" }),
  });
  fs.chmodSync(descriptor.appStatePath, 0o600);
  const result = await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: credential(),
    nowMs: NOW_MS,
  });
  assert.equal(result.ok, true);
  assert.equal(result.action, "projected");
  assert.equal(
    JSON.parse(fs.readFileSync(descriptor.appStatePath, "utf8")).oauthAccount.emailAddress,
    "alpha@example.com",
  );
  assert.equal(
    JSON.parse(fs.readFileSync(descriptor.credentialsPath, "utf8")).claudeAiOauth.refreshToken,
    REFRESH,
  );
});

test("post-run sync captures a newer same-identity file rotation", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const stored = credential({ access: "STORED_ACCESS", refresh: "STORED_REFRESH", expiresAtMs: NOW_MS + 120_000 });
  const rotated = credential({
    access: "ROTATED_ACCESS",
    refresh: "ROTATED_REFRESH",
    expiresAtMs: NOW_MS + 180_000,
  });
  writeExactManagedBundle(configDir, rotated);
  const state = {
    schemaVersion: "0.2",
    accounts: { alpha: { provider: "anthropic", reauth: { mode: "native-claude" } } },
    credentials: { "openai-codex": {}, anthropic: { alpha: stored } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: { activeLabel: "alpha" },
      piCli: {},
    },
    pool: { "openai-codex": { history: [] }, anthropic: { history: [] } },
  };
  const credentialsBefore = structuredClone(state.credentials);
  const result = await syncLiveClaudeRotationBackToLabelFromStorage({
    state,
    descriptor,
    nowMs: NOW_MS,
  });
  assert.equal(result.status, "candidate");
  assert.deepEqual(result.rotatedFields.toSorted(), ["accessToken", "expiresAt", "refreshToken"]);
  assert.equal(result.source, "file");
  assert.equal(
    result.candidateCredential.nativeClaudeBundle.claudeAiOauth.accessToken,
    "ROTATED_ACCESS",
  );
  assert.equal(
    result.candidateCredential.nativeClaudeBundle.claudeAiOauth.refreshToken,
    "ROTATED_REFRESH",
  );
  assert.equal(Object.isFrozen(result), true);
  assert.equal(Object.isFrozen(result.rotatedFields), true);
  assert.equal(Object.isFrozen(result.candidateCredential), true);
  assert.equal(Object.isFrozen(result.candidateCredential.nativeClaudeBundle), true);
  assert.equal(Object.isFrozen(result.candidateCredential.nativeClaudeBundle.claudeAiOauth), true);
  assert.deepEqual(state.credentials, credentialsBefore);
});
