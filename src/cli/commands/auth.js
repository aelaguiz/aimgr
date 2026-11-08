import { maintainLocalClaudeCredential } from "../../credentials/claude-local-maintenance.js";
import { readClaudeAccountMetadata } from "../../coordination/claude-metadata.js";
import { readClaudeEnvironment } from "../../privacy/claude-environment.js";
import { buildCoordinationView } from "../../coordination/snapshot.js";
import { rememberClaudeProtection } from "../../network/claude-offline-binding.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from "../../core/constants.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
} from "../../coordination/runtime.js";
import { REDIS_CONNECTION_POLICY_LEASED } from "../../coordination/redis-store.js";
import { isObject, normalizeLabel } from "../../core/normalize.js";
import { parseExpiresAtToMs } from "../../core/time.js";
import { getAnthropicCredentialView } from "../../credentials/anthropic.js";
import { maintainRedisClaudeCredential } from "../../credentials/claude-maintenance.js";
import { maintainLocalCodexCredential, readLocalCodexCredential } from "../../credentials/codex-local.js";
import { readCodexAccountMetadata } from "../../coordination/codex-metadata.js";
import { readCodexEnvironment } from "../../privacy/codex-environment.js";
import { hasXaiRefreshMaterial, maintainRedisXaiCredential } from "../../credentials/xai-login.js";

import { sanitizeForStatus } from "../../core/sanitize.js";
import { writeHermesAuthFromState } from "../../targets/hermes-auth.js";

const OAUTH_REAUTH_REQUIRED = "oauth_reauth_required";
const SHARED_DUE_WINDOW_MS = 5 * 60_000;
const MAINTAINED_PROVIDERS = new Set([XAI_PROVIDER]);

function hasLoadedCredential(record) {
  return isObject(record?.credential) && Object.keys(record.credential).length > 0;
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
  return !access || expiresAtMs === null || expiresAtMs <= nowMs + SHARED_DUE_WINDOW_MS;
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
  // Native admission/refresh can outlive a one-shot connection's idle timeout.
  // Keep the existing leased connection policy until publication/release, or
  // successfully refreshed tokens cannot be committed and later accounts fail.
  // This does not relax ownership: each publication still checks the live lease,
  // and leased connections disable offline command queueing on a disconnect.
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl,
    connectionPolicy: REDIS_CONNECTION_POLICY_LEASED, excludeCodexGrants: true, excludeClaudeGrants: true });
  const counts = {
    refreshed: 0,
    unchanged: 0,
    reauth_required: 0,
    retryable: 0,
    skipped: 0,
  };
  try {
    for (const record of sortedMaintenanceRecords(runtime.snapshot)) {
      // Fence old ordinary caches before skip decisions, not just before refresh.
      // A remotely protected but blocked account must remain protected offline.
      // Regression: test/cli/auth-maintain-command.test.js.
      if (record.provider === ANTHROPIC_PROVIDER) rememberClaudeProtection(homeDir, record.label, record);
      let maintenanceResult = null;
      if (
        !hasLoadedCredential(record)
        || isTerminallyMarked(record)
        // Claude applies its own refresh due gate after the per-label lease is held.
        || (record.provider !== ANTHROPIC_PROVIDER && hasXaiRefreshMaterial(record.credential) && !isDue(record, nowMs))
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
          } else if (record.provider === XAI_PROVIDER) {
            const result = await maintainRedisXaiCredential({
              runtime,
              record,
              fetchImpl: context.fetchImpl ?? globalThis.fetch.bind(globalThis),
            });
            outcome = result.outcome;
            reason = result.reason;
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
    let claudeEnvironment;
    try { claudeEnvironment = (context.readClaudeEnvironmentImpl ?? readClaudeEnvironment)(); } catch {}
    if (claudeEnvironment) {
      const metadata = await readClaudeAccountMetadata(runtime.store);
      const state = buildCoordinationView({credentials:metadata}, {localState:runtime.localState,provider:ANTHROPIC_PROVIDER});
      for (const item of metadata) {
        const result = await maintainLocalClaudeCredential(context, {metadata:item,environment:claudeEnvironment,state});
        counts[result.outcome] += 1;
        stdout.write(`provider=${ANTHROPIC_PROVIDER} authority=environment-local label=${item.label} outcome=${result.outcome} reason=${result.reason}\n`);
      }
    }
    // Codex maintenance uses only this environment's independently authorized
    // grant. Redis supplies account metadata, never legacy primary credentials.
    let environment = null;
    try { environment = (context.readCodexEnvironmentImpl ?? readCodexEnvironment)(); } catch { /* No local runtime/grants to maintain. */ }
    if (environment) for (const item of await readCodexAccountMetadata(runtime.store)) {
      if (!item.accountId) continue;
      const options = { homeDir, env: context.env, environment, accountId: item.accountId };
      let outcome, reason;
      try {
        const before = readLocalCodexCredential(options);
        const after = await maintainLocalCodexCredential(options, { fetchJsonWithTimeoutImpl });
        outcome = after.status === "reauth_required" ? "reauth_required" : !after.credential ? "skipped"
          : before.generation !== after.generation ? "refreshed" : "unchanged";
        reason = after.status;
      } catch { outcome = "retryable"; reason = "maintenance_failed"; }
      counts[outcome] += 1;
      stdout.write(`provider=${OPENAI_CODEX_PROVIDER} authority=environment-local label=${item.label} outcome=${outcome} reason=${reason}\n`);
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
