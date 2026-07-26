import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  buildClaudeNativeStorageDescriptor,
  buildManagedClaudeNativeStorageDescriptor,
  readManagedClaudeNativeBundleFromFiles,
  readClaudeNativeBundleFromStorage,
  readClaudeNativeKeychainOauth,
  readClaudeNativeOauthAccountAtPath,
  retireManagedClaudeCredentialProjection,
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
import {
  ensureManagedClaudePersonalSkillsLink,
  materializeClaudeSecurityShim,
  prepareClaudeCliLaunch,
  resolveEnabledClaudeUserPlugins,
  runClaudeCli,
  syncManagedClaudeUserCustomizations,
  syncManagedClaudePluginPreferences,
  verifyInstalledClaudeExecutable,
} from "../../src/targets/claude-runner.js";
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

function buildPreparedLaunch(home, {
  label = "alpha",
  command = process.execPath,
  launchMode = "darwin-direct",
  userPluginDirs = [],
  userHooksPath = null,
  userMcpConfigPath = null,
} = {}) {
  const aimgrRoot = path.join(home, ".aimgr");
  const selectedLabelHome = path.join(aimgrRoot, "claude-homes", label);
  const configDir = path.join(selectedLabelHome, ".claude");
  const runtimeRoot = path.join(aimgrRoot, "runtime", "claude-file-store");
  const common = {
    command,
    userHomeDir: home,
    homeDir: selectedLabelHome,
    configDir,
    launchMode,
    userPluginDirs,
    userHooksPath,
    userMcpConfigPath,
    aimgrRoot,
    claudeHomesRoot: path.join(aimgrRoot, "claude-homes"),
    selectedLabelHome,
  };
  if (launchMode === "linux-direct") return common;
  return {
    ...common,
    runtimeRoot,
    adapterDir: path.join(runtimeRoot, "source-sha"),
    shimPath: path.join(runtimeRoot, "source-sha", "security"),
  };
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

test("managed projection blocks a different app-state identity before credential projection", async () => {
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
  let wroteCredential = false;
  await assert.rejects(
    () => projectClaudeNativeBundleToManagedConfig({
      descriptor,
      credential: credential(),
      nowMs: NOW_MS,
      writeJsonFileIfChangedImpl: () => {
        wroteCredential = true;
        throw new Error("must not write");
      },
    }),
    /file_bundle_unavailable/,
  );
  assert.equal(wroteCredential, false);
  assert.equal(JSON.parse(fs.readFileSync(descriptor.appStatePath, "utf8")).oauthAccount.emailAddress, "different@example.com");
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
  const result = await syncLiveClaudeRotationBackToLabelFromStorage({
    state,
    descriptor,
    nowMs: NOW_MS,
  });
  assert.equal(result.synced, true, JSON.stringify(result));
  assert.deepEqual(result.rotatedFields.toSorted(), ["accessToken", "expiresAt", "refreshToken"]);
  assert.equal(result.source, "file");
  assert.equal(state.credentials.anthropic.alpha.access, "ROTATED_ACCESS");
  assert.equal(state.credentials.anthropic.alpha.refresh, "ROTATED_REFRESH");
  assert.doesNotMatch(JSON.stringify(result), /ROTATED_ACCESS|ROTATED_REFRESH/);
});

test("managed retirement removes only the disposable credential projection", async () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  await projectClaudeNativeBundleToManagedConfig({
    descriptor,
    credential: credential(),
    nowMs: NOW_MS,
  });
  const sessionPath = path.join(configDir, "sessions", "resume-marker");
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, "keep");

  assert.deepEqual(retireManagedClaudeCredentialProjection({ descriptor }), { removed: true });
  assert.equal(fs.existsSync(descriptor.credentialsPath), false);
  assert.equal(fs.existsSync(descriptor.appStatePath), true);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), "keep");
  assert.deepEqual(retireManagedClaudeCredentialProjection({ descriptor }), { removed: false });
});

test("compatibility executable is content-addressed, private, and reusable", {
  skip: process.platform !== "darwin",
}, () => {
  const home = mkTempHome();
  const first = materializeClaudeSecurityShim({ homeDir: home });
  const second = materializeClaudeSecurityShim({ homeDir: home });
  assert.deepEqual(second, first);
  assert.match(first.sourceSha256, /^[a-f0-9]{64}$/);
  assert.equal(fs.statSync(first.shimPath).mode & 0o777, 0o500);
  assert.equal(fs.statSync(first.shimPath).nlink, 1);
});

test("managed Claude shares only the exact personal skills directory and rejects conflicts", () => {
  const home = mkTempHome();
  const selectedHome = path.join(home, ".aimgr", "claude-homes", "alpha");
  const configDir = path.join(selectedHome, ".claude");
  const source = path.join(home, ".claude", "skills");
  const destination = path.join(configDir, "skills");
  fs.mkdirSync(configDir, { recursive: true });

  assert.deepEqual(
    ensureManagedClaudePersonalSkillsLink({
      userHomeDir: home,
      configDir,
    }),
    { linked: false, reason: "source_missing" },
  );

  fs.mkdirSync(path.join(source, "shared-proof"), { recursive: true });
  fs.writeFileSync(path.join(source, "shared-proof", "SKILL.md"), "proof");
  assert.deepEqual(
    ensureManagedClaudePersonalSkillsLink({
      userHomeDir: home,
      configDir,
    }),
    { linked: true, path: destination },
  );
  assert.equal(fs.lstatSync(destination).isSymbolicLink(), true);
  assert.equal(fs.readlinkSync(destination), source);

  assert.deepEqual(
    ensureManagedClaudePersonalSkillsLink({
      userHomeDir: home,
      configDir,
    }),
    { linked: true, path: destination },
  );

  const conflictHome = mkTempHome();
  const conflictConfig = path.join(conflictHome, ".aimgr", "claude-homes", "alpha", ".claude");
  fs.mkdirSync(path.join(conflictHome, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(path.join(conflictConfig, "skills"), { recursive: true });
  assert.throws(
    () => ensureManagedClaudePersonalSkillsLink({
      userHomeDir: conflictHome,
      configDir: conflictConfig,
    }),
    /conflicting managed Claude skills path/,
  );

  const wrongLinkHome = mkTempHome();
  const wrongLinkConfig = path.join(wrongLinkHome, ".aimgr", "claude-homes", "alpha", ".claude");
  const wrongTarget = path.join(wrongLinkHome, "other-skills");
  fs.mkdirSync(path.join(wrongLinkHome, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(wrongTarget, { recursive: true });
  fs.mkdirSync(wrongLinkConfig, { recursive: true });
  fs.symlinkSync(wrongTarget, path.join(wrongLinkConfig, "skills"), "dir");
  assert.throws(
    () => ensureManagedClaudePersonalSkillsLink({
      userHomeDir: wrongLinkHome,
      configDir: wrongLinkConfig,
    }),
    /conflicting managed Claude skills path/,
  );
});

test("managed Claude mirrors only allowlisted user settings and MCPs on every launch", () => {
  const home = mkTempHome();
  const claudeDir = path.join(home, ".claude");
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const hookRoot = path.join(claudeDir, "custom-hook");
  const mcpRoot = path.join(claudeDir, "custom-mcp");
  fs.mkdirSync(hookRoot, { recursive: true });
  fs.mkdirSync(mcpRoot, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  const hooks = {
    SessionStart: [{
      hooks: [{
        type: "command",
        command: `${hookRoot}/start.sh`,
      }],
    }],
  };
  const mcpServers = {
    browseros: {
      type: "http",
      url: "http://127.0.0.1:9000/mcp",
    },
    custom: {
      command: `${mcpRoot}/server`,
      args: ["--stdio"],
    },
  };
  const statusLine = {
    type: "command",
    command: "bash ~/.claude/statusline-command.sh",
    refreshInterval: 2,
  };
  writeJson(path.join(claudeDir, "settings.json"), {
    hooks,
    statusLine,
    enabledPlugins: { "proof@market": true },
    theme: "dark",
  });
  writeJson(path.join(home, ".claude.json"), {
    mcpServers,
    oauthAccount: { accessToken: "OAUTH_MUST_NOT_ENTER_OVERLAY" },
    projects: { "/private/project": { allowedTools: ["Bash"] } },
  });

  const result = syncManagedClaudeUserCustomizations({
    userHomeDir: home,
    configDir,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.hooksPath, "utf8")), {
    hooks,
    statusLine,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(result.mcpConfigPath, "utf8")), { mcpServers });
  assert.equal(fs.statSync(result.hooksPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(result.mcpConfigPath).mode & 0o777, 0o600);
  assert.doesNotMatch(
    `${fs.readFileSync(result.hooksPath, "utf8")}${fs.readFileSync(result.mcpConfigPath, "utf8")}`,
    /OAUTH_MUST_NOT_ENTER_OVERLAY|enabledPlugins|projects|theme/,
  );

  writeJson(path.join(claudeDir, "settings.json"), { hooks: {}, statusLine: {} });
  writeJson(path.join(home, ".claude.json"), { mcpServers: {} });
  const cleared = syncManagedClaudeUserCustomizations({
    userHomeDir: home,
    configDir,
  });
  assert.deepEqual(cleared, {
    hooksPath: null,
    mcpConfigPath: null,
  });
  assert.equal(fs.existsSync(result.hooksPath), false);
  assert.equal(fs.existsSync(result.mcpConfigPath), false);

  writeJson(path.join(claudeDir, "settings.json"), { hooks: [] });
  assert.throws(
    () => syncManagedClaudeUserCustomizations({
      userHomeDir: home,
      configDir,
    }),
    /user hooks are malformed/,
  );
  writeJson(path.join(claudeDir, "settings.json"), { statusLine: "invalid" });
  assert.throws(
    () => syncManagedClaudeUserCustomizations({
      userHomeDir: home,
      configDir,
    }),
    /user status-line settings are malformed/,
  );
});

test("managed Claude resolves enabled user plugins from Claude's canonical state", () => {
  const home = mkTempHome();
  const claudeDir = path.join(home, ".claude");
  const cacheDir = path.join(claudeDir, "plugins", "cache");
  const alphaDir = path.join(cacheDir, "market", "alpha", "1.0.0");
  const betaDir = path.join(cacheDir, "market", "beta", "1.0.0");
  const zetaDir = path.join(cacheDir, "market", "zeta", "2.0.0");
  for (const pluginDir of [alphaDir, betaDir, zetaDir]) {
    fs.mkdirSync(pluginDir, { recursive: true });
  }
  writeJson(path.join(claudeDir, "settings.json"), {
    enabledPlugins: {
      "zeta@market": true,
      "beta@market": false,
      "alpha@market": true,
    },
  });
  writeJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "alpha@market": [
        { scope: "project", installPath: "/not/a/user/install" },
        { scope: "user", installPath: alphaDir },
      ],
      "beta@market": [{ scope: "user", installPath: betaDir }],
      "zeta@market": [{ scope: "user", installPath: zetaDir }],
    },
  });

  assert.deepEqual(resolveEnabledClaudeUserPlugins({ userHomeDir: home }), [
    { id: "alpha@market", installPath: fs.realpathSync(alphaDir) },
    { id: "zeta@market", installPath: fs.realpathSync(zetaDir) },
  ]);

  const emptyHome = mkTempHome();
  assert.deepEqual(resolveEnabledClaudeUserPlugins({ userHomeDir: emptyHome }), []);
});

test("managed Claude fails closed on contradictory or unsafe enabled plugin state", () => {
  const missingInstallHome = mkTempHome();
  const missingClaudeDir = path.join(missingInstallHome, ".claude");
  fs.mkdirSync(path.join(missingClaudeDir, "plugins", "cache"), { recursive: true });
  writeJson(path.join(missingClaudeDir, "settings.json"), {
    enabledPlugins: { "missing@market": true },
  });
  writeJson(path.join(missingClaudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "missing@market": [{ scope: "project", installPath: "/tmp/project-plugin" }],
    },
  });
  assert.throws(
    () => resolveEnabledClaudeUserPlugins({ userHomeDir: missingInstallHome }),
    /no unambiguous user installation/,
  );

  const escapingHome = mkTempHome();
  const escapingClaudeDir = path.join(escapingHome, ".claude");
  const outsideDir = path.join(escapingHome, "outside-plugin");
  fs.mkdirSync(path.join(escapingClaudeDir, "plugins", "cache"), { recursive: true });
  fs.mkdirSync(outsideDir);
  writeJson(path.join(escapingClaudeDir, "settings.json"), {
    enabledPlugins: { "escape@market": true },
  });
  writeJson(path.join(escapingClaudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "escape@market": [{ scope: "user", installPath: outsideDir }],
    },
  });
  assert.throws(
    () => resolveEnabledClaudeUserPlugins({ userHomeDir: escapingHome }),
    /escapes the user plugin cache/,
  );
});

test("managed Claude mirrors only the requested ADHD always-on preference", () => {
  const home = mkTempHome();
  const configDir = path.join(home, ".aimgr", "claude-homes", "alpha", ".claude");
  const source = path.join(home, ".claude", ".i-have-adhd-always");
  const destination = path.join(configDir, ".i-have-adhd-always");
  fs.mkdirSync(path.dirname(source), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(source, "");

  assert.deepEqual(syncManagedClaudePluginPreferences({
    userHomeDir: home,
    configDir,
    enabledPluginIds: ["i-have-adhd@i-have-adhd"],
  }), {
    enabled: true,
    path: destination,
  });
  assert.equal(fs.readFileSync(destination, "utf8"), "");
  assert.equal(fs.statSync(destination).mode & 0o777, 0o600);

  fs.unlinkSync(source);
  assert.deepEqual(syncManagedClaudePluginPreferences({
    userHomeDir: home,
    configDir,
    enabledPluginIds: ["i-have-adhd@i-have-adhd"],
  }), {
    enabled: false,
    path: null,
  });
  assert.equal(fs.existsSync(destination), false);

  fs.writeFileSync(source, "");
  syncManagedClaudePluginPreferences({
    userHomeDir: home,
    configDir,
    enabledPluginIds: [],
  });
  assert.equal(fs.existsSync(destination), false);
});

test("runner preserves the user home while pinning Claude config and exact launch behavior", async () => {
  const home = mkTempHome();
  const userHooksPath = path.join(home, ".aimgr-user-hooks.json");
  const userMcpConfigPath = path.join(home, ".aimgr-user-mcp.json");
  const pluginDirs = [
    path.join(home, ".claude", "plugins", "cache", "market", "alpha", "1.0.0"),
    path.join(home, ".claude", "plugins", "cache", "market", "zeta", "2.0.0"),
  ];
  const preparedLaunch = buildPreparedLaunch(home, {
    userPluginDirs: pluginDirs,
    userHooksPath,
    userMcpConfigPath,
  });
  const calls = [];
  const spawnImpl = (file, args, options) => {
    calls.push({ file, args, options });
    return { status: 0, signal: null };
  };

  await runClaudeCli({
    command: preparedLaunch.command,
    userHomeDir: home,
    homeDir: preparedLaunch.homeDir,
    configDir: preparedLaunch.configDir,
    cwd: home,
    args: ["--exact-argument"],
    env: {
      HOME: home,
      PATH: "/custom/bin:/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
      CLAUDE_CODE_OAUTH_TOKEN: "must-be-scrubbed",
      ANTHROPIC_API_KEY: "must-be-scrubbed",
      PRESERVED_PROJECT_ENV: "yes",
    },
    preparedLaunch,
    spawnImpl,
  });
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[0].args[0], /src\/targets\/claude-supervisor\.js$/);
  assert.deepEqual(calls[0].args.slice(1), [
    preparedLaunch.command,
    "--settings",
    userHooksPath,
    "--mcp-config",
    userMcpConfigPath,
    "--plugin-dir",
    pluginDirs[0],
    "--plugin-dir",
    pluginDirs[1],
    "--exact-argument",
  ]);
  assert.deepEqual(calls[0].options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
  assert.equal(calls[0].options.cwd, home);
  assert.equal(calls[0].options.env.HOME, preparedLaunch.userHomeDir);
  assert.notEqual(calls[0].options.env.HOME, preparedLaunch.homeDir);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, preparedLaunch.configDir);
  assert.equal(calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, preparedLaunch.configDir);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls[0].options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(calls[0].options.env.PRESERVED_PROJECT_ENV, "yes");
  assert.equal(
    calls[0].options.env.PATH,
    `${preparedLaunch.adapterDir}:/custom/bin:/usr/bin:/bin`,
  );
});

test("Darwin runner permits ps and a nested build sandbox", {
  skip: process.platform !== "darwin",
}, async () => {
  const home = mkTempHome();
  const preparedLaunch = buildPreparedLaunch(home);
  const result = await runClaudeCli({
    command: preparedLaunch.command,
    userHomeDir: home,
    homeDir: preparedLaunch.homeDir,
    configDir: preparedLaunch.configDir,
    cwd: home,
    args: [
      "-e",
      [
        'const { spawnSync } = require("node:child_process");',
        'const ps = spawnSync("/bin/ps", ["-p", "1"], { stdio: "ignore" });',
        "const nested = spawnSync(",
        '  "/usr/bin/sandbox-exec",',
        '  ["-p", "(version 1) (allow default)", "/bin/echo", "nested-ok"],',
        '  { stdio: "ignore" },',
        ");",
        "process.exit(ps.status === 0 && nested.status === 0 ? 0 : 1);",
      ].join("\n"),
    ],
    env: {
      HOME: home,
      PATH: "/usr/bin:/bin",
    },
    preparedLaunch,
  });
  assert.deepEqual(result, { status: 0, signal: null });
});

test("Darwin qualification trusts the Anthropic signing identity without a release pin", async () => {
  const command = "/Users/test/.local/share/claude/versions/9.9.9";
  let signatureChecked = false;
  const result = await verifyInstalledClaudeExecutable({
    command,
    platform: "darwin",
    arch: "arm64",
    fsImpl: {
      realpathSync: (filePath) => {
        assert.equal(filePath, command);
        return command;
      },
      lstatSync: (filePath) => {
        assert.equal(filePath, command);
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          nlink: 1,
          uid: typeof process.getuid === "function" ? process.getuid() : 0,
        };
      },
      accessSync: (filePath, mode) => {
        assert.equal(filePath, command);
        assert.equal(mode, fs.constants.X_OK);
      },
    },
    hashFileImpl: async () => {
      throw new Error("Darwin qualification must not pin a release digest.");
    },
    verifyCodeSignatureImpl: (filePath, { build }) => {
      assert.equal(filePath, command);
      assert.equal(build.identifier, "com.anthropic.claude-code");
      assert.equal(build.teamIdentifier, "Q6L2SF6YDW");
      signatureChecked = true;
    },
  });
  assert.equal(result, command);
  assert.equal(signatureChecked, true);
});

test("Linux qualification accepts only the pinned native x64 artifact without Darwin signing", async () => {
  const command = "/home/test/.local/share/claude/versions/2.1.218";
  let signatureChecked = false;
  const result = await verifyInstalledClaudeExecutable({
    command,
    platform: "linux",
    arch: "x64",
    fsImpl: {
      realpathSync: (filePath) => {
        assert.equal(filePath, command);
        return command;
      },
      lstatSync: (filePath) => {
        assert.equal(filePath, command);
        return {
          isFile: () => true,
          isSymbolicLink: () => false,
          nlink: 1,
          uid: typeof process.getuid === "function" ? process.getuid() : 0,
        };
      },
      accessSync: (filePath, mode) => {
        assert.equal(filePath, command);
        assert.equal(mode, fs.constants.X_OK);
      },
    },
    hashFileImpl: async (filePath) => {
      assert.equal(filePath, command);
      return "e12071751a9336b8af1012c103358ff04ac18f9aaff4a738cff7ba5cdfaf63f2";
    },
    verifyCodeSignatureImpl: () => {
      signatureChecked = true;
    },
  });
  assert.equal(result, command);
  assert.equal(signatureChecked, false);
});

test("Linux qualification rejects an unqualified digest and unsupported architecture", async () => {
  const command = "/home/test/.local/share/claude/versions/2.1.218";
  const fsImpl = {
    realpathSync: () => command,
    lstatSync: () => ({
      isFile: () => true,
      isSymbolicLink: () => false,
      nlink: 1,
      uid: typeof process.getuid === "function" ? process.getuid() : 0,
    }),
    accessSync: () => {},
  };
  await assert.rejects(
    () => verifyInstalledClaudeExecutable({
      command,
      platform: "linux",
      arch: "x64",
      fsImpl,
      hashFileImpl: async () => "0".repeat(64),
    }),
    /digest is not the qualified native build/,
  );
  await assert.rejects(
    () => verifyInstalledClaudeExecutable({
      command,
      platform: "linux",
      arch: "arm64",
      fsImpl,
    }),
    /only qualified native Darwin arm64 and Linux x64 builds/,
  );
});

test("Linux preflight omits the macOS Keychain adapter", async () => {
  const home = mkTempHome();
  const command = "/home/test/.local/share/claude/versions/2.1.218";
  const selectedLabelHome = path.join(home, ".aimgr", "claude-homes", "alpha");
  const configDir = path.join(selectedLabelHome, ".claude");
  const personalSkills = path.join(home, ".claude", "skills");
  const pluginDir = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "i-have-adhd",
    "i-have-adhd",
    "0.1.0",
  );
  fs.mkdirSync(personalSkills, { recursive: true });
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".i-have-adhd-always"), "");
  writeJson(path.join(home, ".claude", "settings.json"), {
    enabledPlugins: {
      "i-have-adhd@i-have-adhd": true,
    },
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: "/usr/bin/true" }],
      }],
    },
    statusLine: {
      type: "command",
      command: "bash ~/.claude/statusline-command.sh",
      refreshInterval: 2,
    },
  });
  writeJson(path.join(home, ".claude.json"), {
    mcpServers: {
      browseros: { type: "http", url: "http://127.0.0.1:9000/mcp" },
    },
    oauthAccount: { accessToken: "DO_NOT_COPY" },
  });
  writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "i-have-adhd@i-have-adhd": [{ scope: "user", installPath: pluginDir }],
    },
  });
  let verified = false;
  const prepared = await prepareClaudeCliLaunch({
    command,
    userHomeDir: home,
    homeDir: selectedLabelHome,
    configDir,
    platform: "linux",
    arch: "x64",
    verifyInstalledClaudeExecutableImpl: async (options) => {
      assert.equal(options.command, command);
      assert.equal(options.platform, "linux");
      assert.equal(options.arch, "x64");
      verified = true;
      return command;
    },
    materializeClaudeSecurityShimImpl: () => {
      throw new Error("Linux preflight must not materialize the macOS security shim.");
    },
  });
  assert.equal(verified, true);
  assert.equal(prepared.launchMode, "linux-direct");
  assert.equal(prepared.command, command);
  assert.equal(prepared.homeDir, selectedLabelHome);
  assert.equal(prepared.configDir, configDir);
  assert.equal(prepared.adapterDir, undefined);
  assert.deepEqual(prepared.userPluginDirs, [fs.realpathSync(pluginDir)]);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.userHooksPath, "utf8")), {
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: "/usr/bin/true" }],
      }],
    },
    statusLine: {
      type: "command",
      command: "bash ~/.claude/statusline-command.sh",
      refreshInterval: 2,
    },
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.userMcpConfigPath, "utf8")), {
    mcpServers: {
      browseros: { type: "http", url: "http://127.0.0.1:9000/mcp" },
    },
  });
  assert.equal(fs.readlinkSync(path.join(configDir, "skills")), personalSkills);
  assert.equal(
    fs.existsSync(path.join(configDir, ".i-have-adhd-always")),
    true,
  );
});

test("fresh login staging remains plugin-free", async () => {
  const home = mkTempHome();
  const command = "/home/test/.local/share/claude/versions/2.1.218";
  const stagingHome = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "alpha",
    ".login-staging",
  );
  const configDir = path.join(stagingHome, ".claude");
  const pluginDir = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "i-have-adhd",
    "i-have-adhd",
    "0.1.0",
  );
  fs.mkdirSync(pluginDir, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", ".i-have-adhd-always"), "");
  writeJson(path.join(home, ".claude", "settings.json"), {
    enabledPlugins: {
      "i-have-adhd@i-have-adhd": true,
    },
    hooks: {
      SessionStart: [{
        hooks: [{ type: "command", command: "/usr/bin/true" }],
      }],
    },
  });
  writeJson(path.join(home, ".claude.json"), {
    mcpServers: {
      browseros: { type: "http", url: "http://127.0.0.1:9000/mcp" },
    },
  });
  writeJson(path.join(home, ".claude", "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "i-have-adhd@i-have-adhd": [{ scope: "user", installPath: pluginDir }],
    },
  });

  const prepared = await prepareClaudeCliLaunch({
    command,
    userHomeDir: home,
    homeDir: stagingHome,
    configDir,
    platform: "linux",
    arch: "x64",
    verifyInstalledClaudeExecutableImpl: async () => command,
  });

  assert.deepEqual(prepared.userPluginDirs, []);
  assert.equal(prepared.userHooksPath, null);
  assert.equal(prepared.userMcpConfigPath, null);
  assert.equal(fs.existsSync(path.join(configDir, "skills")), false);
  assert.equal(fs.existsSync(path.join(configDir, ".i-have-adhd-always")), false);
  assert.equal(fs.existsSync(path.join(configDir, ".aimgr-user-hooks.json")), false);
  assert.equal(fs.existsSync(path.join(configDir, ".aimgr-user-mcp.json")), false);
});

test("Linux runner preserves the user home and directly supervises the exact Claude argv", async () => {
  const home = mkTempHome();
  const userHooksPath = path.join(home, ".aimgr-user-hooks.json");
  const userMcpConfigPath = path.join(home, ".aimgr-user-mcp.json");
  const pluginDir = path.join(
    home,
    ".claude",
    "plugins",
    "cache",
    "market",
    "alpha",
    "1.0.0",
  );
  const preparedLaunch = buildPreparedLaunch(home, {
    launchMode: "linux-direct",
    command: "/home/test/.local/share/claude/versions/2.1.218",
    userPluginDirs: [pluginDir],
    userHooksPath,
    userMcpConfigPath,
  });
  const calls = [];
  await runClaudeCli({
    command: preparedLaunch.command,
    userHomeDir: home,
    homeDir: preparedLaunch.homeDir,
    configDir: preparedLaunch.configDir,
    cwd: home,
    args: ["--version"],
    env: {
      HOME: home,
      PATH: "/custom/bin:/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_CODE_OAUTH_TOKEN: "must-be-scrubbed",
      LD_LIBRARY_PATH: "/untrusted",
      LD_PRELOAD: "/untrusted/library.so",
      PRESERVED_PROJECT_ENV: "yes",
    },
    preparedLaunch,
    spawnImpl: (file, args, options) => {
      calls.push({ file, args, options });
      return { status: 0, signal: null };
    },
  });
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[0].args[0], /src\/targets\/claude-supervisor\.js$/);
  assert.deepEqual(calls[0].args.slice(1), [
    preparedLaunch.command,
    "--settings",
    userHooksPath,
    "--mcp-config",
    userMcpConfigPath,
    "--plugin-dir",
    pluginDir,
    "--version",
  ]);
  assert.equal(calls[0].options.cwd, home);
  assert.equal(calls[0].options.env.HOME, preparedLaunch.userHomeDir);
  assert.notEqual(calls[0].options.env.HOME, preparedLaunch.homeDir);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, preparedLaunch.configDir);
  assert.equal(calls[0].options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls[0].options.env.LD_LIBRARY_PATH, undefined);
  assert.equal(calls[0].options.env.LD_PRELOAD, undefined);
  assert.equal(calls[0].options.env.PRESERVED_PROJECT_ENV, "yes");
  assert.equal(calls[0].options.env.PATH, "/custom/bin:/usr/bin:/bin");
});

test("runner preserves a signalled Claude process result", async () => {
  const home = mkTempHome();
  const preparedLaunch = buildPreparedLaunch(home);
  const result = await runClaudeCli({
    command: preparedLaunch.command,
    userHomeDir: home,
    homeDir: preparedLaunch.homeDir,
    configDir: preparedLaunch.configDir,
    preparedLaunch,
    spawnImpl: () => ({ status: null, signal: "SIGTERM" }),
  });
  assert.deepEqual(result, { status: null, signal: "SIGTERM" });
});

test("runner preserves a nonzero Claude exit", async () => {
  const home = mkTempHome();
  const preparedLaunch = buildPreparedLaunch(home);
  const result = await runClaudeCli({
    command: preparedLaunch.command,
    userHomeDir: home,
    homeDir: preparedLaunch.homeDir,
    configDir: preparedLaunch.configDir,
    preparedLaunch,
    spawnImpl: () => ({ status: 7, signal: null }),
  });
  assert.deepEqual(result, { status: 7, signal: null });
});
