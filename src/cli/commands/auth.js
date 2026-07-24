import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { acquireRedisCredentialLease } from "../../coordination/redis-credential-lease.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
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
import {
  CodexRefreshInvalidGrantError,
  refreshCodexWithoutBrowser,
} from "../../credentials/codex-login.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { writeHermesAuthFromState } from "../../targets/hermes-auth.js";
import { maintainRedisClaudeCredential } from "./claude.js";

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
  return parseExpiresAtToMs(record?.credential?.expiresAt);
}

function isDue(record, nowMs) {
  const expiresAtMs = recordExpiryMs(record);
  const access = typeof record?.credential?.access === "string" ? record.credential.access.trim() : "";
  return !access || expiresAtMs === null || expiresAtMs <= nowMs + dueWindowMs(record.provider);
}

function isTerminallyMarked(record) {
  return record?.policy?.reauth?.blockedReason === OAUTH_REAUTH_REQUIRED;
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
  const lease = await acquireRedisCredentialLease(runtime.store, {
    provider: OPENAI_CODEX_PROVIDER,
    label: record.label,
  });
  if (!lease) return "skipped";

  let outcome = null;
  let failure = null;
  try {
    await refreshRedisRuntimeState(runtime);
    const current = findCredentialRecord(runtime.snapshot, {
      provider: OPENAI_CODEX_PROVIDER,
      label: record.label,
    });
    if (!current || !hasLoadedCredential(current) || isTerminallyMarked(current)) {
      outcome = "skipped";
    } else if (!hasRequiredRefreshMaterial(current)) {
      if (await lease.renew() !== true) {
        throw new Error(`Codex credential lease was lost before publishing ${record.label}.`);
      }
      await markReauthRequired(runtime, current, new Date(nowMs).toISOString());
      outcome = "reauth_required";
    } else if (!isDue(current, nowMs)) {
      outcome = "skipped";
    } else {
      try {
        const nextCredential = await refreshCodexWithoutBrowser({
          credential: current.credential,
          fetchJsonWithTimeoutImpl,
          nowMs,
        });
        runtime.state.credentials[OPENAI_CODEX_PROVIDER][record.label] = nextCredential;
        if (await lease.renew() !== true) {
          throw new Error(`Codex credential lease was lost before publishing ${record.label}.`);
        }
        const published = await publishMaintainedCredential({
          store: runtime.store,
          snapshot: runtime.snapshot,
          state: runtime.state,
          label: record.label,
          provider: OPENAI_CODEX_PROVIDER,
          observedAt: new Date(nowMs).toISOString(),
        });
        if (!published.ok) {
          throw new Error(`Redis stale_version while publishing Codex credential for label=${record.label}.`);
        }
        outcome = "refreshed";
      } catch (error) {
        if (!(error instanceof CodexRefreshInvalidGrantError)) throw error;
        if (await lease.renew() !== true) {
          throw new Error(`Codex credential lease was lost before publishing ${record.label}.`);
        }
        await markReauthRequired(runtime, current, new Date(nowMs).toISOString());
        outcome = "reauth_required";
      }
    }
  } catch (error) {
    failure = error;
  }

  const released = await lease.release().catch(() => false);
  if (failure) throw failure;
  if (!released) {
    throw new Error(`Codex credential lease was lost before release for label=${record.label}.`);
  }
  return outcome;
}

async function handleOAuthMaintain(context) {
  const {
    homeDir,
    stdout,
    setExitCode,
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
    failed: 0,
    skipped: 0,
  };
  try {
    for (const record of sortedMaintenanceRecords(runtime.snapshot)) {
      if (
        !hasLoadedCredential(record)
        || isTerminallyMarked(record)
        || (hasRequiredRefreshMaterial(record) && !isDue(record, nowMs))
      ) {
        counts.skipped += 1;
        continue;
      }
      try {
        let outcome;
        if (!hasRequiredRefreshMaterial(record)) {
          await refreshRedisRuntimeState(runtime);
          const current = findCredentialRecord(runtime.snapshot, {
            provider: record.provider,
            label: record.label,
          });
          if (!current || !hasLoadedCredential(current) || isTerminallyMarked(current)) {
            outcome = "skipped";
          } else if (record.provider === OPENAI_CODEX_PROVIDER) {
            outcome = await maintainCodexRecord({
              runtime,
              record: current,
              nowMs,
              fetchJsonWithTimeoutImpl,
            });
          } else {
            await markReauthRequired(runtime, current, new Date(nowMs).toISOString());
            outcome = "reauth_required";
          }
        } else if (record.provider === ANTHROPIC_PROVIDER) {
          const result = await maintainRedisClaudeCredential(context, { label: record.label });
          outcome = result.outcome;
        } else {
          outcome = await maintainCodexRecord({
            runtime,
            record,
            nowMs,
            fetchJsonWithTimeoutImpl,
          });
        }
        if (Object.hasOwn(counts, outcome)) {
          counts[outcome] += 1;
        } else {
          counts.failed += 1;
        }
      } catch {
        counts.failed += 1;
      }
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
  stdout.write(
    `refreshed=${counts.refreshed} unchanged=${counts.unchanged} `
      + `reauth_required=${counts.reauth_required} failed=${counts.failed} skipped=${counts.skipped}\n`,
  );
  if (counts.failed > 0) setExitCode(1);
  return counts;
}

export async function handleAuth(context) {
  const { opts, positional, statePath, homeDir, stdout, connectRedisStoreImpl } = context;
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
  if (isRedisConfigured({ homeDir })) {
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, runtime.state);
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
      return;
    } finally {
      await closeRedisRuntime(runtime);
    }
  }
  const state = loadAimgrState(statePath);
  const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
  return;
}
