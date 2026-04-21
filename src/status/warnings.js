import { normalizeInteractiveOAuthMode, resolveBrowserBindingDisplay } from "../browser/bindings.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs } from "../core/time.js";
import { buildDirtyImportedAnthropicLabels, buildDirtyImportedCodexLabels } from "../credentials/codex-portable.js";
import { getInteractiveOAuthBindingForLabel, getOpenclawAssignments } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function buildWarningsFromState(state) {
  const warnings = [];

  ensureStateShape(state);
  const accounts = isObject(state.accounts) ? state.accounts : {};
  const codexCredsByLabel = state.credentials[OPENAI_CODEX_PROVIDER];
  const anthropicCredsByLabel = state.credentials[ANTHROPIC_PROVIDER];

  // Missing creds
  for (const [label, account] of Object.entries(accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    if (provider === OPENAI_CODEX_PROVIDER && !isObject(codexCredsByLabel[label])) {
      warnings.push({ kind: "missing_credentials", provider: OPENAI_CODEX_PROVIDER, label });
    }
    if (provider === ANTHROPIC_PROVIDER && !isObject(anthropicCredsByLabel[label])) {
      warnings.push({ kind: "missing_credentials", provider: ANTHROPIC_PROVIDER, label });
    }
  }

  // Collisions (accountId -> multiple labels)
  const byAccountId = new Map();
  for (const [label, cred] of Object.entries(codexCredsByLabel)) {
    if (!isObject(cred)) continue;
    const accountId = typeof cred.accountId === "string" ? cred.accountId : null;
    if (!accountId) continue;
    const list = byAccountId.get(accountId) ?? [];
    list.push(label);
    byAccountId.set(accountId, list);
  }
  for (const [accountId, labels] of byAccountId.entries()) {
    if (labels.length > 1) {
      warnings.push({ kind: "account_id_collision", provider: OPENAI_CODEX_PROVIDER, accountId, labels });
    }
  }

  for (const label of buildDirtyImportedCodexLabels(state)) {
    warnings.push({ kind: "local_update_not_promoted", provider: OPENAI_CODEX_PROVIDER, label });
  }
  for (const label of buildDirtyImportedAnthropicLabels(state)) {
    warnings.push({ kind: "local_update_not_promoted", provider: ANTHROPIC_PROVIDER, label });
  }

  // Stored assignments pointing to missing labels/creds
  const assignments = getOpenclawAssignments(state);
  for (const [agentId, label] of Object.entries(assignments)) {
    if (typeof label !== "string") continue;
    if (!isObject(accounts[label])) {
      warnings.push({ kind: "assignment_points_to_missing_account", system: "openclaw", agentId, label });
      continue;
    }
    const provider = normalizeProviderId(accounts[label]?.provider);
    if (provider === OPENAI_CODEX_PROVIDER) {
      if (!isObject(codexCredsByLabel[label])) {
        warnings.push({ kind: "assignment_points_to_missing_credentials", system: "openclaw", agentId, label });
      }
      continue;
    }
    if (provider === ANTHROPIC_PROVIDER) {
      if (!isObject(anthropicCredsByLabel[label])) {
        warnings.push({
          kind: "assignment_points_to_missing_credentials",
          system: "openclaw",
          agentId,
          label,
          provider,
        });
      }
      continue;
    }

    warnings.push({ kind: "assignment_points_to_unsupported_provider", system: "openclaw", agentId, label, provider });
  }

  return warnings;
}

export function buildWarningsFromStatusAccounts(accounts, { now = Date.now() } = {}) {
  const warnings = [];

  for (const account of Array.isArray(accounts) ? accounts : []) {
    if (!account) continue;
    const provider = normalizeProviderId(account.provider);
    const label = typeof account.label === "string" ? account.label : null;
    if (!label) continue;

    const expiresAt =
      account.credentials && typeof account.credentials.expiresAt === "string" ? account.credentials.expiresAt : null;
    const expiresMs = expiresAt ? parseExpiresAtToMs(expiresAt) : null;
    if (expiresMs !== null && expiresMs <= now) {
      warnings.push({
        kind: "credentials_expired",
        provider: provider || "unknown",
        label,
        expiresAt,
      });
    }

    const usage = account.usage;
    if (isObject(usage) && usage.ok !== true && usage.missingScope) {
      warnings.push({
        kind: "usage_scope_missing",
        provider: provider || "unknown",
        label,
        missingScope: true,
        ...(usage.status ? { status: usage.status } : {}),
      });
    }
    if (isObject(usage) && usage.ok !== true && usage.tokenExpired) {
      warnings.push({
        kind: "token_invalid_or_expired",
        provider: provider || "unknown",
        label,
        ...(usage.status ? { status: usage.status } : {}),
      });
    }

    if (provider === ANTHROPIC_PROVIDER && isObject(usage) && usage.ok === true && usage.opusUnavailable) {
      warnings.push({
        kind: "anthropic_opus_usage_unavailable",
        provider: ANTHROPIC_PROVIDER,
        label,
      });
    }
  }

  return warnings;
}

export function buildInteractiveLoginStatus({ state, label }) {
  const binding = getInteractiveOAuthBindingForLabel(state, label);
  const mode = normalizeInteractiveOAuthMode(binding?.mode);
  return mode
    ? {
        mode,
        bindingPresent: Boolean(binding?.binding),
        ...(binding?.binding ? { binding: resolveBrowserBindingDisplay(binding.binding) } : {}),
      }
    : null;
}
