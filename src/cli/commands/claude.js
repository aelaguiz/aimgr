import { ANTHROPIC_PROVIDER } from "../../core/constants.js";
import { normalizeLabel } from "../../core/normalize.js";
import { recordAccountMaintenanceAttempt, recordAccountMaintenanceFailure, recordAccountMaintenanceSuccess } from "../../credentials/anthropic-maintenance.js";
import { captureAnthropicNativeBundleForLabel, exportLiveClaudeNativeBundle, importAnthropicNativeBundleForLabel, resolveAnthropicMaintenanceBlockedReason } from "../../credentials/claude-native.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { resolveCliPath, resolveOptionalSourceHome } from "../../io/paths.js";
import { markImportedAnthropicLabelDirtyState } from "../../state/authority-anthropic.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activateClaudeLabelSelection, activateClaudePoolSelection } from "../../targets/claude-cli.js";

export async function handleClaude(context) {
  const { opts, positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error(
      "Missing claude subcommand. Usage: aim claude use [label] | aim claude capture-native <label> | aim claude export-live --out <file> | aim claude import-native <label> --in <file>",
    );
  }
  if (subcmd === "capture-native") {
    const label = normalizeLabel(positional[2]);
    const sourceHome = resolveOptionalSourceHome(opts.sourceHome, { homeDir });
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
    throw new Error(`Unsupported claude subcommand: ${subcmd} (supported: use, capture-native, export-live, import-native).`);
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
