import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { claudeOwnerBinding, readClaudeEnvironment } from "../privacy/claude-environment.js";
import { readClaudeActiveAppState } from "../privacy/claude-state-source.js";
import { planClaudeCredentialProjection } from "../privacy/claude-credential-projection.js";
import { migrateClaudePrivateState, assertClaudeNativeOwnersStopped } from "../privacy/claude-state-migration.js";
import { acquireClaudeAssignmentLock } from "../network/claude-offline-binding.js";
import { withClaudeNativeStateLocks } from "./claude-native-state-lock.js";
import { buildManagedClaudeNativeStorageDescriptor, ensureSafeManagedClaudeStorage, readManagedClaudeNativeBundleFromFiles } from "./claude-native-storage.js";
import { buildClaudeCredentialSummaryFromBundle } from "./claude-bundle.js";
import { resolveAimgrClaudeLabelHomeDir, resolveAimgrStateDir, resolveManagedClaudeDir } from "../io/paths.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";

export const CLAUDE_LOCAL_AUTHORITY = "environment-local";
export const claudeCredentialGeneration = value => createHash("sha256").update(JSON.stringify(value ?? null)).digest("hex");
const ownerName = ".aim-privacy-identity.json";
const providerKeys = ["claudeAiOauth", "enterpriseGateway", "gatewayTrust", "gatewayAllowlistEntries", "designOauth", "cloudSessionsOauth", "organizationUuid", "trustedDeviceToken", "trustedDeviceEnrolledAfterRefusalAtMs", "coworkRemoteDevice"];
const stoppedOwnerError = label => Object.assign(new Error(`Claude ${label}: stop this account's Claude sessions and background work on this machine, then run \`aim claude login ${label}\` again.`),
  { code: 'AIMGR_CLAUDE_LOCAL_LOGIN_REQUIRES_STOPPED_OWNER' });

function privateJson(file) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.uid !== process.getuid() || stat.mode & 0o077 || stat.size > 32 * 1024 * 1024) throw new Error();
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Error("Claude local state is unreadable; preserve it and sign in with `aim claude login <label>`.");
  } finally { if (fd !== undefined) fs.closeSync(fd); }
}

export function localClaudePaths({ homeDir, label, metadata }) {
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  const configDir = resolveManagedClaudeDir({ homeDir: claudeHome });
  const expectedEmail = metadata?.policy?.expect?.email ?? metadata?.identity?.emailAddress;
  const descriptor = buildManagedClaudeNativeStorageDescriptor({ configDir, expectedEmail,
    defaultConfigDir: resolveManagedClaudeDir({ homeDir }), managedRootDir: resolveAimgrStateDir({ homeDir }) });
  return { claudeHome, configDir, descriptor, ownerPath: path.join(configDir, ownerName) };
}

export function readLocalClaudeCredential({ homeDir, label, metadata, environment = readClaudeEnvironment() }) {
  const paths = localClaudePaths({ homeDir, label, metadata });
  const identity = metadata?.identity;
  const result = { ...paths, status: "login_required", credential: null, nativeClaudeBundle: null, owner: null, generation: null };
  if (!identity?.accountUuid || !identity?.organizationUuid) return result;
  const binding = claudeOwnerBinding(environment, identity);
  const owner = privateJson(paths.ownerPath);
  if (!owner || owner.accountUuid !== identity.accountUuid || owner.organizationUuid !== identity.organizationUuid
    || owner.environmentBinding !== binding || owner.grant?.source !== "native-local-login" || !/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(owner.grant?.id ?? "")
    || !["ready","logged_out"].includes(owner.grant.status) || !Number.isFinite(Date.parse(owner.grant.grantedAt))) return result;
  if (owner.grant.status === "logged_out") return { ...result, owner, status: "login_required" };
  const stored = readManagedClaudeNativeBundleFromFiles({ descriptor: paths.descriptor });
  if (!stored.ok) return { ...result, owner, status: stored.errorKind === "native_storage_empty" ? "reauth_required" : "local_auth_unavailable" };
  const account = stored.nativeClaudeBundle.oauthAccount;
  if (account.accountUuid !== identity.accountUuid || account.organizationUuid !== identity.organizationUuid
    || account.emailAddress?.toLowerCase() !== String(paths.descriptor.expectedEmail).toLowerCase()) return { ...result, owner, status: "identity_mismatch" };
  const generation = claudeCredentialGeneration(stored.nativeClaudeBundle.claudeAiOauth);
  if (owner.grant.failedGeneration === generation) return { ...result, owner, generation, status: "reauth_required" };
  const summary = buildClaudeCredentialSummaryFromBundle(stored.nativeClaudeBundle);
  return { ...result, owner, generation, nativeClaudeBundle: stored.nativeClaudeBundle,
    status: stored.expiresAtMs > Date.now() ? "ready" : "expired", credential: {
      ...summary, nativeClaudeBundle: stored.nativeClaudeBundle, authority: CLAUDE_LOCAL_AUTHORITY,
      ownerBinding: binding,
    } };
}

// Refuse a stopped-owner conversion before asking the user to authorize a new
// grant. The commit repeats this check because sessions can start during login.
export async function assertLocalClaudeLoginTransitionAllowed({ homeDir, label, metadata, environment, command,
  assertStopped = assertClaudeNativeOwnersStopped }) {
  const options = { homeDir, label, metadata, environment };
  const current = readLocalClaudeCredential(options);
  if (current.owner) return;
  const paths = localClaudePaths(options);
  ensureSafeManagedClaudeStorage({ descriptor: paths.descriptor });
  let guard;
  try {
    guard = await acquireClaudeAssignmentLock(homeDir, label, { exclusive: true });
    // A peer may have finished the same enrollment before we acquired EX.
    if (!readLocalClaudeCredential(options).owner) {
      await assertStopped({ configDir: fs.realpathSync(paths.configDir), command });
      guard.assertOwned();
    }
  } catch (error) {
    if (error.code === 'AIMGR_CLAUDE_ASSIGNMENT_BUSY' || guard) {
      throw stoppedOwnerError(label);
    }
    throw error;
  } finally { await guard?.release(); }
}

// Only a successful official login in this environment may call this. Staging
// is never a fallback for launch and never enters shared state.credentials.
export async function saveLocalClaudeLogin({ homeDir, label, metadata, environment, command,
  nativeClaudeBundle, assertStopped = assertClaudeNativeOwnersStopped }) {
  const identity = nativeClaudeBundle?.oauthAccount;
  if (identity?.accountUuid !== metadata?.identity?.accountUuid || identity?.organizationUuid !== metadata?.identity?.organizationUuid) throw new Error("Claude login identity changed before commit.");
  const paths = localClaudePaths({ homeDir, label, metadata });
  ensureSafeManagedClaudeStorage({ descriptor: paths.descriptor });
  const binding = claudeOwnerBinding(environment, identity);
  const grant = { id: randomUUID(), source: "native-local-login", grantedAt: new Date().toISOString(), status: "ready" };
  let guard = await acquireClaudeAssignmentLock(homeDir, label, { waitForTransition: true });
  try {
    let current = readLocalClaudeCredential({ homeDir, label, metadata, environment });
    const sameOwner = current.owner?.environmentBinding === binding && current.owner?.organizationUuid === identity.organizationUuid;
    if (!sameOwner) {
      await guard.release();
      guard = null;
      try { guard = await acquireClaudeAssignmentLock(homeDir, label, { exclusive: true }); }
      catch (error) { if (error.code === 'AIMGR_CLAUDE_ASSIGNMENT_BUSY') throw stoppedOwnerError(label); throw error; }
      const migrationDir = path.join(paths.claudeHome, ".privacy-migration");
      fs.mkdirSync(migrationDir, { recursive: true, mode: 0o700 });
      await migrateClaudePrivateState({ userHomeDir: fs.realpathSync(homeDir), configDir: fs.realpathSync(paths.configDir), migrationDir: fs.realpathSync(migrationDir),
        command, credential: { nativeClaudeBundle }, accountUuid: identity.accountUuid, organizationUuid: identity.organizationUuid,
        environmentBinding: binding, grant, guard, assertStopped });
    } else {
      // Same-owner relogin stays concurrent. These are the client's own RMW
      // locks: reread full documents after waiting; preserve fresh MCP writes.
      await withClaudeNativeStateLocks({ configDir: paths.configDir, appStatePath: paths.descriptor.appStatePath, refresh: true }, () => {
        guard.assertOwned();
        current = readLocalClaudeCredential({ homeDir, label, metadata, environment });
        if (current.owner?.environmentBinding !== binding) throw new Error("Claude owner changed during login.");
        const active = readClaudeActiveAppState({ configDir: paths.configDir });
        const auth = privateJson(paths.descriptor.credentialsPath) ?? {};
        if (active.state.oauthAccount && (active.state.oauthAccount.accountUuid !== identity.accountUuid
          || active.state.oauthAccount.organizationUuid !== identity.organizationUuid)) throw new Error("Claude native account differs from its local owner.");
        const next = planClaudeCredentialProjection({ current: auth, currentAccountUuid: active.state.oauthAccount?.accountUuid ?? (current.owner.grant.status === "logged_out" ? identity.accountUuid : null),
          targetAccountUuid: identity.accountUuid, projectedOauth: nativeClaudeBundle.claudeAiOauth });
        // Owner is published last. A crash before first-owner publication can
        // never manufacture authorization of an unowned legacy credential.
        try {
          writeJsonFileIfChanged(active.file, { ...active.state, oauthAccount: identity,
            hasCompletedOnboarding: true, hasAvailableSubscription: true }, { mode: 0o600 });
          writeJsonFileIfChanged(paths.descriptor.credentialsPath, next, { mode: 0o600 });
          writeJsonFileIfChanged(paths.ownerPath, { ...current.owner, grant }, { mode: 0o600 });
        } catch {
          // No native writer can interleave while both refresh and document
          // locks are held. A failed commit restores the previous grant.
          try {
            writeJsonFileIfChanged(active.file, active.state, {mode:0o600});
            writeJsonFileIfChanged(paths.descriptor.credentialsPath, auth, {mode:0o600});
            writeJsonFileIfChanged(paths.ownerPath, current.owner, {mode:0o600});
          } catch { throw new Error("Claude login could not restore its prior local state; preserve this profile for repair."); }
          throw new Error("Claude login could not commit; its prior local grant was preserved.");
        }
      });
    }
    return readLocalClaudeCredential({ homeDir, label, metadata, environment });
  } finally { await guard?.release(); }
}

export async function logoutLocalClaudeCredential({ homeDir, label, metadata, environment, command,
  assertStopped = assertClaudeNativeOwnersStopped }) {
  const guard = await acquireClaudeAssignmentLock(homeDir, label, { exclusive: true });
  try {
    const current = readLocalClaudeCredential({ homeDir, label, metadata, environment });
    if (!current.owner) return { changed: false };
    await assertStopped({ configDir: current.configDir, command });
    await withClaudeNativeStateLocks({ configDir: current.configDir, appStatePath: current.descriptor.appStatePath }, () => {
      guard.assertOwned();
      // Invalidate first: interruption cannot resurrect a remaining native
      // token. Never clear the mixed document's third-party credentials.
      const owner = privateJson(current.ownerPath);
      if (owner?.grant?.id !== current.owner.grant.id) throw new Error("Claude login changed during logout.");
      writeJsonFileIfChanged(current.ownerPath, { ...owner, grant: { ...owner.grant, status: "logged_out" } }, { mode: 0o600 });
      const auth = privateJson(current.descriptor.credentialsPath) ?? {};
      for (const key of providerKeys) delete auth[key];
      writeJsonFileIfChanged(current.descriptor.credentialsPath, auth, { mode: 0o600 });
      const active = readClaudeActiveAppState({ configDir: current.configDir });
      const state = { ...active.state }; delete state.oauthAccount;
      writeJsonFileIfChanged(active.file, state, { mode: 0o600 });
    });
    return { changed: true };
  } finally { await guard.release(); }
}

export function assertClaudeCredentialExportable(credential) {
  if (credential?.authority === CLAUDE_LOCAL_AUTHORITY || credential?.ownerBinding) {
    throw new Error('Primary Claude credentials are environment-local and cannot be exported or published.');
  }
}

// A failed native refresh can clear its own primary OAuth document. Invalidate
// only the observed local grant/generation; a concurrent successful login wins.
export async function markLocalClaudeGrantRejected({ homeDir, label, metadata, environment, grantId, generation }) {
  const paths = localClaudePaths({homeDir,label,metadata});
  return withClaudeNativeStateLocks({configDir:paths.configDir,appStatePath:paths.descriptor.appStatePath,refresh:true},()=>{
    const owner=privateJson(paths.ownerPath);
    if(owner?.grant?.id!==grantId || owner.environmentBinding!==claudeOwnerBinding(environment,metadata.identity)) return false;
    const auth=privateJson(paths.descriptor.credentialsPath) ?? {};
    const current=claudeCredentialGeneration(auth.claudeAiOauth);
    const empty=!auth.claudeAiOauth || (!auth.claudeAiOauth.accessToken && !auth.claudeAiOauth.refreshToken);
    if(!empty && current!==generation) return false;
    writeJsonFileIfChanged(paths.ownerPath,{...owner,grant:{...owner.grant,failedGeneration:empty?current:generation}}, {mode:0o600});
    return true;
  });
}
