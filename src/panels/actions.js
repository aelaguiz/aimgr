import path from "node:path";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import { resolveBrowserBinding, setBrowserBinding } from "../browser/bindings.js";
import { discoverSelectableChromeBindings } from "../browser/selectable-profiles.js";
import { launchBrowserBindingForUrl } from "../browser/launch.js";
import { chooseDiscoveredChromeBinding, chooseSuggestedAgentBrowserBinding, loadSuggestedBrowserBindings, runBrowserBindingWizard, showLabelAdvancedDetails } from "../browser/wizard.js";
import { promptLine, promptMenuChoice, promptRequiredLine } from "../io/prompts.js";
import { writeStdout } from "../io/streams.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AIM_PROFILE, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { recordAccountMaintenanceAttempt, recordAccountMaintenanceFailure, recordAccountMaintenanceSuccess } from "../credentials/anthropic-maintenance.js";
import { captureAnthropicNativeBundleForLabel, exportLiveClaudeNativeBundle, importAnthropicNativeBundleForLabel, resolveAnthropicMaintenanceBlockedReason } from "../credentials/claude-native.js";
import { ensureProviderConfiguredForLabel } from "../credentials/oauth.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { resolveCliPath } from "../io/paths.js";
import { formatBrowserLaunchFailure } from "../core/shell.js";
import { readOpenclawAgentsListFromConfig, readOpenclawBindingsFromConfig } from "../openclaw/config.js";
import { performLabelMaintenance, reportPanelActionError } from "./maintenance.js";
import { buildLabelPanelActions, renderLabelControlPanel } from "./render.js";
import { buildLabelControlPanelState, resolveProviderHomeUrl, summarizeBrowserBindingForPanel } from "./state.js";
import { getAccountRecord } from "../state/accounts.js";
import { markImportedAnthropicLabelDirtyState } from "../state/authority-anthropic.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { activateClaudeLabelSelection } from "../targets/claude-cli.js";

function defaultPersistState({ statePath, state }) {
  writeJsonFileWithBackup(statePath, state);
}

export async function runLabelPanelAction({
  action,
  statePath,
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  allowAnthropicNativeMaintenance = true,
  performLabelMaintenanceImpl = performLabelMaintenance,
  activateClaudeLabelSelectionImpl = activateClaudeLabelSelection,
  persistStateImpl = defaultPersistState,
  writeImpl = writeStdout,
}) {
  const normalizedLabel = normalizeLabel(label);
  const persistState = () => persistStateImpl({ statePath, state, label: normalizedLabel });
  if (action === "done") {
    return { done: true };
  }

  if (action === "show_details") {
    showLabelAdvancedDetails({ state, label: normalizedLabel, homeDir, writeImpl });
    return { done: false };
  }

  if (
    action === "capture_native_claude"
    || action === "import_native_claude_bundle"
    || action === "export_live_native_claude_bundle"
    || action === "use_native_claude_label"
  ) {
    if (action === "use_native_claude_label") {
      const activated = activateClaudeLabelSelectionImpl({ state, homeDir, label: normalizedLabel });
      await persistState();
      writeImpl(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n\n`);
      return { done: false };
    }

    const attemptedAt = recordAccountMaintenanceAttempt(state, normalizedLabel, { providerHint: ANTHROPIC_PROVIDER });
    try {
      if (action === "capture_native_claude") {
        const captured = captureAnthropicNativeBundleForLabel({
          state,
          label: normalizedLabel,
          sourceHome: homeDir,
        });
        recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
        await persistState();
        writeImpl(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              captured: {
                label: normalizedLabel,
                sourceHome: captured.sourceHome,
                emailAddress: captured.summary.emailAddress,
                organizationName: captured.summary.organizationName,
                organizationUuid: captured.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n\n`,
        );
        return { done: false };
      }

      if (action === "import_native_claude_bundle") {
        const bundlePath = resolveCliPath(
          await promptLineImpl(`Bundle JSON path for "${normalizedLabel}":`),
          { homeDir, optionName: "bundle path" },
        );
        const imported = importAnthropicNativeBundleForLabel({
          state,
          label: normalizedLabel,
          filePath: bundlePath,
        });
        recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
        markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
        await persistState();
        writeImpl(
          `${JSON.stringify(
            sanitizeForStatus({
              ok: true,
              imported: {
                label: normalizedLabel,
                filePath: imported.filePath,
                sourceHome: imported.sourceHome,
                emailAddress: imported.summary.emailAddress,
                organizationName: imported.summary.organizationName,
                organizationUuid: imported.summary.organizationUuid,
              },
            }),
            null,
            2,
          )}\n\n`,
        );
        return { done: false };
      }

      if (action === "export_live_native_claude_bundle") {
        const outPath = resolveCliPath(
          await promptLineImpl(`Write native Claude bundle for "${normalizedLabel}" to:`, {
            defaultValue: path.join(homeDir, `${normalizedLabel}.claude-native-bundle.json`),
          }),
          { homeDir, optionName: "bundle output path" },
        );
        const exported = exportLiveClaudeNativeBundle({
          filePath: outPath,
          sourceHome: homeDir,
          labelHint: normalizedLabel,
        });
        writeImpl(
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
          )}\n\n`,
        );
        return { done: false };
      }

    } catch (err) {
      const message = String(err?.message ?? err);
      recordAccountMaintenanceFailure(state, normalizedLabel, {
        observedAt: attemptedAt,
        ...(resolveAnthropicMaintenanceBlockedReason(message)
          ? { blockedReason: resolveAnthropicMaintenanceBlockedReason(message) }
          : {}),
      });
      await persistState();
      reportPanelActionError(err, { writeImpl });
    }
    return { done: false };
  }

  if (action === "open_browser") {
    const account = getAccountRecord(state, normalizedLabel, { create: true });
    const binding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
    if (!binding) {
      writeImpl(`No browser binding is configured for ${normalizedLabel}.\n\n`);
      return { done: false };
    }
    const provider = normalizeProviderId(account.provider);
    const url = resolveProviderHomeUrl(provider);
    if (!url) {
      writeImpl(`No browser home URL is configured for provider=${provider || "unknown"}.\n\n`);
      return { done: false };
    }
    const opened = openUrlImpl({ binding, url, homeDir });
    if (!opened.ok) {
      if (opened.reason === "missing_browser_path") {
        writeImpl(`Configured browser path is missing: ${opened.path}\n\n`);
      } else {
        writeImpl(`Failed to open browser (${formatBrowserLaunchFailure(opened)}).\n\n`);
      }
      return { done: false };
    }
    writeImpl(`Opened ${normalizedLabel} in ${summarizeBrowserBindingForPanel({ binding, reauthMode: account?.reauth?.mode })}.\n\n`);
    return { done: false };
  }

  if (
    action === "setup_agent_browser"
    || action === "setup_aim_profile"
    || action === "setup_chrome_profile"
    || action === "setup_manual_callback"
    || action === "change_browser_setup"
  ) {
    try {
      let configured = null;
      if (action === "setup_aim_profile") {
        configured = { configured: true, updated: setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE }) };
      } else if (action === "setup_chrome_profile") {
        configured = await chooseDiscoveredChromeBinding({
          state,
          label: normalizedLabel,
          candidates: discoverSelectableChromeBindings({ homeDir, label: normalizedLabel }),
          promptLineImpl,
          writeImpl,
        });
      } else if (action === "setup_manual_callback") {
        configured = { configured: true, updated: setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK }) };
      } else if (action === "setup_agent_browser") {
        const { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
          label: normalizedLabel,
          repoRoot,
          readOpenclawBindingsFromConfigImpl,
          readOpenclawAgentsListFromConfigImpl,
        });
        if (discoveryWarning) {
          writeImpl(`Suggestion lookup unavailable: ${discoveryWarning}\n`);
        }
        configured = await chooseSuggestedAgentBrowserBinding({
          state,
          label: normalizedLabel,
          candidates: suggestions,
          promptLineImpl,
          writeImpl,
        });
      } else {
        configured = await runBrowserBindingWizard({
          state,
          label: normalizedLabel,
          homeDir,
          repoRoot,
          promptLineImpl,
          writeImpl,
          readOpenclawBindingsFromConfigImpl,
          readOpenclawAgentsListFromConfigImpl,
        });
      }

      if (!configured?.configured) {
        writeImpl("Browser setup unchanged.\n\n");
        return { done: false };
      }

      await persistState();
      writeImpl(`Saved browser setup for ${normalizedLabel}.\n\n`);

      if (action !== "change_browser_setup") {
        try {
          await performLabelMaintenanceImpl({
            state,
            label: normalizedLabel,
            homeDir,
            promptLineImpl,
            promptImpl,
            openUrlImpl,
            loginOpenAICodexImpl,
            refreshOpenAICodexImpl,
            allowAnthropicNativeMaintenance,
            writeImpl,
          });
          await persistState();
          writeImpl(`${normalizedLabel} is ready.\n\n`);
        } catch (err) {
          await persistState();
          reportPanelActionError(err, { writeImpl });
        }
      }
      return { done: false };
    } catch (err) {
      reportPanelActionError(err, { writeImpl });
      return { done: false };
    }
  }

  if (action === "reauth_now") {
    try {
      await performLabelMaintenanceImpl({
        state,
        label: normalizedLabel,
        homeDir,
        promptLineImpl,
        promptImpl,
        openUrlImpl,
        loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        allowAnthropicNativeMaintenance,
        writeImpl,
      });
      await persistState();
      writeImpl(`${normalizedLabel} is ready.\n\n`);
    } catch (err) {
      await persistState();
      reportPanelActionError(err, { writeImpl });
    }
    return { done: false };
  }

  throw new Error(`Unsupported panel action: ${action}`);
}

export async function runLabelControlPanel({
  statePath,
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  allowAnthropicNativeMaintenance = true,
  performLabelMaintenanceImpl = performLabelMaintenance,
  activateClaudeLabelSelectionImpl = activateClaudeLabelSelection,
  persistStateImpl = defaultPersistState,
  writeImpl = writeStdout,
}) {
  const normalizedLabel = normalizeLabel(label);
  const beforeProvider = getAccountRecord(state, normalizedLabel)?.provider ?? null;
  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: normalizedLabel,
    promptLineImpl,
    writeImpl,
  });
  if (provider && provider !== beforeProvider) {
    await persistStateImpl({ statePath, state, label: normalizedLabel });
  }
  if (provider === ANTHROPIC_PROVIDER && !allowAnthropicNativeMaintenance) {
    throw new Error(
      `Redis-backed Claude maintenance for label=${normalizedLabel} is owned by ` +
        "`aim claude capture-native`, `aim claude import-native`, and `aim claude run`.",
    );
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
      label: normalizedLabel,
      repoRoot,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
    });
    const panelState = buildLabelControlPanelState({
      state,
      label: normalizedLabel,
      homeDir,
    });
    renderLabelControlPanel(panelState, { writeImpl });
    const actions = buildLabelPanelActions(panelState, {
      homeDir,
      suggestions,
      discoveryWarning,
    });
    const choice = await promptMenuChoice({
      title: "What do you want to do?",
      options: actions.map(({ key, label: actionLabel, details }) => ({ key, label: actionLabel, details })),
      promptLineImpl,
      writeImpl,
    });
    const selected = actions.find((action) => action.key === choice);
    const result = await runLabelPanelAction({
      action: selected?.action,
      statePath,
      state,
      label: normalizedLabel,
      homeDir,
      repoRoot,
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      allowAnthropicNativeMaintenance,
      performLabelMaintenanceImpl,
      activateClaudeLabelSelectionImpl,
      persistStateImpl,
      writeImpl,
    });
    if (result?.done) {
      return {
        ok: true,
        label: normalizedLabel,
      };
    }
  }
}
