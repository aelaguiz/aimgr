import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { admitClaudeArtifact } from "./claude-artifacts.js";
import { readClaudeActiveAppState } from "./claude-state-source.js";
import { assertClaudeIndividualOAuth, claudeStoredOAuthEnvironment } from "./claude-provider-admission.js";
import { composeClaudePrivacySettings, ClaudePrivacySettingsError } from "./claude-settings.js";
import { stageClaudeSettingsSnapshot, claudeArgsWithSettingsSnapshot } from "./claude-settings-handoff.js";
import { inspectClaudeManagedPolicy } from "./claude-managed-policy.js";
import { validateClaudeSettingsSnapshot } from "./claude-settings-validation-runner.js";
import { retainClaudeLaunchFiles } from "./claude-launch-retention.js";
import { nativeClaudeHeaderSourceAccepted, resolveClaudeSessionHeaders, pinClaudeSessionHeaders } from "./claude-session-headers.js";
import { readClaudeLaunchState, stageClaudeLaunchEnvironment, buildClaudePrivacyEnvironment, resolveClaudeTaskReadRoots, resolveClaudeConfiguredInputs, resolveClaudeUpdateRoots, prepareClaudeDaemonDirectory } from "./claude-launch-inputs.js";

const fail = reason => { throw new ClaudePrivacySettingsError(reason); };

/** Assemble the same admitted native entry for interactive, unattended and
 * maintenance launches. Call under the existing account guard, after credential
 * reconciliation. Route setup remains outside this function and must complete
 * before the returned invocation executes. The isolated doctor has no auth or
 * network, even when the eventual account is ordinary (T02/T07/T08/T18).
 *
 * Read/update roots come from the pinned build's reviewed path inventory, not
 * arbitrary inherited environment. Native entry independently canonicalizes
 * them and fixes its vendor target; the caller cannot choose a payload image.
 */
export async function prepareClaudeNativeInvocation({
  preparedLaunch, args, env, cwd, protectedAccount, readRoots, updateRoots,
  expectedIdentity, requiredHooks = {},
  stdoutIsTTY = Boolean(process.stdout.isTTY),
  admitArtifact = admitClaudeArtifact, inspectManagedPolicy = inspectClaudeManagedPolicy,
  validateSnapshot = validateClaudeSettingsSnapshot,
  validateHeaderSource = nativeClaudeHeaderSourceAccepted,
  prepareDaemonDirectory = prepareClaudeDaemonDirectory,
} = {}) {
  let scratch, snapshot, environmentFd, retention, started = false, executableAliases = [];
  try {
    if (!preparedLaunch || !path.isAbsolute(cwd ?? "") || typeof protectedAccount !== "boolean"
      || (readRoots !== undefined && !Array.isArray(readRoots)) || (updateRoots !== undefined && !Array.isArray(updateRoots))
      || [...(readRoots ?? []), ...(updateRoots ?? [])].some(file => !path.isAbsolute(file)) || (readRoots?.length ?? 0) > 256 || (updateRoots?.length ?? 0) > 256) {
      fail("the native privacy launch inputs are incomplete");
    }
    const artifact = admitArtifact({ selectedCommand: preparedLaunch.command,
      pinnedArtifactSet: env.AIMGR_CLAUDE_ARTIFACT_SET });
    // The admitted policy bytes are immutable and included in the artifact
    // digest. Identity is never discovered by executing an unapproved binary.
    const policy = JSON.parse(fs.readFileSync(artifact.policy, "utf8"));
    if (policy.schema !== 1 || policy.platform !== process.platform || policy.arch !== process.arch
      || policy.version !== artifact.version || !/^[a-f0-9]{12}$/.test(policy.vendorCommit ?? "")) fail("the approved native validation identity is missing");
    // Lock the reviewed Claude/helper/policy bytes, not the user's OS release.
    // testedKernelRelease records the test environment only: requiring equality
    // would force unrelated OS upgrades across machines with active work. The
    // fixed native entry must still apply its policy successfully before Claude
    // executes; an actual enforcement failure has no unsandboxed fallback.
    const configDir = fs.realpathSync(preparedLaunch.configDir);
    const appState = readClaudeActiveAppState({ configDir }).state;
    let identity;
    if (!preparedLaunch.loginStaging) {
      const credentialDocument = readClaudeLaunchState(path.join(configDir, ".credentials.json"));
      identity = assertClaudeIndividualOAuth({ credentialDocument, appState,
        accountUuid: expectedIdentity?.accountUuid ?? appState.oauthAccount?.accountUuid,
        organizationUuid: expectedIdentity?.organizationUuid ?? appState.oauthAccount?.organizationUuid });
    }
    // Preserve the ORIGINAL inline-settings origin before choosing a private
    // runtime scratch. Reusing the cleaned validator env changes permission
    // anchors for relative native sandbox/read rules (T15).
    const nativeTempDirectory = path.resolve(cwd, env.CLAUDE_CODE_TMPDIR || os.tmpdir(), `claude-${process.getuid()}`);
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(configDir, ".aim-private-runtime-")));
    fs.chmodSync(scratch, 0o700);
    const emptyProfiles = path.join(scratch, "profiles");
    fs.mkdirSync(emptyProfiles, { mode: 0o500 });
    const providerEnvironment = claudeStoredOAuthEnvironment({ emptyProfiles, subscriptionType: identity?.subscriptionType });
    const composition = composeClaudePrivacySettings({ args, cwd, protectedAccount, requiredHooks, nativeTempDirectory, providerEnvironment });
    const validation = { expected: { version: artifact.version, commit: policy.vendorCommit,
      platform: process.platform, arch: process.arch, entrypoint: artifact.command },
    nativeLauncher: artifact.launcher, scratchParent: scratch };
    providerEnvironment.ANTHROPIC_CUSTOM_HEADERS = await resolveClaudeSessionHeaders({ args, cwd, configDir,
      userHomeDir: preparedLaunch.userHomeDir, composition, env, appState, stdoutIsTTY,
      sourceAccepted: source => validateHeaderSource(source, validation) });
    pinClaudeSessionHeaders(composition, providerEnvironment.ANTHROPIC_CUSTOM_HEADERS);
    const managedPolicy = inspectManagedPolicy({ protectedAccount, providerEnvironment, cwd, userHomeDir: preparedLaunch.userHomeDir });
    if (readRoots === undefined) {
      const task = resolveClaudeConfiguredInputs({ args, cwd, configDir, userHomeDir: preparedLaunch.userHomeDir,
        composition, env, appState, discoverReadRoots: protectedAccount });
      executableAliases = task.executableAliases ?? [];
      task.taskFiles.push(...(managedPolicy.tlsReadPaths ?? []));
      if (protectedAccount) {
        const sharedMemoryDirectory = path.join(preparedLaunch.userHomeDir, ".claude/projects");
        fs.mkdirSync(sharedMemoryDirectory, { recursive: true, mode: 0o700 });
        readRoots = resolveClaudeTaskReadRoots({ ...task, userHomeDir: preparedLaunch.userHomeDir,
          configDir, appState, sharedMemoryDirectory,
          userPluginDirs: [...task.userPluginDirs, ...(preparedLaunch.userPluginDirs ?? [])] });
      } else readRoots = [];
    }
    updateRoots ??= resolveClaudeUpdateRoots({ userHomeDir: preparedLaunch.userHomeDir, env, cwd, vendorCommand: artifact.command });
    snapshot = stageClaudeSettingsSnapshot(composition);
    await validateSnapshot({ ...validation, snapshot, managedPolicy });
    const environment = buildClaudePrivacyEnvironment({ env: { ...env, ...providerEnvironment }, protectedAccount,
      artifactSet: artifact.artifactSet, emptyProfiles, scratch });
    // Nested AIM must resolve the pinned immutable Claude, not an old user
    // installation whose update/cache reads are deliberately denied below.
    // This changes only the child environment; preserve every existing PATH
    // entry for builds/MCP. Native live PATH settings remain live, and an
    // explicit different selection must still pass ordinary artifact checks.
    environment.PATH = path.dirname(artifact.command) + (environment.PATH ? path.delimiter + environment.PATH : "");
    environmentFd = stageClaudeLaunchEnvironment(environment, scratch);
    const daemonRoots = protectedAccount ? [prepareDaemonDirectory({ configDir, env: environment })] : [];
    const combinedReads = [...new Set([...readRoots, ...daemonRoots, ...(artifact.readPaths ?? []), ...managedPolicy.resolvedReadPaths])];
    if (protectedAccount && process.platform === "darwin") {
      // Only the new immutable helper understands executable-alias entries.
      // Old approved bundles retain their original native MCP behavior; an
      // incomplete optional-server inventory must not refuse unrelated work.
      // Never replace the user's configured command or bypass build admission.
      const nativeRoots = [configDir, scratch, "/System", "/usr", "/bin", "/sbin", "/dev",
        "/Library/Apple", "/Library/Developer", "/private/etc", "/private/var/db/dyld", "/private/preboot/Cryptexes/OS"];
      const covered = file => [...combinedReads, ...nativeRoots].some(root => file === root || file.startsWith(root + path.sep));
      const needed = executableAliases.filter(file => !covered(file));
      if (policy.mcpExecutableAliases === true) combinedReads.push(...new Set(needed));
    }
    if (combinedReads.length > 256) fail("the task and machine read roots exceed native policy capacity");
    snapshot.assertUnchanged();
    retention = retainClaudeLaunchFiles({ configDir, settings: snapshot.file, scratch });
    const nativeArgs = ["v1", protectedAccount ? "protected" : "ordinary", configDir,
      fs.realpathSync(snapshot.file), scratch, "3", String(combinedReads.length), ...combinedReads,
      String(updateRoots.length), ...updateRoots, "--", ...claudeArgsWithSettingsSnapshot(args, snapshot)];
    return Object.freeze({ command: artifact.launcher, args: Object.freeze(nativeArgs),
      vendorCommand: artifact.command, artifact, environment, environmentFd,
      // Caller closes its FD immediately after spawn; the supervisor holds
      // its inherited copy and passes it as fd3 only to the fixed native entry.
      closeEnvironment() { if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; } },
      markStarted() { started = true; },
      disposeBeforeStart() {
        if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; }
        if (started) return;
        snapshot.dispose(); fs.rmSync(scratch, { recursive: true, force: true }); retention.cancelBeforeStart();
      },
      // Do not delete a snapshot at foreground exit: native background owners
      // can replay --settings later. Retirement is a stopped-owner operation;
      // the account coordinator retires these only after stopped-owner proof.
      retainedPaths: Object.freeze({ settings: snapshot.file, scratch }),
    });
  } catch (error) {
    if (environmentFd !== undefined) fs.closeSync(environmentFd);
    retention?.cancelBeforeStart();
    snapshot?.dispose();
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true });
    if (error?.code?.startsWith("AIMGR_CLAUDE_")) throw error;
    fail("the native privacy launch could not be prepared safely");
  }
}
