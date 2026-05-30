import fs from "node:fs";
import { ANTHROPIC_PROVIDER } from "../../core/constants.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, publishRedisStateSession, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { publishMaintainedLabelSession } from "../../coordination/login-publish.js";
import { normalizeLabel } from "../../core/normalize.js";
import { recordAccountMaintenanceAttempt, recordAccountMaintenanceFailure, recordAccountMaintenanceSuccess } from "../../credentials/anthropic-maintenance.js";
import { captureAnthropicNativeBundleForLabel, exportLiveClaudeNativeBundle, importAnthropicNativeBundleForLabel, resolveAnthropicMaintenanceBlockedReason, syncLiveClaudeRotationBackToLabel } from "../../credentials/claude-native.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { resolveAimgrClaudeLabelHomeDir, resolveCliPath, resolveOptionalSourceHome } from "../../io/paths.js";
import { markImportedAnthropicLabelDirtyState } from "../../state/authority-anthropic.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activateClaudeLabelSelection, activateClaudePoolSelection } from "../../targets/claude-cli.js";
import { runClaudeCli } from "../../targets/claude-runner.js";

async function handleRedisClaudeCaptureNative(context, { label, sourceHome }) {
  const { homeDir, stdout, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  const attemptedAt = recordAccountMaintenanceAttempt(runtime.state, label, { providerHint: ANTHROPIC_PROVIDER });
  try {
    const captured = captureAnthropicNativeBundleForLabel({
      state: runtime.state,
      label,
      sourceHome,
    });
    recordAccountMaintenanceSuccess(runtime.state, label, { homeDir, observedAt: attemptedAt });
    const published = await publishMaintainedLabelSession({
      store: runtime.store,
      snapshot: runtime.snapshot,
      state: runtime.state,
      label,
      provider: ANTHROPIC_PROVIDER,
      machineId: runtime.machineId,
      observedAt: attemptedAt,
    });
    if (!published.ok) {
      throw new Error(`Redis stale_version while publishing Claude native bundle for label=${label}; reload and retry.`);
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          captured: {
            label,
            sourceHome: captured.sourceHome,
            emailAddress: captured.summary.emailAddress,
            organizationName: captured.summary.organizationName,
            organizationUuid: captured.summary.organizationUuid,
          },
        }),
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    recordAccountMaintenanceFailure(runtime.state, label, {
      observedAt: attemptedAt,
      ...(resolveAnthropicMaintenanceBlockedReason(message)
        ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
        : {}),
    });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    throw err;
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleRedisClaudeImportNative(context, { label, inFile }) {
  const { homeDir, stdout, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  const attemptedAt = recordAccountMaintenanceAttempt(runtime.state, label, { providerHint: ANTHROPIC_PROVIDER });
  try {
    const imported = importAnthropicNativeBundleForLabel({
      state: runtime.state,
      label,
      filePath: inFile,
    });
    recordAccountMaintenanceSuccess(runtime.state, label, { homeDir, observedAt: attemptedAt });
    const published = await publishMaintainedLabelSession({
      store: runtime.store,
      snapshot: runtime.snapshot,
      state: runtime.state,
      label,
      provider: ANTHROPIC_PROVIDER,
      machineId: runtime.machineId,
      observedAt: attemptedAt,
    });
    if (!published.ok) {
      throw new Error(`Redis stale_version while publishing Claude native bundle for label=${label}; reload and retry.`);
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          imported: {
            label,
            filePath: imported.filePath,
            sourceHome: imported.sourceHome,
            emailAddress: imported.summary.emailAddress,
            organizationName: imported.summary.organizationName,
            organizationUuid: imported.summary.organizationUuid,
          },
        }),
        null,
        2,
      )}\n`,
    );
  } catch (err) {
    const message = String(err?.message ?? err);
    recordAccountMaintenanceFailure(runtime.state, label, {
      observedAt: attemptedAt,
      ...(resolveAnthropicMaintenanceBlockedReason(message)
        ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
        : {}),
    });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    throw err;
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleRedisClaudeRun(context) {
  const { opts, positional, homeDir, env, stdout, setExitCode, connectRedisStoreImpl, runClaudeCliImpl = runClaudeCli } = context;
  const label = normalizeLabel(positional[2]);
  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  fs.mkdirSync(claudeHome, { recursive: true });
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const activated = activateClaudeLabelSelection({ state: runtime.state, homeDir: claudeHome, env, label });
    const preSwitchSync = activated?.receipt?.preSwitchSync;
    if (preSwitchSync?.synced === true && preSwitchSync.label) {
      await publishRedisStateSession({
        runtime,
        state: runtime.state,
        provider: ANTHROPIC_PROVIDER,
        label: preSwitchSync.label,
        observedAt: new Date().toISOString(),
        lineageMode: "native-claude-rotation",
      });
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    if (activated.status === "blocked") {
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, activated }), null, 2)}\n`);
      setExitCode(1);
      return;
    }

    const launched = runClaudeCliImpl({
      homeDir: claudeHome,
      args: opts.afterDoubleDash,
      env,
    });
    const postRunSync = syncLiveClaudeRotationBackToLabel({ state: runtime.state, homeDir: claudeHome });
    if (postRunSync.synced === true && postRunSync.label) {
      await publishRedisStateSession({
        runtime,
        state: runtime.state,
        provider: ANTHROPIC_PROVIDER,
        label: postRunSync.label,
        observedAt: new Date().toISOString(),
        lineageMode: "native-claude-rotation",
      });
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: launched.status === 0,
          claudeRun: {
            label,
            homeDir: claudeHome,
            activated,
            launched,
            postRunSync,
          },
        }),
        null,
        2,
      )}\n`,
    );
    if (launched.status !== 0) {
      setExitCode(launched.status);
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
}

export async function handleClaude(context) {
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error(
      "Missing claude subcommand. Usage: aim claude run <label> [-- <claude args...>] | aim claude capture-native <label> | aim claude export-live --out <file> | aim claude import-native <label> --in <file>",
    );
  }
  if (subcmd === "run") {
    if (!isRedisConfigured({ homeDir })) {
      throw new Error("`aim claude run <label>` requires Redis. Run `aim redis configure --url redis://amirs-mac-studio:6380 --primary-host agents@amirs-mac-studio`.");
    }
    await handleRedisClaudeRun(context);
    return;
  }
  if (subcmd === "capture-native") {
    const label = normalizeLabel(positional[2]);
    const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
    if (isRedisConfigured({ homeDir })) {
      await handleRedisClaudeCaptureNative(context, { label, sourceHome });
      return;
    }
    const state = loadAimgrState(statePath);
    const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
    try {
      const captured = captureAnthropicNativeBundleForLabel({
        state,
        label,
        sourceHome,
      });
      recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
      markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
      writeJsonFileWithBackup(statePath, state);
      stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            captured: {
              label,
              sourceHome: captured.sourceHome,
              emailAddress: captured.summary.emailAddress,
              organizationName: captured.summary.organizationName,
              organizationUuid: captured.summary.organizationUuid,
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
  }
  if (subcmd === "export-live") {
    const outFile = resolveCliPath(opts.outFile, { homeDir, optionName: "--out" });
    const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
    const exported = exportLiveClaudeNativeBundle({
      filePath: outFile,
      sourceHome,
    });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          exported: {
            filePath: exported.filePath,
            sourceHome: exported.sourceHome,
            emailAddress: exported.summary.emailAddress,
            organizationName: exported.summary.organizationName,
            organizationUuid: exported.summary.organizationUuid,
            wrote: exported.wrote,
          },
        }),
        null,
        2,
      )}\n`,
    );
    return;
  }
  if (subcmd === "import-native") {
    const label = normalizeLabel(positional[2]);
    const inFile = resolveCliPath(opts.inFile, { homeDir, optionName: "--in" });
    if (isRedisConfigured({ homeDir })) {
      await handleRedisClaudeImportNative(context, { label, inFile });
      return;
    }
    const state = loadAimgrState(statePath);
    const attemptedAt = recordAccountMaintenanceAttempt(state, label, { providerHint: ANTHROPIC_PROVIDER });
    try {
      const imported = importAnthropicNativeBundleForLabel({
        state,
        label,
        filePath: inFile,
      });
      recordAccountMaintenanceSuccess(state, label, { homeDir, observedAt: attemptedAt });
      markImportedAnthropicLabelDirtyState(state, label, { observedAt: attemptedAt });
      writeJsonFileWithBackup(statePath, state);
      stdout.write(
        `${JSON.stringify(
          sanitizeForStatus({
            ok: true,
            imported: {
              label,
              filePath: imported.filePath,
              sourceHome: imported.sourceHome,
              emailAddress: imported.summary.emailAddress,
              organizationName: imported.summary.organizationName,
              organizationUuid: imported.summary.organizationUuid,
            },
          }),
          null,
          2,
        )}\n`,
      );
      return;
    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, label, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
      writeJsonFileWithBackup(statePath, state);
      throw err;
    }
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported claude subcommand: ${subcmd} (supported: run, use, capture-native, export-live, import-native).`);
  }
  if (isRedisConfigured({ homeDir })) {
    throw new Error("`aim claude use` was retired for Redis installs. Use `aim claude run <label> [-- <claude args...>]`.");
  }
  const state = loadAimgrState(statePath);
  const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
  const activated = explicitLabel
    ? activateClaudeLabelSelection({ state, homeDir, env, label: explicitLabel })
    : await activateClaudePoolSelection({ state, homeDir, env, probeUsageSnapshotsByProviderImpl });
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
  if (activated.status === "blocked") {
    setExitCode(1);
  }
  return;
}
