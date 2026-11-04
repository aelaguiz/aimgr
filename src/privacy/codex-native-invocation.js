import fs from "node:fs";
import path from "node:path";
import { admitCodexArtifact } from "./codex-artifacts.js";
import { prepareCodexAccountState, codexStateLink } from "./codex-account-state.js";
import { readCodexEnvironment } from "./codex-environment.js";
import { readLocalCodexCredential } from "../credentials/codex-local.js";
import { codexArguments } from "./codex-arguments.js";
import { codexSettingsView, superviseCodexSettings } from "../io/codex-settings.js";
import { codexCanonicalPath, resolveCodexLaunchInputs, codexPrivacyEnvironment } from "./codex-launch-inputs.js";
import { inspectCodexManagedPolicy } from "./codex-managed-policy.js";
import { prepareCodexNativeInputs } from "./codex-native-inputs.js";
import { stageLaunchEnvironment } from "./launch-environment.js";
import { codexStateIO } from "../io/codex-state-io.js";
import { prepareCodexWorktree, codexWorktreeDatabases, finishCodexWorktree } from "./codex-worktree.js";

/** One launch owner carries the exact selected account through admission,
 * settings supervision and spawn. No global selection is read after this. */
export async function prepareCodexNativeInvocation({ prepared, command, homeDir, cwd = process.cwd(), env = process.env,
  args = [], ownedAppServer = false, onWarning = () => {}, onError = () => {}, onNotice = () => {},
  admitArtifact = admitCodexArtifact, inspectManagedPolicy = inspectCodexManagedPolicy,
  environment = readCodexEnvironment(), resolveInputs = resolveCodexLaunchInputs,
  nativeInputs = prepareCodexNativeInputs,
  worktreeOperation,
} = {}) {
  let supervisor, scratch, environmentFd, worktree;
  try {
    if (!prepared?.accountId || prepared.environmentId !== environment.binding) throw new Error("Codex needs the selected account's authorization from this environment.");
    const account = prepareCodexAccountState({ homeDir, accountId: prepared.accountId, label: prepared.label,
      env: { ...env, CODEX_HOME: prepared.sharedHome }, environment });
    if (account.codexHome !== prepared.codexHome || account.accountRoot !== prepared.accountRoot) throw new Error("Codex prepared account state changed before launch.");
    const local = prepared.keyBacked && prepared.accountId === "api-provider:deepseek" ? { status: "ready", credential: null }
      : readLocalCodexCredential({ homeDir, env: { CODEX_HOME: account.sharedHome }, accountId: account.accountId, environment });
    if (local.status !== "ready") throw new Error(`Codex account ${account.label ?? "selected"} needs a healthy local login (${local.status}).`);
    let parsedArgs = codexArguments(args, { cwd, ownedAppServer });
    const artifact = admitArtifact({ selectedCommand: command, pinnedArtifactSet: env.AIMGR_CODEX_ARTIFACT_SET });
    const policy = JSON.parse(fs.readFileSync(artifact.policy, "utf8"));
    if (policy.schema !== 1 || policy.version !== artifact.version || policy.platform !== process.platform || policy.arch !== process.arch
      || policy.settingsManifest !== 1 || !/^[a-f0-9]{40}$/.test(policy.sourceCommit ?? "")) throw new Error("Codex approved settings compatibility record is invalid.");
    const managed = inspectManagedPolicy({ artifact, credential: local.credential });
    const entries = ["config.toml", ...(parsedArgs.profile ? [`${parsedArgs.profile}.config.toml`] : [])].map(name => {
      const entry = codexSettingsView({ base: account.base, source: path.join(account.sharedHome, name), home: homeDir });
      codexStateLink(path.join(account.codexHome, name), entry.view);
      return entry;
    });
    supervisor = await superviseCodexSettings(entries, { onWarning, onError,
      stateIO: request => codexStateIO(request, { helperPath: artifact.stateIO }) });
    scratch = fs.realpathSync(fs.mkdtempSync(path.join(account.accountRoot, ".runtime-")));
    fs.chmodSync(scratch, 0o700);
    const environmentValues = codexPrivacyEnvironment({ env, prepared: account, artifact, scratch });
    worktree = await prepareCodexWorktree({ parsedArgs, nativeInputs, artifact, prepared: account,
      env: environmentValues, managed, operate: worktreeOperation });
    if (worktree) parsedArgs = worktree.parsedArgs;
    const effectiveInputs = await nativeInputs({ artifact, prepared: account, parsedArgs,
      env: environmentValues, managed, ownedAppServer });
    if (effectiveInputs.mcp_store !== "keyring" || fs.existsSync(path.join(account.sharedHome, ".credentials.json"))) {
      throw new Error("Codex's shared MCP credentials need the one-time native keyring conversion. Run `aim codex mcp-migrate` from a terminal before starting Codex.");
    }
    const worktreeDatabases = worktree ? codexWorktreeDatabases(effectiveInputs) : null;
    const inputs = resolveInputs({ prepared: account, parsedArgs, homeDir, env: environmentValues,
      managedFiles: managed.files, effectiveInputs });
    environmentFd = stageLaunchEnvironment(environmentValues, scratch);
    const writes = [...new Set([...inputs.writes, ...entries.filter(entry => supervisor.states.get(entry)?.writable)
      .map(entry => codexCanonicalPath(path.dirname(entry.view)))])];
    const reads = [...new Set([...inputs.reads, ...artifact.readPaths, ...entries.filter(entry => !supervisor.states.get(entry)?.writable)
      .map(entry => codexCanonicalPath(path.dirname(entry.view)))])];
    const databases = [...new Set(inputs.databases)];
    const denied = [codexCanonicalPath(path.join(account.sharedHome, "secrets", "codex_auth.age")),
      codexCanonicalPath(path.join(account.codexHome, "secrets", "codex_auth.age"))];
    if ([writes, reads, databases, denied].some(list => list.length > 256)) throw new Error("Codex startup inputs exceed the native policy capacity.");
    const nativeArgs = ["v1", fs.realpathSync(account.accountRoot), fs.realpathSync(account.codexHome), scratch, "3",
      String(writes.length), ...writes, String(reads.length), ...reads, String(databases.length), ...databases,
      String(denied.length), ...denied, "--", ...parsedArgs.args];
    let closed = false, startedAt, endedAt;
    return { command: artifact.launcher, args: nativeArgs, artifact, prepared: account, entries, inputs, parsedArgs,
      environment: environmentValues, environmentFd,
      // A privileged entry receives only fixed bootstrap variables. All user
      // tool environment crosses the unlinked descriptor after policy entry.
      // Keep original process cwd for native argument semantics. A requested
      // worktree has already been created and receives absolute -C/add-dir.
      env: { PATH: "/usr/bin:/bin" }, cwd: parsedArgs.processCwd,
      beforeSpawn() { startedAt = new Date().toISOString(); },
      childClosed() { endedAt = new Date().toISOString(); },
      flushSettings: () => supervisor.flush(),
      closeEnvironment() { if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; } },
      async close() {
        if (closed) return; closed = true;
        if (environmentFd !== undefined) { fs.closeSync(environmentFd); environmentFd = undefined; }
        if (worktree && startedAt && endedAt) await finishCodexWorktree({ worktree, nativeInputs, artifact,
          prepared: account, parsedArgs, env: environmentValues, managed, databases: worktreeDatabases,
          startedAt, endedAt, onNotice });
        else if (worktree) { try { onNotice(`Codex kept the worktree at ${worktree.checkout.root}.`); } catch {} }
        await supervisor.close();
        // Background tools may still refer to their temporary directory. Keep
        // nonempty scratch; empty launch scratch has no surviving state.
        try { fs.rmdirSync(scratch); } catch (error) { if (!["ENOTEMPTY", "EEXIST"].includes(error.code)) throw error; }
      },
    };
  } catch (error) {
    if (environmentFd !== undefined) fs.closeSync(environmentFd);
    if (supervisor) await supervisor.close().catch(() => {});
    if (scratch) fs.rmSync(scratch, { recursive: true, force: true }); // No child has been started.
    if (worktree) error.message += ` The worktree was kept at ${worktree.checkout.root}.`;
    throw error;
  }
}
