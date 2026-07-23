import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildManagedClaudeNativeStorageDescriptor,
  captureClaudeNativeBundleFromKeychain,
  readClaudeNativeBundleFromStorage,
  readClaudeNativeKeychainOauth,
  readClaudeNativeOauthAccountAtPath,
  writeClaudeNativeKeychainOauth,
} from "../../src/credentials/claude-native-storage.js";
import { buildClaudeKeychainService } from "../../src/credentials/claude-native-storage.js";
import {
  planClaudeNativeBundleReplacement,
  syncLiveClaudeRotationBackToLabelFromStorage,
  validateAnthropicNativeBundleForLabel,
} from "../../src/credentials/claude-native.js";
import {
  projectClaudeNativeBundleToManagedConfig,
  writeClaudeNativeProjectionPair,
} from "../../src/targets/claude-cli.js";
import { runClaudeCli } from "../../src/targets/claude-runner.js";
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
      calls.push({ file, args, options: { ...options, input: "<stdin>" } });
      return { status: 0 };
    },
  });

  assert.deepEqual(result, { ok: true });
  assert.equal(calls[0].file, "/usr/bin/security");
  assert.deepEqual(calls[0].args, [
    "add-generic-password",
    "-U",
    "-a",
    "test-user",
    "-s",
    "Claude Code-credentials-isolated",
    "-T",
    fs.realpathSync(process.execPath),
    "-w",
  ]);
  assert.doesNotMatch(JSON.stringify(calls), /ACCESS_SECRET|REFRESH_SECRET/);
  assert.equal(calls[0].args.includes("-A"), false);
  assert.match(copiedInput.toString("utf8"), /ACCESS_SECRET_SENTINEL/);
  assert.match(copiedInput.toString("utf8"), /REFRESH_SECRET_SENTINEL/);
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

test("managed descriptors isolate two labels and assemble a complete in-memory bundle", async () => {
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
  assert.notEqual(alpha.service, beta.service);
  assert.notEqual(alpha.service, buildClaudeKeychainService({ configDir: defaultConfigDir, defaultConfigDir }));
  assert.equal(Object.isFrozen(alpha), true);

  writeJson(alpha.appStatePath, { oauthAccount: account() });
  fs.chmodSync(alpha.appStatePath, 0o600);
  let reads = 0;
  const captured = await captureClaudeNativeBundleFromKeychain({
    descriptor: alpha,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: ({ service }) => {
      reads += 1;
      assert.equal(service, alpha.service);
      return { ok: true, oauth: oauth() };
    },
  });
  assert.equal(reads, 1);
  assert.equal(captured.ok, true);
  assert.equal(captured.nativeClaudeBundle.claudeAiOauth.refreshToken, REFRESH);
  assert.equal(captured.nativeClaudeBundle.oauthAccount.accountUuid, "acct_alpha");
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

test("managed projection writes and verifies files plus one isolated Keychain item", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  let keychainOauth = null;
  let writes = 0;
  const readKeychain = () => keychainOauth
    ? { ok: true, oauth: structuredClone(keychainOauth) }
    : { ok: false, errorKind: "keychain_item_missing" };
  const result = await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: credential(),
    trustedApplicationPath: process.execPath,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: readKeychain,
    writeClaudeNativeKeychainOauthImpl: ({ service, oauth: next }) => {
      assert.equal(service, descriptor.service);
      writes += 1;
      keychainOauth = structuredClone(next);
      return { ok: true };
    },
    deleteClaudeNativeKeychainOauthImpl: () => {
      keychainOauth = null;
      return { ok: true };
    },
  });
  assert.equal(result.ok, true);
  assert.equal(writes, 1);
  assert.equal(keychainOauth.refreshToken, REFRESH);
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
  let keychainOauth = null;
  const result = await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: expired,
    trustedApplicationPath: process.execPath,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: () => keychainOauth
      ? { ok: true, oauth: structuredClone(keychainOauth) }
      : { ok: false, errorKind: "keychain_item_missing" },
    writeClaudeNativeKeychainOauthImpl: ({ oauth: next }) => {
      keychainOauth = structuredClone(next);
      return { ok: true };
    },
    deleteClaudeNativeKeychainOauthImpl: () => ({ ok: true }),
  });

  assert.equal(result.ok, true);
  assert.equal(keychainOauth.refreshToken, REFRESH);
  assert.equal(keychainOauth.expiresAt, NOW_MS - 60_000);
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
  let keychainOauth = null;
  const options = {
    descriptor,
    credential: credential(),
    trustedApplicationPath: process.execPath,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: () => keychainOauth
      ? { ok: true, oauth: structuredClone(keychainOauth) }
      : { ok: false, errorKind: "keychain_item_missing" },
    writeClaudeNativeKeychainOauthImpl: ({ oauth: next }) => {
      keychainOauth = structuredClone(next);
      return { ok: true };
    },
    deleteClaudeNativeKeychainOauthImpl: () => ({ ok: true }),
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

test("managed projection rejects a symlinked AIM-owned directory before any Keychain write", async () => {
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
  let wroteKeychain = false;

  await assert.rejects(
    projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: credential(),
      trustedApplicationPath: process.execPath,
      nowMs: NOW_MS,
      readClaudeNativeKeychainOauthImpl: () => ({ ok: false, errorKind: "keychain_item_missing" }),
      writeClaudeNativeKeychainOauthImpl: () => {
        wroteKeychain = true;
        return { ok: true };
      },
    }),
    /unsafe managed Claude directory/,
  );
  assert.equal(wroteKeychain, false);
  assert.equal(fs.readdirSync(external).length, 0);

  let keychainReads = 0;
  const read = await readClaudeNativeBundleFromStorage({
    descriptor,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: () => {
      keychainReads += 1;
      return { ok: false, errorKind: "must_not_run" };
    },
  });
  assert.deepEqual(read, { ok: false, errorKind: "managed_storage_unsafe" });
  assert.equal(keychainReads, 0);
  assert.equal(fs.readdirSync(external).length, 0);
});

test("managed projection restores both files and the prior Keychain item after failed verification", async () => {
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
  let keychainOauth = structuredClone(oldCredential.nativeClaudeBundle.claudeAiOauth);
  let readCount = 0;
  const readKeychain = () => {
    readCount += 1;
    if (readCount === 2) {
      return {
        ok: true,
        oauth: oauth({ accessToken: "VERIFY_WRONG_ACCESS", refreshToken: "VERIFY_WRONG_REFRESH", expiresAt: NOW_MS + 180_000 }),
      };
    }
    return { ok: true, oauth: structuredClone(keychainOauth) };
  };

  await assert.rejects(
    () => projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: newCredential,
      trustedApplicationPath: process.execPath,
      nowMs: NOW_MS,
      readClaudeNativeKeychainOauthImpl: readKeychain,
      writeClaudeNativeKeychainOauthImpl: ({ oauth: next }) => {
        keychainOauth = structuredClone(next);
        return { ok: true };
      },
      deleteClaudeNativeKeychainOauthImpl: () => ({ ok: false, errorKind: "unexpected" }),
    }),
    /Keychain projection readback mismatch/,
  );
  assert.equal(keychainOauth.accessToken, "OLD_ACCESS");
  assert.equal(keychainOauth.refreshToken, "OLD_REFRESH");
  assert.equal(fs.readFileSync(credentialsPath, "utf8"), credentialsBefore);
  assert.equal(fs.readFileSync(appStatePath, "utf8"), appStateBefore);
});

test("native storage blocks equal-expiry file and Keychain ambiguity", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
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

test("managed projection blocks a different app-state identity even when files and Keychain tokens are absent", async () => {
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
  let wroteKeychain = false;
  await assert.rejects(
    () => projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: credential(),
      trustedApplicationPath: process.execPath,
      nowMs: NOW_MS,
      readClaudeNativeKeychainOauthImpl: () => ({ ok: false, errorKind: "keychain_item_missing" }),
      writeClaudeNativeKeychainOauthImpl: () => {
        wroteKeychain = true;
        return { ok: true };
      },
    }),
    /file_bundle_unavailable/,
  );
  assert.equal(wroteKeychain, false);
  assert.equal(JSON.parse(fs.readFileSync(descriptor.appStatePath, "utf8")).oauthAccount.emailAddress, "different@example.com");
});

test("post-run sync chooses a newer same-identity Keychain rotation", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  const stored = credential({ access: "STORED_ACCESS", refresh: "STORED_REFRESH", expiresAtMs: NOW_MS + 120_000 });
  const rotatedOauth = oauth({ accessToken: "ROTATED_ACCESS", refreshToken: "ROTATED_REFRESH", expiresAt: NOW_MS + 180_000 });
  writeExactManagedBundle(configDir, stored);
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
  const result = await syncLiveClaudeRotationBackToLabelFromStorage({
    state,
    descriptor,
    nowMs: NOW_MS,
    readClaudeNativeKeychainOauthImpl: () => ({ ok: true, oauth: rotatedOauth }),
  });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.deepEqual(result.rotatedFields.toSorted(), ["accessToken", "expiresAt", "refreshToken"]);
  assert.equal(result.source, "keychain");
  assert.equal(state.credentials.anthropic.alpha.access, "ROTATED_ACCESS");
  assert.equal(state.credentials.anthropic.alpha.refresh, "ROTATED_REFRESH");
  assert.doesNotMatch(JSON.stringify(result), /ROTATED_ACCESS|ROTATED_REFRESH/);
});

test("runner pins both managed config variables and launches the exact trusted executable", async () => {
  const home = mkTempHome();
  const alphaDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const betaDir = path.join(home, ".aimgr", "claude-homes", "beta", ".claude");
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0, signal: null };
  };

  await runClaudeCli({
    command: process.execPath,
    homeDir: home,
    configDir: alphaDir,
    args: ["--exact-argument"],
    env: {
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
    },
    spawnImpl,
  });
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[0].args[0], /src\/targets\/claude-supervisor\.js$/);
  assert.deepEqual(calls[0].args.slice(1), [path.resolve(process.execPath), "--exact-argument"]);
  assert.deepEqual(calls[0].options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, alphaDir);
  assert.equal(calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, alphaDir);

  await runClaudeCli({
    command: process.execPath,
    homeDir: home,
    env: {
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
    },
    spawnImpl,
  });
  assert.equal(calls[1].options.env.CLAUDE_CONFIG_DIR, undefined);
  assert.equal(calls[1].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, undefined);

  const defaultConfigDir = path.join(home, ".claude");
  assert.notEqual(
    buildClaudeKeychainService({ configDir: alphaDir, defaultConfigDir }),
    buildClaudeKeychainService({ configDir: betaDir, defaultConfigDir }),
  );
});

test("runner reports a signalled Claude process as failed", async () => {
  const home = mkTempHome();
  const result = await runClaudeCli({
    command: process.execPath,
    homeDir: home,
    configDir: path.join(home, ".claude"),
    spawnImpl: () => ({ status: null, signal: "SIGTERM" }),
  });
  assert.deepEqual(result, { status: 1, signal: "SIGTERM" });
});

test("runner propagates a real nonzero Claude exit through the supervisor", async () => {
  const home = mkTempHome();
  const result = await runClaudeCli({
    command: process.execPath,
    homeDir: home,
    configDir: path.join(home, ".claude"),
    args: ["-e", "process.exit(7)"],
  });
  assert.deepEqual(result, { status: 7, signal: null });
});
