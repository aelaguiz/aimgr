import { loginOpenAICodex, refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import { launchBrowserBindingForUrl } from "../browser/launch.js";
import { promptLine, promptRequiredLine } from "../io/prompts.js";
import { writeStdout } from "../io/streams.js";
import { normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, REAUTH_MODE_MANUAL_CALLBACK, SCHEMA_VERSION } from "../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { maintainAnthropicNativeLabel, recordAccountMaintenanceAttempt, recordAccountMaintenanceFailure, recordAccountMaintenanceSuccess } from "../credentials/anthropic-maintenance.js";
import { ensureAnthropicLabelConfigured, resolveAnthropicMaintenanceBlockedReason } from "../credentials/claude-native.js";
import { ensureOpenAICodexInteractiveLoginBinding, refreshOrLoginCodex } from "../credentials/codex-login.js";
import { ensureProviderConfiguredForLabel } from "../credentials/oauth.js";
import { syncHermesHomesForLabel } from "../pool/hermes-rebalance.js";
import { getAuthorityAnthropicImport, markImportedAnthropicLabelDirtyState } from "../state/authority-anthropic.js";
import { getAuthorityCodexImport, markImportedCodexLabelDirtyState } from "../state/authority-codex.js";
import { getAccountRecord, getAccountReauthState } from "../state/accounts.js";

function configureManualCallbackStdioProvider({ state, label }) {
  const account = getAccountRecord(state, label, { create: true });
  const existingProvider = normalizeProviderId(account?.provider);
  if (existingProvider && existingProvider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(
      `--manual-callback-stdio only supports ${OPENAI_CODEX_PROVIDER} labels; label=${label} is provider=${existingProvider}.`,
    );
  }
  account.provider = OPENAI_CODEX_PROVIDER;

  const reauth = getAccountReauthState(state, label, { create: true });
  const hasSavedBrowserBinding = Boolean(account.browser) && typeof account.browser === "object" && !Array.isArray(account.browser);
  if (!normalizeInteractiveOAuthMode(reauth.mode) && !hasSavedBrowserBinding) {
    reauth.mode = REAUTH_MODE_MANUAL_CALLBACK;
  }
  return OPENAI_CODEX_PROVIDER;
}

export async function performLabelMaintenance({
  state,
  label,
  homeDir,
  promptLineImpl = promptLine,
  promptImpl = promptRequiredLine,
  openUrlImpl = launchBrowserBindingForUrl,
  loginOpenAICodexImpl = loginOpenAICodex,
  refreshOpenAICodexImpl = refreshOpenAICodexToken,
  allowAnthropicNativeMaintenance = true,
  manualCallbackAutomation = null,
  writeImpl = writeStdout,
}) {
  const normalizedLabel = normalizeLabel(label);
  const provider = manualCallbackAutomation
    ? configureManualCallbackStdioProvider({ state, label: normalizedLabel })
    : await ensureProviderConfiguredForLabel({
        state,
        label: normalizedLabel,
        promptLineImpl,
        writeImpl,
      });
  const attemptedAt = recordAccountMaintenanceAttempt(state, normalizedLabel, { providerHint: provider });
  let hermesSync = {
    status: "noop",
    checkedHomeCount: 0,
    matchedHomeCount: 0,
    syncedHomeIds: [],
    writes: [],
  };
  let authorityPromotion = {
    imported: false,
    dirty: false,
  };

  try {
    if (provider === OPENAI_CODEX_PROVIDER) {
      const interactiveBinding = manualCallbackAutomation
        ? { mode: REAUTH_MODE_MANUAL_CALLBACK }
        : await ensureOpenAICodexInteractiveLoginBinding({
            state,
            label: normalizedLabel,
            homeDir,
            promptLineImpl,
            writeImpl,
          });
      const cred = await refreshOrLoginCodex({
        state,
        label: normalizedLabel,
        homeDir,
        interactiveBinding,
        loginImpl: loginOpenAICodexImpl,
        refreshImpl: refreshOpenAICodexImpl,
        promptImpl,
        openUrlImpl,
        manualCallbackAutomation,
        writeImpl,
      });
      state.credentials[OPENAI_CODEX_PROVIDER][normalizedLabel] = cred;
    } else if (provider === ANTHROPIC_PROVIDER) {
      if (!allowAnthropicNativeMaintenance) {
        throw new Error(
          `Redis-backed Claude maintenance for label=${normalizedLabel} is owned by ` +
            "`aim claude capture-native`, `aim claude import-native`, and `aim claude run`.",
        );
      }
      ensureAnthropicLabelConfigured(state, normalizedLabel);
      const cred = await maintainAnthropicNativeLabel({
        state,
        label: normalizedLabel,
        homeDir,
      });
      state.credentials[ANTHROPIC_PROVIDER][normalizedLabel] = cred;
    } else {
      throw new Error(`Provider not supported: ${provider}`);
    }

    recordAccountMaintenanceSuccess(state, normalizedLabel, { homeDir, observedAt: attemptedAt });
    if (provider === OPENAI_CODEX_PROVIDER) {
      authorityPromotion = markImportedCodexLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
    } else if (provider === ANTHROPIC_PROVIDER) {
      authorityPromotion = markImportedAnthropicLabelDirtyState(state, normalizedLabel, { observedAt: attemptedAt });
    }
    if (provider === OPENAI_CODEX_PROVIDER) {
      hermesSync = syncHermesHomesForLabel({
        state,
        label: normalizedLabel,
        homeDir,
      });
    }
    state.schemaVersion = SCHEMA_VERSION;
    return {
      ok: true,
      label: normalizedLabel,
      provider,
      maintenance: {
        status: "ready",
        observedAt: attemptedAt,
      },
      ...(authorityPromotion.imported
        ? {
            authorityPromotion: {
              dirty: authorityPromotion.dirty,
              ...(authorityPromotion.dirty
                ? {
                    status: "pending_publish",
                    target:
                      provider === OPENAI_CODEX_PROVIDER
                        ? (typeof getAuthorityCodexImport(state).source === "string" ? getAuthorityCodexImport(state).source : null)
                        : (typeof getAuthorityAnthropicImport(state).source === "string" ? getAuthorityAnthropicImport(state).source : null),
                  }
                : { status: "clean" }),
            },
          }
        : {}),
      hermesSync,
    };
  } catch (err) {
    const message = String(err?.message ?? err);
    const anthropicBlockedReason =
      provider === ANTHROPIC_PROVIDER ? resolveAnthropicMaintenanceBlockedReason(message) : null;
    recordAccountMaintenanceFailure(state, normalizedLabel, {
      observedAt: attemptedAt,
      ...(anthropicBlockedReason
        ? { blockedReason: anthropicBlockedReason }
        : message.match(/conflict|does not match|unsupported/i)
          ? { blockedReason: message }
          : {}),
    });
    state.schemaVersion = SCHEMA_VERSION;
    throw err;
  }
}

export function reportPanelActionError(err, { writeImpl = writeStdout } = {}) {
  writeImpl(`${String(err?.message ?? err)}\n\n`);
}
