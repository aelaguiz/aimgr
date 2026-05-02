import { buildSuggestedAgentBrowserDetails, discoverSuggestedBrowserBindings } from "./agent-browser.js";
import { setBrowserBinding, showBrowserBinding } from "./bindings.js";
import { buildChromeProfileChoiceDetails, buildChromeProfileChoiceLabel, resolveAimBrowserUserDataDir } from "./chrome.js";
import { buildChromeSetupOptionDetails, discoverSelectableChromeBindings } from "./selectable-profiles.js";
import { getAnthropicCredential, getCodexCredential } from "./seed.js";
import { promptLine, promptMenuChoice } from "../io/prompts.js";
import { writeStdout } from "../io/streams.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { readOpenclawAgentsListFromConfig, readOpenclawBindingsFromConfig } from "../openclaw/config.js";
import { getAccountRecord } from "../state/accounts.js";

export function buildBrowserSetupMenuOptions({ label, homeDir, suggestions, discoveryWarning }) {
  const normalizedLabel = normalizeLabel(label);
  const suggested = Array.isArray(suggestions) ? suggestions : [];
  const topSuggestion = suggested[0] ?? null;
  const aimPath = resolveAimBrowserUserDataDir({ homeDir, label: normalizedLabel });
  const agentBrowserOption = topSuggestion
    ? {
        key: "1",
        action: "setup_agent_browser",
        label: "Use the likely agent browser",
        details: buildSuggestedAgentBrowserDetails(topSuggestion, {
          label: normalizedLabel,
          prefix: "Next screen will offer",
        }),
      }
    : {
        key: "1",
        action: "setup_agent_browser",
        label: "Use an agent-browser profile",
        details: [
          `Will ask for an explicit agent-browser profile path and session, then save them for ${normalizedLabel}.`,
          ...(discoveryWarning
            ? [`AIM could not prefill a likely match because suggestion lookup failed: ${discoveryWarning}`]
            : []),
        ],
      };

  return [
    agentBrowserOption,
    {
      key: "2",
      action: "setup_aim_profile",
      label: "Use an AIM browser",
      details: [`Will save AIM browser path ${aimPath} and then start login for ${normalizedLabel}.`],
    },
    {
      key: "3",
      action: "setup_chrome_profile",
      label: "Use another Chrome profile",
      details: buildChromeSetupOptionDetails({ label: normalizedLabel, homeDir }),
    },
    {
      key: "4",
      action: "setup_manual_callback",
      label: "Manual callback login",
      details: [
        `Will not use a local browser for ${normalizedLabel}.`,
        "If refresh is not enough, AIM will print the auth URL and ask you to paste the callback URL.",
      ],
    },
    {
      key: "5",
      action: "show_details",
      label: "Show advanced details",
      details: [`Will print the raw provider, credential, and browser-binding JSON for ${normalizedLabel}.`],
    },
    {
      key: "0",
      action: "done",
      label: "Cancel",
      details: ["Makes no changes."],
    },
  ];
}

export function showLabelAdvancedDetails({ state, label, homeDir, writeImpl = writeStdout }) {
  const normalizedLabel = normalizeLabel(label);
  const account = getAccountRecord(state, normalizedLabel);
  const provider = normalizeProviderId(account?.provider);
  const credential =
    provider === OPENAI_CODEX_PROVIDER
      ? getCodexCredential(state, normalizedLabel)
      : provider === ANTHROPIC_PROVIDER
        ? getAnthropicCredential(state, normalizedLabel)
        : null;
  const details = {
    label: normalizedLabel,
    provider: provider || null,
    account,
    credential,
    browser: showBrowserBinding({ state, label: normalizedLabel, homeDir }),
    liveClaude: provider === ANTHROPIC_PROVIDER ? readClaudeNativeBundle({ homeDir }) : null,
  };
  writeImpl(`${JSON.stringify(sanitizeForStatus(details), null, 2)}\n\n`);
}

export async function promptMappedChromeBinding({
  state,
  label,
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
}) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const userDataDir = await promptLineImpl(`Chrome user-data-dir for "${label}" (absolute path):`);
    const profileDirectory = await promptLineImpl(
      `Chrome profile-directory for "${label}" (blank for Default):`,
      { defaultValue: "" },
    );
    try {
      const updated = setBrowserBinding({
        state,
        label,
        mode: BROWSER_MODE_CHROME_PROFILE,
        userDataDir,
        profileDirectory: String(profileDirectory ?? "").trim() || null,
      });
      return { configured: true, updated };
    } catch (err) {
      writeImpl(`${String(err?.message ?? err)}\n`);
    }
  }
}

export async function chooseDiscoveredChromeBinding({
  state,
  label,
  candidates,
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return promptMappedChromeBinding({ state, label, promptLineImpl, writeImpl });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const options = candidates.map((candidate, index) => ({
      key: String(index + 1),
      label: buildChromeProfileChoiceLabel(candidate),
      details: buildChromeProfileChoiceDetails(candidate, {
        label,
        prefix: "Will save",
      }),
    }));
    const manualKey = String(candidates.length + 1);
    options.push({
      key: manualKey,
      label: "Enter another Chrome user-data-dir/profile-directory",
      details: [
        `Will ask for an absolute Chrome user-data-dir and optional profile-directory, then save them for ${label}.`,
      ],
    });
    options.push({ key: "0", label: "Back", details: ["Makes no changes."] });
    const choice = await promptMenuChoice({
      title: `Discovered Chrome profiles for ${label}`,
      options,
      promptLineImpl,
      writeImpl,
    });
    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === manualKey) {
      return promptMappedChromeBinding({ state, label, promptLineImpl, writeImpl });
    }

    const candidate = candidates[Number(choice) - 1];
    const confirm = await promptMenuChoice({
      title: `Use this Chrome profile for ${label}?`,
      options: [
        {
          key: "1",
          label: "Yes, save it",
          details: buildChromeProfileChoiceDetails(candidate, {
            label,
            prefix: "Will save",
          }),
        },
        { key: "0", label: "Back", details: ["Makes no changes."] },
      ],
      promptLineImpl,
      writeImpl,
    });
    if (confirm !== "1") {
      continue;
    }

    const updated = setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_CHROME_PROFILE,
      userDataDir: candidate.userDataDir,
      profileDirectory: candidate.profileDirectory,
    });
    return { configured: true, updated, candidate };
  }
}

export async function promptManualAgentBrowserBinding({
  state,
  label,
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
}) {
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const agentBrowserProfile = await promptLineImpl(`agent-browser profile path for "${label}" (absolute path):`);
    const agentBrowserSession = await promptLineImpl(`agent-browser session for "${label}":`);
    try {
      const updated = setBrowserBinding({
        state,
        label,
        mode: BROWSER_MODE_AGENT_BROWSER,
        agentBrowserProfile,
        agentBrowserSession,
      });
      return { configured: true, updated };
    } catch (err) {
      writeImpl(`${String(err?.message ?? err)}\n`);
    }
  }
}

export async function chooseSuggestedAgentBrowserBinding({
  state,
  label,
  candidates,
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
}) {
  if (!Array.isArray(candidates) || candidates.length === 0) {
    return promptManualAgentBrowserBinding({ state, label, promptLineImpl, writeImpl });
  }

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const options = candidates.map((candidate, index) => ({
      key: String(index + 1),
      label: candidate.display,
      details: buildSuggestedAgentBrowserDetails(candidate, {
        label,
        prefix: "Will save",
      }),
    }));
    const manualKey = String(candidates.length + 1);
    options.push({
      key: manualKey,
      label: "Enter another agent-browser profile/session",
      details: [`Will ask for an explicit profile path and session, then save them for ${label}.`],
    });
    options.push({ key: "0", label: "Back", details: ["Makes no changes."] });
    const choice = await promptMenuChoice({
      title: `Suggested browser bindings for ${label}`,
      options,
      promptLineImpl,
      writeImpl,
    });
    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === manualKey) {
      return promptManualAgentBrowserBinding({ state, label, promptLineImpl, writeImpl });
    }

    const candidate = candidates[Number(choice) - 1];
    const confirm = await promptMenuChoice({
      title: `Use this browser binding for ${label}?`,
      options: [
        {
          key: "1",
          label: "Yes, save it",
          details: buildSuggestedAgentBrowserDetails(candidate, {
            label,
            prefix: "Will save",
          }),
        },
        { key: "0", label: "Back", details: ["Makes no changes."] },
      ],
      promptLineImpl,
      writeImpl,
    });
    if (confirm !== "1") {
      continue;
    }

    const updated = setBrowserBinding({
      state,
      label,
      mode: BROWSER_MODE_AGENT_BROWSER,
      agentBrowserProfile: candidate.agentBrowserProfile,
      agentBrowserSession: candidate.agentBrowserSession,
    });
    return { configured: true, updated, candidate };
  }
}

export function loadSuggestedBrowserBindings({
  label,
  repoRoot,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
}) {
  try {
    return {
      suggestions: discoverSuggestedBrowserBindings({
        label,
        repoRoot,
        bindings: readOpenclawBindingsFromConfigImpl(),
        agentsList: readOpenclawAgentsListFromConfigImpl(),
      }),
      discoveryWarning: null,
    };
  } catch (err) {
    return {
      suggestions: [],
      discoveryWarning: String(err?.message ?? err),
    };
  }
}

export async function runBrowserBindingWizard({
  state,
  label,
  homeDir,
  repoRoot,
  promptLineImpl = promptLine,
  writeImpl = writeStdout,
  readOpenclawBindingsFromConfigImpl = readOpenclawBindingsFromConfig,
  readOpenclawAgentsListFromConfigImpl = readOpenclawAgentsListFromConfig,
}) {
  const normalizedLabel = normalizeLabel(label);
  let { suggestions, discoveryWarning } = loadSuggestedBrowserBindings({
    label: normalizedLabel,
    repoRoot,
    readOpenclawBindingsFromConfigImpl,
    readOpenclawAgentsListFromConfigImpl,
  });

  // eslint-disable-next-line no-constant-condition
  while (true) {
    if (discoveryWarning) {
      writeImpl(`Suggestion lookup unavailable: ${discoveryWarning}\n`);
      discoveryWarning = null;
    }

    const choice = await promptMenuChoice({
      title: "What do you want to do?",
      options: buildBrowserSetupMenuOptions({
        label: normalizedLabel,
        homeDir,
        suggestions,
        discoveryWarning,
      }).map(({ key, label: optionLabel, details }) => ({ key, label: optionLabel, details })),
      promptLineImpl,
      writeImpl,
    });

    if (choice === "0") {
      return { configured: false, cancelled: true };
    }
    if (choice === "5") {
      showLabelAdvancedDetails({ state, label: normalizedLabel, homeDir, writeImpl });
      continue;
    }
    if (choice === "4") {
      const updated = setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK });
      return { configured: true, updated };
    }
    if (choice === "2") {
      const updated = setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE });
      return { configured: true, updated };
    }
    if (choice === "3") {
      return chooseDiscoveredChromeBinding({
        state,
        label: normalizedLabel,
        candidates: discoverSelectableChromeBindings({ homeDir, label: normalizedLabel }),
        promptLineImpl,
        writeImpl,
      });
    }

    const result = await chooseSuggestedAgentBrowserBinding({
      state,
      label: normalizedLabel,
      candidates: suggestions,
      promptLineImpl,
      writeImpl,
    });
    if (!result.cancelled) {
      return result;
    }
  }
}
