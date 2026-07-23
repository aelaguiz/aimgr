import path from "node:path";
import { ANTHROPIC_PROVIDER, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { writeStdout } from "../io/streams.js";
import { buildBrowserSetupMenuOptions } from "../browser/wizard.js";
import { describeConcreteBrowserTarget, resolveProviderHomeUrl } from "./state.js";

export function renderLabelControlPanel(panelState, { writeImpl = writeStdout } = {}) {
  const lines = [];
  const provider = panelState.provider || "provider-not-set";
  lines.push(`${panelState.label} · ${provider}`);
  lines.push(`Status: ${panelState.panelKind === "setup" ? "setup needed" : panelState.panelKind}`);
  if (panelState.reason) {
    lines.push(`Why: ${panelState.reason}`);
  }
  lines.push(`${panelState.providerLabel}: ${panelState.credentialHealth}`);
  if (panelState.provider === ANTHROPIC_PROVIDER) {
    lines.push(`Native bundle: ${panelState.nativeBundleComplete ? "complete" : "missing"}`);
  } else {
    lines.push(`Browser: ${panelState.browserSummary}`);
  }
  writeImpl(`${lines.join("\n")}\n\n`);
}

export function buildAnthropicLabelPanelActions(panelState) {
  const actions = [];
  if (panelState.nativeBundleComplete) {
    actions.push({
      key: "1",
      action: "use_native_claude_label",
      label: "Use this label in Claude",
      details: ["Will write this label's native Claude bundle into the managed Claude CLI files now."],
    });
    actions.push({
      key: "2",
      action: "capture_native_claude",
      label: "Capture current native Claude login",
      details: ["Will read the live Claude login files from this host and store them on this label."],
    });
    actions.push({
      key: "3",
      action: "import_native_claude_bundle",
      label: "Import native Claude bundle",
      details: ["Will ask for a portable Claude bundle JSON file path and store it on this label."],
    });
    actions.push({
      key: "4",
      action: "export_live_native_claude_bundle",
      label: "Export current live native bundle",
      details: ["Will ask where to write a portable Claude bundle JSON from the live Claude login on this host."],
    });
    actions.push({
      key: "5",
      action: "show_details",
      label: "Show details",
      details: [`Will print the raw provider, credential, and native Claude state for ${panelState.label}.`],
    });
  } else {
    actions.push({
      key: "1",
      action: "capture_native_claude",
      label: "Capture current native Claude login",
      details: ["Will read the live Claude login files from this host and store them on this label."],
    });
    actions.push({
      key: "2",
      action: "import_native_claude_bundle",
      label: "Import native Claude bundle",
      details: ["Will ask for a portable Claude bundle JSON file path and store it on this label."],
    });
    actions.push({
      key: "3",
      action: "export_live_native_claude_bundle",
      label: "Export current live native bundle",
      details: ["Will ask where to write a portable Claude bundle JSON from the live Claude login on this host."],
    });
    actions.push({
      key: "4",
      action: "show_details",
      label: "Show details",
      details: [`Will print the raw provider, credential, and native Claude state for ${panelState.label}.`],
    });
  }
  actions.push({
    key: "0",
    action: "done",
    label: "Done",
    details: ["Makes no changes."],
  });
  return actions;
}

export function buildLabelPanelActions(panelState, { homeDir, suggestions, discoveryWarning } = {}) {
  if (panelState.provider === ANTHROPIC_PROVIDER) {
    return buildAnthropicLabelPanelActions(panelState);
  }
  if (panelState.panelKind === "setup") {
    return buildBrowserSetupMenuOptions({
      label: panelState.label,
      homeDir,
      suggestions,
      discoveryWarning,
    });
  }

  const actions = [];
  const canReauth = panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK || Boolean(panelState.binding);
  const providerUrl = resolveProviderHomeUrl(panelState.provider);
  const browserTarget = describeConcreteBrowserTarget(panelState.binding);
  if (panelState.panelKind === "reauth" && canReauth) {
    actions.push({
      key: "1",
      action: "reauth_now",
      label: "Reauth now",
      details:
        panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK
          ? [
              "Will try token refresh first.",
              "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
            ]
          : [
              "Will try token refresh first.",
              `If refresh is not enough, AIM will open ${providerUrl || "the provider login page"} using ${browserTarget}.`,
            ],
    });
  }
  if (panelState.binding) {
    actions.push({
      key: String(actions.length + 1),
      action: "open_browser",
      label: "Open browser",
      details: [`Will open ${providerUrl || "the provider home page"} using ${browserTarget}.`],
    });
  }
  if (panelState.panelKind !== "reauth" && canReauth) {
    actions.push({
      key: String(actions.length + 1),
      action: "reauth_now",
      label: "Reauth / refresh login",
      details:
        panelState.reauthMode === REAUTH_MODE_MANUAL_CALLBACK
          ? [
              "Will try token refresh first.",
              "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
            ]
          : [
              "Will try token refresh first.",
              `If refresh is not enough, AIM will open ${providerUrl || "the provider login page"} using ${browserTarget}.`,
            ],
    });
  }
  actions.push({
    key: String(actions.length + 1),
    action: "change_browser_setup",
    label: "Change browser setup",
    details: panelState.binding
      ? [
          `Current browser binding: ${browserTarget}.`,
          `Will reopen setup and only save a different binding for ${panelState.label} if you confirm it.`,
        ]
      : [`Will reopen setup and save a browser/login path for ${panelState.label}.`],
  });
  actions.push({
    key: String(actions.length + 1),
    action: "show_details",
    label: "Show details",
    details: [`Will print the raw provider, credential, and browser-binding JSON for ${panelState.label}.`],
  });
  actions.push({
    key: "0",
    action: "done",
    label: "Done",
    details: ["Makes no changes."],
  });
  return actions;
}
