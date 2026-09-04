import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {

  ANTHROPIC_PROVIDER,
  DEFAULT_CLAUDE_FABLE_MODEL,
  OPENAI_CODEX_PROVIDER,
  XAI_PROVIDER,
} from "../../core/constants.js";
import { resolveManagedPrimeAgentDir } from "../../io/paths.js";
import { readPrimeSessionProfile } from "../../targets/prime-sessions.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
  writeRedisLocalStateFromView,
} from "../../coordination/runtime.js";
import { REDIS_CONNECTION_POLICY_LEASED } from "../../coordination/redis-store.js";
import { findCredentialRecord } from "../../coordination/snapshot.js";
import {
  buildHarnessIdentityFingerprint,
  inspectHarnessCredentialRecord,
} from "../../credentials/harness-access.js";
import { loadLocalState, writeLocalState } from "../../state/local-state.js";
import { buildRecentSelectionCycleAvoidLabels } from "../../pool/history.js";
import {
  collectClaudeRedisAccountUsageStatus,
  selectLeastUsedUnlockedClaudeAccount,
} from "../../status/claude-redis-view.js";
import {
  buildHarnessExternalDescriptor,
  HARNESS_MANAGED_PROVIDERS,
  installHarnessProvider,
  isAimHarnessExternalDescriptor,
  readHarnessTargetStatus,
  uninstallHarnessProvider,
} from "../../targets/harness-auth.js";
import {
  clearLegacyPiProjectionReceipt,
  createPiTargetAdapter,
  isRecognizedAimLegacyPiProjection,
  selectNextBestPiCodexLabel,
} from "../../targets/pi-cli.js";
import { ensureHarnessSessionIdentityExtension } from "../../targets/harness-session-identity.js";
import { createPrimeTargetAdapter } from "../../targets/prime-agent.js";
import { preparePrimeInvocation, resolvePrimeLauncher } from "../../targets/prime-launcher.js";


const DEFAULT_CODEX_MODEL = "gpt-5.6-sol";
function adapterFor(targetId, options) {
  return targetId === "pi" ? createPiTargetAdapter(options) : createPrimeTargetAdapter(options);
}

function readInstalledAimBinding(authPath, provider) {
  try {
    if (!fs.existsSync(authPath)) return null;
    const stat = fs.lstatSync(authPath);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const entry = auth && typeof auth === "object" && !Array.isArray(auth) ? auth[provider] : null;
    return isAimHarnessExternalDescriptor(entry) ? entry.binding : null;
  } catch {
    return null;
  }
}

function exactRecord(snapshot, provider, label) {
  const normalizedLabel = normalizeLabel(label);
  const record = findCredentialRecord(snapshot, { provider, label: normalizedLabel });
  if (record) return record;
  const other = (snapshot?.credentials ?? []).find((entry) => entry.label === normalizedLabel);
  if (other) throw new Error(`Label=${normalizedLabel} belongs to provider=${other.provider}, not ${provider}.`);
  throw new Error(`Unknown ${provider} label=${normalizedLabel}.`);
}

function normalizeUninstallProviders(raw) {
  const value = String(raw ?? "").trim().toLowerCase();
  if (!value) return HARNESS_MANAGED_PROVIDERS;
  if (value === "codex" || value === OPENAI_CODEX_PROVIDER) return [OPENAI_CODEX_PROVIDER];
  if (value === "claude" || value === ANTHROPIC_PROVIDER) return [ANTHROPIC_PROVIDER];
  if (value === "grok" || value === XAI_PROVIDER) return [XAI_PROVIDER];
  throw new Error("--provider must be openai-codex, codex, anthropic, claude, xai, or grok.");
}

function selectReadyXaiLabel(snapshot, { currentLabel = null, avoidCurrentLabel = false } = {}) {
  const labels = (snapshot?.credentials ?? [])
    .filter((record) => (
      record.provider === XAI_PROVIDER
      && record.health?.status === "ready"
      && record.policy?.pool?.enabled !== false
      && record.policy?.reauth?.blockedReason !== "oauth_reauth_required"
    ))
    .map((record) => record.label)
    .sort();
  if (avoidCurrentLabel && currentLabel) {
    const alternate = labels.find((label) => label !== currentLabel);
    if (alternate) return alternate;
  }
  return labels[0] ?? null;
}

async function selectClaudePreset({
  runtime,
  preset,
  homeDir,
  nowMs,
  fetchJsonWithTimeoutImpl,
  collectClaudeRedisAccountUsageStatusImpl = collectClaudeRedisAccountUsageStatus,
  excludeLabel = null,
  recentLabels = [],
}) {
  const records = (runtime.snapshot?.credentials ?? [])
    .filter((record) => record.provider === ANTHROPIC_PROVIDER);
  const usageStatus = await collectClaudeRedisAccountUsageStatusImpl({
    homeDir,
    records,
    redisStore: runtime.store,
    fresh: false,
    nowMs,
    fetchJsonWithTimeoutImpl,
  });
  const accounts = usageStatus.accounts;
  const selectableLabels = accounts
    .filter((account) => selectLeastUsedUnlockedClaudeAccount({ accounts: [account] }, { preset }))
    .map((account) => account.label);
  const cycleAvoid = buildRecentSelectionCycleAvoidLabels({
    selectableLabels,
    sourceLabel: excludeLabel,
    recentLabels,
  });
  const withoutSource = accounts.filter((account) => account.label !== excludeLabel);
  const preferred = withoutSource.filter((account) => !cycleAvoid.has(account.label));
  const selected = selectLeastUsedUnlockedClaudeAccount({ accounts: preferred }, { preset })
    ?? selectLeastUsedUnlockedClaudeAccount({ accounts: withoutSource }, { preset })
    ?? selectLeastUsedUnlockedClaudeAccount({ accounts }, { preset });
  return selected?.label ?? null;
}

async function resolveUseSelections({
  context,
  runtime,
  targetId,
  targetState,
}) {
  const { opts, probeUsageSnapshotsByProviderImpl } = context;
  const bareUse = opts.codex === undefined && opts.claude === undefined && opts.grok === undefined;
  const codexSelection = bareUse ? "auto" : opts.codex;
  const claudeSelection = opts.claude;
  const grokSelection = opts.grok;
  // Claude selection owns a bounded, cache-aware status path. The generic
  // provider probe fans out across every account and can turn provider
  // throttling into a false `no_alternate_account` result.
  const needsUsage = codexSelection === "auto";
  const usageByProvider = needsUsage
    ? await probeUsageSnapshotsByProviderImpl(runtime.state, { env: context.env })
    : null;
  const selections = [];

  if (codexSelection !== undefined) {
    if (codexSelection === "off") {
      selections.push({ provider: OPENAI_CODEX_PROVIDER, off: true });
    } else {
      let label;
      let selectionMeta = null;
      if (codexSelection === "auto") {
        const currentLabel = context.currentCodexLabel !== undefined
          ? context.currentCodexLabel
          : typeof targetState?.providers?.[OPENAI_CODEX_PROVIDER]?.binding === "string"
            ? targetState.providers[OPENAI_CODEX_PROVIDER].binding
            : null;
        const selected = await selectNextBestPiCodexLabel({
          state: runtime.state,
          homeDir: context.homeDir,
          usageByProvider,
          currentLabel,
          avoidCurrentLabel: context.avoidCurrentSelection === true,
        });
        if (!selected.selection) {
          return { blocked: true, selections: [], reason: "no_eligible_account" };
        }
        label = selected.selection.label;
        if (context.requireDifferentSelection === true && currentLabel && label === currentLabel) {
          return { blocked: true, selections: [], reason: "no_alternate_account" };
        }
        selectionMeta = selected.selection;
      } else {
        label = normalizeLabel(codexSelection);
      }
      selections.push({
        provider: OPENAI_CODEX_PROVIDER,
        record: exactRecord(runtime.snapshot, OPENAI_CODEX_PROVIDER, label),
        selectionMeta,
      });
    }
  }

  if (claudeSelection !== undefined) {
    if (claudeSelection === "off") {
      selections.push({ provider: ANTHROPIC_PROVIDER, off: true });
    } else {
      const currentLabel = context.currentClaudeLabel !== undefined
        ? context.currentClaudeLabel
        : typeof targetState?.providers?.[ANTHROPIC_PROVIDER]?.binding === "string"
          ? targetState.providers[ANTHROPIC_PROVIDER].binding
          : null;
      const isPreset = claudeSelection === "fable" || claudeSelection === "opus";
      const label = isPreset
        ? await selectClaudePreset({
            runtime,
            preset: claudeSelection,
            homeDir: context.homeDir,
            nowMs: context.nowMs,
            fetchJsonWithTimeoutImpl: context.fetchJsonWithTimeoutImpl,
            collectClaudeRedisAccountUsageStatusImpl:
              context.collectClaudeRedisAccountUsageStatusImpl,
            excludeLabel: context.avoidCurrentSelection === true ? currentLabel : null,
            recentLabels: context.primeRotationRecentLabels,
          })
        : normalizeLabel(claudeSelection);
      if (!label) {
        if (context.requireDifferentSelection === true && currentLabel) {
          return { blocked: true, selections: [], reason: "no_alternate_account" };
        }
        throw new Error(`No eligible unlocked Claude account is available for ${claudeSelection}.`);
      }
      if (context.requireDifferentSelection === true && currentLabel && label === currentLabel) {
        return { blocked: true, selections: [], reason: "no_alternate_account" };
      }
      selections.push({
        provider: ANTHROPIC_PROVIDER,
        record: exactRecord(runtime.snapshot, ANTHROPIC_PROVIDER, label),
      });
    }
  }

  if (grokSelection !== undefined) {
    if (grokSelection === "off") {
      selections.push({ provider: XAI_PROVIDER, off: true });
    } else {
      const currentLabel = context.currentGrokLabel !== undefined
        ? context.currentGrokLabel
        : typeof targetState?.providers?.[XAI_PROVIDER]?.binding === "string"
          ? targetState.providers[XAI_PROVIDER].binding
          : null;
      const label = grokSelection === "auto"
        ? selectReadyXaiLabel(runtime.snapshot, {
            currentLabel,
            avoidCurrentLabel: context.avoidCurrentSelection === true,
          })
        : normalizeLabel(grokSelection);
      if (!label) {
        return { blocked: true, selections: [], reason: "no_eligible_account" };
      }
      if (context.requireDifferentSelection === true && currentLabel && label === currentLabel) {
        return { blocked: true, selections: [], reason: "no_alternate_account" };
      }
      selections.push({
        provider: XAI_PROVIDER,
        record: exactRecord(runtime.snapshot, XAI_PROVIDER, label),
      });
    }
  }
  return { blocked: false, selections };
}

async function handleUse(context, targetId, { emitReceipt = true } = {}) {
  const { homeDir, env, stdout, setExitCode, connectRedisStoreImpl } = context;
  if (targetId !== "prime" && context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} use\` does not accept a label; use --codex, --claude, or --grok.`);
  }
  const shorthand = targetId === "prime"
    ? String(context.positional[2] ?? "").trim().toLowerCase()
    : "";
  if (context.positional.length > 3 || (shorthand && shorthand !== "codex" && shorthand !== "claude" && shorthand !== "grok")) {
    throw new Error("Usage: aim prime use codex | aim prime use claude | aim prime use grok");
  }
  if (shorthand && (context.opts.codex !== undefined || context.opts.claude !== undefined || context.opts.grok !== undefined)) {
    throw new Error(`Do not combine \`aim ${targetId} use ${shorthand}\` with --codex, --claude, or --grok.`);
  }
  const opts = shorthand === "codex"
    ? { ...context.opts, codex: "auto" }
    : shorthand === "claude"
      ? { ...context.opts, claude: "fable" }
      : shorthand === "grok"
        ? { ...context.opts, grok: "auto" }
        : context.opts;
  const effectiveContext = opts === context.opts ? context : { ...context, opts };
  if (opts.provider !== undefined) {
    throw new Error(`\`aim ${targetId} use\` does not accept --provider.`);
  }
  // Account selection performs provider usage probes before its final live
  // lease read. Keep Redis connected across that external I/O instead of
  // letting the one-shot socket expire while it is idle.
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl,
    connectionPolicy: REDIS_CONNECTION_POLICY_LEASED,
  });
  try {
    const adapter = adapterFor(targetId, { state: runtime.state, homeDir, env });
    const installedCodexLabel = readInstalledAimBinding(adapter.authPath, OPENAI_CODEX_PROVIDER);
    const installedClaudeLabel = readInstalledAimBinding(adapter.authPath, ANTHROPIC_PROVIDER);
    const installedGrokLabel = readInstalledAimBinding(adapter.authPath, XAI_PROVIDER);
    const selectionContext = { ...effectiveContext };
    if (selectionContext.currentCodexLabel === undefined) {
      selectionContext.currentCodexLabel = installedCodexLabel;
    }
    if (selectionContext.currentClaudeLabel === undefined) {
      selectionContext.currentClaudeLabel = installedClaudeLabel;
    }
    if (selectionContext.currentGrokLabel === undefined) {
      selectionContext.currentGrokLabel = installedGrokLabel;
    }
    const resolved = await resolveUseSelections({
      context: selectionContext,
      runtime,
      targetId,
      targetState: adapter.targetState,
    });
    if (resolved.blocked) {
      const receipt = {
        action: `${targetId}_use`,
        status: "blocked",
        reason: resolved.reason,
        authPath: adapter.authPath,
        resolvedAuthPath: adapter.resolvedAuthPath,
        pathConflict: adapter.pathConflict,
        effect: "new_root_sessions",
        secretsCopiedToTarget: false,
      };
      if (emitReceipt) stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, receipt }), null, 2)}\n`);
      setExitCode(1);
      return { ok: false, receipt };
    }

    const ensureSessionIdentityImpl = context.ensureHarnessSessionIdentityExtensionImpl
      ?? ensureHarnessSessionIdentityExtension;
    ensureSessionIdentityImpl({ agentDir: adapter.agentDir });

    const preparedSelections = resolved.selections.map((selection) => {
      if (selection.off) return selection;
      return {
        ...selection,
        inspection: inspectHarnessCredentialRecord(selection.record, { nowMs: context.nowMs }),
        descriptor: buildHarnessExternalDescriptor({
          executable: context.aimExecutable,
          binding: selection.record.label,
          expectedIdentityFingerprint: buildHarnessIdentityFingerprint(selection.record),
        }),
      };
    });
    const changes = [];
    for (const selection of preparedSelections) {
      if (selection.off) {
        changes.push(await uninstallHarnessProvider({
          targetId,
          targetState: adapter.targetState,
          authPath: adapter.authPath,
          homeDir,
          provider: selection.provider,
        }));
        continue;
      }
      changes.push(await installHarnessProvider({
        targetId,
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        homeDir,
        provider: selection.provider,
        descriptor: selection.descriptor,
        recognizeLegacyEntry: targetId === "pi" && selection.provider === OPENAI_CODEX_PROVIDER
          ? (entry) => {
              const legacyLabel = typeof adapter.targetState.activeLabel === "string"
                ? adapter.targetState.activeLabel
                : "";
              const legacyRecord = legacyLabel
                ? findCredentialRecord(runtime.snapshot, {
                    provider: OPENAI_CODEX_PROVIDER,
                    label: legacyLabel,
                  })
                : null;
              return isRecognizedAimLegacyPiProjection({
                entry,
                targetState: adapter.targetState,
                record: legacyRecord,
              });
            }
          : undefined,
      }));
      if (selection.inspection.due) changes[changes.length - 1] = {
        ...changes[changes.length - 1],
        credentialMaintenanceDue: true,
      };
      if (targetId === "pi" && selection.provider === OPENAI_CODEX_PROVIDER) {
        clearLegacyPiProjectionReceipt(adapter.targetState);
      }
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    const receipt = {
      action: `${targetId}_use`,
      status: changes.some((change) => change.wrote) ? "updated" : "noop",
      authPath: adapter.authPath,
      resolvedAuthPath: adapter.resolvedAuthPath,
      pathConflict: adapter.pathConflict,
      effect: "new_root_sessions",
      secretsCopiedToTarget: false,
      providers: changes.map((change) => ({
        provider: change.provider,
        binding: change.binding ?? null,
        status: change.status ?? (change.wrote ? "installed" : "unchanged"),
        migratedLegacy: change.migratedLegacy === true,
        displacedNative: change.displacedNative === true,
        backupPath: change.backupPath ?? null,
        credentialMaintenanceDue: change.credentialMaintenanceDue === true,
      })),
    };
    if (emitReceipt) stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, receipt }), null, 2)}\n`);
    return { ok: true, receipt };
  } finally {
    await closeRedisRuntime(runtime);
  }
}

function launchPrimeAgent({ command, args, cwd, env, stdio = "inherit", spawnImpl = spawnSync } = {}) {
  return spawnImpl(command, args, {
    cwd,
    env,
    shell: false,
    stdio,
  });
}

function runPrimeLauncher(context, args, { ensureSessionIdentity = true, stdio = "inherit" } = {}) {
  const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
  const launchPrimeAgentImpl = context.launchPrimeAgentImpl ?? launchPrimeAgent;
  const ensureSessionIdentityImpl = context.ensureHarnessSessionIdentityExtensionImpl
    ?? ensureHarnessSessionIdentityExtension;
  if (ensureSessionIdentity) {
    ensureSessionIdentityImpl({
      agentDir: resolveManagedPrimeAgentDir({ homeDir: context.homeDir, env: context.env }),
    });
  }
  const invocation = preparePrimeInvocation({
    command: resolvePrimeLauncherImpl({ homeDir: context.homeDir, env: context.env }),
    args,
  });
  const cwd = context.cwd ?? process.cwd();
  const result = launchPrimeAgentImpl({
    ...invocation,
    cwd,
    env: context.env,
    stdio,
  });
  if (result?.error) throw new Error("Could not start the local Prime Agent launcher.");
  if (result?.status !== 0) {
    context.setExitCode(Number.isInteger(result?.status) ? result.status : 1);
    return false;
  }
  return true;
}

function claudePresetForModel(model) {
  const normalized = String(model).toLowerCase();
  if (normalized.includes("fable") || normalized.includes("sonnet")) return "fable";
  if (normalized.includes("opus")) return "opus";
  throw new Error(`AIM cannot automatically rotate unsupported Claude model=${model}.`);
}

async function selectPrimeRotation(context, profile) {
  const runtime = await loadRedisRuntime({
    homeDir: context.homeDir,
    connectRedisStoreImpl: context.connectRedisStoreImpl,
    // Rotation performs the same slow usage probes followed by a live lease
    // read as `prime use`; keep this command-owned Redis client usable across
    // that idle interval too.
    connectionPolicy: REDIS_CONNECTION_POLICY_LEASED,
  });
  try {
    const selectionOpts = profile.provider === OPENAI_CODEX_PROVIDER
      ? { codex: "auto" }
      : profile.provider === ANTHROPIC_PROVIDER
        ? { claude: claudePresetForModel(profile.model) }
        : { grok: "auto" };
    const resolved = await resolveUseSelections({
      context: {
        ...context,
        opts: selectionOpts,
        avoidCurrentSelection: true,
        requireDifferentSelection: true,
        currentCodexLabel: profile.provider === OPENAI_CODEX_PROVIDER ? profile.binding : undefined,
        currentClaudeLabel: profile.provider === ANTHROPIC_PROVIDER ? profile.binding : undefined,
        currentGrokLabel: profile.provider === XAI_PROVIDER ? profile.binding : undefined,
        primeRotationRecentLabels:
          profile.provider === ANTHROPIC_PROVIDER ? profile.bindingHistory : undefined,
      },
      runtime,
      targetId: "prime",
      targetState: null,
    });
    if (resolved.blocked) {
      context.stdout.write(`AIM Prime could not rotate accounts: ${resolved.reason}\n`);
      context.setExitCode(1);
      return null;
    }
    const selection = resolved.selections.find((candidate) => (
      candidate.provider === profile.provider && candidate.record
    ));
    if (!selection?.record) {
      throw new Error(`AIM did not select a ${profile.provider} account.`);
    }
    const inspection = inspectHarnessCredentialRecord(selection.record, { nowMs: context.nowMs });
    return {
      binding: selection.record.label,
      identityFingerprint: inspection.identityFingerprint,
    };
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleResume(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports the resume command.");
  if (context.positional.length !== 3) {
    throw new Error("Usage: aim prime resume <path-or-id> [--rotate]");
  }
  if (context.opts.afterDoubleDash?.length) {
    throw new Error("`aim prime resume` does not accept additional Prime arguments.");
  }
  const selector = String(context.positional[2] ?? "").trim();
  if (!selector) throw new Error("Usage: aim prime resume <path-or-id> [--rotate]");

  if (context.opts.primeResumeRotate !== true) {
    runPrimeLauncher(context, ["--resume", selector]);
    return;
  }

  const profile = readPrimeSessionProfile({
    selector,
    homeDir: context.homeDir,
    env: context.env,
    cwd: context.cwd,
  });
  const requested = await selectPrimeRotation(context, profile);
  if (!requested) return;

  const handedOff = runPrimeLauncher(context, [
    "__aim-handoff-credential",
    profile.sessionId,
    profile.provider,
    profile.model,
    profile.binding,
    profile.identityFingerprint,
    requested.binding,
    requested.identityFingerprint,
    "--json",
  ], {
    ensureSessionIdentity: false,
    stdio: ["ignore", "ignore", "inherit"],
  });
  if (!handedOff) return;

  context.stdout.write(`AIM Prime: ${profile.provider} · ${requested.binding} · live handoff complete\n`);
  runPrimeLauncher(context, ["--resume", selector]);
}

async function handleRun(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports the run command.");
  if (context.positional.length !== 3 && context.positional.length !== 4) {
    throw new Error("Usage: aim prime run codex [model] | aim prime run claude | aim prime run grok");
  }
  if (context.opts.afterDoubleDash?.length) {
    throw new Error("`aim prime run` does not accept additional Prime arguments.");
  }
  const flavor = String(context.positional[2] ?? "").trim().toLowerCase();
  // Optional exact model id, e.g. `aim prime run codex gpt-6-astra`.
  const requestedModel = String(context.positional[3] ?? "").trim();
  if (requestedModel && flavor !== "codex") {
    throw new Error("Usage: aim prime run codex [model] | aim prime run claude | aim prime run grok");
  }
  const profile = flavor === "codex"
    ? { provider: OPENAI_CODEX_PROVIDER, model: requestedModel || DEFAULT_CODEX_MODEL }
    : flavor === "claude"
      ? { provider: ANTHROPIC_PROVIDER, model: DEFAULT_CLAUDE_FABLE_MODEL }
      : flavor === "grok"
        ? { provider: XAI_PROVIDER, model: "grok-4.6" }
        : null;
  if (!profile) throw new Error("Usage: aim prime run codex [model] | aim prime run claude | aim prime run grok");

  const selected = await handleUse({
    ...context,
    opts: { ...context.opts },
    positional: [targetId, "use", flavor],
    avoidCurrentSelection: true,
  }, targetId, { emitReceipt: false });
  if (!selected?.ok) {
    context.stdout.write(`AIM Prime could not select an account: ${selected?.receipt?.reason ?? "unknown"}\n`);
    return;
  }
  const providerReceipt = selected.receipt.providers.find(
    (provider) => provider.provider === profile.provider && provider.binding,
  );
  if (!providerReceipt) throw new Error(`AIM did not select a ${flavor} account.`);

  context.stdout.write(`AIM Prime: ${profile.provider} · ${providerReceipt.binding}\n`);
  runPrimeLauncher(context, ["--provider", profile.provider, "--model", profile.model]);
}

async function handleUninstall(context, targetId) {
  const { homeDir, env, stdout, opts } = context;
  const writeLocalStateImpl = context.writeLocalStateImpl ?? writeLocalState;
  if (context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} uninstall\` does not accept positional arguments.`);
  }
  const localState = loadLocalState({ homeDir });
  const adapter = adapterFor(targetId, { state: localState, homeDir, env });
  const changes = [];
  for (const provider of normalizeUninstallProviders(opts.provider)) {
    changes.push(await uninstallHarnessProvider({
      targetId,
      targetState: adapter.targetState,
      authPath: adapter.authPath,
      homeDir,
      provider,
    }));
  }
  await writeLocalStateImpl({ homeDir, localState });
  const receipt = {
    action: `${targetId}_uninstall`,
    status: changes.some((change) => change.wrote) ? "updated" : "noop",
    authPath: adapter.authPath,
    resolvedAuthPath: adapter.resolvedAuthPath,
    pathConflict: adapter.pathConflict,
    effect: "after_active_workers_stop",
    providers: changes.map(({ provider, status, backupPath }) => ({ provider, status, backupPath })),
  };
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, receipt }), null, 2)}\n`);
}

async function handleTargetStatus(context, targetId) {
  const { homeDir, env, stdout, connectRedisStoreImpl } = context;
  if (context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} status\` does not accept positional arguments.`);
  }
  if (context.opts.provider !== undefined) {
    throw new Error(`\`aim ${targetId} status\` does not accept --provider.`);
  }
  const localState = loadLocalState({ homeDir });
  const adapter = adapterFor(targetId, { state: localState, homeDir, env });
  let runtime = null;
  let records = [];
  let redisConfigured = false;
  try {
    redisConfigured = isRedisConfigured({ homeDir });
  } catch {
    redisConfigured = true;
  }
  let coordination = redisConfigured ? "unavailable" : "not_configured";
  if (redisConfigured) {
    try {
      runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
      records = runtime.snapshot.credentials.filter((record) => {
        try {
          inspectHarnessCredentialRecord(record);
          return true;
        } catch {
          return false;
        }
      });
      coordination = "available";
    } catch {
      coordination = "unavailable";
    }
  }
  try {
    const status = readHarnessTargetStatus({
      targetId,
      targetState: adapter.targetState,
      authPath: adapter.authPath,
      homeDir,
      resolvedAuthPath: adapter.resolvedAuthPath,
      persistedAuthPath: adapter.persistedAuthPath,
      pathConflict: adapter.pathConflict,
      records,
      coordination,
      recognizeLegacyEntry: targetId === "pi"
        ? (provider, entry) => {
            if (provider !== OPENAI_CODEX_PROVIDER) return false;
            const legacyLabel = typeof adapter.targetState.activeLabel === "string"
              ? adapter.targetState.activeLabel
              : "";
            const record = legacyLabel
              ? findCredentialRecord(records.length > 0 ? { credentials: records } : null, {
                  provider: OPENAI_CODEX_PROVIDER,
                  label: legacyLabel,
                })
              : null;
            return isRecognizedAimLegacyPiProjection({
              entry,
              targetState: adapter.targetState,
              record,
            });
          }
        : undefined,
    });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, status }), null, 2)}\n`);
  } finally {
    if (runtime) await closeRedisRuntime(runtime);
  }
}

export async function handleHarnessTarget(context, targetId) {
  const subcmd = String(context.positional[1] ?? "").trim().toLowerCase();
  const supported = targetId === "prime" ? "use, run, resume, status, uninstall" : "use, status, uninstall";
  if (!subcmd) {
    throw new Error(`Missing ${targetId} subcommand. Supported: ${supported}.`);
  }
  if (subcmd === "use") return handleUse(context, targetId);
  if (subcmd === "run" && targetId === "prime") return handleRun(context, targetId);
  if (subcmd === "resume" && targetId === "prime") return handleResume(context, targetId);
  if (subcmd === "status") return handleTargetStatus(context, targetId);
  if (subcmd === "uninstall") return handleUninstall(context, targetId);
  throw new Error(`Unsupported ${targetId} subcommand: ${subcmd} (supported: ${supported}).`);
}
