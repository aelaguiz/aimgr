import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { expandHomeShorthandPath, resolveManagedPrimeAgentDir } from "../../io/paths.js";
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
import {
  appendAnthropicHistory,
  appendOpenaiCodexHistory,
  buildRecentSelectionCycleAvoidLabels,
} from "../../pool/history.js";
import { selectLeastUsedUnlockedClaudeAccount } from "../../status/claude-redis-view.js";
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
  throw new Error("--provider must be openai-codex, codex, anthropic, or claude.");
}

const PRIME_ROTATION_HISTORY_KIND = "prime_rotation";

function primeRotationHistoryLabels(state, provider) {
  const history = provider === OPENAI_CODEX_PROVIDER
    ? state?.pool?.openaiCodex?.history
    : state?.pool?.anthropic?.history;
  return (Array.isArray(history) ? history : [])
    .filter((entry) => (
      entry?.kind === PRIME_ROTATION_HISTORY_KIND
      && entry?.status === "selected"
      && typeof entry.label === "string"
    ))
    .flatMap((entry) => [
      ...(typeof entry.previousLabel === "string" ? [entry.previousLabel] : []),
      entry.label,
    ]);
}

function recordPrimeRotationSelection(state, {
  provider,
  label,
  previousLabel,
  observedAt,
}) {
  const append = provider === OPENAI_CODEX_PROVIDER
    ? appendOpenaiCodexHistory
    : appendAnthropicHistory;
  append(state, [{
    observedAt,
    kind: PRIME_ROTATION_HISTORY_KIND,
    status: "selected",
    label,
    ...(previousLabel && previousLabel !== label ? { previousLabel } : {}),
  }]);
}

async function selectClaudePreset({
  runtime,
  preset,
  usageByProvider,
  excludeLabel = null,
  recentRotationLabels = [],
}) {
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
  const selectableLabels = accounts
    .filter((account) => selectLeastUsedUnlockedClaudeAccount({ accounts: [account] }, { preset }))
    .map((account) => account.label);
  const cycleAvoid = buildRecentSelectionCycleAvoidLabels({
    selectableLabels,
    sourceLabel: excludeLabel,
    recentLabels: recentRotationLabels,
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
          recentRotationLabels: context.primeRotationRecentLabels ?? [],
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
            usageByProvider,
            excludeLabel: context.avoidCurrentSelection === true ? currentLabel : null,
            recentRotationLabels: context.primeRotationRecentLabels ?? [],
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
    const installedCodexLabel = readInstalledAimBinding(adapter.authPath, OPENAI_CODEX_PROVIDER);
    const installedClaudeLabel = readInstalledAimBinding(adapter.authPath, ANTHROPIC_PROVIDER);
    const selectionContext = { ...effectiveContext };
    if (selectionContext.currentCodexLabel === undefined) {
      selectionContext.currentCodexLabel = installedCodexLabel;
    }
    if (selectionContext.currentClaudeLabel === undefined) {
      selectionContext.currentClaudeLabel = installedClaudeLabel;
    }
    if (effectiveContext.primeRotationProvider) {
      const installedLabel = effectiveContext.primeRotationProvider === OPENAI_CODEX_PROVIDER
        ? installedCodexLabel
        : installedClaudeLabel;
      selectionContext.primeRotationRecentLabels = [
        ...primeRotationHistoryLabels(runtime.state, effectiveContext.primeRotationProvider),
        ...(installedLabel ? [installedLabel] : []),
      ];
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
    if (effectiveContext.primeRotationProvider) {
      const rotationChange = changes.find((change) => (
        change.provider === effectiveContext.primeRotationProvider
        && typeof change.binding === "string"
      ));
      if (rotationChange) {
        const observedAt = new Date(context.nowMs ?? Date.now()).toISOString();
        const installedLabel = rotationChange.provider === OPENAI_CODEX_PROVIDER
          ? installedCodexLabel
          : installedClaudeLabel;
        recordPrimeRotationSelection(runtime.state, {
          provider: rotationChange.provider,
          label: rotationChange.binding,
          previousLabel: installedLabel,
          observedAt,
        });
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

function inspectPrimeDefaultLauncherLane({ command, cwd, env, spawnSyncImpl = spawnSync }) {
  try {
    const result = spawnSyncImpl(command, ["status", "--json"], {
      cwd,
      env,
      shell: false,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1_024 * 1_024,
    });
    if (result?.status !== 0 || typeof result.stdout !== "string") return null;
    const daemons = JSON.parse(result.stdout);
    if (!Array.isArray(daemons)) return null;
    const current = daemons.find((daemon) => daemon?.isDefault === true && daemon?.status === "current");
    if (typeof current?.buildId !== "string") return null;
    return current.buildId.startsWith("dist-") ? "dist" : "source";
  } catch {
    return null;
  }
}

function runPrimeLauncher(context, args) {
  const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
  const launchPrimeAgentImpl = context.launchPrimeAgentImpl ?? launchPrimeAgent;
  const ensureSessionIdentityImpl = context.ensureHarnessSessionIdentityExtensionImpl
    ?? ensureHarnessSessionIdentityExtension;
  ensureSessionIdentityImpl({
    agentDir: resolveManagedPrimeAgentDir({ homeDir: context.homeDir, env: context.env }),
  });
  const command = resolvePrimeLauncherImpl({ homeDir: context.homeDir });
  const cwd = context.cwd ?? process.cwd();
  const inspectLaneImpl = context.inspectPrimeDefaultLauncherLaneImpl ?? inspectPrimeDefaultLauncherLane;
  const activeLane = inspectLaneImpl({ command, cwd, env: context.env });
  const baseArgs = args[0] === "--dist" ? args.slice(1) : args;
  const launchArgs = activeLane === "source" ? baseArgs : ["--dist", ...baseArgs];
  const result = launchPrimeAgentImpl({
    command,
    args: launchArgs,
    cwd,
    env: context.env,
  });
  if (result?.error) throw new Error("Could not start the local Prime Agent launcher.");
  if (result?.status !== 0) {
    context.setExitCode(Number.isInteger(result?.status) ? result.status : 1);
  }
}

function resolvePrimeSessionPath({ selector, homeDir, env = {}, cwd = process.cwd() }) {
  const looksLikePath = selector.includes("/") || selector.includes("\\") || selector.endsWith(".jsonl");
  if (looksLikePath) {
    const candidate = path.resolve(cwd, expandHomeShorthandPath(selector, { homeDir }));
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) {
      throw new Error(`Prime session file does not exist: ${candidate}`);
    }
    return candidate;
  }

  const sessionDirOverride = String(
    env.PRIME_AGENT_SESSION_DIR ?? env.PRIME_AGENT_CODING_AGENT_SESSION_DIR ?? "",
  ).trim();
  const sessionDir = sessionDirOverride
    ? path.resolve(expandHomeShorthandPath(sessionDirOverride, { homeDir }))
    : path.join(resolveManagedPrimeAgentDir({ homeDir, env }), "sessions");
  const exactPath = path.join(sessionDir, `${selector}.jsonl`);
  if (fs.existsSync(exactPath) && fs.statSync(exactPath).isFile()) return exactPath;

  let names;
  try {
    names = fs.readdirSync(sessionDir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".jsonl"))
      .map((entry) => entry.name);
  } catch {
    throw new Error(`Prime session directory is unavailable: ${sessionDir}`);
  }
  const normalizedSelector = selector.replaceAll("-", "").toLowerCase();
  const hexSelector = normalizedSelector && /^[0-9a-f]+$/.test(normalizedSelector);
  const matches = names.filter((name) => {
    const id = name.slice(0, -".jsonl".length);
    const normalizedId = id.replaceAll("-", "").toLowerCase();
    return hexSelector && /^[0-9a-f]+$/.test(normalizedId)
      ? normalizedId.startsWith(normalizedSelector) || normalizedId.endsWith(normalizedSelector)
      : id.startsWith(selector);
  });
  if (matches.length === 1) return path.join(sessionDir, matches[0]);
  if (matches.length > 1) throw new Error(`Ambiguous Prime session selector: ${selector}`);
  throw new Error(`No Prime session found matching: ${selector}`);
}

function readPrimeResumeProfile({ selector, homeDir, env, cwd }) {
  const sessionPath = resolvePrimeSessionPath({ selector, homeDir, env, cwd });
  let lastModel = null;
  const bindings = new Map();
  for (const line of fs.readFileSync(sessionPath, "utf8").split(/\r?\n/)) {
    if (!line) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (
      entry?.type === "model_change"
      && typeof entry.provider === "string"
      && typeof entry.modelId === "string"
    ) {
      lastModel = { provider: entry.provider, model: entry.modelId };
    }
    if (
      entry?.type === "message"
      && entry.message?.role === "assistant"
      && typeof entry.message.provider === "string"
      && typeof entry.message.model === "string"
    ) {
      lastModel = { provider: entry.message.provider, model: entry.message.model };
    }
    if (
      entry?.type === "credential_binding"
      && entry.source === "aimgr"
      && typeof entry.provider === "string"
      && typeof entry.binding === "string"
    ) {
      bindings.set(entry.provider, entry.binding);
    }
  }
  if (!lastModel) throw new Error(`Prime session has no model metadata: ${sessionPath}`);
  if (!HARNESS_MANAGED_PROVIDERS.includes(lastModel.provider)) {
    throw new Error(`AIM cannot rotate unsupported Prime provider=${lastModel.provider}.`);
  }
  const binding = bindings.get(lastModel.provider);
  if (!binding) {
    throw new Error(`Prime session has no AIM binding for provider=${lastModel.provider}.`);
  }
  return { ...lastModel, binding, sessionPath };
}

function claudePresetForModel(model) {
  const normalized = String(model).toLowerCase();
  if (normalized.includes("fable") || normalized.includes("sonnet")) return "fable";
  if (normalized.includes("opus")) return "opus";
  throw new Error(`AIM cannot automatically rotate unsupported Claude model=${model}.`);
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
    runPrimeLauncher(context, ["--dist", "--resume", selector]);
    return;
  }

  const profile = readPrimeResumeProfile({
    selector,
    homeDir: context.homeDir,
    env: context.env,
    cwd: context.cwd,
  });
  const selectionOpts = profile.provider === OPENAI_CODEX_PROVIDER
    ? { codex: "auto" }
    : { claude: claudePresetForModel(profile.model) };
  const selected = await handleUse({
    ...context,
    opts: { ...context.opts, ...selectionOpts },
    positional: [targetId, "use"],
    avoidCurrentSelection: true,
    requireDifferentSelection: true,
    currentCodexLabel: profile.provider === OPENAI_CODEX_PROVIDER ? profile.binding : undefined,
    currentClaudeLabel: profile.provider === ANTHROPIC_PROVIDER ? profile.binding : undefined,
    primeRotationProvider: profile.provider,
  }, targetId, { emitReceipt: false });
  if (!selected?.ok) {
    context.stdout.write(`AIM Prime could not rotate accounts: ${selected?.receipt?.reason ?? "unknown"}\n`);
    return;
  }
  const providerReceipt = selected.receipt.providers.find(
    (provider) => provider.provider === profile.provider && provider.binding,
  );
  if (!providerReceipt) throw new Error(`AIM did not select a ${profile.provider} account.`);

  context.stdout.write(`AIM Prime: ${profile.provider} · ${providerReceipt.binding} · rotating resume\n`);
  // The reset flag ships in Prime source with this AIM command. Avoid a stale local dist bundle
  // rejecting it before the next Prime bundle release is built. Launch from the exact agent dir
  // that received the selected descriptor, including persisted-path recovery cases.
  const launchContext = {
    ...context,
    env: {
      ...context.env,
      PRIME_AGENT_CODING_AGENT_DIR: path.dirname(selected.receipt.authPath),
    },
  };
  runPrimeLauncher(launchContext, [
    "--provider",
    profile.provider,
    "--model",
    profile.model,
    "--fork",
    selector,
    "--reset-credential-binding",
    profile.provider,
  ]);
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
  runPrimeLauncher(context, ["--dist", "--provider", profile.provider, "--model", profile.model]);
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
