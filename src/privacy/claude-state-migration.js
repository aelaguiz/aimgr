import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { ClaudePrivateIdentityError, planClaudePrivateIdentity } from "./claude-identity.js";
import { readClaudeActiveAppState } from "./claude-state-source.js";
import { planClaudeCredentialProjection } from "./claude-credential-projection.js";
import { commitClaudeIdentityMigration } from "./claude-state-transaction.js";
import { claudeBackupRetirementComplete, retireClaudeLegacyBackups } from "./claude-backup-retirement.js";
import { hasRetainedClaudeLaunchFiles, retireClaudeLaunchFiles } from "./claude-launch-retention.js";
import { getClaudeNativeBundle, hasCompleteClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { planClaudeNativeBundleReplacement } from "../credentials/claude-native.js";
import { acquireClaudeAssignmentLock } from "../network/claude-offline-binding.js";
import { buildManagedClaudeNativeStorageDescriptor, ensureSafeManagedClaudeStorage } from "../credentials/claude-native-storage.js";
import { resolveAimgrStateDir, resolveManagedClaudeDir } from "../io/paths.js";

const execute = promisify(execFile);
const ownerHelper = fileURLToPath(new URL("../../native/claude/check_owners.py", import.meta.url));
const FIELDS = ["userID", "machineID", "summonSidKey", "remoteControlMachineId"];
const LIMIT = 32 * 1024 * 1024;
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = reason => { throw new ClaudePrivateIdentityError(reason); };

function readState(file, { tighten = false, parse = true, limit = LIMIT } = {}) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.size > limit) {
      fail("local identity state is not a bounded owned regular file");
    }
    if (tighten) fs.fchmodSync(fd, 0o600);
    if (!parse) return null;
    const text = fs.readFileSync(fd, "utf8");
    const value = text.length ? JSON.parse(text) : {};
    if (!object(value)) fail("local identity state is not a JSON object");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return null;
    if (error instanceof ClaudePrivateIdentityError) throw error;
    fail("local identity state could not be inspected; preserve it for repair");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

/** Read only the known app-state files, never recursively copy/search a home.
 * Inactive canonical state beside legacy state is also comparison evidence:
 * retiring that selector later must not expose a copied installation ID.
 */
export function collectClaudeForeignIdentifiers({ userHomeDir, configDir }) {
  const files = new Set([path.join(userHomeDir, ".claude.json"), path.join(userHomeDir, ".claude/.config.json"),
    path.join(userHomeDir, ".claude/.claude.json")]);
  const homes = path.join(userHomeDir, ".aimgr/claude-homes");
  let entries;
  try { entries = fs.readdirSync(homes, { withFileTypes: true }); }
  catch (error) { if (error.code === "ENOENT") entries = []; else fail("the local account identity inventory is unavailable"); }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      if (entry.isSymbolicLink()) fail("the local account identity inventory contains an unsupported directory alias");
      continue;
    }
    const directory = path.join(homes, entry.name, ".claude");
    if (path.resolve(directory) === configDir) continue;
    files.add(path.join(directory, ".claude.json"));
    files.add(path.join(directory.normalize("NFC"), ".config.json"));
  }
  const result = [];
  for (const file of files) {
    const state = readState(file);
    for (const field of FIELDS) if (typeof state?.[field] === "string") result.push(state[field]);
  }
  return result;
}

export async function assertClaudeNativeOwnersStopped({ configDir, command }) {
  try {
    await execute("/usr/bin/python3", ["-I", ownerHelper, configDir, command], {
      env: { PATH: "/usr/bin:/bin", LC_ALL: "C" }, timeout: 10_000, maxBuffer: 16_384,
    });
  } catch {
    // Never forward native process metadata or raw helper errors into logs.
    fail("existing Claude owners could not be confirmed stopped; stop this account's sessions and background work before its identity transition");
  }
}

function verifyStaged(staged) {
  if (!object(staged.appState) || !object(staged.auth) || !object(staged.identity)
    || staged.legacyAppState !== null
    || staged.appState.oauthAccount?.accountUuid !== staged.identity.accountUuid) {
    fail("staged native identity does not match its account");
  }
  const identity = planClaudePrivateIdentity({ appState: staged.appState, identityRecord: staged.identity,
    accountUuid: staged.identity.accountUuid, organizationUuid: staged.identity.organizationUuid,
    environmentBinding: staged.identity.environmentBinding ?? null, inventoryComplete: true, foreignIdentifiers: [] });
  if (identity.changedFields.length || identity.recordChanged) fail("staged native identity is inconsistent");
  const auth = planClaudeCredentialProjection({ current: staged.auth,
    currentAccountUuid: staged.identity.accountUuid, targetAccountUuid: staged.identity.accountUuid,
    projectedOauth: staged.auth.claudeAiOauth });
  if (JSON.stringify(auth) !== JSON.stringify(staged.auth)) fail("staged native credentials contain another account's state");
}

/** Recover/migrate under EX ownership before ordinary preflight or projection.
 *
 * The caller releases SH, obtains EX, rereads the authoritative account binding,
 * calls this function, then releases EX/reacquires SH and revalidates. Never
 * pretend SH->EX conversion is atomic. No provider execution occurs here.
 * Journals stay outside the vendor-readable config; no returned secret leaves
 * this function. The final launch must separately enforce file visibility.
 */
export async function migrateClaudePrivateState({ userHomeDir, configDir, migrationDir,
  command, credential, accountUuid, organizationUuid = null, environmentBinding = null, grant = null, guard, assertStopped = assertClaudeNativeOwnersStopped } = {}) {
  if (guard?.exclusive !== true || typeof guard.assertOwned !== "function") fail("exclusive identity migration ownership is required");
  guard.assertOwned();
  for (const directory of [userHomeDir, configDir, migrationDir]) {
    if (!path.isAbsolute(directory ?? "") || fs.realpathSync(directory) !== directory) fail("identity migration paths must be canonical");
  }
  if (migrationDir === configDir || migrationDir.startsWith(configDir + path.sep)) fail("private migration backups overlap native state");
  await assertStopped({ configDir, command });
  guard.assertOwned();
  const journal = readState(path.join(migrationDir, "transaction.json"), { limit: 8 * LIMIT });
  if (journal && journal.phase !== "complete") {
    // Recovery validates its own old binding first, even if the display label
    // has since been rebound. No launch is allowed between recovery and the
    // subsequent new-account migration below.
    commitClaudeIdentityMigration({ configDir, migrationDir, guard, verifyStaged });
  }
  const active = readClaudeActiveAppState({ configDir });
  for (const name of [".claude.json", ".config.json", ".credentials.json", ".aim-privacy-identity.json"]) {
    readState(path.join(configDir, name), { tighten: true, parse: false });
  }
  const currentAuth = readState(path.join(configDir, ".credentials.json")) ?? {};
  const identityRecord = readState(path.join(configDir, ".aim-privacy-identity.json"));
  let selected = credential ? getClaudeNativeBundle(credential) : {
    claudeAiOauth: currentAuth.claudeAiOauth, oauthAccount: active.state.oauthAccount,
  };
  if (!selected || selected.oauthAccount?.accountUuid !== accountUuid) fail("the migration credential does not match the selected account");
  const candidate = planClaudeNativeBundleReplacement({ currentBundle: null, candidateBundle: selected,
    expectedEmail: selected.oauthAccount.emailAddress, allowExpiredCandidate: true });
  if (!candidate.ok) fail("the migration credential is incomplete");
  const currentBundle = { claudeAiOauth: currentAuth.claudeAiOauth, oauthAccount: active.state.oauthAccount };
  if (!grant && currentBundle.oauthAccount?.accountUuid === accountUuid
    && [currentAuth.claudeAiOauth?.accessToken, currentAuth.claudeAiOauth?.refreshToken]
      .some(value => typeof value === "string" && value.length > 0)
    && !hasCompleteClaudeNativeBundle(currentBundle)) {
    // Missing metadata does not make a possibly newer refresh-token lineage
    // disposable. An old Redis token may already have been spent by native.
    // Preserve the incomplete evidence for repair rather than reverting it.
    fail("native OAuth contains an incomplete same-account token lineage; repair it before identity migration");
  }
  if (!grant && credential && currentBundle.oauthAccount?.accountUuid === accountUuid && hasCompleteClaudeNativeBundle(currentBundle)) {
    const choice = planClaudeNativeBundleReplacement({ currentBundle, candidateBundle: selected,
      expectedEmail: selected.oauthAccount.emailAddress, allowExpiredCandidate: true });
    if (choice.action === "noop" || choice.reason === "stale_candidate") selected = currentBundle;
    else if (choice.ok !== true) fail("native credential lineage is ambiguous before identity migration");
  }
  const identity = planClaudePrivateIdentity({ appState: active.state, identityRecord, accountUuid, organizationUuid, environmentBinding,
    foreignIdentifiers: collectClaudeForeignIdentifiers({ userHomeDir, configDir }), inventoryComplete: true });
  const auth = planClaudeCredentialProjection({ current: currentAuth,
    currentAccountUuid: active.state.oauthAccount?.accountUuid ?? null, targetAccountUuid: accountUuid,
    projectedOauth: selected.claudeAiOauth });
  retireClaudeLegacyBackups({ configDir, migrationDir, identityRecord: identity.record, guard });
  if (!grant && !identity.recordChanged && !identity.changedFields.length && !active.legacy
    && JSON.stringify(auth) === JSON.stringify(currentAuth)) return { action: "unchanged" };
  if (grant) identity.record.grant = structuredClone(grant);
  const desired = { appState: { ...identity.state, oauthAccount: structuredClone(selected.oauthAccount),
    hasCompletedOnboarding: true, hasAvailableSubscription: true }, auth, identity: identity.record, legacyAppState: null };
  const result = commitClaudeIdentityMigration({ configDir, migrationDir, desired, guard, verifyStaged });
  guard.assertOwned();
  return { action: result.action };
}

function needsIdentityMigration({ userHomeDir, configDir, migrationDir, accountUuid, organizationUuid = null, environmentBinding = null }) {
  const journal = readState(path.join(migrationDir, "transaction.json"), { limit: 8 * LIMIT });
  if (journal && journal.phase !== "complete") return true;
  const active = readClaudeActiveAppState({ configDir });
  const identityRecord = readState(path.join(configDir, ".aim-privacy-identity.json"));
  if (!claudeBackupRetirementComplete({ migrationDir, identityRecord })) return true;
  const plan = planClaudePrivateIdentity({ appState: active.state, identityRecord, accountUuid, organizationUuid, environmentBinding,
    foreignIdentifiers: collectClaudeForeignIdentifiers({ userHomeDir, configDir }), inventoryComplete: true });
  if (active.legacy || plan.recordChanged || plan.changedFields.length !== 0) return true;
  const auth = readState(path.join(configDir, ".credentials.json"));
  if (!auth?.claudeAiOauth?.accessToken) return true;
  const classified = planClaudeCredentialProjection({ current: auth,
    currentAccountUuid: active.state.oauthAccount?.accountUuid, targetAccountUuid: accountUuid,
    projectedOauth: auth.claudeAiOauth });
  return JSON.stringify(classified) !== JSON.stringify(auth);
}

/** Acquire the launch's SH guard, using EX only for a stopped transition.
 *
 * The normal path is SH throughout, including simultaneous launches. flock
 * upgrades are NOT atomic: release SH, acquire EX without waiting, reread the
 * authoritative binding, migrate, then reacquire SH and reread once more.
 * A binding change in either gap refuses this launch, never downgrades it to
 * ordinary mode or projects a stale account. readBinding executes no vendor;
 * online callers also verify their Redis lease there. The returned SH guard
 * belongs to the caller and must cover its final publication and vendor exit.
 */
export async function acquireClaudeStateGuard({ homeDir, label, configDir, command,
  readBinding, beforeState = null, assertStopped = assertClaudeNativeOwnersStopped } = {}) {
  let guard;
  const acquireShared = (acquireTimeoutMs = 5_000) => acquireClaudeAssignmentLock(homeDir, label,
    { waitForTransition: true, acquireTimeoutMs });
  try {
    guard = await acquireShared();
    const initial = await readBinding();
    const bindingKey = binding => JSON.stringify([binding.protected === true,
      binding.accountUuid ?? null, binding.organizationUuid ?? null, binding.environmentBinding ?? null, binding.profileRef ?? null]);
    const expected = bindingKey(initial);
    const recheck = async () => {
      guard.assertOwned();
      const binding = await readBinding();
      if (bindingKey(binding) !== expected) fail("the account or proxy assignment changed during its identity transition; retry the launch");
      guard.assertOwned();
      return binding;
    };
    // Ordinary maintenance can be the first use of this account on a machine.
    // Its local directory is needed before realpath/retention inspection too;
    // creating validated storage is independent of opting into protection.
    const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir,
      defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
      expectedEmail: initial.expectedEmail, managedRootDir: resolveAimgrStateDir({ homeDir }) });
    ensureSafeManagedClaudeStorage({ descriptor });
    // Static launch/artifact preparation may reject the installed executable.
    // Complete it under SH before placing a fresh credential in native state.
    if (beforeState) await beforeState();
    guard.assertOwned();
    const canonicalHome = fs.realpathSync(homeDir), canonicalConfig = fs.realpathSync(configDir);
    const migrationDir = path.join(path.dirname(canonicalConfig), ".privacy-migration");
    const paths = { userHomeDir: canonicalHome, configDir: canonicalConfig, migrationDir };
    let migrate = initial.protected === true && needsIdentityMigration({ ...paths, accountUuid: initial.accountUuid, organizationUuid: initial.organizationUuid, environmentBinding: initial.environmentBinding ?? null });
    const retire = hasRetainedClaudeLaunchFiles(canonicalConfig);
    if (!migrate && !retire) return guard;
    await guard.release(); guard = null;
    const transitionDeadline = Date.now() + 5_000;
    for (;;) {
      try { guard = await acquireClaudeAssignmentLock(homeDir, label, { exclusive: true }); break; }
      catch (error) {
        if (error.code !== "AIMGR_CLAUDE_ASSIGNMENT_BUSY") throw error;
        // Two first launches may both discover the same pending migration.
        // Release every SH reference before trying EX; if the peer completed
        // it, rejoin its now-stable identity. Never cap concurrent sessions or
        // run migration while another owner still holds SH. A real live-owner
        // conflict remains a bounded refusal, without changing that identity.
        const remaining = transitionDeadline - Date.now();
        if (remaining <= 0) throw error;
        guard = await acquireShared(Math.max(1, remaining));
        const current = await recheck();
        // Readiness can change while SH was released, even if this call
        // originally wanted only optional cleanup (for example a peer died
        // during migration). A cached false must never skip recovery.
        migrate = current.protected === true && needsIdentityMigration({ ...paths, accountUuid: current.accountUuid, organizationUuid: current.organizationUuid, environmentBinding: current.environmentBinding ?? null });
        if (!migrate) return guard;
        await guard.release(); guard = null;
        if (Date.now() >= transitionDeadline) throw error;
        await delay(25 + Math.floor(Math.random() * 25));
      }
    }
    const binding = await recheck();
    migrate = binding.protected === true && needsIdentityMigration({ ...paths, accountUuid: binding.accountUuid, organizationUuid: binding.organizationUuid, environmentBinding: binding.environmentBinding ?? null });
    if (migrate) {
      // Only EX may create or recover this private journal. Its parent was
      // validated by managed storage; no recursive mkdir follows unknown links.
      try { fs.mkdirSync(migrationDir, { mode: 0o700 }); }
      catch (error) { if (error.code !== "EEXIST") throw error; }
      const stat = fs.lstatSync(migrationDir);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid()
        || (stat.mode & 0o077)) fail("the private migration directory is unsafe");
      await migrateClaudePrivateState({ ...paths, command: fs.realpathSync(command),
        accountUuid: binding.accountUuid, organizationUuid: binding.organizationUuid,
        environmentBinding: binding.environmentBinding ?? null, credential: binding.credential, guard, assertStopped });
      if (retire) retireClaudeLaunchFiles({ configDir: canonicalConfig, guard });
    } else if (retire) {
      let stopped = false;
      try { await assertStopped({ configDir: canonicalConfig, command: fs.realpathSync(command) }); stopped = true; }
      catch { /* Detached owners or an uncertain inventory retain their files. */ }
      if (stopped) retireClaudeLaunchFiles({ configDir: canonicalConfig, guard });
    }
    await guard.release(); guard = null;
    guard = await acquireShared();
    const final = await recheck();
    if (final.protected === true && needsIdentityMigration({ ...paths, accountUuid: final.accountUuid, organizationUuid: final.organizationUuid, environmentBinding: final.environmentBinding ?? null })) {
      fail("account identity changed before launch; retry after affected work has stopped");
    }
    return guard;
  } catch (error) {
    await guard?.release();
    throw error;
  }
}
