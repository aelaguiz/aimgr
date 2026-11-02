import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  buildClaudeNativeStorageDescriptor,
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
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
  applyClaudeCliFromState,
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

test("Keychain projection preserves native OAuth client and refresh expiry metadata", async () => {
  for (const metadata of [{}, { clientId: "synthetic-native-client", refreshTokenExpiresAt: NOW_MS + 86400000 },
    { clientId: null, refreshTokenExpiresAt: null }]) {
    const result = await readClaudeNativeKeychainOauth({ service: "Claude Code-credentials-synthetic", account: "test-user",
      execFileImpl: (_file, _args, _options, callback) => callback(null,
        Buffer.from(JSON.stringify({ claudeAiOauth: { ...oauth(), ...metadata } })), Buffer.alloc(0)),
    });
    assert.equal(result.ok, true);
    for (const key of ["clientId", "refreshTokenExpiresAt"]) {
      assert.equal(Object.hasOwn(result.oauth, key), Object.hasOwn(metadata, key));
      assert.deepEqual(result.oauth[key], metadata[key]);
    }
  }
});

test("Keychain projection preserves subscription verification provenance without inventing freshness", async () => {
  for (const provenance of [{}, { subscriptionTypeSource: "sign_in" },
    { subscriptionTypeSource: "profile", subscriptionTypeVerifiedAt: NOW_MS },
    { subscriptionTypeSource: "profile", subscriptionTypeVerifiedAt: null },
    { subscriptionTypeSource: "profile", subscriptionTypeVerifiedAt: "malformed" }]) {
    const result = await readClaudeNativeKeychainOauth({
      service: "Claude Code-credentials-synthetic", account: "test-user",
      execFileImpl: (_file, _args, _options, callback) => callback(null,
        Buffer.from(JSON.stringify({ claudeAiOauth: { ...oauth(), ...provenance } })), Buffer.alloc(0)),
    });
    assert.equal(result.ok, true);
    for (const key of ["subscriptionTypeSource", "subscriptionTypeVerifiedAt"]) {
      assert.equal(Object.hasOwn(result.oauth, key), Object.hasOwn(provenance, key));
      assert.deepEqual(result.oauth[key], provenance[key]);
    }
  }
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

test("two-file projection restores app state when the credential write fails", async () => {
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

  await assert.rejects(
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

test("legacy-only native state preserves newer local OAuth during reconciliation and reprojection", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".aimgr/claude-homes/alpha/.claude");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  const newer = credential({ access: "NEWER_NATIVE_ACCESS", refresh: "NEWER_NATIVE_REFRESH",
    expiresAtMs: NOW_MS + 7_200_000 });
  writeJson(path.join(configDir, ".config.json"), { oauthAccount: newer.nativeClaudeBundle.oauthAccount,
    projects: { retained: true } });
  writeJson(path.join(configDir, ".credentials.json"), { claudeAiOauth: newer.nativeClaudeBundle.claudeAiOauth,
    mcpOAuth: { retained: true } });
  const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com", managedRootDir: path.join(home, ".aimgr") });
  const read = readManagedClaudeNativeBundleFromFiles({ descriptor });
  assert.equal(read.ok, true); assert.deepEqual(read.nativeClaudeBundle, newer.nativeClaudeBundle);
  const result = await projectClaudeNativeBundleToManagedConfig({ descriptor, credential: credential(),
    nowMs: NOW_MS, preserveNewerLocal: true });
  assert.equal(result.action, "kept_local");
  assert.equal(JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"))).claudeAiOauth.refreshToken,
    "NEWER_NATIVE_REFRESH");
  assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), false);
  // A stale canonical owner cannot redirect file/keychain identity selection.
  writeJson(path.join(configDir, ".claude.json"), { oauthAccount: account({ emailAddress: "wrong@example.com" }) });
  assert.equal(readManagedClaudeNativeBundleFromFiles({ descriptor }).ok, true);
});

test("projection preserves ambiguous and incomplete same-account token lineages", async t => {
  for (const incomplete of [false, true]) {
    const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const configDir = path.join(home, ".aimgr/claude-homes/alpha/.claude");
    fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
    const current = credential({ access: "NATIVE_ACCESS", refresh: "NATIVE_REFRESH" }).nativeClaudeBundle;
    if (incomplete) delete current.claudeAiOauth.rateLimitTier;
    writeJson(path.join(configDir, ".claude.json"), { oauthAccount: current.oauthAccount });
    writeJson(path.join(configDir, ".credentials.json"), { claudeAiOauth: current.claudeAiOauth });
    const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, defaultConfigDir: path.join(home, ".claude"),
      expectedEmail: "alpha@example.com", managedRootDir: path.join(home, ".aimgr") });
    const before = fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8");
    await assert.rejects(projectClaudeNativeBundleToManagedConfig({ descriptor, credential: credential(),
      nowMs: NOW_MS, preserveNewerLocal: true }), /preserve.*repair/);
    assert.equal(fs.readFileSync(path.join(configDir, ".credentials.json"), "utf8"), before);
  }
});

test("ordinary projection retains corrupt-cache repair only for the exact empty-token tombstone", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".aimgr/claude-homes/alpha/.claude");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(configDir, ".claude.json"), "{malformed", { mode: 0o600 });
  writeJson(path.join(configDir, ".credentials.json"), { claudeAiOauth: { ...oauth(), accessToken: "", refreshToken: "" },
    mcpOAuth: { retained: true } });
  const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com", managedRootDir: path.join(home, ".aimgr") });
  const result = await projectClaudeNativeBundleToManagedConfig({ descriptor, credential: credential(),
    nowMs: NOW_MS, preserveNewerLocal: true });
  assert.equal(result.action, "projected");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"))).mcpOAuth, { retained: true });
});

test("projection waits for native MCP/OAuth writes and rechecks freshness under their existing lock", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const configDir = path.join(home, ".aimgr/claude-homes/alpha/.claude");
  fs.mkdirSync(configDir, { recursive: true, mode: 0o700 });
  writeJson(path.join(configDir, ".claude.json"), { oauthAccount: account() });
  writeJson(path.join(configDir, ".credentials.json"), { claudeAiOauth: oauth() });
  const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, defaultConfigDir: path.join(home, ".claude"),
    expectedEmail: "alpha@example.com", managedRootDir: path.join(home, ".aimgr") });
  const release = await lockfile.lock(path.join(configDir, ".storage-write"), { realpath: false, stale: 15_000 });
  let completed = false;
  const projecting = projectClaudeNativeBundleToManagedConfig({ descriptor, credential: credential(),
    nowMs: NOW_MS, preserveNewerLocal: true }).finally(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, false);
  const native = { claudeAiOauth: oauth({ accessToken: "CONCURRENT_ACCESS", refreshToken: "CONCURRENT_REFRESH",
    expiresAt: NOW_MS + 7_200_000 }), mcpOAuth: { concurrent: { accessToken: "CONCURRENT_MCP" } } };
  writeJson(path.join(configDir, ".credentials.json"), native);
  await release();
  assert.equal((await projecting).action, "kept_local");
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(configDir, ".credentials.json"))), native);
});

test("projection waits for native app-state edits and holds both locks through rollback", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeClaudeNativeBundle(home, { oauthAccount: account(), appState: { theme: "old" } });
  const configDir = path.join(home, ".claude"), statePath = path.join(home, ".claude.json");
  const release = await lockfile.lock(statePath, { lockfilePath: statePath + ".lock" });
  let completed = false;
  const projecting = writeClaudeNativeProjectionPair({ homeDir: home, credential: credential(),
    verifyImpl() {
      for (const file of [statePath, path.join(configDir, ".storage-write")]) {
        assert.throws(() => lockfile.lockSync(file, { realpath: false, retries: 0 }), { code: "ELOCKED" });
      }
      throw new Error("synthetic readback interruption");
    } }).finally(() => { completed = true; });
  // Install the rejection observer before allowing the synthetic write error.
  const rejected = assert.rejects(projecting, /synthetic readback interruption/);
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(completed, false);
  const current = JSON.parse(fs.readFileSync(statePath)); current.theme = "concurrent-native-theme";
  writeJson(statePath, current);
  await release(); await rejected;
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath)), current);
  for (const file of [statePath, path.join(configDir, ".storage-write")]) {
    const unlock = await lockfile.lock(file, { realpath: false, retries: 0 }); await unlock();
  }
});

test("native credential reprojection preserves MCP auth and rejects unclassified secrets before writes", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeClaudeNativeBundle(home, { oauthAccount: account(), appState: { theme: "dark" } });
  const authFile = path.join(home, ".claude/.credentials.json"), appFile = path.join(home, ".claude.json");
  const current = JSON.parse(fs.readFileSync(authFile, "utf8"));
  const nativeSecrets = { mcpOAuth: { required: { accessToken: "private-mcp-token" } },
    mcpOAuthClientConfig: { required: { clientId: "required-client" } },
    pluginSecrets: { requiredSkillPackage: { credential: "private-package-token" } } };
  fs.writeFileSync(authFile, JSON.stringify({ ...current, ...nativeSecrets }), { mode: 0o600 });
  await writeClaudeNativeProjectionPair({ homeDir: home, credential: credential() });
  const projected = JSON.parse(fs.readFileSync(authFile, "utf8"));
  assert.equal(projected.claudeAiOauth.accessToken, ACCESS);
  for (const [key, value] of Object.entries(nativeSecrets)) assert.deepEqual(projected[key], value);
  assert.equal(JSON.parse(fs.readFileSync(appFile)).theme, "dark");
  fs.writeFileSync(authFile, JSON.stringify({ ...projected, unknownPrivateStore: "must-preserve-for-review" }));
  const before = [fs.readFileSync(authFile, "utf8"), fs.readFileSync(appFile, "utf8")];
  await assert.rejects(() => writeClaudeNativeProjectionPair({ homeDir: home, credential: credential({ access: "different" }) }),
    error => error.code === "AIMGR_CLAUDE_PRIVATE_IDENTITY" && !error.message.includes("must-preserve-for-review"));
  assert.deepEqual([fs.readFileSync(authFile, "utf8"), fs.readFileSync(appFile, "utf8")], before);
});

test("native projection drops prior-account provider secrets while retaining independent MCP auth", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeClaudeNativeBundle(home, { oauthAccount: { ...account(), accountUuid: "different-account" } });
  const file = path.join(home, ".claude/.credentials.json");
  const current = JSON.parse(fs.readFileSync(file));
  fs.writeFileSync(file, JSON.stringify({ ...current, trustedDeviceToken: "other-device-token",
    coworkRemoteDevice: { "different-account": { key: "private-key" } }, mcpOAuth: { retained: true } }));
  await writeClaudeNativeProjectionPair({ homeDir: home, credential: credential() });
  assert.deepEqual(JSON.parse(fs.readFileSync(file)), {
    claudeAiOauth: credential().nativeClaudeBundle.claudeAiOauth, mcpOAuth: { retained: true },
  });
});

test("ordinary legacy projection follows native ownership and restores all sources on failure", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  writeClaudeNativeBundle(home, { oauthAccount: account() });
  const directory = path.join(home, ".claude"), legacy = path.join(directory, ".config.json");
  const authFile = path.join(directory, ".credentials.json"), canonical = path.join(home, ".claude.json");
  writeJson(legacy, { oauthAccount: { ...account(), accountUuid: "native-old-owner" }, theme: "native-theme" });
  writeJson(authFile, { ...JSON.parse(fs.readFileSync(authFile)), trustedDeviceToken: "old-owner-device", mcpOAuth: { retained: true } });
  const files = [legacy, authFile, canonical], before = files.map(file => fs.readFileSync(file, "utf8"));
  await assert.rejects(() => writeClaudeNativeProjectionPair({ homeDir: home, credential: credential(),
    writeJsonFileIfChangedImpl(file, value, options) {
      if (file === authFile) throw new Error("synthetic auth write failure");
      return writeJsonFileIfChanged(file, value, options);
    } }), /synthetic auth write failure/);
  assert.deepEqual(files.map(file => fs.readFileSync(file, "utf8")), before);
  await writeClaudeNativeProjectionPair({ homeDir: home, credential: credential() });
  assert.equal(JSON.parse(fs.readFileSync(legacy)).theme, "native-theme");
  assert.deepEqual(JSON.parse(fs.readFileSync(legacy)), JSON.parse(fs.readFileSync(canonical)));
  assert.equal(JSON.parse(fs.readFileSync(authFile)).trustedDeviceToken, undefined);
  assert.deepEqual(JSON.parse(fs.readFileSync(authFile)).mcpOAuth, { retained: true });
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

test("nested storage accepts pinned private ancestors but still refuses an unrepaired public directory", t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir: path.join(home, ".aimgr", "claude-homes", "alpha", ".claude"),
    defaultConfigDir: path.join(home, ".claude"), expectedEmail: "alpha@example.com",
    managedRootDir: path.join(home, ".aimgr"),
  });
  ensureSafeManagedClaudeStorage({ descriptor });
  const io = new Proxy(fs, { get(target, key) {
    return key === "chmodSync" ? () => { throw Object.assign(new Error("pinned ancestor"), { code: "EACCES" }); } : target[key];
  } });
  assert.doesNotThrow(() => ensureSafeManagedClaudeStorage({ descriptor, fsImpl: io }));
  fs.chmodSync(descriptor.managedRootDir, 0o755);
  assert.throws(() => ensureSafeManagedClaudeStorage({ descriptor, fsImpl: io }), { code: "EACCES" });
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
    credentials: { "openai-codex": {}, anthropic: { alpha: stored }, xai: {} },
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


test("legacy selection preserves a refresh completed during its native lock wait", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const now = Date.now(), current = credential({ expiresAtMs: now + 3_600_000 });
  writeClaudeNativeBundle(home, { oauthAccount: account(), expiresAtMs: now + 3_600_000 });
  const configDir = path.join(home, ".claude"), file = path.join(configDir, ".credentials.json");
  // Native selects legacy state even if canonical state claims another owner.
  writeJson(path.join(configDir, ".config.json"), { oauthAccount: account(), theme: "retained" });
  writeJson(path.join(home, ".claude.json"), { oauthAccount: { ...account(), accountUuid: "stale-owner" } });
  const state = { accounts: { alpha: { provider: "anthropic", pool: { enabled: true } } },
    credentials: { anthropic: { alpha: current } } };
  const release = await lockfile.lock(path.join(configDir, ".storage-write"), { realpath: false });
  let completed = false;
  const pending = applyClaudeCliFromState({ label: "alpha", homeDir: home }, state)
    .finally(() => { completed = true; });
  await new Promise(resolve => setTimeout(resolve, 30)); assert.equal(completed, false);
  const fresh = credential({ access: "CONCURRENT_ACCESS", refresh: "CONCURRENT_REFRESH", expiresAtMs: now + 7_200_000 });
  writeJson(file, { claudeAiOauth: fresh.nativeClaudeBundle.claudeAiOauth, mcpOAuth: { retained: true } });
  await release(); await pending;
  assert.equal(JSON.parse(fs.readFileSync(file)).claudeAiOauth.refreshToken, "CONCURRENT_REFRESH");
  assert.equal(state.credentials.anthropic.alpha.nativeClaudeBundle.claudeAiOauth.refreshToken, "CONCURRENT_REFRESH");
  assert.deepEqual(JSON.parse(fs.readFileSync(file)).mcpOAuth, { retained: true });
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, ".claude.json"))).theme, "retained");
});

test("legacy selection refuses ambiguous or incomplete current lineage without writes", async t => {
  for (const incomplete of [false, true]) {
    const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const expiresAtMs = Date.now() + 3_600_000;
    writeClaudeNativeBundle(home, { oauthAccount: account(), accessToken: "LOCAL_ACCESS", refreshToken: "LOCAL_REFRESH", expiresAtMs });
    const file = path.join(home, ".claude/.credentials.json");
    if (incomplete) { const auth = JSON.parse(fs.readFileSync(file)); delete auth.claudeAiOauth.rateLimitTier; writeJson(file, auth); }
    const before = fs.readFileSync(file, "utf8");
    const state = { accounts: { alpha: { provider: "anthropic", pool: { enabled: true } } },
      credentials: { anthropic: { alpha: credential({ expiresAtMs }) } } };
    await assert.rejects(applyClaudeCliFromState({ label: "alpha", homeDir: home }, state), /preserve.*repair/);
    assert.equal(fs.readFileSync(file, "utf8"), before);
  }
});
