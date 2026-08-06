import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
  publishRedisCredentialPolicyFromState,
  refreshRedisRuntimeState,
} from "../../coordination/runtime.js";
import { findCredentialRecord } from "../../coordination/snapshot.js";
import { isObject, normalizeLabel } from "../../core/normalize.js";
import { parseExpiresAtToMs } from "../../core/time.js";
import { hasCompleteClaudeNativeBundle } from "../../credentials/claude-bundle.js";
import { getAnthropicCredentialView } from "../../credentials/anthropic.js";
import { maintainRedisClaudeCredential } from "../../credentials/claude-maintenance.js";
import { maintainRedisCodexCredential } from "../../credentials/harness-access.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { writeHermesAuthFromState } from "../../targets/hermes-auth.js";

const OAUTH_REAUTH_REQUIRED = "oauth_reauth_required";
const CLAUDE_DUE_WINDOW_MS = 5 * 60_000;
const CODEX_DUE_WINDOW_MS = 48 * 60 * 60_000;
const MAINTAINED_PROVIDERS = new Set([ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER]);

function hasLoadedCredential(record) {
  return isObject(record?.credential) && Object.keys(record.credential).length > 0;
}

function hasCodexRefreshMaterial(credential) {
  return Boolean(
    typeof credential?.refresh === "string"
    && credential.refresh.trim()
    && typeof credential?.accountId === "string"
    && credential.accountId.trim()
  );
}

function hasRequiredRefreshMaterial(record) {
  if (record.provider === ANTHROPIC_PROVIDER) {
    return hasCompleteClaudeNativeBundle(record.credential);
  }
  if (record.provider === OPENAI_CODEX_PROVIDER) {
    return hasCodexRefreshMaterial(record.credential);
  }
  return false;
}

function dueWindowMs(provider) {
  return provider === ANTHROPIC_PROVIDER ? CLAUDE_DUE_WINDOW_MS : CODEX_DUE_WINDOW_MS;
}

function recordExpiryMs(record) {
  const credential = record?.provider === ANTHROPIC_PROVIDER
    ? getAnthropicCredentialView(record?.credential)
    : record?.credential;
  return parseExpiresAtToMs(credential?.expiresAt);
}

function isDue(record, nowMs) {
  const expiresAtMs = recordExpiryMs(record);
  const credential = record?.provider === ANTHROPIC_PROVIDER
    ? getAnthropicCredentialView(record?.credential)
    : record?.credential;
  const access = typeof credential?.access === "string" ? credential.access.trim() : "";
  return !access || expiresAtMs === null || expiresAtMs <= nowMs + dueWindowMs(record.provider);
}

function isTerminallyMarked(record) {
  return record?.policy?.reauth?.blockedReason === OAUTH_REAUTH_REQUIRED;
}

// Single-line, bounded rendering of a failure message for per-label log lines;
// the maintenance messages are state names and guard reasons, not tokens.
function maintenanceFailureDetail(error) {
  const detail = String(error?.message ?? "").replace(/["\s]+/g, " ").trim().slice(0, 160);
  return detail || null;
}

function sortedMaintenanceRecords(snapshot) {
  return (snapshot?.credentials ?? [])
    .filter((record) => MAINTAINED_PROVIDERS.has(record.provider))
    .toSorted((left, right) => {
      const leftExpiry = recordExpiryMs(left) ?? Number.NEGATIVE_INFINITY;
      const rightExpiry = recordExpiryMs(right) ?? Number.NEGATIVE_INFINITY;
      return leftExpiry - rightExpiry
        || `${left.provider}:${left.label}`.localeCompare(`${right.provider}:${right.label}`);
    });
}

async function markReauthRequired(runtime, record, observedAt) {
  const account = runtime.state?.accounts?.[record.label];
  if (!isObject(account) || account.provider !== record.provider) {
    throw new Error(`Cannot mark OAuth reauthentication for ${record.provider}:${record.label}.`);
  }
  account.reauth = {
    ...(isObject(account.reauth) ? account.reauth : {}),
    blockedReason: OAUTH_REAUTH_REQUIRED,
  };
  return publishRedisCredentialPolicyFromState({
    runtime,
    state: runtime.state,
    label: record.label,
    observedAt,
  });
}

async function maintainCodexRecord({
  runtime,
  record,
  nowMs,
  fetchJsonWithTimeoutImpl,
}) {
  const result = await maintainRedisCodexCredential({
    runtime,
    nowMs,
    fetchJsonWithTimeoutImpl,
  }, {
    runtime,
    label: record.label,
    force: true,
    incompleteMeansReauth: true,
  });
  if (result.outcome === "refreshed" || result.outcome === "reauth_required") return result;
  return { outcome: "skipped", reason: result.reason ?? "not_actionable" };
}

async function handleOAuthMaintain(context) {
  const {
    homeDir,
    stdout,
    connectRedisStoreImpl,
    fetchJsonWithTimeoutImpl,
    nowMs,
  } = context;
  if (!isRedisConfigured({ homeDir })) {
    throw new Error("`aim auth maintain` requires Redis.");
  }
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  const counts = {
    refreshed: 0,
    unchanged: 0,
    reauth_required: 0,
    retryable: 0,
    skipped: 0,
  };
  try {
    for (const record of sortedMaintenanceRecords(runtime.snapshot)) {
      let maintenanceResult = null;
      if (
        !hasLoadedCredential(record)
        || isTerminallyMarked(record)
        // Claude applies its own refresh due gate after the per-label lease is held.
        || (record.provider !== ANTHROPIC_PROVIDER && hasRequiredRefreshMaterial(record) && !isDue(record, nowMs))
      ) {
        maintenanceResult = {
          outcome: "skipped",
          reason: !hasLoadedCredential(record)
            ? "credential_missing"
            : isTerminallyMarked(record)
              ? "reauth_already_required"
              : "not_due",
        };
      } else {
        try {
          let outcome;
          let reason = null;
          let detail = null;
          if (record.provider === ANTHROPIC_PROVIDER) {
            const result = await maintainRedisClaudeCredential(context, {
              runtime,
              label: record.label,
            });
            outcome = result.outcome;
            reason = result.reason;
            detail = result.detail ?? null;
          } else if (!hasRequiredRefreshMaterial(record)) {
            await refreshRedisRuntimeState(runtime);
            const current = findCredentialRecord(runtime.snapshot, {
              provider: record.provider,
              label: record.label,
            });
            if (!current || !hasLoadedCredential(current) || isTerminallyMarked(current)) {
              outcome = "skipped";
              reason = !current || !hasLoadedCredential(current)
                ? "credential_missing"
                : "reauth_already_required";
            } else if (record.provider === OPENAI_CODEX_PROVIDER) {
              const codexResult = await maintainCodexRecord({
                runtime,
                record: current,
                nowMs,
                fetchJsonWithTimeoutImpl,
              });
              outcome = codexResult.outcome;
              reason = codexResult.reason;
            } else {
              await markReauthRequired(runtime, current, new Date(nowMs).toISOString());
              outcome = "reauth_required";
              reason = "refresh_material_missing";
            }
          } else {
            const codexResult = await maintainCodexRecord({
              runtime,
              record,
              nowMs,
              fetchJsonWithTimeoutImpl,
            });
            outcome = codexResult.outcome;
            reason = codexResult.reason;
          }
          maintenanceResult = {
            outcome: Object.hasOwn(counts, outcome) ? outcome : "retryable",
            reason: reason
              ?? (outcome === "refreshed"
                ? "credential_rotated"
                : outcome === "reauth_required"
                  ? "refresh_rejected"
                  : outcome === "unchanged"
                    ? "tokens_unchanged"
                    : "not_actionable"),
            ...(detail ? { detail } : {}),
          };
        } catch (error) {
          maintenanceResult = {
            outcome: "retryable",
            reason: "maintenance_failed",
            ...(maintenanceFailureDetail(error) ? { detail: maintenanceFailureDetail(error) } : {}),
          };
        }
      }

      counts[maintenanceResult.outcome] += 1;
      stdout.write(
        `provider=${record.provider} label=${record.label} `
          + `outcome=${maintenanceResult.outcome} reason=${maintenanceResult.reason}`
          + (maintenanceResult.detail ? ` detail="${maintenanceResult.detail}"` : "")
          + `\n`,
      );
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
  stdout.write(
    `refreshed=${counts.refreshed} unchanged=${counts.unchanged} `
      + `reauth_required=${counts.reauth_required} retryable=${counts.retryable} skipped=${counts.skipped}\n`,
  );
  // Per-account retryables are reported, not fatal: the exit code is reserved
  // for the run itself failing (the thrown paths above).
  return counts;
}

export async function handleAuth(context) {
  const { opts, positional, homeDir, stdout, connectRedisStoreImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing auth subcommand. Usage: aim auth maintain | aim auth write hermes <label> --auth-file <abs-path>");
  }
  if (subcmd === "maintain") {
    if (positional.length > 2) {
      throw new Error("`aim auth maintain` does not accept positional arguments.");
    }
    await handleOAuthMaintain(context);
    return;
  }
  if (subcmd !== "write") {
    throw new Error(`Unsupported auth subcommand: ${subcmd} (supported: maintain, write).`);
  }
  const system = String(positional[2] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing auth target. Usage: aim auth write hermes <label> --auth-file <abs-path>");
  }
  if (system !== "hermes") {
    throw new Error(`Unsupported auth target: ${system} (supported: hermes).`);
  }
  const label = normalizeLabel(positional[3]);
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, runtime.state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
  } finally {
    await closeRedisRuntime(runtime);
  }
}
