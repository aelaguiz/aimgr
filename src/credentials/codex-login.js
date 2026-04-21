import path from "node:path";
import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import { ensureAccountShape, normalizeInteractiveOAuthMode, resolveBrowserBinding, setBrowserBinding } from "../browser/bindings.js";
import { resolveAimBrowserUserDataDir } from "../browser/chrome.js";
import { launchBrowserBindingForUrl } from "../browser/launch.js";
import { assertMappedBrowserBindingExists, assertNoCodexAccountIdCollisions, ensureAimBrowserProfileBinding, getCodexCredential, getRepairBindingCommand } from "../browser/seed.js";
import { toIsoFromExpiresMs } from "../core/time.js";
import { promptLine, promptRequiredLine } from "../io/prompts.js";
import { ANTHROPIC_PROVIDER, BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK } from "../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { resolveBrowserModeSelectionFromInput, resolveOpenAICodexInteractiveLoginModeFromInput } from "./oauth.js";
import { formatBrowserLaunchFailure } from "../core/shell.js";
import { getAccountRecord, getInteractiveOAuthBindingForLabel } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export async function ensureInteractiveLoginBindingForProvider({
  state,
  label,
  homeDir,
  provider,
  promptLineImpl = promptLine,
  writeImpl = () => {},
}) {
  if (normalizeProviderId(provider) === ANTHROPIC_PROVIDER) {
    throw new Error(
      `Claude labels now use native Claude bundle capture/import only. ` +
        `Use \`aim claude capture-native ${normalizeLabel(label)}\`, \`aim claude import-native ${normalizeLabel(label)} --in <file>\`, or \`aim ${normalizeLabel(label)}\`.`,
    );
  }
  const normalizedLabel = normalizeLabel(label);
  ensureStateShape(state);
  const account = getAccountRecord(state, normalizedLabel, { create: true });
  ensureAccountShape(account, { providerHint: provider });
  const existing = getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  const existingMode = normalizeInteractiveOAuthMode(existing?.mode);

  if (existingMode === REAUTH_MODE_MANUAL_CALLBACK) {
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  if (existingMode === REAUTH_MODE_BROWSER_MANAGED) {
    const existingBinding = resolveBrowserBinding({ account, homeDir, label: normalizedLabel });
    if (!existingBinding) {
      writeImpl(`Label "${normalizedLabel}" is browser-managed but has no explicit browser binding yet.\n`);
    } else if (existingBinding?.mode === BROWSER_MODE_AIM_PROFILE) {
      await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir, promptLineImpl, writeImpl });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    } else {
      assertMappedBrowserBindingExists({ label: normalizedLabel, binding: existingBinding });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    }
  }

  if (!existingMode) {
    writeImpl(`No interactive login mode configured for label "${normalizedLabel}" yet.\n`);
    writeImpl("Choose login mode:\n");
    writeImpl("  1) browser-managed\n");
    writeImpl("  2) manual-callback\n\n");
    const answer = await promptLineImpl(`Login mode for "${normalizedLabel}" (1-2 or id) [1]:`, {
      defaultValue: "1",
    });
    const selectedReauthMode = resolveOpenAICodexInteractiveLoginModeFromInput(answer);
    if (!selectedReauthMode) {
      throw new Error(`Unsupported login mode selection for label=${normalizedLabel}: ${answer}`);
    }

    if (selectedReauthMode === REAUTH_MODE_MANUAL_CALLBACK) {
      setBrowserBinding({ state, label: normalizedLabel, mode: REAUTH_MODE_MANUAL_CALLBACK });
      return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
    }
  }

  writeImpl(`Browser mode for "${normalizedLabel}"?\n`);
  writeImpl("  1) AIM-managed profile\n");
  writeImpl("  2) mapped Chrome profile\n");
  writeImpl("  3) mapped agent-browser profile\n\n");
  const browserModeAnswer = await promptLineImpl(`Browser mode for "${normalizedLabel}" (1-3 or id) [1]:`, {
    defaultValue: "1",
  });
  const browserMode = resolveBrowserModeSelectionFromInput(browserModeAnswer);
  if (!browserMode) {
    throw new Error(`Unsupported browser mode selection for label=${normalizedLabel}: ${browserModeAnswer}`);
  }

  if (browserMode === BROWSER_MODE_AIM_PROFILE) {
    setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_AIM_PROFILE });
    await ensureAimBrowserProfileBinding({ state, label: normalizedLabel, homeDir, promptLineImpl, writeImpl });
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  if (browserMode === BROWSER_MODE_CHROME_PROFILE) {
    const userDataDir = await promptLineImpl(`Chrome user-data-dir for "${normalizedLabel}" (absolute path):`);
    setBrowserBinding({ state, label: normalizedLabel, mode: BROWSER_MODE_CHROME_PROFILE, userDataDir });
    return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
  }

  const agentBrowserProfile = await promptLineImpl(`agent-browser profile path for "${normalizedLabel}" (absolute path):`);
  const agentBrowserSession = await promptLineImpl(`agent-browser session for "${normalizedLabel}":`);
  setBrowserBinding({
    state,
    label: normalizedLabel,
    mode: BROWSER_MODE_AGENT_BROWSER,
    agentBrowserProfile,
    agentBrowserSession,
  });
  return getInteractiveOAuthBindingForLabel(state, normalizedLabel);
}

export async function ensureOpenAICodexInteractiveLoginBinding({
  state,
  label,
  homeDir,
  promptLineImpl = promptLine,
  writeImpl = () => {},
}) {
  return ensureInteractiveLoginBindingForProvider({
    state,
    label,
    homeDir,
    provider: OPENAI_CODEX_PROVIDER,
    promptLineImpl,
    writeImpl,
  });
}

export async function refreshOrLoginCodex({
  state,
  label,
  homeDir,
  interactiveBinding,
  loginImpl = loginOpenAICodex,
  refreshImpl = refreshOpenAICodexToken,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  writeImpl = () => {},
  }) {
  const existing = getCodexCredential(state, label);
  const existingRefresh = existing && typeof existing.refresh === "string" ? existing.refresh : null;
  const existingAccountId = existing && typeof existing.accountId === "string" ? existing.accountId : null;
  const binding = interactiveBinding ?? getInteractiveOAuthBindingForLabel(state, label);
  const bindingMode = normalizeInteractiveOAuthMode(binding?.mode);
  const browserBinding =
    bindingMode === REAUTH_MODE_BROWSER_MANAGED
      ? (() => {
          const resolved = resolveBrowserBinding({ account: getAccountRecord(state, label), homeDir, label });
          if (resolved?.mode === BROWSER_MODE_AIM_PROFILE) {
            return { ...resolved, userDataDir: resolveAimBrowserUserDataDir({ homeDir, label }) };
          }
          return assertMappedBrowserBindingExists({ label, binding: resolved });
        })()
      : null;

  // Try refresh first (fast + no browser).
  if (existingRefresh) {
    try {
      const updated = await refreshImpl(existingRefresh);
      const accountId = typeof updated?.accountId === "string" ? updated.accountId : "";
      if (!accountId) {
        throw new Error("refresh returned no accountId");
      }
      if (existingAccountId && existingAccountId !== accountId) {
        throw new Error(`refresh produced different accountId (${accountId}) than existing (${existingAccountId})`);
      }
      const expiresAt = toIsoFromExpiresMs(updated.expires);
      if (!expiresAt) {
        throw new Error("refresh returned no expires");
      }

      assertNoCodexAccountIdCollisions(state, label, accountId);

      return {
        access: updated.access,
        refresh: updated.refresh,
        expiresAt,
        accountId,
        idToken: updated.access,
      };
    } catch (err) {
      writeImpl(`Refresh failed for ${label}; falling back to OAuth login (${String(err?.message ?? err)}).\n`);
    }
  }

  const manualCallbackPrompt = async () =>
    await promptImpl(
      'Paste the full callback URL from your browser address bar (looks like "http://localhost:1455/auth/callback?code=...&state=..."):',
    );

  // Full OAuth login.
  const creds = await loginImpl({
    onAuth: ({ url }) => {
      writeImpl(`OAuth URL:\n${url}\n\n`);

      if (bindingMode === REAUTH_MODE_MANUAL_CALLBACK) {
        writeImpl(
          [
            "Open this URL in the browser on your laptop and complete login there.",
            "When the browser lands on the localhost callback page, copy the full URL from the address bar and paste it here.",
            "",
          ].join("\n"),
        );
        return;
      }

      if (!browserBinding) {
        throw new Error(`Missing browser binding for label=${label}.`);
      }

      const opened = openUrlImpl({ binding: browserBinding, url, homeDir });
      if (opened.ok) {
        return;
      }

      if (opened.reason === "missing_browser_path") {
        throw new Error(
          `Configured browser binding for label=${label} is missing on disk: ${opened.path}. ` +
            `Repair it with \`${getRepairBindingCommand(label)}\`.`,
        );
      }

      if (opened.reason === "missing_agent_browser_session") {
        throw new Error(
          `Configured agent-browser binding for label=${label} is missing its session. ` +
            `Repair it with \`aim browser set ${label} --mode agent-browser --profile <abs-path> --session <name>\`.`,
        );
      }

      if (opened.reason === "missing_user_data_dir") {
        throw new Error(
          `Configured Chrome binding for label=${label} is incomplete. ` +
            `Repair it with \`${getRepairBindingCommand(label)}\`.`,
        );
      }

      writeImpl(
        [
          `Failed to auto-open configured browser binding (${formatBrowserLaunchFailure(opened)}).`,
          "Open the URL manually in the exact configured browser identity:",
          ...(browserBinding.mode === BROWSER_MODE_AGENT_BROWSER
            ? [
                `  agent-browser profile: ${browserBinding.agentBrowserProfile}`,
                `  agent-browser session: ${browserBinding.agentBrowserSession}`,
              ]
            : [`  user-data dir: ${browserBinding.userDataDir}`]),
          "",
        ].join("\n") + "\n",
      );
    },
    ...(bindingMode === REAUTH_MODE_MANUAL_CALLBACK
      ? {
          onManualCodeInput: manualCallbackPrompt,
          onPrompt: manualCallbackPrompt,
        }
      : {
          onPrompt: async () => {
            throw new Error(
              "Manual redirect-url paste flow is not supported for browser-managed labels. " +
                "Run on the Mac host with the configured browser binding so the localhost callback can complete.",
            );
          },
        }),
    originator: "aimgr",
  });

  const accountId = typeof creds?.accountId === "string" ? creds.accountId : "";
  if (!accountId) {
    throw new Error("OAuth succeeded but no accountId was returned. Refusing to store ambiguous credentials.");
  }
  const expiresAt = toIsoFromExpiresMs(creds.expires);
  if (!expiresAt) {
    throw new Error("OAuth succeeded but no expires was returned. Refusing to store ambiguous credentials.");
  }

  assertNoCodexAccountIdCollisions(state, label, accountId);

  return {
    access: creds.access,
    refresh: creds.refresh,
    expiresAt,
    accountId,
    idToken: creds.access,
  };
}
