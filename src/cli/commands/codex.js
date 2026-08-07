import os from "node:os";
import { spawn } from "node:child_process";
import { OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import {
  acquireCodexIdentityCatalogLease,
  assertCodexIdentityWriteAllowed,
  buildCodexDesktopIdentityFingerprint,
  buildReservedCodexIdentityIndex,
  commitCodexIdentityRecordFenced,
  CODEX_DESKTOP_NATIVE_OWNED_STATUS,
  CODEX_DESKTOP_RESERVED_REASON,
  getCodexDesktopReservation,
  listRawCodexIdentityRecords,
} from "../../coordination/codex-identity.js";
import { acquireRedisCredentialLease } from "../../coordination/redis-credential-lease.js";
import { closeRedisRuntime, loadRedisRuntime, publishCodexReconciliation, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { refreshCodexWithoutBrowser } from "../../credentials/codex-login.js";
import { resolveManagedCodexHomeDir, resolveNativeCodexHomeDir } from "../../io/paths.js";
import { getCodexDesktopTargetState } from "../../state/accounts.js";
import { readCodexAuthFile } from "../../targets/codex-store.js";
import { activateCodexLabelSelection, reconcileCodexCliAuth } from "../../targets/codex-cli.js";
import { drainCodexDesktopIdentityCopies } from "../../targets/codex-desktop-drain.js";
import { acquireCodexRunLock } from "../../targets/codex-run-lock.js";

const USAGE = "Usage: aim codex run [label] [-- codex-args...] | aim codex desktop pin <label> | aim codex desktop unpin <label> | aim codex desktop drain <label> [--dry-run]";

function emit(stdout, payload) {
  stdout.write(`${JSON.stringify(sanitizeForStatus(payload), null, 2)}\n`);
}

async function selectManagedCodexLabel(context, { runtime, explicitLabel }) {
  const { homeDir, env, probeUsageSnapshotsByProviderImpl, activateCodexPoolSelectionImpl } = context;
  const reconciliation = reconcileCodexCliAuth({
    state: runtime.state,
    homeDir,
    env,
    observedAt: new Date().toISOString(),
  });
  await publishCodexReconciliation({ runtime, state: runtime.state, reconciliation });

  // Fresh raw reservation scan: an explicit reserved label (or a reserved
  // alias of the same immutable account) must fail closed with zero writes.
  const rawRecords = await listRawCodexIdentityRecords(runtime.store);
  const reservedIndex = buildReservedCodexIdentityIndex(rawRecords);
  if (explicitLabel) {
    const targetRecord = rawRecords.find((record) => record.label === explicitLabel) ?? null;
    assertCodexIdentityWriteAllowed({
      index: reservedIndex,
      label: explicitLabel,
      accountId: targetRecord?.identity?.accountId ?? targetRecord?.credential?.accountId ?? null,
      operation: "codex run selection",
    });
  }

  const activated = explicitLabel
    ? activateCodexLabelSelection({ state: runtime.state, homeDir, env, label: explicitLabel })
    : await activateCodexPoolSelectionImpl({
        state: runtime.state,
        homeDir,
        env,
        probeUsageSnapshotsByProviderImpl,
        selectLeastUsed: true,
      });

  if (activated.status !== "blocked") {
    const selectedLabel = activated.receipt?.label ?? null;
    const selectedRecord = rawRecords.find((record) => record.label === selectedLabel) ?? null;
    assertCodexIdentityWriteAllowed({
      index: reservedIndex,
      label: selectedLabel,
      accountId: selectedRecord?.identity?.accountId ?? null,
      operation: "codex run selection",
    });
  }
  writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
  return { reconciliation, activated };
}

async function handleCodexRun(context) {
  const {
    opts,
    positional,
    homeDir,
    stdout,
    setExitCode,
    connectRedisStoreImpl,
    spawnCodexImpl,
    codexCommand = "codex",
  } = context;
  const explicitLabel = String(positional[2] ?? "").trim() ? normalizeLabel(positional[2]) : null;
  const managedCodexHome = resolveManagedCodexHomeDir({ homeDir });
  const childArgs = Array.isArray(opts.afterDoubleDash) ? opts.afterDoubleDash : [];

  // One non-time-stealable owner lock serializes selection through child exit.
  const lock = acquireCodexRunLock({ managedCodexHome });
  try {
    let selection;
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      selection = await selectManagedCodexLabel(context, { runtime, explicitLabel });
    } finally {
      await closeRedisRuntime(runtime);
    }
    if (selection.activated.status === "blocked") {
      emit(stdout, { ok: false, action: "codex_run", ...selection });
      setExitCode(1);
      return;
    }

    lock.markSpawning();
    const spawnImpl = spawnCodexImpl
      ?? ((command, args, options) => spawn(command, args, options));
    let child;
    try {
      child = spawnImpl(codexCommand, childArgs, {
        stdio: "inherit",
        env: { ...context.env, CODEX_HOME: managedCodexHome },
      });
    } catch (err) {
      lock.markSpawnFailed();
      throw err;
    }
    const exit = await new Promise((resolve, reject) => {
      child.once("error", (err) => {
        lock.markSpawnFailed();
        reject(err);
      });
      child.once("spawn", () => {
        lock.recordChildPid(child.pid);
      });
      child.once("exit", (code, signal) => resolve({ code, signal }));
    });
    emit(stdout, {
      ok: (exit.code ?? 0) === 0 && !exit.signal,
      action: "codex_run",
      label: selection.activated.receipt?.label ?? explicitLabel ?? null,
      reconciliation: selection.reconciliation,
      activated: selection.activated,
      exitCode: exit.code,
      exitSignal: exit.signal ?? null,
    });
    if (exit.code !== 0 || exit.signal) {
      setExitCode(typeof exit.code === "number" && exit.code > 0 ? exit.code : 1);
    }
  } finally {
    lock.release();
  }
}

function findRawRecord(records, label) {
  return records.find((record) => record.label === label && record.provider === OPENAI_CODEX_PROVIDER) ?? null;
}

function recordAccountId(record) {
  const identityAccountId = typeof record?.identity?.accountId === "string" ? record.identity.accountId.trim() : "";
  if (identityAccountId) return identityAccountId;
  const credentialAccountId = typeof record?.credential?.accountId === "string" ? record.credential.accountId.trim() : "";
  return credentialAccountId || null;
}

function blocked(stdout, setExitCode, payload) {
  emit(stdout, { ok: false, ...payload });
  setExitCode(1);
}

async function handleCodexDesktopPin(context) {
  const {
    positional,
    homeDir,
    stdout,
    setExitCode,
    connectRedisStoreImpl,
    refreshCodexWithoutBrowserImpl = refreshCodexWithoutBrowser,
    fetchJsonWithTimeoutImpl,
    hostnameImpl = os.hostname,
  } = context;
  const label = String(positional[3] ?? "").trim();
  if (!label) throw new Error("Usage: aim codex desktop pin <label>");
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();

  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    // Fixed lock order: identity catalog first, then the per-label credential lease.
    const catalogLease = await acquireCodexIdentityCatalogLease(runtime.store);
    if (!catalogLease) {
      blocked(stdout, setExitCode, { action: "codex_desktop_pin", status: "blocked", blockers: [{ reason: "identity_catalog_busy" }] });
      return;
    }
    let credentialLease = null;
    try {
      credentialLease = await acquireRedisCredentialLease(runtime.store, {
        provider: OPENAI_CODEX_PROVIDER,
        label: normalizedLabel,
      });
      if (!credentialLease) {
        blocked(stdout, setExitCode, { action: "codex_desktop_pin", status: "blocked", blockers: [{ reason: "credential_lease_busy" }] });
        return;
      }

      // Fresh raw provider-wide scan under the catalog lease.
      const rawRecords = await listRawCodexIdentityRecords(runtime.store);
      const record = findRawRecord(rawRecords, normalizedLabel);
      if (!record) {
        blocked(stdout, setExitCode, { action: "codex_desktop_pin", status: "blocked", label: normalizedLabel, blockers: [{ reason: "unknown_label" }] });
        return;
      }
      const accountId = recordAccountId(record);
      if (!accountId) {
        blocked(stdout, setExitCode, { action: "codex_desktop_pin", status: "blocked", label: normalizedLabel, blockers: [{ reason: "identity_missing" }] });
        return;
      }

      const existingReservation = getCodexDesktopReservation(record);
      if (existingReservation) {
        emit(stdout, { ok: true, action: "codex_desktop_pin", status: "noop", label: normalizedLabel, reserved: true });
        return;
      }

      // A pre-pin duplicate alias of the same immutable account blocks with zero writes.
      const aliases = rawRecords.filter((other) => other.label !== normalizedLabel && recordAccountId(other) === accountId);
      if (aliases.length > 0) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "identity_alias_conflict", labels: aliases.map((other) => other.label).sort() }],
        });
        return;
      }
      const reservedIndex = buildReservedCodexIdentityIndex(rawRecords);
      if (reservedIndex.has(accountId)) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "identity_already_reserved" }],
        });
        return;
      }

      // Refresh the exact record to prove the Redis identity/lineage is live.
      // The refreshed material is deliberately discarded: pin retires the AIM
      // credential rather than publishing one more secret copy.
      let refreshedAccountId = accountId;
      if (Object.keys(record.credential ?? {}).length > 0) {
        let refreshed;
        try {
          refreshed = await refreshCodexWithoutBrowserImpl({
            credential: record.credential,
            fetchJsonWithTimeoutImpl,
            nowMs: Date.now(),
          });
        } catch (err) {
          blocked(stdout, setExitCode, {
            action: "codex_desktop_pin",
            status: "blocked",
            label: normalizedLabel,
            blockers: [{ reason: "credential_refresh_failed", detail: String(err?.message ?? err) }],
          });
          return;
        }
        refreshedAccountId = typeof refreshed?.accountId === "string" && refreshed.accountId.trim()
          ? refreshed.accountId.trim()
          : null;
      } else {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "credential_missing" }],
        });
        return;
      }
      if (refreshedAccountId !== accountId) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "identity_mismatch_after_refresh" }],
        });
        return;
      }

      // Native Desktop home is read-only here: verify the desktop is actually
      // signed into the same immutable account before reserving it.
      const nativeHome = resolveNativeCodexHomeDir({ homeDir });
      const native = readCodexAuthFile({ codexHome: nativeHome });
      if (native.ok !== true || !native.accountId) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "native_auth_unreadable" }],
        });
        return;
      }
      if (native.accountId !== accountId) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "native_identity_mismatch" }],
        });
        return;
      }

      const identityFingerprint = buildCodexDesktopIdentityFingerprint(accountId);
      const ownerHost = String(hostnameImpl() ?? "").trim() || "unknown-host";
      const reservedRecord = {
        ...record,
        credential: {},
        identity: { accountId },
        policy: {
          ...record.policy,
          expect: {
            ...(record.policy?.expect ?? {}),
            codexDesktop: {
              reserved: true,
              ownerHost,
              identityFingerprint,
              reservedAt: observedAt,
            },
          },
          pool: {
            enabled: false,
            disabledReason: CODEX_DESKTOP_RESERVED_REASON,
          },
        },
        health: {
          status: CODEX_DESKTOP_NATIVE_OWNED_STATUS,
          reason: CODEX_DESKTOP_RESERVED_REASON,
        },
      };
      const committed = await commitCodexIdentityRecordFenced(catalogLease, {
        expectedVersion: record.version,
        credentialRecord: reservedRecord,
        updatedBy: runtime.updatedBy,
        observedAt,
      });
      if (!committed.ok) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_pin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: committed.code === "catalog_lease_lost" ? "identity_catalog_lease_lost" : "stale_record_version" }],
        });
        return;
      }

      const desktopTarget = getCodexDesktopTargetState(runtime.state);
      desktopTarget.expectedLabel = normalizedLabel;
      desktopTarget.identityFingerprint = identityFingerprint;
      desktopTarget.pinnedAt = observedAt;
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });

      emit(stdout, {
        ok: true,
        action: "codex_desktop_pin",
        status: "reserved",
        label: normalizedLabel,
        ownerHost,
        reservedAt: observedAt,
        credentialRetired: true,
      });
    } finally {
      if (credentialLease) await credentialLease.release().catch(() => {});
      await catalogLease.release().catch(() => {});
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleCodexDesktopUnpin(context) {
  const {
    positional,
    homeDir,
    stdout,
    setExitCode,
    connectRedisStoreImpl,
    hostnameImpl = os.hostname,
  } = context;
  const label = String(positional[3] ?? "").trim();
  if (!label) throw new Error("Usage: aim codex desktop unpin <label>");
  const normalizedLabel = normalizeLabel(label);
  const observedAt = new Date().toISOString();

  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const catalogLease = await acquireCodexIdentityCatalogLease(runtime.store);
    if (!catalogLease) {
      blocked(stdout, setExitCode, { action: "codex_desktop_unpin", status: "blocked", blockers: [{ reason: "identity_catalog_busy" }] });
      return;
    }
    let credentialLease = null;
    try {
      credentialLease = await acquireRedisCredentialLease(runtime.store, {
        provider: OPENAI_CODEX_PROVIDER,
        label: normalizedLabel,
      });
      if (!credentialLease) {
        blocked(stdout, setExitCode, { action: "codex_desktop_unpin", status: "blocked", blockers: [{ reason: "credential_lease_busy" }] });
        return;
      }

      const rawRecords = await listRawCodexIdentityRecords(runtime.store);
      const record = findRawRecord(rawRecords, normalizedLabel);
      if (!record) {
        blocked(stdout, setExitCode, { action: "codex_desktop_unpin", status: "blocked", label: normalizedLabel, blockers: [{ reason: "unknown_label" }] });
        return;
      }
      const reservation = getCodexDesktopReservation(record);
      if (!reservation) {
        emit(stdout, { ok: true, action: "codex_desktop_unpin", status: "noop", label: normalizedLabel, reserved: false });
        return;
      }
      const ownerHost = String(hostnameImpl() ?? "").trim() || "unknown-host";
      if (reservation.ownerHost !== ownerHost) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_unpin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "owner_host_mismatch" }],
        });
        return;
      }
      const accountId = recordAccountId(record);
      if (!accountId || reservation.identityFingerprint !== buildCodexDesktopIdentityFingerprint(accountId)) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_unpin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: "identity_fingerprint_mismatch" }],
        });
        return;
      }

      const nextExpect = { ...(record.policy?.expect ?? {}) };
      delete nextExpect.codexDesktop;
      const releasedRecord = {
        ...record,
        credential: {},
        policy: {
          ...record.policy,
          expect: nextExpect,
          // The retired credential is never restored by unpin; a fresh
          // `aim login <label>` is required before this account re-enters AIM.
          pool: { enabled: false },
        },
        health: { status: "candidate", reason: "credential_missing" },
      };
      const committed = await commitCodexIdentityRecordFenced(catalogLease, {
        expectedVersion: record.version,
        credentialRecord: releasedRecord,
        updatedBy: runtime.updatedBy,
        observedAt,
      });
      if (!committed.ok) {
        blocked(stdout, setExitCode, {
          action: "codex_desktop_unpin",
          status: "blocked",
          label: normalizedLabel,
          blockers: [{ reason: committed.code === "catalog_lease_lost" ? "identity_catalog_lease_lost" : "stale_record_version" }],
        });
        return;
      }

      const desktopTarget = getCodexDesktopTargetState(runtime.state);
      delete desktopTarget.expectedLabel;
      delete desktopTarget.identityFingerprint;
      delete desktopTarget.pinnedAt;
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });

      emit(stdout, {
        ok: true,
        action: "codex_desktop_unpin",
        status: "released",
        label: normalizedLabel,
        credentialRestored: false,
      });
    } finally {
      if (credentialLease) await credentialLease.release().catch(() => {});
      await catalogLease.release().catch(() => {});
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
}

/**
 * Identity-targeted local cleanup for the quiescent migration: removes raw
 * credential copies of the exact reserved account from OpenClaw/Hermes active
 * stores, AIM-created backups, and displaced Pi/Prime harness backups on this
 * host. Never creates a replacement secret backup; `--dry-run` scans only.
 */
async function handleCodexDesktopDrain(context) {
  const { opts, positional, homeDir, stdout, setExitCode, connectRedisStoreImpl } = context;
  const label = String(positional[3] ?? "").trim();
  if (!label) throw new Error("Usage: aim codex desktop drain <label> [--dry-run]");
  const normalizedLabel = normalizeLabel(label);
  const dryRun = opts.dryRun === true;

  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  let receipt;
  try {
    const rawRecords = await listRawCodexIdentityRecords(runtime.store);
    receipt = drainCodexDesktopIdentityCopies({
      homeDir,
      label: normalizedLabel,
      records: rawRecords,
      dryRun,
    });
  } finally {
    await closeRedisRuntime(runtime);
  }
  const unreadable = (receipt?.openclaw?.unreadable ?? 0)
    + (receipt?.hermes?.unreadable ?? 0)
    + (receipt?.harnessBackups?.unreadable ?? 0);
  emit(stdout, { ok: unreadable === 0, label: normalizedLabel, ...receipt });
  if (unreadable > 0) setExitCode(1);
}

export async function handleCodex(context) {
  const { positional } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error(`Missing codex subcommand. ${USAGE}`);
  }
  if (subcmd === "use" || subcmd === "watch") {
    throw new Error(
      `\`aim codex ${subcmd}\` was removed: the managed Codex home has exactly one writer. ${USAGE}`,
    );
  }
  if (subcmd === "run") {
    await handleCodexRun(context);
    return;
  }
  if (subcmd === "desktop") {
    const desktopCmd = String(positional[2] ?? "").trim().toLowerCase();
    if (desktopCmd === "pin") {
      await handleCodexDesktopPin(context);
      return;
    }
    if (desktopCmd === "unpin") {
      await handleCodexDesktopUnpin(context);
      return;
    }
    if (desktopCmd === "drain") {
      await handleCodexDesktopDrain(context);
      return;
    }
    throw new Error(`Unsupported codex desktop subcommand: ${desktopCmd || "(none)"}. ${USAGE}`);
  }
  throw new Error(`Unsupported codex subcommand: ${subcmd}. ${USAGE}`);
}
