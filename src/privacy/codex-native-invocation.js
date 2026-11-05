import fs from "node:fs";
import path from "node:path";
import { admitCodexArtifact } from "./codex-artifacts.js";
import { prepareCodexAccountState, codexStateLink } from "./codex-account-state.js";
import { readCodexEnvironment } from "./codex-environment.js";
import { readLocalCodexCredential } from "../credentials/codex-local.js";
import { codexArguments, codexProxyArguments } from "./codex-arguments.js";
import { codexSettingsView, superviseCodexSettings } from "../io/codex-settings.js";
import { codexCanonicalPath, resolveCodexLaunchInputs, codexPrivacyEnvironment } from "./codex-launch-inputs.js";
import { inspectCodexManagedPolicy } from "./codex-managed-policy.js";
import { prepareCodexNativeInputs } from "./codex-native-inputs.js";
import { stageLaunchEnvironment } from "./launch-environment.js";
import { codexStateIO } from "../io/codex-state-io.js";
import { prepareCodexWorktree, codexWorktreeDatabases, finishCodexWorktree } from "./codex-worktree.js";
import { acquireCodexAssignmentLock, resolveCodexRoute } from "../network/codex-egress.js";
import { prepareCodexNativeRoute, codexProxyEnvironment } from "../network/claude-native-route.js";

/** One launch owner carries the exact selected account through admission,
 * settings supervision and spawn. No global selection is read after this. */
export async function prepareCodexNativeInvocation({ prepared, command, homeDir, cwd = process.cwd(), env = process.env,
  args = [], ownedAppServer = false, onWarning = () => {}, onError = () => {}, onNotice = () => {},
  admitArtifact = admitCodexArtifact, inspectManagedPolicy = inspectCodexManagedPolicy,
  environment = readCodexEnvironment(), resolveInputs = resolveCodexLaunchInputs,
  nativeInputs = prepareCodexNativeInputs,
  prepareRoute = prepareCodexNativeRoute,
  worktreeOperation,
} = {}) {
  let supervisor, scratch, environmentFd, worktree, assignment;
  try {
    if (!prepared?.accountId || prepared.environmentId !== environment.binding) throw new Error("Codex needs the selected account's authorization from this environment.");
    const routing = { homeDir, accountId: prepared.accountId, label: prepared.label, environment,
      record: prepared.routeRecord, offline: !prepared.routeRecord };
    assignment = await acquireCodexAssignmentLock(routing);
    const route = resolveCodexRoute(routing);
    const account = prepareCodexAccountState({ homeDir, accountId: prepared.accountId, label: prepared.label,
      env: { ...env, CODEX_HOME: prepared.codexHome }, environment });
    if (account.codexHome !== prepared.codexHome || account.accountRoot !== prepared.accountRoot) throw new Error("Codex prepared account state changed before launch.");
    const local = prepared.keyBacked && prepared.accountId === "api-provider:deepseek" ? { status: "ready", credential: null }
      : readLocalCodexCredential({ homeDir, env: { CODEX_HOME: account.sharedHome }, accountId: account.accountId, environment });
    if (local.status !== "ready") throw new Error(`Codex account ${account.label ?? "selected"} needs a healthy local login (${local.status}).`);
    // New AIM sessions use native keyring storage without changing the shared
    // source or any already-running session. Later explicit CLI overrides
    // retain native precedence and are checked against the effective mode.
    const privacyArgs = ["-c", 'mcp_oauth_credentials_store="keyring"', ...args];
    let parsedArgs = codexArguments(route ? codexProxyArguments(privacyArgs, { cwd, ownedAppServer }) : privacyArgs, { cwd, ownedAppServer });
    // Native Clap exits before reading configuration for these exact forms.
    // Do not use parsedArgs.inspection: passthrough child argv can contain help.
    const inspectionOnly = (args.length === 1 && ["--help", "-h", "--version", "-V"].includes(args[0]))
      || (args.length === 2 && parsedArgs.command === args[0] && ["--help", "-h"].includes(args[1]));
    if (!inspectionOnly && fs.existsSync(path.join(account.sharedHome, ".credentials.json"))) {
      throw new Error("Codex's shared MCP credentials need the one-time native keyring conversion. Run `aim codex mcp-migrate` from a terminal before starting Codex.");
    }
    const artifact = admitArtifact({ selectedCommand: command, pinnedArtifactSet: env.AIMGR_CODEX_ARTIFACT_SET });
    const policy = JSON.parse(fs.readFileSync(artifact.policy, "utf8"));
    if (policy.schema !== 1 || policy.version !== artifact.version || policy.platform !== process.platform || policy.arch !== process.arch
      || policy.settingsManifest !== 1 || !/^[a-f0-9]{40}$/.test(policy.sourceCommit ?? "")) throw new Error("Codex approved settings compatibility record is invalid.");
    const managed = inspectManagedPolicy({ artifact, credential: local.credential });
    const entries = (inspectionOnly ? [] : ["config.toml", ...(parsedArgs.profile ? [`${parsedArgs.profile}.config.toml`] : [])]).map(name => {
      const entry = codexSettingsView({ base: account.base, source: path.join(account.sharedHome, name), home: homeDir });
      codexStateLink(path.join(account.codexHome, name), entry.view);
      return entry;
    });
    if (!inspectionOnly) supervisor = await superviseCodexSettings(entries, { onWarning, onError,
      stateIO: request => codexStateIO(request, { helperPath: artifact.stateIO }) });
    // Chrome and other ordinary tools put Unix sockets under TMPDIR. Account
    // homes can exceed the OS socket-path limit; keep each private launch
    // directory short and grant only that directory in the vendor policy.
    scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), `aim-codex-${process.getuid()}-`));
    fs.chmodSync(scratch, 0o700);
    const privateEnvironment = codexPrivacyEnvironment({ env, prepared: account, artifact, scratch });
    const environmentValues = route ? codexProxyEnvironment(privateEnvironment, route) : privateEnvironment;
    if (!inspectionOnly) worktree = await prepareCodexWorktree({ parsedArgs, nativeInputs, artifact, prepared: account,
      env: environmentValues, managed, operate: worktreeOperation });
    if (worktree) parsedArgs = worktree.parsedArgs;
    const effectiveInputs = inspectionOnly ? null : await nativeInputs({ artifact, prepared: account, parsedArgs,
      env: environmentValues, managed, ownedAppServer });
    if (!inspectionOnly && effectiveInputs.mcp_store !== "keyring") {
      throw new Error('Codex privacy requires mcp_oauth_credentials_store="keyring". Remove the conflicting command-line or administrator setting before starting Codex.');
    }
    const worktreeDatabases = worktree ? codexWorktreeDatabases(effectiveInputs) : null;
    const inputs = inspectionOnly ? { cwd: parsedArgs.cwd, writes: [], reads: [], databases: [] } : resolveInputs({ prepared: account, parsedArgs, homeDir, env: environmentValues,
      managedFiles: managed.files, effectiveInputs });
    environmentFd = stageLaunchEnvironment(environmentValues, scratch);
    // Only the private view directory is admitted. Its ordinary permissions
    // mirror source replaceability and can recover within this session; an
    // initially read-only source must not leave a permanent native read grant.
    const writes = [...new Set([...inputs.writes, ...entries.map(entry => codexCanonicalPath(path.dirname(entry.view)))])];
    const reads = [...new Set([...inputs.reads, ...artifact.readPaths])];
    const databases = [...new Set(inputs.databases)];
    const denied = [codexCanonicalPath(path.join(account.sharedHome, "secrets", "codex_auth.age")),
      codexCanonicalPath(path.join(account.codexHome, "secrets", "codex_auth.age"))];
    // Doctor reads the desktop installation ID outside CODEX_HOME. An explicit
    // project/import grant must not turn that automatic identity read back on.
    if (process.platform === "darwin") for (const root of new Set([homeDir, env.HOME || homeDir])) {
      denied.push(codexCanonicalPath(path.join(root, "Library/Application Support/com.openai.codex/production-appcast-bootstrap.json")));
    }
    const nativeArgs = ["assigned-v1", fs.realpathSync(account.accountRoot), fs.realpathSync(account.codexHome), scratch, "3",
      String(writes.length), ...writes, String(reads.length), ...reads, String(databases.length), ...databases,
      String(denied.length), ...denied, "--", ...parsedArgs.args];
    const launch = route ? await prepareRoute({ profile: route, command: artifact.launcher, args: nativeArgs,
      nativeCommand: artifact.command, signal: assignment.signal }) : { command: artifact.launcher, args: nativeArgs };
    let closed = false, startedAt, endedAt;
    return { ...launch, artifact, prepared: account, entries, inputs, parsedArgs,
      environment: environmentValues, environmentFd, assignmentFd: assignment.fd, route,
      // A privileged entry receives only fixed bootstrap variables. All user
      // tool environment crosses the unlinked descriptor after policy entry.
      // Keep original process cwd for native argument semantics. A requested
      // worktree has already been created and receives absolute -C/add-dir.
      env: { PATH: "/usr/bin:/bin" }, cwd: parsedArgs.processCwd,
      beforeSpawn() { assignment.assertOwned(); startedAt = new Date().toISOString(); },
      childClosed() { endedAt = new Date().toISOString(); },
      flushSettings: async () => supervisor?.flush(),
      closeEnvironment() { if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; } },
      async close() {
        if (closed) return; closed = true;
        try {
          if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; }
          if (worktree && startedAt && endedAt) await finishCodexWorktree({ worktree, nativeInputs, artifact,
            prepared: account, parsedArgs, env: environmentValues, managed, databases: worktreeDatabases,
            startedAt, endedAt, onNotice });
          else if (worktree) { try { onNotice(`Codex kept the worktree at ${worktree.checkout.root}.`); } catch {} }
          await supervisor?.close();
          // Background tools may still refer to their temporary directory. Keep
          // nonempty scratch; empty launch scratch has no surviving state.
          try { fs.rmdirSync(scratch); } catch (error) { if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
        } finally { await assignment.release(); }
      },
    };
  } catch (error) {
    try {
      if (environmentFd !== undefined) fs.closeSync(environmentFd);
      if (supervisor) await supervisor.close().catch(() => {});
      if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); // No child has been started.
      if (worktree) error.message += ` The worktree was kept at ${worktree.checkout.root}.`;
    } finally { await assignment?.release(); }
    throw error;
  }
}
