import fs from "node:fs";
import path from "node:path";
import { handleLocalClaudeAuth } from "./claude-local-auth.js";
import { loadClaudeRuntime } from "../../coordination/claude-runtime.js";
import { updateClaudeEgressMetadata } from "../../coordination/claude-metadata.js";
import { closeRedisRuntime, isRedisConfigured, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { readLocalClaudeCredential } from "../../credentials/claude-local.js";
import { claudeOwnerBinding } from "../../privacy/claude-environment.js";
import { acquireClaudeStateGuard } from "../../privacy/claude-state-migration.js";
import { acquireClaudeAssignmentLock, invalidateClaudeOfflineBinding } from "../../network/claude-offline-binding.js";
import { resolveNativeAccountProfile, assertLocalClaudeProfileStopped } from "../../network/claude-native-route.js";
import { assertClaudeLocalInvocation } from "../../privacy/claude-settings.js";
import { inspectClaudePrivacyStatus, formatClaudePrivacyStatus } from "../../privacy/claude-status.js";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { normalizeEgressPolicy, resolveClaudeEgressProfile } from "../../network/claude-egress-policy.js";
import { normalizeLabel } from "../../core/normalize.js";
import { AIMGR_REDIS_PRIMARY_HOST, AIMGR_REDIS_PRIMARY_URL } from "../../core/constants.js";
import { pickClaudeSession } from "../claude-session-picker.js";
import { claudeRunPresetArgs } from "../args.js";
import { readMachineClaudeSessionCounts, joinLocalClaudeSessions } from "../../targets/claude-machine-lease.js";
import { prepareClaudeCliLaunch, runClaudeCli } from "../../targets/claude-runner.js";
import { inheritClaudeProjectConsent } from "../../targets/claude-project-consent.js";
import { foldManagedClaudeMemories, renderClaudeSharedMemoryReport, summarizeClaudeSharedMemory } from "../../targets/claude-shared-memory.js";
import { buildManagedClaudeSessionForkName, findManagedClaudeSessionFiles, listRecentManagedClaudeSessions, readManagedClaudeSessions,
 renderRecentManagedClaudeSessions, resolveManagedClaudeSession, stageManagedClaudeSessionFork } from "../../targets/claude-sessions.js";
import { assertClaudeUsageRoutes, collectClaudeRedisAccountInventory, collectClaudeRedisAccountUsageStatus,
 renderClaudeRedisAccountInventory, renderClaudeRedisAccountUsageStatus, selectClaudeAccountForSession } from "../../status/claude-redis-view.js";

function localLoginRequired(label) {
  return Object.assign(new Error(`Claude ${label} needs local sign-in: aim claude login ${label}`), {code:"AIMGR_CLAUDE_AUTH_UNAVAILABLE"});
}

function nativeClaudeOption(args, names) {
  const matches = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--") break;
    if (names.includes(arg)) {
      const next = args[index + 1];
      matches.push({ index, inline: false, value: next && !next.startsWith("-") ? next : null });
    } else {
      const name = names.find((candidate) => arg.startsWith(`${candidate}=`));
      if (name) matches.push({ index, inline: true, value: arg.slice(name.length + 1) || null });
    }
  }
  if (matches.length > 1) throw new Error("Claude native arguments contain more than one resume or session-ID option.");
  return matches[0] ?? null;
}

function isPathWithin(parent, candidate) {
  let canonicalParent;
  try {
    canonicalParent = fs.realpathSync(parent);
  } catch {
    canonicalParent = path.resolve(parent);
  }
  const relative = path.relative(canonicalParent, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function planCrossAccountClaudeResume({ homeDir, label, configDir, cwd, args, sessionFork }) {
  const nativeArgs = Array.isArray(args) ? [...args] : [];
  const resumeOption = nativeClaudeOption(nativeArgs, ["--resume", "-r"]);
  const sessionIdOption = nativeClaudeOption(nativeArgs, ["--session-id"]);
  if (sessionFork) {
    if (!resumeOption?.value) throw new Error("Cross-account Claude resume requires a source transcript.");
    if (sessionIdOption) throw new Error("Cross-account Claude resume cannot reuse an explicit session ID.");
    return { args: nativeArgs, resumeOption, sessionFork };
  }
  if (!resumeOption?.value && !sessionIdOption?.value) {
    return { args: nativeArgs, resumeOption: null, sessionFork: null };
  }

  const selector = resumeOption?.value;
  if (selector && (path.isAbsolute(selector) || selector.endsWith(".jsonl"))) {
    let sourcePath;
    try {
      sourcePath = fs.realpathSync(path.resolve(cwd, selector));
    } catch {
      // Preserve native Claude's existing error for a path that does not exist.
      return { args: nativeArgs, resumeOption, sessionFork: null };
    }
    if (isPathWithin(configDir, sourcePath)) {
      return { args: nativeArgs, resumeOption, sessionFork: null };
    }
    if (sessionIdOption) throw new Error("Cross-account Claude resume cannot reuse an explicit session ID.");
    return {
      args: nativeArgs,
      resumeOption,
      sessionFork: { transcriptPath: sourcePath },
    };
  }

  // Check filenames before opening transcripts. A resume of one ID must never
  // parse the entire account pool's history, including when that ID is absent.
  if (sessionIdOption?.value && findManagedClaudeSessionFiles({
    homeDir, threadId: sessionIdOption.value,
  }).some((candidate) => candidate.account !== label)) {
    throw new Error(
      `Claude session ID ${sessionIdOption.value} belongs to another account; use \`aim claude resume ${sessionIdOption.value} --account ${label}\` to continue it with a fresh ID.`,
    );
  }
  if (!selector) {
    return { args: nativeArgs, resumeOption: null, sessionFork: null };
  }

  const exactId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(selector);
  const localMatches = exactId ? findManagedClaudeSessionFiles({ homeDir, threadId: selector, account: label }) : [];
  const managedSessions = exactId
    ? (localMatches.length ? localMatches : findManagedClaudeSessionFiles({ homeDir, threadId: selector }))
    : readManagedClaudeSessions({ homeDir });

  const sameAccount = managedSessions.some((candidate) => (
    candidate.account === label
    && (candidate.threadId.toLowerCase() === selector.toLowerCase()
      || candidate.threadName?.toLowerCase() === selector.toLowerCase())
  ));
  if (sameAccount) return { args: nativeArgs, resumeOption, sessionFork: null };
  const otherMatches = managedSessions.filter((candidate) => (
    candidate.account !== label
    && (candidate.threadId.toLowerCase() === selector.toLowerCase()
      || candidate.threadName?.toLowerCase() === selector.toLowerCase())
  ));
  if (otherMatches.length > 1) {
    throw new Error(`Claude session ${selector} exists in multiple accounts; resume its absolute transcript path to choose one.`);
  }
  if (otherMatches.length > 0 && sessionIdOption) {
    throw new Error("Cross-account Claude resume cannot reuse an explicit session ID.");
  }
  return {
    args: nativeArgs,
    resumeOption,
    sessionFork: otherMatches[0] ?? null,
  };
}

function stagedClaudeResumeArgs(plan, staged) {
  if (!staged) return plan.args;
  const args = [...plan.args];
  const { index, inline } = plan.resumeOption;
  if (inline) args[index] = `${args[index].split("=")[0]}=${staged.targetTranscriptPath}`;
  else args[index + 1] = staged.targetTranscriptPath;
  if (!args.includes("--fork-session")) args.push("--fork-session");
  if (!args.includes("--name") && !args.some((arg) => arg.startsWith("--name="))) {
    args.push("--name", "Continued session");
  }
  return args;
}

function crossAccountClaudeEnvironment(env, staged) {
  if (!staged) return env;
  const safe = { ...(env ?? {}) };
  delete safe.ANTHROPIC_CUSTOM_HEADERS;
  delete safe.CLAUDE_CODE_EXTRA_BODY;
  return safe;
}

function claudePresetForSessionModel(model) {
  const normalized = String(model ?? "").toLowerCase();
  if (normalized.includes("fable")) return "fable";
  if (normalized.includes("sonnet")) return "sonnet";
  return "opus";
}

async function selectAutomaticClaudeAccount(context, {
  preset,
  excludeLabels = [],
  requireLive = false,
} = {}) {
  const {
    homeDir,
    nowMs,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
  } = context;
  const excluded = new Set(excludeLabels.map((label) => normalizeLabel(label)));
  const usageStatus = await collectClaudeRedisAccountUsageStatus({
    homeDir,
    fresh: requireLive,
    nowMs,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
    readClaudeEnvironmentImpl:context.readClaudeEnvironmentImpl,
  });
  // Check before preference/exclusion filtering: a failed configured route
  // cannot disappear from the live-only resume candidates and cause fallback.
  assertClaudeUsageRoutes(usageStatus);
  const localSessions = readMachineClaudeSessionCounts({ homeDir });
  return selectClaudeAccountForSession({
    ...usageStatus,
    accounts: usageStatus.accounts
      .filter(
        (account) => !excluded.has(account.label)
          && (!requireLive || (account.source === "live" && account.credentialReady && account.usage?.ok)),
      )
      .map((account) => ({ ...account, localSessions: localSessions.get(account.label) ?? 0 })),
  }, { preset });
}

async function handleRedisClaudeRun(context, { launchCwd = process.cwd(), sessionFork = null, allowOffline = true } = {}) {
  const { homeDir, opts, env, positional, setExitCode, resolveExecutableOnPathImpl } = context;
  const label = normalizeLabel(positional[2]);
  const runtime = await loadClaudeRuntime({ homeDir, connectRedisStoreImpl: context.connectRedisStoreImpl,
    readClaudeEnvironmentImpl: context.readClaudeEnvironmentImpl, allowOffline });
  let assignmentLock, stagedSessionFork, leaveSessions;
  try {
    const metadata = runtime.snapshot.credentials.find(item => item.label === label);
    if (!metadata) throw new Error(`Unknown Claude account ${label}; use \`aim claude login ${label}\`.`);
    const localOptions = { homeDir, label, metadata, environment: runtime.environment };
    let local = readLocalClaudeCredential(localOptions);
    if (!local.credential || (runtime.offline && local.status !== "ready")) throw localLoginRequired(label);
    const { claudeHome, configDir } = local;
    const profile = resolveNativeAccountProfile({ homeDir, state: runtime.state, label });
    const discovered = resolveExecutableOnPathImpl?.("claude");
    const prepare = resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl ?? prepareClaudeCliLaunch;
    let prepared;
    assignmentLock = await acquireClaudeStateGuard({ homeDir, label, configDir, command: discovered,
      beforeState: async () => { prepared = await prepare({ command: discovered, userHomeDir: homeDir, homeDir: claudeHome, configDir }); },
      readBinding: async () => {
        local = readLocalClaudeCredential(localOptions);
        if (!local.credential) throw localLoginRequired(label);
        return { protected: true, accountUuid: metadata.identity.accountUuid, organizationUuid: metadata.identity.organizationUuid,
          environmentBinding: claudeOwnerBinding(runtime.environment, metadata.identity), profileRef: profile?.profileRef,
          credential: local.credential, expectedEmail: local.descriptor.expectedEmail };
      } });
    const plan = planCrossAccountClaudeResume({ homeDir, label, configDir, cwd: launchCwd, args: opts.afterDoubleDash, sessionFork });
    if (plan.sessionFork) stagedSessionFork = stageManagedClaudeSessionFork({ session: plan.sessionFork, targetConfigDir: configDir });
    inheritClaudeProjectConsent({ userHomeDir: homeDir, configDir, cwd: launchCwd });
    const target = runtime.state.targets.claudeCli;
    target.lastRunLabel = label;
    delete target.claudeDir; delete target.credentialsPath; delete target.appStatePath;
    target.lastAppliedAt = new Date().toISOString();
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    leaveSessions = await joinLocalClaudeSessions({homeDir,label});
    const launched = await (context.runClaudeCliImpl ?? runClaudeCli)({ assignmentLock, egressProfile: profile,
      expectedIdentity: local.nativeClaudeBundle.oauthAccount, command: prepared.command, preparedLaunch: prepared,
      userHomeDir: homeDir, homeDir: claudeHome, configDir, cwd: launchCwd,
      args: stagedClaudeResumeArgs(plan, stagedSessionFork), env: crossAccountClaudeEnvironment(env, stagedSessionFork) });
    if (launched?.signal) process.kill(process.pid, launched.signal);
    else if (launched?.status !== 0) setExitCode(Number.isInteger(launched?.status) ? launched.status : 1);
  } finally {
    try { await leaveSessions?.(); stagedSessionFork?.cleanup(); } finally {
      try { await assignmentLock?.release(); } finally { await closeRedisRuntime(runtime); }
    }
  }
}

// Scheduled work uses the same machine-local login and native refresh locks.
export async function runAutomaticClaudeSession(context, { cwd, runSession, jobName = "a scheduled job" }) {
  if (!isRedisConfigured({ homeDir: context.homeDir })) {
    throw new Error("Claude routines require configured Redis account coordination.");
  }
  const selected = await selectAutomaticClaudeAccount(context, { preset: "fable" });
  if (!selected) throw new Error("No locally signed-in Claude account with usage left is available.");
  await handleRedisClaudeRun({
    ...context,
    positional: ["claude", "run", selected.label],
    runClaudeCliImpl: (launch) => runSession({ ...launch, label: selected.label }),
  }, { launchCwd: cwd, allowOffline: false });
}

export async function handleClaude(context) {
  const {
    opts,
    positional,
    statePath,
    homeDir,
    env,
    stdout,
    setExitCode,
    probeUsageSnapshotsByProviderImpl,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
    nowMs,
  } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (subcmd === "login" || subcmd === "logout") return await handleLocalClaudeAuth(context);
  if (["capture-native", "import-native", "export-live"].includes(subcmd)) throw new Error("Primary Claude credentials stay on this machine. Use `aim claude login <label>`; explicit legacy Prime/Pi enrollment uses `aim login <label> --provider anthropic`.");
  // Reject unsupported native intent before account selection, Redis or any
  // provider preflight. The shared settings handoff repeats this for internal
  // callers; this early check makes the public failure local and intelligible.
  if (subcmd === "run" || subcmd === "resume") assertClaudeLocalInvocation(opts.afterDoubleDash ?? []);
  if (subcmd === "privacy") {
    if (positional[2] !== "status" || positional.length > 4) throw new Error("Usage: aim claude privacy status [account] [--json]");
    const label = positional[3] ? normalizeLabel(positional[3]) : undefined;
    const status = inspectClaudePrivacyStatus({ command: context.resolveExecutableOnPathImpl?.("claude"),
      homeDir, label, pinnedArtifactSet: env.AIMGR_CLAUDE_ARTIFACT_SET });
    stdout.write(opts.json ? JSON.stringify(status, null, 2) + "\n" : formatClaudePrivacyStatus(status));
    if (status.refusal) setExitCode(1);
    return;
  }
  if (!subcmd) {
    throw new Error(
      "Missing claude subcommand. Usage: aim claude list [count] [--json] | aim claude resume [<row-or-thread-id-or-name>] [--account <label>] [--switch-account fable|opus|sonnet] | aim claude inventory [--json] | aim claude memory | aim claude status [account...] [--fresh] [--verbose] [--json] | aim claude run <label> [-- <claude args...>] | aim claude login <label> | aim claude logout <label>",
    );
  }
  if (subcmd === "proxy") {
    if (positional[2] !== "set" || positional.length !== 5) {
      throw new Error("Usage: aim claude proxy set <label> <profileRef>");
    }
    const label = normalizeLabel(positional[3]);
    const egress = normalizeEgressPolicy({ profileRef: positional[4] });
    resolveClaudeEgressProfile({ label, account: { egress }, profiles: readAimgrConfig({ homeDir }).config.claudeProxyProfiles });
    const runtime = await loadClaudeRuntime({homeDir,connectRedisStoreImpl,readClaudeEnvironmentImpl:context.readClaudeEnvironmentImpl});
    let assignmentLock;
    try {
      assignmentLock = await acquireClaudeAssignmentLock(homeDir,label,{exclusive:true});
      const record = runtime.snapshot.credentials.find(item => item.label === label);
      if (!record) throw new Error(`Unknown Claude account: ${label}`);
      await (context.assertLocalClaudeProfileStoppedImpl ?? assertLocalClaudeProfileStopped)(record.policy?.egress?.profileRef);
      invalidateClaudeOfflineBinding(homeDir,label);
      assignmentLock.assertOwned();
      await updateClaudeEgressMetadata(runtime.store,{label,expectedVersion:record.version,egress});
      // The old safe cache must not preserve a superseded route offline.
      fs.rmSync(path.join(homeDir,'.aimgr','claude-account-metadata.json'),{force:true});
      stdout.write(`Claude ${label} uses proxy ${egress.profileRef}.\n`);
    } finally { try { await assignmentLock?.release(); } finally { await closeRedisRuntime(runtime); } }
    return;
  }
  if (subcmd === "list") {
    const requestedCount = positional[2];
    if (
      positional.length > 3
      || (
        requestedCount !== undefined
        && (
          !/^\d+$/.test(requestedCount)
          || !Number.isSafeInteger(Number(requestedCount))
          || Number(requestedCount) < 1
        )
      )
    ) {
      throw new Error("Usage: aim claude list [count] [--json]");
    }
    const sessions = listRecentManagedClaudeSessions({
      homeDir,
      ...(requestedCount === undefined ? {} : { limit: Number(requestedCount) }),
    });
    if (opts.json) {
      stdout.write(`${JSON.stringify({
        sessions: sessions.map((session) => ({
          rank: session.rank,
          lastUsedAt: session.lastUsedAt,
          account: session.account,
          threadName: session.threadName,
          threadId: session.threadId,
          cwd: session.cwd,
        })),
      }, null, 2)}\n`);
    } else {
      stdout.write(renderRecentManagedClaudeSessions(sessions, { homeDir, nowMs }));
    }
    return;
  }
  if (subcmd === "resume") {
    if (positional.length > 3) {
      throw new Error(
        "Usage: aim claude resume [<row-or-thread-id-or-name>] [--account <label>] [--switch-account fable|opus|sonnet]",
      );
    }
    let picked;
    if (positional[2] === undefined) {
      if (opts.json) throw new Error("Use `aim claude list --json` to list sessions, or `aim claude resume` in an interactive terminal to choose one.");
      picked = await pickClaudeSession(context);
      if (!picked) return;
    }
    const session = resolveManagedClaudeSession({
      homeDir,
      selector: picked?.threadId ?? positional[2],
      ...(picked ? { account: picked.account } : {}),
    });
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude resume\` requires Redis. Run \`aim redis configure --url '${AIMGR_REDIS_PRIMARY_URL}' --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const requestedSwitchPreset = opts.claudeResumeSwitchAccountPreset;
    const requestedAccountLabel = opts.claudeResumeAccountLabel
      ? normalizeLabel(opts.claudeResumeAccountLabel)
      : null;
    if (requestedAccountLabel === session.account) {
      throw new Error(
        `Claude session already belongs to label=${session.account}; omit --account to resume it directly.`,
      );
    }
    const preservedResumeArgs = session.model && session.effort
      ? [
        "--dangerously-skip-permissions",
        "--model",
        session.model,
        "--effort",
        session.effort,
      ]
      : null;
    if (!preservedResumeArgs) {
      throw new Error(
        `Claude session ${session.threadId} does not record an exact model and effort; refusing to guess.`,
      );
    }
    let unavailableReason = "busy";
    if (!requestedSwitchPreset && !requestedAccountLabel) {
      const directContext = {
        ...context,
        positional: ["claude", "run", session.account],
        opts: {
          ...opts,
          afterDoubleDash: [
            ...preservedResumeArgs,
            "--resume",
            session.threadId,
          ],
        },
      };
      try {
        await handleRedisClaudeRun(directContext, {
          launchCwd: session.cwd,
        });
        return;
      } catch (error) {
        if (error?.code === "AIMGR_CLAUDE_AUTH_UNAVAILABLE") unavailableReason = "requires login";
        else if (error?.code !== "AIMGR_CREDENTIAL_BUSY") throw error;
      }
    }

    const forkPreset = requestedSwitchPreset ?? claudePresetForSessionModel(session.model);
    const forkResumeArgs = [...preservedResumeArgs];
    if (requestedSwitchPreset) {
      const presetArgs = claudeRunPresetArgs(forkPreset);
      // Switching presets changes the model, never the saved session effort.
      forkResumeArgs[forkResumeArgs.indexOf("--model") + 1] = presetArgs[presetArgs.indexOf("--model") + 1];
    }
    const selected = requestedAccountLabel
      ? { label: requestedAccountLabel }
      : await selectAutomaticClaudeAccount(context, {
          preset: forkPreset,
          excludeLabels: [session.account],
          requireLive: unavailableReason === "requires login",
        });
    if (!selected) {
      if (requestedSwitchPreset) {
        throw new Error(
          `No other unlocked Claude account with usage left is available for --switch-account ${forkPreset}.`,
        );
      }
      throw new Error(
        `Claude label=${session.account} ${unavailableReason === "busy" ? "is busy" : "requires login"} and no other unlocked Claude account with usage left is available.`,
      );
    }
    const forkName = buildManagedClaudeSessionForkName(session);
    const forkReason = requestedAccountLabel
      ? `Switching session from ${session.account} to ${selected.label}`
        + (requestedSwitchPreset ? ` using ${forkPreset}` : "")
      : requestedSwitchPreset
        ? `Switching session from ${session.account} to ${selected.label} using ${forkPreset}`
        : `${session.account} ${unavailableReason === "busy" ? "is busy" : "requires login"}; forking session onto ${selected.label}`;
    stdout.write(`${forkReason} as "${forkName}".\n`);
    await handleRedisClaudeRun({
      ...context,
      positional: ["claude", "run", selected.label],
      opts: {
        ...opts,
        afterDoubleDash: [
          ...forkResumeArgs,
          "--resume",
          session.threadId,
          "--fork-session",
          "--name",
          forkName,
        ],
      },
    }, {
      launchCwd: session.cwd,
      sessionFork: session,
      allowOffline: Boolean(requestedAccountLabel),
    });
    return;
  }
  if (subcmd === "run") {
    if (positional.length > 3) {
      throw new Error(
        `Unknown Claude run preset: ${positional[3]}. Use opus, fable, sonnet, or -- <claude args...>.`,
      );
    }
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude run\` requires Redis. Run \`aim redis configure --url '${AIMGR_REDIS_PRIMARY_URL}' --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    if (opts.claudeAutoSelect === true) {
      const selected = await selectAutomaticClaudeAccount(context, {
        preset: opts.claudeAutoSelectPreset,
      });
      if (!selected) {
        throw new Error(
          "No unlocked Claude account with usage left is available.",
        );
      }
      await handleRedisClaudeRun({
        ...context,
        positional: ["claude", "run", selected.label],
      }, { allowOffline: false });
      return;
    }
    await handleRedisClaudeRun(context);
    return;
  }
  if (subcmd === "status" || subcmd === "usage") {
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude ${subcmd}\` requires Redis. Run \`aim redis configure --url '${AIMGR_REDIS_PRIMARY_URL}' --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const selectedLabels = positional.slice(2);
    const result = await collectClaudeRedisAccountUsageStatus({
      homeDir,
      selectedLabels,
      fresh: opts.fresh === true,
      nowMs,
      fetchJsonWithTimeoutImpl,
      connectRedisStoreImpl,
      readClaudeEnvironmentImpl:context.readClaudeEnvironmentImpl,
    });
    stdout.write(
      opts.json
        ? `${JSON.stringify(result, null, 2)}\n`
        : renderClaudeRedisAccountUsageStatus(result, { verbose: opts.verbose === true }),
    );
    if (result.ok !== true) {
      setExitCode(1);
    }
    return;
  }
  if (subcmd === "memory") {
    if (positional.length > 2) {
      throw new Error("`aim claude memory` does not accept positional arguments.");
    }
    const fold = foldManagedClaudeMemories({ userHomeDir: homeDir });
    stdout.write(renderClaudeSharedMemoryReport({
      summary: summarizeClaudeSharedMemory({ userHomeDir: homeDir }),
      fold,
    }));
    return;
  }
  if (subcmd === "inventory") {
    if (positional.length > 2) {
      throw new Error("`aim claude inventory` does not accept positional arguments.");
    }
    if (opts.fresh === true) {
      throw new Error("`aim claude inventory` is always offline and does not accept --fresh.");
    }
    if (!isRedisConfigured({ homeDir })) {
      throw new Error(`\`aim claude inventory\` requires Redis. Run \`aim redis configure --url '${AIMGR_REDIS_PRIMARY_URL}' --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
    }
    const result = await collectClaudeRedisAccountInventory({
      homeDir,
      nowMs,
      connectRedisStoreImpl,
      readClaudeEnvironmentImpl:context.readClaudeEnvironmentImpl,
    });
    stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n` : renderClaudeRedisAccountInventory(result));
    if (result.ok !== true) {
      setExitCode(1);
    }
    return;
  }
  throw new Error(`Unsupported claude subcommand: ${subcmd}. Use login, logout, list, resume, inventory, status, usage, run, memory, or privacy.`);
}
