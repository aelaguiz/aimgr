import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { readClaudeAppStateFile, readClaudeNativeBundle } from "../credentials/claude-bundle.js";
import { getAnthropicCredentialView } from "../credentials/anthropic.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveClaudeAppStatePath, resolveClaudeAuthFilePath, resolveManagedClaudeDir } from "../io/paths.js";
import { getClaudeTargetState } from "../state/accounts.js";
import { getAuthorityAnthropicImport, getImportedAnthropicLabels } from "../state/authority-anthropic.js";
import { ensureStateShape } from "../state/schema.js";
import { resolveClaudeCommand } from "./codex-store.js";

export function inferClaudeAuthMethodFromOverrideEnv(envNames) {
  const names = Array.isArray(envNames) ? envNames : [];
  if (names.includes("CLAUDE_CODE_OAUTH_TOKEN")) return "oauth_token";
  if (names.includes("ANTHROPIC_AUTH_TOKEN") || names.includes("ANTHROPIC_API_KEY")) return "api_key";
  if (names.includes("CLAUDE_CODE_USE_BEDROCK")) return "bedrock";
  if (names.includes("CLAUDE_CODE_USE_VERTEX")) return "vertex";
  if (names.includes("CLAUDE_CODE_USE_FOUNDRY")) return "foundry";
  return "env_override";
}

export function readClaudeAuthStatus({ homeDir, env = {}, spawnImpl = spawnSync } = {}) {
  const commandPath = resolveClaudeCommand({ homeDir, spawnImpl });
  if (!commandPath) {
    return {
      available: false,
      commandPath: null,
    };
  }

  const overrideEnv = readClaudeAuthOverrideEnv({ env });
  if (overrideEnv.length > 0) {
    return {
      available: true,
      commandPath,
      ok: true,
      loggedIn: true,
      authMethod: inferClaudeAuthMethodFromOverrideEnv(overrideEnv),
      apiProvider: "override",
      email: null,
      orgId: null,
      orgName: null,
      subscriptionType: null,
    };
  }

  // Do not shell out to `claude auth status --json` here. On current Claude
  // builds that command is not reliably read-only and can rewrite
  // `~/.claude/.credentials.json` with a sparse payload, which then breaks
  // native-bundle capture. AIM must treat Claude auth status as a file/env
  // readback problem, not an external CLI status problem.
  const readback = readClaudeNativeBundle({ homeDir });
  if (readback.ok !== true) {
    return {
      available: true,
      ok: false,
      commandPath,
      error:
        readback.credentials?.ok === false
          ? String(readback.credentials.error || `Could not read ${readback.credentialsPath}.`)
          : readback.appState?.ok === false
            ? String(readback.appState.error || `Could not read ${readback.appStatePath}.`)
            : "Claude auth files are unreadable.",
    };
  }

  const hasTokens =
    readback.credentials?.claudeAiOauthPresent === true
    && typeof readback.credentials?.accessToken === "string"
    && readback.credentials.accessToken.trim()
    && typeof readback.credentials?.refreshToken === "string"
    && readback.credentials.refreshToken.trim()
    && Number.isFinite(Number(readback.credentials?.expiresAt));
  const hasIdentity = readback.appState?.oauthAccountPresent === true;
  const loggedIn = Boolean(hasTokens && hasIdentity);

  return {
    available: true,
    ok: true,
    commandPath,
    loggedIn,
    authMethod: loggedIn ? "claude.ai" : "none",
    apiProvider: loggedIn ? "firstParty" : "none",
    email:
      typeof readback.appState?.emailAddress === "string" && readback.appState.emailAddress.trim()
        ? readback.appState.emailAddress.trim().toLowerCase()
        : null,
    orgId:
      typeof readback.appState?.organizationUuid === "string" && readback.appState.organizationUuid.trim()
        ? readback.appState.organizationUuid.trim()
        : null,
    orgName:
      typeof readback.appState?.organizationName === "string" && readback.appState.organizationName.trim()
        ? readback.appState.organizationName.trim()
        : null,
    subscriptionType:
      typeof readback.credentials?.subscriptionType === "string" && readback.credentials.subscriptionType.trim()
        ? readback.credentials.subscriptionType.trim()
        : null,
  };
}

export function readClaudeAuthOverrideEnv({ env = {} } = {}) {
  return [
    "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_API_KEY",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_USE_VERTEX",
    "CLAUDE_CODE_USE_FOUNDRY",
  ].filter((name) => String(env[name] ?? "").trim());
}

export function getAnthropicCredentialMatchLabel(state, { accessToken, refreshToken }) {
  ensureStateShape(state);
  const access = typeof accessToken === "string" ? accessToken.trim() : "";
  const refresh = typeof refreshToken === "string" ? refreshToken.trim() : "";
  const refreshMatches = [];
  const accessMatches = [];

  for (const [label, credential] of Object.entries(state.credentials[ANTHROPIC_PROVIDER])) {
    if (!isObject(credential)) continue;
    const view = getAnthropicCredentialView(credential);
    const credentialRefresh = typeof view?.refresh === "string" ? view.refresh.trim() : "";
    const credentialAccess = typeof view?.access === "string" ? view.access.trim() : "";
    if (refresh && credentialRefresh === refresh) {
      refreshMatches.push(label);
    }
    if (access && credentialAccess === access) {
      accessMatches.push(label);
    }
  }

  if (refreshMatches.length === 1) return refreshMatches[0];
  if (refreshMatches.length > 1) return null;
  if (accessMatches.length === 1) return accessMatches[0];
  return null;
}

// Codex and Paperclip both inherit this managed file-backed auth target on the host.
// If AIM cannot pick an eligible pool account, the old file and active-target metadata
// must be cleared so the previous machine account cannot survive as a hidden fallback.

export function clearManagedClaudeCliAuthFiles({ homeDir }) {
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const authPath = resolveClaudeAuthFilePath(claudeDir);
  const appStatePath = resolveClaudeAppStatePath({ homeDir });
  let currentAppState = null;
  if (fs.existsSync(appStatePath)) {
    currentAppState = readClaudeAppStateFile({ homeDir });
    if (currentAppState.ok !== true) {
      throw new Error(`Refusing to mutate unreadable Claude app state file: ${currentAppState.error || appStatePath}`);
    }
  }

  fs.rmSync(authPath, { force: true });
  if (currentAppState) {
    if (isObject(currentAppState.json) && Object.hasOwn(currentAppState.json, "oauthAccount")) {
      const next = { ...currentAppState.json };
      delete next.oauthAccount;
      if (Object.keys(next).length === 0) {
        fs.rmSync(appStatePath, { force: true });
      } else {
        writeJsonFileIfChanged(appStatePath, next, { mode: 0o600 });
      }
    }
  }
}

export function clearManagedClaudeCliTargetState(state) {
  ensureStateShape(state);
  const target = getClaudeTargetState(state);
  delete target.claudeDir;
  delete target.authPath;
  delete target.credentialsPath;
  delete target.appStatePath;
  delete target.lastRunLabel;
  delete target.expectedSubscriptionType;
  delete target.lastAppliedAt;
}

export function clearManagedClaudeCliActivation({ state, homeDir }) {
  clearManagedClaudeCliAuthFiles({ homeDir });
  clearManagedClaudeCliTargetState(state);
}

export function readClaudeCliTargetStatus({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const importMeta = getAuthorityAnthropicImport(state);
  const target = getClaudeTargetState(state);
  const claudeDir = resolveManagedClaudeDir({ homeDir });
  const readback = readClaudeNativeBundle({ homeDir });
  const lastRunLabel = typeof target.lastRunLabel === "string" ? target.lastRunLabel.trim() : "";
  const lastRunCredential = lastRunLabel ? getAnthropicCredential(state, lastRunLabel) : null;
  const expected = getAnthropicCredentialView(lastRunCredential);
  const inferredLabel =
    readback.summary
      ? getAnthropicCredentialMatchLabel(state, {
          accessToken: readback.summary.access,
          refreshToken: readback.summary.refresh,
        })
      : null;
  const authStatus =
    lastRunLabel || readback.exists
      ? readClaudeAuthStatus({ homeDir, env })
      : {
          available: false,
          commandPath: resolveClaudeCommand({ homeDir }),
        };
  const actualSubscriptionType =
    typeof authStatus?.subscriptionType === "string" && authStatus.subscriptionType.trim()
      ? authStatus.subscriptionType.trim()
      : readback.summary?.subscriptionType
        ? readback.summary.subscriptionType
        : null;
  const actualEmailAddress =
    typeof authStatus?.email === "string" && authStatus.email.trim()
      ? authStatus.email.trim().toLowerCase()
      : readback.summary?.emailAddress
        ? readback.summary.emailAddress
        : null;
  const actualOrganizationName =
    typeof authStatus?.orgName === "string" && authStatus.orgName.trim()
      ? authStatus.orgName.trim()
      : readback.summary?.organizationName
        ? readback.summary.organizationName
        : null;
  const actualOrganizationUuid =
    typeof authStatus?.orgId === "string" && authStatus.orgId.trim()
      ? authStatus.orgId.trim()
      : readback.summary?.organizationUuid
        ? readback.summary.organizationUuid
        : null;

  return {
    source: typeof importMeta.source === "string" ? importMeta.source.trim() || null : null,
    importedAt: typeof importMeta.importedAt === "string" ? importMeta.importedAt.trim() || null : null,
    importedLabels: getImportedAnthropicLabels(state),
    claudeDir,
    credentialsPath: readback.credentialsPath,
    appStatePath: readback.appStatePath,
    lastRunLabel: lastRunLabel || null,
    lastRunAccountPresent: lastRunLabel ? isObject(state.accounts[lastRunLabel]) : false,
    lastRunCredentialPresent: lastRunLabel ? isObject(lastRunCredential) : false,
    expectedSubscriptionType: expected?.subscriptionType || null,
    expectedEmailAddress: expected?.emailAddress || null,
    expectedOrganizationName: expected?.organizationName || null,
    expectedOrganizationUuid: expected?.organizationUuid || null,
    actualSubscriptionType,
    actualEmailAddress,
    actualOrganizationName,
    actualOrganizationUuid,
    inferredLabel: inferredLabel || null,
    readback,
    authStatus,
    authOverrideEnv: readClaudeAuthOverrideEnv({ env }),
    lastSelectionReceipt: isObject(target.lastSelectionReceipt) ? target.lastSelectionReceipt : null,
    lastAppliedAt: typeof target.lastAppliedAt === "string" ? target.lastAppliedAt.trim() || null : null,
  };
}

export function buildWarningsFromClaudeTargetStatus(status) {
  const warnings = [];
  if (!status) return warnings;
  const label = status.lastRunLabel;

  if (label && !status.lastRunAccountPresent) {
    warnings.push({
      kind: "claude_target_label_missing",
      system: "claude-cli",
      label,
    });
  }

  if (label && !status.lastRunCredentialPresent) {
    warnings.push({
      kind: "claude_target_credentials_missing",
      system: "claude-cli",
      label,
    });
  }

  if (label && status.readback?.credentials?.exists !== true) {
    warnings.push({
      kind: "claude_target_missing_auth_file",
      system: "claude-cli",
      label,
    });
  }

  if (status.readback?.credentials?.exists === true && status.readback.credentials.ok !== true) {
    warnings.push({
      kind: "claude_target_auth_unreadable",
      system: "claude-cli",
      status: status.readback.credentials.error,
    });
  }

  if (label && status.readback?.credentials?.ok === true && !status.readback.credentials.claudeAiOauthPresent) {
    warnings.push({
      kind: "claude_target_missing_provider_entry",
      system: "claude-cli",
      label,
    });
  }

  if (label && status.readback?.appState?.exists !== true) {
    warnings.push({
      kind: "claude_target_missing_app_state",
      system: "claude-cli",
      label,
    });
  }

  if (status.readback?.appState?.exists === true && status.readback.appState.ok !== true) {
    warnings.push({
      kind: "claude_target_app_state_unreadable",
      system: "claude-cli",
      status: status.readback.appState.error,
    });
  }

  if (label && status.readback?.appState?.ok === true && !status.readback.appState.oauthAccountPresent) {
    warnings.push({
      kind: "claude_target_missing_oauth_account",
      system: "claude-cli",
      label,
    });
  }

  if (
    label
    && status.expectedSubscriptionType
    && status.actualSubscriptionType
    && status.expectedSubscriptionType !== status.actualSubscriptionType
  ) {
    warnings.push({
      kind: "claude_target_subscription_mismatch",
      system: "claude-cli",
      label,
      status: status.actualSubscriptionType,
    });
  }

  if (
    label
    && status.expectedEmailAddress
    && status.actualEmailAddress
    && status.expectedEmailAddress !== status.actualEmailAddress
  ) {
    warnings.push({
      kind: "claude_target_email_mismatch",
      system: "claude-cli",
      label,
      status: status.actualEmailAddress,
    });
  }

  if (
    label
    && status.expectedOrganizationName
    && status.actualOrganizationName
    && status.expectedOrganizationName !== status.actualOrganizationName
  ) {
    warnings.push({
      kind: "claude_target_organization_mismatch",
      system: "claude-cli",
      label,
      status: status.actualOrganizationName,
    });
  }

  if (label && status.inferredLabel && status.inferredLabel !== label) {
    warnings.push({
      kind: "claude_target_label_mismatch",
      system: "claude-cli",
      label,
      actualLabel: status.inferredLabel,
    });
  }

  if (label && status.authStatus?.available === true && status.authStatus.ok !== true) {
    warnings.push({
      kind: "claude_target_status_unreadable",
      system: "claude-cli",
      label,
      status: status.authStatus.error || status.authStatus.status || "unknown",
    });
  }

  if (label && status.authStatus?.ok === true && status.authStatus.loggedIn !== true) {
    warnings.push({
      kind: "claude_target_not_logged_in",
      system: "claude-cli",
      label,
    });
  }

  if (
    label
    && status.authStatus?.ok === true
    && typeof status.authStatus.authMethod === "string"
    && status.authStatus.authMethod
    && status.authStatus.authMethod !== "claude.ai"
  ) {
    warnings.push({
      kind:
        Array.isArray(status.authOverrideEnv) && status.authOverrideEnv.length > 0
          ? "claude_target_env_override"
          : "claude_target_auth_method_mismatch",
      system: "claude-cli",
      label,
      authMethod: status.authStatus.authMethod,
      ...(Array.isArray(status.authOverrideEnv) && status.authOverrideEnv.length > 0
        ? { env: status.authOverrideEnv }
        : {}),
    });
  }

  return warnings;
}
