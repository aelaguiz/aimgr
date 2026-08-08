import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { readHeldRedisCredentialLeaseLabels } from "../../coordination/redis-credential-lease.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
  writeRedisLocalStateFromView,
} from "../../coordination/runtime.js";
import { findCredentialRecord } from "../../coordination/snapshot.js";
import {
  buildHarnessIdentityFingerprint,
  inspectHarnessCredentialRecord,
} from "../../credentials/harness-access.js";
import { loadLocalState, writeLocalState } from "../../state/local-state.js";
import { selectLeastUsedUnlockedClaudeAccount } from "../../status/claude-redis-view.js";
import {
  buildHarnessExternalDescriptor,
  HARNESS_MANAGED_PROVIDERS,
  installHarnessProvider,
  readHarnessTargetStatus,
  uninstallHarnessProvider,
} from "../../targets/harness-auth.js";
import {
  clearLegacyPiProjectionReceipt,
  createPiTargetAdapter,
  isRecognizedAimLegacyPiProjection,
  selectNextBestPiCodexLabel,
} from "../../targets/pi-cli.js";
import { createPrimeTargetAdapter } from "../../targets/prime-agent.js";

function adapterFor(targetId, options) {
  return targetId === "pi" ? createPiTargetAdapter(options) : createPrimeTargetAdapter(options);
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
  throw new Error("--provider must be openai-codex, codex, anthropic, or claude.");
}

async function selectClaudePreset({ runtime, preset, usageByProvider }) {
  const records = (runtime.snapshot?.credentials ?? [])
    .filter((record) => record.provider === ANTHROPIC_PROVIDER);
  const held = await readHeldRedisCredentialLeaseLabels(runtime.store, {
    provider: ANTHROPIC_PROVIDER,
    labels: records.map((record) => record.label),
  });
  const accounts = records.map((record) => {
    const usage = usageByProvider?.[ANTHROPIC_PROVIDER]?.[record.label];
    let readable = false;
    try {
      inspectHarnessCredentialRecord(record);
      readable = usage?.ok === true;
    } catch {
      readable = false;
    }
    return {
      label: record.label,
      authState: readable ? "usage_readable" : "unavailable",
      locked: held.has(record.label),
      usage,
    };
  });
  const selected = selectLeastUsedUnlockedClaudeAccount({ accounts }, { preset });
  if (!selected) throw new Error(`No eligible unlocked Claude account is available for ${preset}.`);
  return selected.label;
}

async function resolveUseSelections({
  context,
  runtime,
  targetId,
  targetState,
}) {
  const { opts, probeUsageSnapshotsByProviderImpl } = context;
  const bareUse = opts.codex === undefined && opts.claude === undefined;
  const codexSelection = bareUse ? "auto" : opts.codex;
  const claudeSelection = opts.claude;
  const needsUsage = codexSelection === "auto"
    || claudeSelection === "fable"
    || claudeSelection === "opus";
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
        const currentLabel = typeof targetState?.providers?.[OPENAI_CODEX_PROVIDER]?.binding === "string"
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
      const label = claudeSelection === "fable" || claudeSelection === "opus"
        ? await selectClaudePreset({ runtime, preset: claudeSelection, usageByProvider })
        : normalizeLabel(claudeSelection);
      selections.push({
        provider: ANTHROPIC_PROVIDER,
        record: exactRecord(runtime.snapshot, ANTHROPIC_PROVIDER, label),
      });
    }
  }
  return { blocked: false, selections };
}

async function handleUse(context, targetId, { emitReceipt = true } = {}) {
  const { homeDir, env, stdout, setExitCode, connectRedisStoreImpl } = context;
  if (targetId !== "prime" && context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} use\` does not accept a label; use --codex or --claude.`);
  }
  const shorthand = targetId === "prime"
    ? String(context.positional[2] ?? "").trim().toLowerCase()
    : "";
  if (context.positional.length > 3 || (shorthand && shorthand !== "codex" && shorthand !== "claude")) {
    throw new Error("Usage: aim prime use codex | aim prime use claude");
  }
  if (shorthand && (context.opts.codex !== undefined || context.opts.claude !== undefined)) {
    throw new Error(`Do not combine \`aim ${targetId} use ${shorthand}\` with --codex or --claude.`);
  }
  const opts = shorthand === "codex"
    ? { ...context.opts, codex: "auto", claude: "off" }
    : shorthand === "claude"
      ? { ...context.opts, codex: "off", claude: "fable" }
      : context.opts;
  const effectiveContext = opts === context.opts ? context : { ...context, opts };
  if (opts.provider !== undefined) {
    throw new Error(`\`aim ${targetId} use\` does not accept --provider.`);
  }
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const adapter = adapterFor(targetId, { state: runtime.state, homeDir, env });
    const persistTargetState = async () => writeRedisLocalStateFromView({
      homeDir,
      state: runtime.state,
      localState: runtime.localState,
    });
    adapter.targetState.agentDir = adapter.agentDir;
    const resolved = await resolveUseSelections({
      context: effectiveContext,
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
      adapter.targetState.lastSelectionReceipt = receipt;
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      if (emitReceipt) stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, receipt }), null, 2)}\n`);
      setExitCode(1);
      return { ok: false, receipt };
    }

    const changes = [];
    for (const selection of resolved.selections) {
      if (selection.off) {
        changes.push(await uninstallHarnessProvider({
          targetId,
          targetState: adapter.targetState,
          authPath: adapter.authPath,
          provider: selection.provider,
          persistTargetState,
        }));
        writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
        continue;
      }
      const inspection = inspectHarnessCredentialRecord(selection.record, { nowMs: context.nowMs });
      const descriptor = buildHarnessExternalDescriptor({
        executable: context.aimExecutable,
        binding: selection.record.label,
        expectedIdentityFingerprint: buildHarnessIdentityFingerprint(selection.record),
      });
      changes.push(await installHarnessProvider({
        targetId,
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        homeDir,
        provider: selection.provider,
        descriptor,
        replaceNativeAuth: opts.replaceNativeAuth,
        persistTargetState,
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
      if (inspection.due) changes[changes.length - 1] = {
        ...changes[changes.length - 1],
        credentialMaintenanceDue: true,
      };
      if (targetId === "pi" && selection.provider === OPENAI_CODEX_PROVIDER) {
        clearLegacyPiProjectionReceipt(adapter.targetState);
      }
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    }
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
    adapter.targetState.lastSelectionReceipt = receipt;
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    if (emitReceipt) stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, receipt }), null, 2)}\n`);
    return { ok: true, receipt };
  } finally {
    await closeRedisRuntime(runtime);
  }
}

function resolvePrimeLauncher({ homeDir, fsImpl = fs } = {}) {
  const launcher = path.join(homeDir, "workspace", "prime-agent", "prime-agent.sh");
  try {
    const resolved = fsImpl.realpathSync(launcher);
    if (!fsImpl.statSync(resolved).isFile()) throw new Error("not a file");
    fsImpl.accessSync(resolved, fs.constants.X_OK);
    return resolved;
  } catch {
    throw new Error(`Prime Agent launcher is unavailable at ${launcher}.`);
  }
}

function launchPrimeAgent({ command, args, cwd, env, spawnImpl = spawnSync } = {}) {
  return spawnImpl(command, args, {
    cwd,
    env,
    shell: false,
    stdio: "inherit",
  });
}

async function handleRun(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports the run command.");
  if (context.positional.length !== 3) {
    throw new Error("Usage: aim prime run codex | aim prime run claude");
  }
  if (context.opts.afterDoubleDash?.length) {
    throw new Error("`aim prime run` does not accept additional Prime arguments.");
  }
  const flavor = String(context.positional[2] ?? "").trim().toLowerCase();
  const profile = flavor === "codex"
    ? { provider: OPENAI_CODEX_PROVIDER, model: "gpt-5.6-sol" }
    : flavor === "claude"
      ? { provider: ANTHROPIC_PROVIDER, model: "claude-fable-5" }
      : null;
  if (!profile) throw new Error("Usage: aim prime run codex | aim prime run claude");

  const selected = await handleUse({
    ...context,
    opts: { ...context.opts, replaceNativeAuth: true },
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
  const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
  const launchPrimeAgentImpl = context.launchPrimeAgentImpl ?? launchPrimeAgent;
  const result = launchPrimeAgentImpl({
    command: resolvePrimeLauncherImpl({ homeDir: context.homeDir }),
    args: ["--dist", "--provider", profile.provider, "--model", profile.model],
    cwd: context.cwd ?? process.cwd(),
    env: context.env,
  });
  if (result?.error) throw new Error("Could not start the local Prime Agent launcher.");
  if (result?.status !== 0) {
    context.setExitCode(Number.isInteger(result?.status) ? result.status : 1);
  }
}

async function handleUninstall(context, targetId) {
  const { homeDir, env, stdout, opts } = context;
  const writeLocalStateImpl = context.writeLocalStateImpl ?? writeLocalState;
  if (context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} uninstall\` does not accept positional arguments.`);
  }
  const localState = loadLocalState({ homeDir });
  const adapter = adapterFor(targetId, { state: localState, homeDir, env });
  const persistTargetState = async () => writeLocalStateImpl({ homeDir, localState });
  const changes = [];
  for (const provider of normalizeUninstallProviders(opts.provider)) {
    changes.push(await uninstallHarnessProvider({
      targetId,
      targetState: adapter.targetState,
      authPath: adapter.authPath,
      provider,
      persistTargetState,
    }));
  }
  adapter.targetState.lastUninstallReceipt = {
    action: `${targetId}_uninstall`,
    status: changes.some((change) => change.wrote) ? "updated" : "noop",
    authPath: adapter.authPath,
    resolvedAuthPath: adapter.resolvedAuthPath,
    pathConflict: adapter.pathConflict,
    effect: "after_active_workers_stop",
    providers: changes.map(({ provider, status, backupPath }) => ({ provider, status, backupPath })),
  };
  await writeLocalStateImpl({ homeDir, localState });
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, receipt: adapter.targetState.lastUninstallReceipt }), null, 2)}\n`);
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
  const supported = targetId === "prime" ? "use, run, status, uninstall" : "use, status, uninstall";
  if (!subcmd) {
    throw new Error(`Missing ${targetId} subcommand. Supported: ${supported}.`);
  }
  if (subcmd === "use") return handleUse(context, targetId);
  if (subcmd === "run" && targetId === "prime") return handleRun(context, targetId);
  if (subcmd === "status") return handleTargetStatus(context, targetId);
  if (subcmd === "uninstall") return handleUninstall(context, targetId);
  throw new Error(`Unsupported ${targetId} subcommand: ${subcmd} (supported: ${supported}).`);
}
