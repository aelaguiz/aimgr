import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { readBoundedJsonDocument } from "../../io/bounded-json.js";
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
  isAimHarnessExternalDescriptor,
  readHarnessProviderProjectionSnapshot,
  readHarnessTargetBriefStatus,
  readHarnessTargetStatus,
  restoreHarnessProviderProjection,
  uninstallHarnessProvider,
} from "../../targets/harness-auth.js";
import {
  clearLegacyPiProjectionReceipt,
  createPiTargetAdapter,
  isRecognizedAimLegacyPiProjection,
  selectNextBestPiCodexLabel,
} from "../../targets/pi-cli.js";
import {
  ensureHarnessSessionIdentityExtension,
  readHarnessSessionIdentityExtensionStatus,
} from "../../targets/harness-session-identity.js";
import { withHarnessTargetMutationLock } from "../../targets/harness-target-lock.js";
import {
  readPrimeCreateJournal,
  writePrimeCreateJournal,
} from "../../targets/prime-create-journal.js";
import {
  buildAimPrimeCreateReceipt,
  buildPrimeCreateDispatchRequest,
  inspectPrimeCreateCapability,
  launchPrimeCreate,
  lookupPrimeCreate,
  parsePrimeCreateRequest,
  parsePrimeCreateStatusRequest,
  primeCreateRequestDigest,
  sanitizePrimeCreateReceipt,
  sameDescriptor,
} from "../../targets/prime-create.js";
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

async function selectClaudePreset({
  runtime,
  preset,
  usageByProvider,
  avoidLabel = null,
  readHeldRedisCredentialLeaseLabelsImpl = readHeldRedisCredentialLeaseLabels,
}) {
  const records = (runtime.snapshot?.credentials ?? [])
    .filter((record) => record.provider === ANTHROPIC_PROVIDER && record.label !== avoidLabel);
  let held;
  try {
    held = await readHeldRedisCredentialLeaseLabelsImpl(runtime.store, {
      provider: ANTHROPIC_PROVIDER,
      labels: records.map((record) => record.label),
    });
  } catch {
    // One reconnect-sized retry absorbs a transient Redis socket turnover while still failing closed.
    await new Promise((resolve) => setTimeout(resolve, 50));
    held = await readHeldRedisCredentialLeaseLabelsImpl(runtime.store, {
      provider: ANTHROPIC_PROVIDER,
      labels: records.map((record) => record.label),
    });
  }
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
      const label = claudeSelection === "fable" || claudeSelection === "opus"
        ? await selectClaudePreset({
            runtime,
            preset: claudeSelection,
            usageByProvider,
            avoidLabel: context.avoidCurrentSelection === true ? context.currentClaudeLabel : null,
            readHeldRedisCredentialLeaseLabelsImpl: context.readHeldRedisCredentialLeaseLabelsImpl,
          })
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
    if (targetId === "prime" && adapter.pathConflict) {
      return writePathConflictReceipt(context, "prime_use");
    }
    const persistTargetState = async () => writeRedisLocalStateFromView({
      homeDir,
      state: runtime.state,
      localState: runtime.localState,
    });
    adapter.targetState.agentDir = adapter.agentDir;
    const selectionContext = { ...effectiveContext };
    if (targetId === "prime" && effectiveContext.avoidCurrentSelection === true) {
      selectionContext.currentCodexLabel ??= readInstalledAimBinding(adapter.authPath, OPENAI_CODEX_PROVIDER);
      selectionContext.currentClaudeLabel ??= readInstalledAimBinding(adapter.authPath, ANTHROPIC_PROVIDER);
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

async function launchPrimeAgent({ command, args, cwd, env, spawnImpl = spawn } = {}) {
  let child;
  try {
    child = await spawnImpl(command, args, {
      cwd,
      env,
      shell: false,
      stdio: "inherit",
    });
  } catch (error) {
    return { error, status: null };
  }
  if (child && (Object.hasOwn(child, "status") || Object.hasOwn(child, "error"))) {
    return child;
  }
  if (!child || typeof child.once !== "function") {
    return { error: new Error("invalid child process"), status: null };
  }
  return new Promise((resolve) => {
    let launchError = null;
    child.once("error", (error) => {
      launchError = error;
    });
    child.once("close", (status) => {
      resolve({ error: launchError, status: Number.isInteger(status) ? status : null });
    });
  });
}

async function runPrimeLauncher(context, args) {
  const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
  const launchPrimeAgentImpl = context.launchPrimeAgentImpl ?? launchPrimeAgent;
  const result = await launchPrimeAgentImpl({
    command: resolvePrimeLauncherImpl({ homeDir: context.homeDir }),
    args,
    cwd: context.cwd ?? process.cwd(),
    env: context.env,
  });
  if (result?.error) throw new Error("Could not start the local Prime Agent launcher.");
  if (result?.status !== 0) {
    context.setExitCode(Number.isInteger(result?.status) ? result.status : 1);
  }
}

function readPrimeResumeProfile({ agentDir, selector }) {
  const sessionFile = path.isAbsolute(selector)
    ? selector
    : /^[0-9a-f]{8}-[0-9a-f-]{27}$/u.test(selector)
      ? path.join(agentDir, "sessions", `${selector}.jsonl`)
      : null;
  if (!sessionFile) return null;
  try {
    const stat = fs.lstatSync(sessionFile);
    if (!stat.isFile() || stat.isSymbolicLink()) return null;
    const length = Math.min(stat.size, 256 * 1_024);
    const buffer = Buffer.alloc(length);
    const fd = fs.openSync(sessionFile, "r");
    let bytesRead;
    try {
      bytesRead = fs.readSync(fd, buffer, 0, length, 0);
    } finally {
      fs.closeSync(fd);
    }
    let configuration = null;
    let model = null;
    for (const line of buffer.subarray(0, bytesRead).toString("utf8").split("\n")) {
      if (!line || line.length > 64 * 1_024) continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (
        record?.type === "credential_configuration"
        && (record.provider === OPENAI_CODEX_PROVIDER || record.provider === ANTHROPIC_PROVIDER)
        && typeof record.binding === "string"
      ) {
        configuration = { provider: record.provider, binding: normalizeLabel(record.binding) };
      }
      if (
        record?.type === "model_change"
        && (record.provider === OPENAI_CODEX_PROVIDER || record.provider === ANTHROPIC_PROVIDER)
        && typeof record.modelId === "string"
        && record.modelId.length > 0
      ) {
        model = { provider: record.provider, modelId: record.modelId };
      }
      if (configuration && model && configuration.provider === model.provider) break;
    }
    if (!configuration || !model || configuration.provider !== model.provider) return null;
    const preset = configuration.provider === ANTHROPIC_PROVIDER
      ? model.modelId.includes("opus") ? "opus" : "fable"
      : null;
    return Object.freeze({ ...configuration, modelId: model.modelId, preset });
  } catch {
    return null;
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
  const localState = loadLocalState({ homeDir: context.homeDir });
  const adapter = createPrimeTargetAdapter({
    state: localState,
    homeDir: context.homeDir,
    env: context.env,
  });
  if (adapter.pathConflict) return writePathConflictReceipt(context, "prime_resume");

  if (context.opts.primeResumeRotate !== true) {
    await runPrimeLauncher(context, ["--dist", "--resume", selector]);
    return;
  }

  const profile = readPrimeResumeProfile({ agentDir: adapter.agentDir, selector }) ?? {
    provider: OPENAI_CODEX_PROVIDER,
    binding: readInstalledAimBinding(adapter.authPath, OPENAI_CODEX_PROVIDER),
    modelId: "gpt-5.6-sol",
    preset: null,
  };
  const rotateOptions = profile.provider === ANTHROPIC_PROVIDER
    ? { ...context.opts, claude: profile.preset, replaceNativeAuth: true }
    : { ...context.opts, codex: "auto", replaceNativeAuth: true };
  const selected = await handleUse({
    ...context,
    opts: rotateOptions,
    positional: [targetId, "use"],
    avoidCurrentSelection: true,
    requireDifferentSelection: true,
    currentCodexLabel: profile.provider === OPENAI_CODEX_PROVIDER ? profile.binding : undefined,
    currentClaudeLabel: profile.provider === ANTHROPIC_PROVIDER ? profile.binding : undefined,
  }, targetId, { emitReceipt: false });
  if (!selected?.ok) {
    context.stdout.write(`AIM Prime could not rotate accounts: ${selected?.receipt?.reason ?? "unknown"}
`);
    return;
  }
  const providerReceipt = selected.receipt.providers.find(
    (provider) => provider.provider === profile.provider && provider.binding,
  );
  if (!providerReceipt) throw new Error(`AIM did not select a ${profile.provider} account.`);

  context.stdout.write(`AIM Prime: ${profile.provider} · ${providerReceipt.binding} · rotating resume
`);
  // A cross-account continuation is a fork so the saved source remains pinned and untouched.
  const launchContext = {
    ...context,
    env: {
      ...context.env,
      PRIME_AGENT_CODING_AGENT_DIR: path.dirname(selected.receipt.authPath),
    },
  };
  await runPrimeLauncher(launchContext, [
    "--provider",
    profile.provider,
    "--model",
    profile.modelId,
    "--fork",
    selector,
    "--reset-credential-binding",
    profile.provider,
  ]);
}

function validatePrimeRunTail(values) {
  if (!values?.length) return [];
  if (
    values.length !== 6
    || values[0] !== "--no-env"
    || values[1] !== "--offline"
    || values[2] !== "--daemon-socket"
    || values[4] !== "--session-dir"
  ) {
    throw new Error(
      "Prime run passthrough accepts only: --no-env --offline --daemon-socket <absolute> --session-dir <absolute>.",
    );
  }
  for (const value of [values[3], values[5]]) {
    if (
      typeof value !== "string"
      || value.length > 4_096
      || !path.isAbsolute(value)
      || path.resolve(value) !== value
      || /[\u0000-\u001f\u007f]/u.test(value)
    ) {
      throw new Error("Prime run isolation paths must be exact absolute paths.");
    }
  }
  return [...values];
}

async function handleRun(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports the run command.");
  if (context.positional.length !== 3) {
    throw new Error("Usage: aim prime run codex | aim prime run claude");
  }
  const passthrough = validatePrimeRunTail(context.opts.afterDoubleDash);
  const flavor = String(context.positional[2] ?? "").trim().toLowerCase();
  const profile = flavor === "codex"
    ? { provider: OPENAI_CODEX_PROVIDER, model: "gpt-5.6-sol" }
    : flavor === "claude"
      ? { provider: ANTHROPIC_PROVIDER, model: "claude-fable-5" }
      : null;
  if (!profile) throw new Error("Usage: aim prime run codex | aim prime run claude");

  let useOptions = { ...context.opts, replaceNativeAuth: true };
  let usePositionals = [targetId, "use", flavor];
  if (context.opts.codex !== undefined) {
    if (flavor !== "codex") throw new Error("--codex exact selection is available only for `aim prime run codex`.");
    let exactLabel;
    try {
      exactLabel = normalizeLabel(context.opts.codex);
    } catch {
      throw new Error("`aim prime run codex --codex` requires an exact account label.");
    }
    if (exactLabel !== context.opts.codex || exactLabel === "auto" || exactLabel === "off") {
      throw new Error("`aim prime run codex --codex` requires an exact account label.");
    }
    useOptions = {
      ...context.opts,
      codex: exactLabel,
      claude: "off",
      replaceNativeAuth: true,
    };
    usePositionals = [targetId, "use"];
  }

  const selected = await handleUse({
    ...context,
    opts: useOptions,
    positional: usePositionals,
    avoidCurrentSelection: context.opts.codex === undefined,
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
  const launchContext = {
    ...context,
    env: {
      ...context.env,
      PRIME_AGENT_CODING_AGENT_DIR: path.dirname(selected.receipt.authPath),
    },
  };
  await runPrimeLauncher(launchContext, [
    "--dist",
    "--provider",
    profile.provider,
    "--model",
    profile.model,
    ...passthrough,
  ]);
}

async function handleUninstall(context, targetId) {
  const { homeDir, env, stdout, opts } = context;
  const writeLocalStateImpl = context.writeLocalStateImpl ?? writeLocalState;
  if (context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} uninstall\` does not accept positional arguments.`);
  }
  const localState = loadLocalState({ homeDir });
  const adapter = adapterFor(targetId, { state: localState, homeDir, env });
  if (targetId === "prime" && adapter.pathConflict) {
    return writePathConflictReceipt(context, "prime_uninstall");
  }
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

function writePrimeCreateReceipt(context, receipt) {
  context.stdout.write(`${JSON.stringify(receipt)}\n`);
  if (receipt.ok !== true) context.setExitCode(1);
  return receipt;
}

const PRIME_CREATE_JOURNAL_REASONS = new Set([
  null,
  "descriptor_write_failed",
  "interrupted_before_descriptor_write",
  "descriptor_evidence_conflict",
  "journal_write_failed",
  "projection_rollback_failed",
  "recovery_required",
  "root_not_admitted",
  "root_admission_uncertain",
  "root_receipt_conflict",
]);
const PRIME_CREATE_ROLLBACK_STATUSES = new Set([
  null,
  "restored_prior_projection",
  "not_attempted_descriptor_conflict",
  "failed",
]);

function canonicalJournalBinding(value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || normalizeLabel(value) !== value) {
    throw new Error("AIM Prime create journal is invalid.");
  }
  return value;
}

function createReceiptFromJournal(journal, overrides = {}) {
  parsePrimeCreateStatusRequest({ schemaVersion: 1, operationId: journal.operationId });
  const provider = journal.provider === OPENAI_CODEX_PROVIDER || journal.provider === ANTHROPIC_PROVIDER
    ? journal.provider
    : null;
  const binding = canonicalJournalBinding(journal.binding);
  const priorBinding = canonicalJournalBinding(journal.priorBinding);
  const rollbackStatus = overrides.rollbackStatus ?? journal.rollbackStatus ?? null;
  const reason = overrides.reason ?? journal.reason ?? null;
  if (
    (journal.provider !== undefined && !provider)
    || !PRIME_CREATE_ROLLBACK_STATUSES.has(rollbackStatus)
    || !PRIME_CREATE_JOURNAL_REASONS.has(reason)
  ) {
    throw new Error("AIM Prime create journal is invalid.");
  }
  const rawRoot = overrides.root ?? journal.root ?? null;
  const root = rawRoot === null
    ? null
    : sanitizePrimeCreateReceipt(rawRoot, {
        operationId: journal.operationId,
        provider,
        binding,
        expectedDaemonSocket: journal.request?.prime?.daemonSocket,
        expectedBuildId: journal.primeColdCreate?.expectedBuildId,
        expectedLauncherLane: journal.primeColdCreate?.expectedLauncherLane,
      });
  return buildAimPrimeCreateReceipt({
    operationId: journal.operationId,
    transactionStatus: overrides.transactionStatus ?? journal.transactionStatus ?? "pending",
    provider,
    binding,
    priorBinding,
    preserveOtherProvider: true,
    root,
    rollbackStatus,
    reason,
  });
}

function restorePriorProviderState(adapter, journal) {
  adapter.targetState.providers = adapter.targetState.providers ?? {};
  if (journal.priorProviderState) {
    adapter.targetState.providers[journal.provider] = structuredClone(journal.priorProviderState);
  } else {
    delete adapter.targetState.providers[journal.provider];
  }
  if (Object.keys(adapter.targetState.providers).length === 0) delete adapter.targetState.providers;
}

async function persistCreateRuntimeState({ homeDir, runtime }) {
  writeRedisLocalStateFromView({
    homeDir,
    state: runtime.state,
    localState: runtime.localState,
  });
}

async function persistCreateJournal({ context, journal }) {
  const writeJournalImpl = context.writePrimeCreateJournalImpl ?? writePrimeCreateJournal;
  const result = writeJournalImpl({ homeDir: context.homeDir, journal });
  if (result && typeof result.then === "function") await result;
}

async function notifyPrimeCreateCrashWindow(context, phase) {
  const notify = context.onPrimeCreateCrashWindowImpl;
  if (!notify) return;
  const result = notify(phase);
  if (result && typeof result.then === "function") await result;
}

function journalWriteFailureReceipt(journal, {
  transactionStatus,
  root = null,
  rollbackStatus = null,
} = {}) {
  return createReceiptFromJournal(journal, {
    transactionStatus,
    root,
    rollbackStatus,
    reason: "journal_write_failed",
  });
}

async function finalizeCreateJournal({
  context,
  runtime,
  journal,
  transactionStatus,
  root = null,
  rollbackStatus = null,
  reason = null,
}) {
  journal.phase = "final";
  journal.transactionStatus = transactionStatus;
  journal.root = root;
  journal.rollbackStatus = rollbackStatus;
  journal.reason = reason;
  journal.updatedAt = new Date(context.nowMs).toISOString();
  const receipt = createReceiptFromJournal(journal);
  journal.receipt = receipt;
  try {
    await persistCreateJournal({ context, journal });
    return receipt;
  } catch {
    return journalWriteFailureReceipt(journal, {
      transactionStatus: transactionStatus === "committed" || transactionStatus === "partial_effect"
        ? "partial_effect"
        : "conflict_uncertain",
      root: transactionStatus === "committed" || transactionStatus === "partial_effect" ? root : null,
      rollbackStatus,
    });
  }
}

async function selectPrimeCreateRecord({ context, runtime, adapter, request }) {
  if (request.label !== "auto") {
    return exactRecord(runtime.snapshot, request.provider, request.label);
  }
  const usageByProvider = await context.probeUsageSnapshotsByProviderImpl(runtime.state, {
    env: context.env,
  });
  if (request.provider === OPENAI_CODEX_PROVIDER) {
    const currentLabel = readInstalledAimBinding(adapter.authPath, OPENAI_CODEX_PROVIDER);
    const selected = await selectNextBestPiCodexLabel({
      state: runtime.state,
      homeDir: context.homeDir,
      usageByProvider,
      currentLabel,
      avoidCurrentLabel: false,
    });
    if (!selected.selection) throw new Error("no_eligible_account");
    return exactRecord(runtime.snapshot, request.provider, selected.selection.label);
  }
  const label = await selectClaudePreset({ runtime, preset: "fable", usageByProvider });
  return exactRecord(runtime.snapshot, request.provider, label);
}

function createDescriptorForRecord(context, record) {
  inspectHarnessCredentialRecord(record, { nowMs: context.nowMs });
  return buildHarnessExternalDescriptor({
    executable: context.aimExecutable,
    binding: record.label,
    expectedIdentityFingerprint: buildHarnessIdentityFingerprint(record),
  });
}

async function attemptPrimeCreateLookup({ context, journal }) {
  const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
  const lookupImpl = context.lookupPrimeCreateImpl ?? lookupPrimeCreate;
  const command = resolvePrimeLauncherImpl({ homeDir: context.homeDir });
  const raw = lookupImpl({
    command,
    operationId: journal.operationId,
    daemonSocket: journal.request.prime.daemonSocket,
    cwd: journal.request.prime.cwd,
    env: {
      ...context.env,
      PRIME_AGENT_CODING_AGENT_DIR: journal.request.targetAgentDir,
    },
  });
  const resolved = raw && typeof raw.then === "function" ? await raw : raw;
  if (resolved?.status === "absent" || resolved?.status === "pending") {
    return Object.freeze({ status: resolved.status });
  }
  if (resolved?.status !== "committed" || !Object.hasOwn(resolved, "receipt")) {
    throw new Error("Prime create returned an invalid status receipt.");
  }
  return Object.freeze({
    status: "committed",
    root: sanitizePrimeCreateReceipt(resolved.receipt, {
      operationId: journal.operationId,
      provider: journal.provider,
      binding: journal.binding,
      expectedDaemonSocket: journal.request.prime.daemonSocket,
      expectedBuildId: journal.primeColdCreate?.expectedBuildId,
      expectedLauncherLane: journal.primeColdCreate?.expectedLauncherLane,
    }),
  });
}

async function rollbackPrimeCreateProjection({
  context,
  runtime,
  adapter,
  journal,
}) {
  journal.phase = "rollback_pending";
  journal.updatedAt = new Date(context.nowMs).toISOString();
  try {
    await persistCreateJournal({ context, journal });
  } catch {
    let projectionMatches = false;
    try {
      const current = readHarnessProviderProjectionSnapshot({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: journal.provider,
      });
      projectionMatches = sameDescriptor(current.descriptor, journal.newDescriptor);
    } catch {
      // The fixed receipt below intentionally omits file/path diagnostics.
    }
    return journalWriteFailureReceipt(journal, {
      transactionStatus: projectionMatches ? "partial_effect" : "conflict_uncertain",
    });
  }
  await notifyPrimeCreateCrashWindow(context, "rollback_pending");
  try {
    const current = readHarnessProviderProjectionSnapshot({
      targetState: adapter.targetState,
      authPath: adapter.authPath,
      provider: journal.provider,
    });
    if (sameDescriptor(current.descriptor, journal.priorDescriptor)) {
      restorePriorProviderState(adapter, journal);
      await persistCreateRuntimeState({ homeDir: context.homeDir, runtime });
    } else if (sameDescriptor(current.descriptor, journal.newDescriptor)) {
      const restoreProjectionImpl = context.restoreHarnessProviderProjectionImpl
        ?? restoreHarnessProviderProjection;
      await restoreProjectionImpl({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: journal.provider,
        expectedCurrentDescriptor: journal.newDescriptor,
        priorDescriptor: journal.priorDescriptor,
        priorProviderState: journal.priorProviderState,
        persistTargetState: async () => persistCreateRuntimeState({
          homeDir: context.homeDir,
          runtime,
        }),
      });
    } else {
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "conflict_uncertain",
        rollbackStatus: "not_attempted_descriptor_conflict",
        reason: "descriptor_evidence_conflict",
      });
    }
    return finalizeCreateJournal({
      context,
      runtime,
      journal,
      transactionStatus: "rolled_back_no_root",
      rollbackStatus: "restored_prior_projection",
      reason: "root_not_admitted",
    });
  } catch {
    let snapshot = null;
    try {
      snapshot = readHarnessProviderProjectionSnapshot({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: journal.provider,
      });
    } catch {
      // The fixed receipt below intentionally omits file/path diagnostics.
    }
    if (snapshot && !sameDescriptor(snapshot.descriptor, journal.newDescriptor)) {
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "conflict_uncertain",
        rollbackStatus: "failed",
        reason: "descriptor_evidence_conflict",
      });
    }
    return finalizeCreateJournal({
      context,
      runtime,
      journal,
      transactionStatus: "partial_effect",
      rollbackStatus: "failed",
      reason: "projection_rollback_failed",
    });
  }
}

async function recoverPendingPrimeCreate({ context, runtime, adapter, journal }) {
  if (journal.phase === "prepared") {
    try {
      const current = readHarnessProviderProjectionSnapshot({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: journal.provider,
      });
      if (sameDescriptor(current.descriptor, journal.priorDescriptor)) {
        restorePriorProviderState(adapter, journal);
        try {
          await persistCreateRuntimeState({ homeDir: context.homeDir, runtime });
        } catch {
          return createReceiptFromJournal(journal, {
            transactionStatus: "conflict_uncertain",
            reason: "projection_rollback_failed",
          });
        }
        return finalizeCreateJournal({
          context,
          runtime,
          journal,
          transactionStatus: "aborted_no_effect",
          reason: "interrupted_before_descriptor_write",
        });
      }
      if (!sameDescriptor(current.descriptor, journal.newDescriptor)) {
        return finalizeCreateJournal({
          context,
          runtime,
          journal,
          transactionStatus: "conflict_uncertain",
          reason: "descriptor_evidence_conflict",
        });
      }
    } catch {
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "conflict_uncertain",
        reason: "descriptor_evidence_conflict",
      });
    }
  }
  if (journal.phase === "prepared" || journal.phase === "descriptor_written") {
    return rollbackPrimeCreateProjection({ context, runtime, adapter, journal });
  }
  if (journal.phase === "root_admitted") {
    try {
      const root = sanitizePrimeCreateReceipt(journal.root, {
        operationId: journal.operationId,
        provider: journal.provider,
        binding: journal.binding,
        expectedDaemonSocket: journal.request?.prime?.daemonSocket,
        expectedBuildId: journal.primeColdCreate?.expectedBuildId,
        expectedLauncherLane: journal.primeColdCreate?.expectedLauncherLane,
      });
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "committed",
        root,
      });
    } catch {
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "conflict_uncertain",
        reason: "root_receipt_conflict",
      });
    }
  }
  if (journal.phase === "rollback_pending") {
    return rollbackPrimeCreateProjection({ context, runtime, adapter, journal });
  }
  if (journal.phase !== "dispatch_pending") {
    return finalizeCreateJournal({
      context,
      runtime,
      journal,
      transactionStatus: "conflict_uncertain",
      reason: "descriptor_evidence_conflict",
    });
  }
  try {
    const lookup = await attemptPrimeCreateLookup({ context, journal });
    if (lookup.status === "committed") {
      return finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "committed",
        root: lookup.root,
      });
    }
    if (lookup.status === "pending") {
      return createReceiptFromJournal(journal, {
        transactionStatus: "pending",
        root: null,
        reason: "recovery_required",
      });
    }
  } catch (error) {
    const receiptConflict = /^Prime create (returned|did not)/.test(String(error?.message ?? ""));
    let projectionMatches = false;
    try {
      const current = readHarnessProviderProjectionSnapshot({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: journal.provider,
      });
      projectionMatches = sameDescriptor(current.descriptor, journal.newDescriptor);
    } catch {
      projectionMatches = false;
    }
    const conflict = receiptConflict || !projectionMatches;
    return finalizeCreateJournal({
      context,
      runtime,
      journal,
      transactionStatus: conflict ? "conflict_uncertain" : "partial_effect",
      reason: receiptConflict
        ? "root_receipt_conflict"
        : projectionMatches
          ? "root_admission_uncertain"
          : "descriptor_evidence_conflict",
    });
  }
  let projectionMatches = false;
  try {
    const current = readHarnessProviderProjectionSnapshot({
      targetState: adapter.targetState,
      authPath: adapter.authPath,
      provider: journal.provider,
    });
    projectionMatches = sameDescriptor(current.descriptor, journal.newDescriptor);
  } catch {
    // The fixed receipt below intentionally omits file/path diagnostics.
  }
  return finalizeCreateJournal({
    context,
    runtime,
    journal,
    transactionStatus: projectionMatches ? "partial_effect" : "conflict_uncertain",
    reason: projectionMatches ? "root_admission_uncertain" : "descriptor_evidence_conflict",
  });
}

function assertPrimeCreateArgv(context, isStatus) {
  const prefix = isStatus ? ["prime", "create", "status"] : ["prime", "create"];
  if (!prefix.every((value, index) => context.argv[index] === value)) {
    throw new Error("Invalid AIM Prime structured request invocation.");
  }
  let requestJsonCount = 0;
  let homeCount = 0;
  for (let index = prefix.length; index < context.argv.length; index += 2) {
    const option = context.argv[index];
    const value = context.argv[index + 1];
    if (option === "--request-json" && value === "-") requestJsonCount += 1;
    else if (option === "--home" && typeof value === "string" && value.length > 0) homeCount += 1;
    else throw new Error("Invalid AIM Prime structured request invocation.");
  }
  if (requestJsonCount !== 1 || homeCount > 1) {
    throw new Error("Invalid AIM Prime structured request invocation.");
  }
}

async function readPrimeCreateRequest(context, isStatus) {
  const expectedLength = isStatus ? 3 : 2;
  if (context.positional.length !== expectedLength || context.opts.requestJson !== "-") {
    throw new Error(isStatus
      ? "Usage: aim prime create status --request-json -"
      : "Usage: aim prime create --request-json -");
  }
  assertPrimeCreateArgv(context, isStatus);
  const value = await readBoundedJsonDocument(context.stdin, {
    errorMessage: "Invalid AIM Prime structured request.",
  });
  return isStatus ? parsePrimeCreateStatusRequest(value) : parsePrimeCreateRequest(value);
}

function primeCreatePathConflictReceipt(context, operationId) {
  return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
    operationId,
    transactionStatus: "aborted_no_effect",
    reason: "path_conflict",
  }));
}

async function preparePrimeCreateMutation(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports account-aware create.");
  const request = await readPrimeCreateRequest(context, false);
  const localState = loadLocalState({ homeDir: context.homeDir });
  const adapter = createPrimeTargetAdapter({
    state: localState,
    homeDir: context.homeDir,
    env: context.env,
  });
  if (adapter.pathConflict || adapter.agentDir !== request.targetAgentDir) {
    return { request: null, targetPath: null, receipt: primeCreatePathConflictReceipt(context, request.operationId) };
  }
  return { request, targetPath: adapter.authPath, receipt: null };
}

async function handlePrimeCreate(context, targetId, preparedRequest = null) {
  if (targetId !== "prime") throw new Error("Only Prime supports account-aware create.");
  const isStatus = String(context.positional[2] ?? "").trim().toLowerCase() === "status";
  const request = preparedRequest ?? await readPrimeCreateRequest(context, isStatus);
  if (isStatus) {
    const readJournalImpl = context.readPrimeCreateJournalImpl ?? readPrimeCreateJournal;
    const stored = readJournalImpl({ homeDir: context.homeDir, operationId: request.operationId });
    const resolvedStored = stored && typeof stored.then === "function" ? await stored : stored;
    if (resolvedStored?.status === "not_found") {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "not_found",
        reason: "operation_not_found",
      }));
    }
    if (!resolvedStored?.journal) {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "conflict_uncertain",
        reason: "journal_invalid",
      }));
    }
    const journal = resolvedStored.journal;
    if (journal.receipt) {
      try {
        return writePrimeCreateReceipt(context, createReceiptFromJournal(journal));
      } catch {
        return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
          operationId: request.operationId,
          transactionStatus: "conflict_uncertain",
          reason: "journal_invalid",
        }));
      }
    }
    try {
      const lookup = await attemptPrimeCreateLookup({ context, journal });
      if (lookup.status === "committed") {
        return writePrimeCreateReceipt(context, createReceiptFromJournal(journal, {
          transactionStatus: "committed",
          root: lookup.root,
          reason: null,
        }));
      }
    } catch {
      // A status lookup never mutates projection state or guesses whether admission occurred.
    }
    try {
      return writePrimeCreateReceipt(context, createReceiptFromJournal(journal, {
        transactionStatus: "pending",
        reason: "recovery_required",
      }));
    } catch {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "conflict_uncertain",
        reason: "journal_invalid",
      }));
    }
  }

  const preliminaryState = loadLocalState({ homeDir: context.homeDir });
  const preliminaryAdapter = createPrimeTargetAdapter({
    state: preliminaryState,
    homeDir: context.homeDir,
    env: context.env,
  });
  if (preliminaryAdapter.pathConflict || preliminaryAdapter.agentDir !== request.targetAgentDir) {
    return primeCreatePathConflictReceipt(context, request.operationId);
  }
  let runtime;
  try {
    runtime = await loadRedisRuntime({
      homeDir: context.homeDir,
      connectRedisStoreImpl: context.connectRedisStoreImpl,
    });
  } catch {
    return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
      operationId: request.operationId,
      transactionStatus: "aborted_no_effect",
      reason: "coordination_unavailable",
    }));
  }
  try {
    const adapter = createPrimeTargetAdapter({
      state: runtime.state,
      homeDir: context.homeDir,
      env: context.env,
    });
    if (adapter.pathConflict || adapter.agentDir !== request.targetAgentDir) {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "aborted_no_effect",
        reason: "path_conflict",
      }));
    }
    const readJournalImpl = context.readPrimeCreateJournalImpl ?? readPrimeCreateJournal;
    const stored = readJournalImpl({ homeDir: context.homeDir, operationId: request.operationId });
    const resolvedStored = stored && typeof stored.then === "function" ? await stored : stored;
    if (resolvedStored?.status === "corrupt") {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "conflict_uncertain",
        reason: "journal_invalid",
      }));
    }
    const requestDigest = primeCreateRequestDigest(request);
    const existing = resolvedStored?.journal ?? null;
    if (existing) {
      if (existing.operationId !== request.operationId || existing.requestDigest !== requestDigest) {
        return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
          operationId: request.operationId,
          transactionStatus: "conflict_uncertain",
          reason: "operation_id_conflict",
        }));
      }
      if (existing.receipt) {
        try {
          return writePrimeCreateReceipt(context, createReceiptFromJournal(existing));
        } catch {
          return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
            operationId: request.operationId,
            transactionStatus: "conflict_uncertain",
            reason: "journal_invalid",
          }));
        }
      }
      const recovered = await recoverPendingPrimeCreate({ context, runtime, adapter, journal: existing });
      return writePrimeCreateReceipt(context, recovered);
    }

    let record;
    let descriptor;
    let prior;
    let command;
    let capability;
    let dispatchRequest;
    try {
      record = await selectPrimeCreateRecord({ context, runtime, adapter, request });
      descriptor = createDescriptorForRecord(context, record);
      prior = readHarnessProviderProjectionSnapshot({
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        provider: request.provider,
      });
      if (prior.ownershipConflict || prior.replaceConflict) {
        throw new Error("ownership_conflict");
      }
      const resolvePrimeLauncherImpl = context.resolvePrimeLauncherImpl ?? resolvePrimeLauncher;
      command = resolvePrimeLauncherImpl({ homeDir: context.homeDir });
      const capabilityImpl = context.inspectPrimeCreateCapabilityImpl ?? inspectPrimeCreateCapability;
      const rawCapability = capabilityImpl({
        command,
        cwd: request.prime.cwd,
        env: {
          ...context.env,
          PRIME_AGENT_CODING_AGENT_DIR: request.targetAgentDir,
        },
      });
      capability = rawCapability && typeof rawCapability.then === "function"
        ? await rawCapability
        : rawCapability;
      dispatchRequest = buildPrimeCreateDispatchRequest({
        request,
        descriptor,
        coldCreate: capability?.coldCreate,
      });
    } catch (error) {
      const reason = error?.message === "ownership_conflict"
        ? "ownership_conflict"
        : error?.message === "no_eligible_account"
          ? "no_eligible_account"
          : "capability_or_account_unavailable";
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "aborted_no_effect",
        reason,
      }));
    }

    const journal = {
      schemaVersion: 1,
      operationId: request.operationId,
      requestDigest,
      request: structuredClone(request),
      phase: "prepared",
      transactionStatus: "pending",
      provider: request.provider,
      binding: descriptor.binding,
      preserveOtherProvider: true,
      priorDescriptor: prior.descriptor,
      priorBinding: prior.descriptor?.binding ?? null,
      priorProviderState: prior.providerState,
      newDescriptor: structuredClone(descriptor),
      primeCreateCommand: "create --request-json -",
      primeColdCreate: structuredClone(capability.coldCreate),
      primeRequestDigest: primeCreateRequestDigest(dispatchRequest),
      createdAt: new Date(context.nowMs).toISOString(),
      updatedAt: new Date(context.nowMs).toISOString(),
    };
    try {
      await persistCreateJournal({ context, journal });
    } catch {
      return writePrimeCreateReceipt(context, buildAimPrimeCreateReceipt({
        operationId: request.operationId,
        transactionStatus: "aborted_no_effect",
        reason: "journal_write_failed",
      }));
    }
    await notifyPrimeCreateCrashWindow(context, "prepared");

    try {
      await installHarnessProvider({
        targetId: "prime",
        targetState: adapter.targetState,
        authPath: adapter.authPath,
        homeDir: context.homeDir,
        provider: request.provider,
        descriptor,
        replaceNativeAuth: false,
        persistTargetState: async () => persistCreateRuntimeState({
          homeDir: context.homeDir,
          runtime,
        }),
      });
    } catch {
      let current = null;
      try {
        current = readHarnessProviderProjectionSnapshot({
          targetState: adapter.targetState,
          authPath: adapter.authPath,
          provider: request.provider,
        });
      } catch {
        // Fixed receipt below.
      }
      if (current && sameDescriptor(current.descriptor, prior.descriptor)) {
        restorePriorProviderState(adapter, journal);
        try {
          await persistCreateRuntimeState({ homeDir: context.homeDir, runtime });
        } catch {
          return writePrimeCreateReceipt(context, createReceiptFromJournal(journal, {
            transactionStatus: "conflict_uncertain",
            reason: "projection_rollback_failed",
          }));
        }
        return writePrimeCreateReceipt(context, await finalizeCreateJournal({
          context,
          runtime,
          journal,
          transactionStatus: "aborted_no_effect",
          reason: "descriptor_write_failed",
        }));
      }
      if (current && sameDescriptor(current.descriptor, descriptor)) {
        return writePrimeCreateReceipt(context, await rollbackPrimeCreateProjection({
          context,
          runtime,
          adapter,
          journal,
        }));
      }
      return writePrimeCreateReceipt(context, await finalizeCreateJournal({
        context,
        runtime,
        journal,
        transactionStatus: "conflict_uncertain",
        reason: "descriptor_evidence_conflict",
      }));
    }

    journal.phase = "descriptor_written";
    journal.updatedAt = new Date(context.nowMs).toISOString();
    try {
      await persistCreateJournal({ context, journal });
    } catch {
      return writePrimeCreateReceipt(context, journalWriteFailureReceipt(journal, {
        transactionStatus: "partial_effect",
      }));
    }
    await notifyPrimeCreateCrashWindow(context, "descriptor_written");
    journal.phase = "dispatch_pending";
    journal.updatedAt = new Date(context.nowMs).toISOString();
    try {
      await persistCreateJournal({ context, journal });
    } catch {
      return writePrimeCreateReceipt(context, journalWriteFailureReceipt(journal, {
        transactionStatus: "partial_effect",
      }));
    }
    await notifyPrimeCreateCrashWindow(context, "dispatch_pending");
    let root;
    try {
      const launchImpl = context.launchPrimeCreateImpl ?? launchPrimeCreate;
      const raw = launchImpl({
        command,
        request: dispatchRequest,
        cwd: request.prime.cwd,
        env: {
          ...context.env,
          PRIME_AGENT_CODING_AGENT_DIR: request.targetAgentDir,
        },
      });
      const resolved = raw && typeof raw.then === "function" ? await raw : raw;
      root = sanitizePrimeCreateReceipt(resolved, {
        operationId: request.operationId,
        provider: request.provider,
        binding: descriptor.binding,
        expectedDaemonSocket: request.prime.daemonSocket,
        expectedBuildId: capability.coldCreate.expectedBuildId,
        expectedLauncherLane: capability.coldCreate.expectedLauncherLane,
      });
    } catch (error) {
      if (error?.uncertain === false) {
        return writePrimeCreateReceipt(context, await rollbackPrimeCreateProjection({
          context,
          runtime,
          adapter,
          journal,
        }));
      }
      const recovered = await recoverPendingPrimeCreate({ context, runtime, adapter, journal });
      return writePrimeCreateReceipt(context, recovered);
    }
    journal.phase = "root_admitted";
    journal.root = root;
    journal.updatedAt = new Date(context.nowMs).toISOString();
    try {
      await persistCreateJournal({ context, journal });
    } catch {
      return writePrimeCreateReceipt(context, journalWriteFailureReceipt(journal, {
        transactionStatus: "partial_effect",
        root,
      }));
    }
    await notifyPrimeCreateCrashWindow(context, "root_admitted");
    return writePrimeCreateReceipt(context, await finalizeCreateJournal({
      context,
      runtime,
      journal,
      transactionStatus: "committed",
      root,
    }));
  } finally {
    await closeRedisRuntime(runtime);
  }
}

function assertOnlyHomeOption(context, prefix, { requiredFlag = null } = {}) {
  if (!prefix.every((value, index) => context.argv[index] === value)) {
    throw new Error("Invalid Prime command invocation.");
  }
  let homeCount = 0;
  let requiredCount = 0;
  for (let index = prefix.length; index < context.argv.length;) {
    const option = context.argv[index];
    if (requiredFlag && option === requiredFlag) {
      requiredCount += 1;
      index += 1;
      continue;
    }
    if (option === "--home" && typeof context.argv[index + 1] === "string") {
      homeCount += 1;
      index += 2;
      continue;
    }
    throw new Error("Invalid Prime command invocation.");
  }
  if (homeCount > 1 || (requiredFlag && requiredCount !== 1)) {
    throw new Error("Invalid Prime command invocation.");
  }
}

async function handlePrimeIdentity(context, targetId) {
  if (targetId !== "prime") throw new Error("Only Prime supports session identity operations.");
  if (context.positional.length !== 3) {
    throw new Error("Usage: aim prime identity install | aim prime identity status");
  }
  const operation = String(context.positional[2] ?? "").trim().toLowerCase();
  if (operation !== "install" && operation !== "status") {
    throw new Error("Usage: aim prime identity install | aim prime identity status");
  }
  assertOnlyHomeOption(context, ["prime", "identity", operation]);
  const localState = loadLocalState({ homeDir: context.homeDir });
  const adapter = createPrimeTargetAdapter({
    state: localState,
    homeDir: context.homeDir,
    env: context.env,
  });
  if (operation === "status") {
    const status = readHarnessSessionIdentityExtensionStatus({ agentDir: adapter.agentDir });
    context.stdout.write(`${JSON.stringify({
      schemaVersion: 1,
      ok: true,
      receipt: {
        action: "prime_identity_status",
        status: status.conflict ? "conflict" : status.installed ? "installed" : "missing",
        installed: status.installed,
        managed: status.managed,
        conflict: status.conflict,
        pathConflict: adapter.pathConflict,
        effect: "read_only",
      },
    }, null, 2)}\n`);
    return;
  }
  if (adapter.pathConflict) return writePathConflictReceipt(context, "prime_identity_install");
  const ensureImpl = context.ensureHarnessSessionIdentityExtensionImpl
    ?? ensureHarnessSessionIdentityExtension;
  const result = ensureImpl({ agentDir: adapter.agentDir });
  context.stdout.write(`${JSON.stringify({
    schemaVersion: 1,
    ok: true,
    receipt: {
      action: "prime_identity_install",
      status: result.status,
      installed: true,
      managed: true,
      conflict: false,
      pathConflict: false,
      effect: "extension_code",
    },
  }, null, 2)}\n`);
}

async function handleTargetStatus(context, targetId) {
  const { homeDir, env, stdout, connectRedisStoreImpl } = context;
  if (context.positional.length > 2) {
    throw new Error(`\`aim ${targetId} status\` does not accept positional arguments.`);
  }
  if (context.opts.provider !== undefined) {
    throw new Error(`\`aim ${targetId} status\` does not accept --provider.`);
  }
  if (context.opts.briefJson === true) {
    assertOnlyHomeOption(context, ["prime", "status"], { requiredFlag: "--brief-json" });
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
    const status = context.opts.briefJson === true
      ? readHarnessTargetBriefStatus({
          targetId,
          targetState: adapter.targetState,
          authPath: adapter.authPath,
          pathConflict: adapter.pathConflict,
          coordination,
        })
      : readHarnessTargetStatus({
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

function writePathConflictReceipt(context, action) {
  const receipt = {
    schemaVersion: 1,
    ok: false,
    receipt: {
      action,
      status: "blocked",
      reason: "path_conflict",
      pathConflict: true,
      effect: "none",
    },
  };
  context.stdout.write(`${JSON.stringify(receipt)}\n`);
  context.setExitCode(1);
  return receipt;
}

export async function handleHarnessTarget(context, targetId) {
  const subcmd = String(context.positional[1] ?? "").trim().toLowerCase();
  const supported = targetId === "prime"
    ? "use, run, resume, create, identity, status, uninstall"
    : "use, status, uninstall";
  if (!subcmd) {
    throw new Error(`Missing ${targetId} subcommand. Supported: ${supported}.`);
  }

  let preparedPrimeCreateRequest = null;
  const dispatch = () => {
    if (subcmd === "use") return handleUse(context, targetId);
    if (subcmd === "run" && targetId === "prime") return handleRun(context, targetId);
    if (subcmd === "resume" && targetId === "prime") return handleResume(context, targetId);
    if (subcmd === "create" && targetId === "prime") {
      return handlePrimeCreate(context, targetId, preparedPrimeCreateRequest);
    }
    if (subcmd === "identity" && targetId === "prime") return handlePrimeIdentity(context, targetId);
    if (subcmd === "status") return handleTargetStatus(context, targetId);
    if (subcmd === "uninstall") return handleUninstall(context, targetId);
    throw new Error(`Unsupported ${targetId} subcommand: ${subcmd} (supported: ${supported}).`);
  };

  const identityOperation = subcmd === "identity"
    ? String(context.positional[2] ?? "").trim().toLowerCase()
    : null;
  const createStatus = subcmd === "create"
    && String(context.positional[2] ?? "").trim().toLowerCase() === "status";
  const readOnly = subcmd === "status" || identityOperation === "status" || createStatus;
  if (readOnly) return dispatch();

  if (subcmd === "create" && targetId === "prime") {
    const prepared = await preparePrimeCreateMutation(context, targetId);
    if (prepared.receipt) return prepared.receipt;
    preparedPrimeCreateRequest = prepared.request;
    const withLockImpl = context.withHarnessTargetMutationLockImpl
      ?? withHarnessTargetMutationLock;
    return withLockImpl({
      homeDir: context.homeDir,
      targetPath: prepared.targetPath,
      ...(context.harnessTargetMutationLockOptions
        ? { lockOptions: context.harnessTargetMutationLockOptions }
        : {}),
    }, dispatch);
  }

  const localState = loadLocalState({ homeDir: context.homeDir });
  const adapter = adapterFor(targetId, {
    state: localState,
    homeDir: context.homeDir,
    env: context.env,
  });
  if (targetId === "prime" && adapter.pathConflict && subcmd !== "create") {
    return writePathConflictReceipt(context, `prime_${subcmd}`);
  }
  const directPrimeLaunch = targetId === "prime"
    && (subcmd === "run" || subcmd === "resume");
  // The interactive child can outlive the shell for hours; its lifetime is not a target-mutation critical section.
  if (directPrimeLaunch) return dispatch();
  const withLockImpl = context.withHarnessTargetMutationLockImpl
    ?? withHarnessTargetMutationLock;
  return withLockImpl({
    homeDir: context.homeDir,
    targetPath: adapter.authPath,
    ...(context.harnessTargetMutationLockOptions
      ? { lockOptions: context.harnessTargetMutationLockOptions }
      : {}),
  }, dispatch);
}
