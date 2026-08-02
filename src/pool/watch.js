import { DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { resolveCodexWatchThresholdPct } from "../core/watch-options.js";
import { activateCodexPoolSelection, buildCodexWatchNonfatalWarnings, buildCodexWatchTargetBlockers, getPrimaryRemainingPctFromUsageSnapshot, readCodexCliTargetStatus } from "../targets/codex-cli.js";
import { buildHermesAssignmentsByHome, rebalanceHermesPool } from "./hermes-rebalance.js";
import { buildHermesHomeBlockers, buildWarningsFromHermesHomeStatus, discoverHermesHomes, readHermesHomeStatus } from "./token-usage.js";
import { collectCodexPoolStatus, getCodexPoolLabels } from "./ranking.js";
import { ensureFileBackedCodexHome } from "../targets/codex-store.js";
import { ensureStateShape } from "../state/schema.js";
import { getCodexTargetState, getHermesFleetState } from "../state/accounts.js";
import { isObject } from "../core/normalize.js";
import { collectCodexUsageSnapshots, probeUsageSnapshotsByProvider } from "./usage.js";
import { resolveManagedCodexHomeDir } from "../io/paths.js";
import { sanitizeForStatus } from "../core/sanitize.js";

function buildUsageUnavailableBlocker({ reason, label, homeId, usage }) {
  const blocker = {
    reason,
  };
  if (typeof homeId === "string" && homeId.trim()) {
    blocker.homeId = homeId.trim();
  }
  if (typeof label === "string" && label.trim()) {
    blocker.label = label.trim();
  }
  if (
    (typeof usage?.status === "string" && usage.status.trim())
    || Number.isFinite(Number(usage?.status))
  ) {
    blocker.status = usage.status;
  }
  if (typeof usage?.error === "string" && usage.error.trim()) {
    blocker.detail = usage.error.trim();
  }
  if (usage?.tokenExpired === true) {
    blocker.tokenExpired = true;
  }
  if (usage?.missingScope === true) {
    blocker.missingScope = true;
  }
  return blocker;
}

export async function watchCodexPoolSelectionOnce(
  {
    state,
    homeDir,
    env = {},
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
  },
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
  } = {},
) {
  ensureStateShape(state);
  // Watch mode owns the threshold decision and receipt, but it must never invent
  // a second auth writer. Weighted selection and auth mutation still flow through
  // activateCodexPoolSelection() -> applyCodexCliFromState().
  ensureFileBackedCodexHome({ codexHome: resolveManagedCodexHomeDir({ homeDir, env }) });
  const effectiveThresholdPct = resolveCodexWatchThresholdPct(thresholdPct);
  const observedAt = new Date().toISOString();
  const usageByProvider = await collectCodexUsageSnapshots({
    state,
    homeDir,
    env,
    nowMs: Date.parse(observedAt),
    probeUsageSnapshotsByProviderImpl,
  });
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const currentTarget = readCodexCliTargetStatus({ state, homeDir, env });
  const target = getCodexTargetState(state);
  const currentLabelBefore = currentTarget.inferredLabel || currentTarget.activeLabel || null;
  const warnings = buildCodexWatchNonfatalWarnings(currentTarget);

  if (!currentLabelBefore) {
    const poolLabels = getCodexPoolLabels(state);
    if (poolLabels.length === 0) {
      const receipt = {
        action: "codex_watch",
        status: "blocked",
        observedAt,
        thresholdPct: effectiveThresholdPct,
        currentLabelBefore: null,
        currentLabelAfter: currentTarget.inferredLabel || null,
        primaryRemainingPctBefore: null,
        triggeredSelection: false,
        warnings,
        blockers: [{ reason: "no_pool_account_available" }],
      };
      target.lastWatchReceipt = receipt;
      return { status: "blocked", receipt, wrote: false };
    }

    const selection = await activateCodexPoolSelectionImpl({
      state,
      homeDir,
      env,
      observedAt,
      usageByProvider,
    });
    const postTarget = readCodexCliTargetStatus({ state, homeDir, env });
    const receipt = {
      action: "codex_watch",
      status: selection.status,
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore: null,
      currentLabelAfter: postTarget.inferredLabel || postTarget.activeLabel || null,
      primaryRemainingPctBefore: null,
      triggeredSelection: true,
      selectionReceipt: selection.receipt,
      warnings: [...warnings, ...(Array.isArray(selection.receipt?.warnings) ? selection.receipt.warnings : [])],
      blockers: Array.isArray(selection.receipt?.blockers) ? selection.receipt.blockers : [],
    };
    target.lastWatchReceipt = receipt;
    return { status: selection.status, receipt, wrote: Boolean(selection.wrote) };
  }

  const targetBlockers = buildCodexWatchTargetBlockers(currentTarget);
  if (targetBlockers.length > 0) {
    const receipt = {
      action: "codex_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore: null,
      triggeredSelection: false,
      warnings,
      blockers: targetBlockers,
    };
    target.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  const activeUsage = usageByLabel[currentLabelBefore] ?? null;
  const primaryRemainingPctBefore = getPrimaryRemainingPctFromUsageSnapshot(activeUsage);
  if (primaryRemainingPctBefore === null) {
    const blockers = [
      buildUsageUnavailableBlocker({
        reason: "active_target_usage_unavailable",
        label: currentLabelBefore,
        usage: activeUsage,
      }),
    ];
    const receipt = {
      action: "codex_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore: null,
      triggeredSelection: false,
      warnings,
      blockers,
    };
    target.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  if (primaryRemainingPctBefore >= effectiveThresholdPct) {
    const receipt = {
      action: "codex_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      currentLabelBefore,
      currentLabelAfter: currentLabelBefore,
      primaryRemainingPctBefore,
      triggeredSelection: false,
      warnings,
      blockers: [],
    };
    target.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  const selection = await activateCodexPoolSelectionImpl({
    state,
    homeDir,
    env,
    observedAt,
    usageByProvider,
  });
  const postTarget = readCodexCliTargetStatus({ state, homeDir, env });
  const receipt = {
    action: "codex_watch",
    status: selection.status,
    observedAt,
    thresholdPct: effectiveThresholdPct,
    currentLabelBefore,
    currentLabelAfter: postTarget.inferredLabel || postTarget.activeLabel || null,
    primaryRemainingPctBefore,
    triggeredSelection: true,
    selectionReceipt: selection.receipt,
    warnings: [...warnings, ...(Array.isArray(selection.receipt?.warnings) ? selection.receipt.warnings : [])],
    blockers: Array.isArray(selection.receipt?.blockers) ? selection.receipt.blockers : [],
  };
  target.lastWatchReceipt = receipt;
  return { status: selection.status, receipt, wrote: Boolean(selection.wrote) };
}

export async function watchHermesPoolSelectionOnce(
  {
    state,
    homeDir,
    env = {},
    thresholdPct = DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT,
  },
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    rebalanceHermesPoolImpl = rebalanceHermesPool,
  } = {},
) {
  ensureStateShape(state);
  const effectiveThresholdPct = resolveCodexWatchThresholdPct(thresholdPct);
  const observedAt = new Date().toISOString();
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env });
  const usageByLabel = isObject(usageByProvider?.[OPENAI_CODEX_PROVIDER]) ? usageByProvider[OPENAI_CODEX_PROVIDER] : {};
  const poolStatus = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel,
    now: Date.parse(observedAt),
  });
  const eligibleLabels = new Set(poolStatus.eligibleLabels);
  const fleet = getHermesFleetState(state);
  const homeStatuses = discoverHermesHomes({ homeDir }).map((home) => readHermesHomeStatus({ state, homeDir, homeId: home.homeId }));
  const warnings = homeStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const homeBlockers = homeStatuses.flatMap((home) => buildHermesHomeBlockers(home));
  const needsSyncHomeIds = homeStatuses.filter((home) => home.needsSync || !home.currentLabel).map((home) => home.homeId);

  if (homeStatuses.length === 0) {
    const receipt = {
      action: "hermes_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: 0,
      currentAssignmentsBefore: {},
      currentAssignmentsAfter: {},
      lowestPrimaryRemainingPctBefore: null,
      triggeredRebalance: false,
      needsSyncHomeIds: [],
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings: [],
      blockers: [],
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  if (homeBlockers.length > 0) {
    const receipt = {
      action: "hermes_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore: null,
      triggeredRebalance: false,
      needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings,
      blockers: homeBlockers,
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  const currentAssignmentsBefore = buildHermesAssignmentsByHome(homeStatuses);
  const belowThresholdHomeIds = [];
  const ineligibleHomeIds = [];
  const usageBlockers = [];
  let lowestPrimaryRemainingPctBefore = null;

  for (const home of homeStatuses) {
    const currentLabel = home.currentLabel;
    if (!currentLabel) {
      continue;
    }
    if (currentLabel && !eligibleLabels.has(currentLabel)) {
      ineligibleHomeIds.push(home.homeId);
    }
    const activeUsage = usageByLabel[currentLabel] ?? null;
    const primaryRemainingPctBefore = getPrimaryRemainingPctFromUsageSnapshot(activeUsage);
    if (primaryRemainingPctBefore === null) {
      usageBlockers.push(buildUsageUnavailableBlocker({
        reason: "hermes_home_usage_unavailable",
        homeId: home.homeId,
        label: currentLabel,
        usage: activeUsage,
      }));
      continue;
    }
    lowestPrimaryRemainingPctBefore =
      lowestPrimaryRemainingPctBefore === null
        ? primaryRemainingPctBefore
        : Math.min(lowestPrimaryRemainingPctBefore, primaryRemainingPctBefore);
    if (primaryRemainingPctBefore < effectiveThresholdPct) {
      belowThresholdHomeIds.push(home.homeId);
    }
  }

  if (usageBlockers.length > 0) {
    const receipt = {
      action: "hermes_watch",
      status: "blocked",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore,
      triggeredRebalance: false,
      needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
      belowThresholdHomeIds,
      ineligibleHomeIds,
      warnings,
      blockers: usageBlockers,
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "blocked", receipt, wrote: false };
  }

  if (belowThresholdHomeIds.length === 0 && ineligibleHomeIds.length === 0 && needsSyncHomeIds.length === 0) {
    const receipt = {
      action: "hermes_watch",
      status: "noop",
      observedAt,
      thresholdPct: effectiveThresholdPct,
      homeCount: homeStatuses.length,
      currentAssignmentsBefore: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      lowestPrimaryRemainingPctBefore,
      triggeredRebalance: false,
      needsSyncHomeIds: [],
      belowThresholdHomeIds: [],
      ineligibleHomeIds: [],
      warnings,
      blockers: [],
    };
    fleet.lastWatchReceipt = receipt;
    return { status: "noop", receipt, wrote: false };
  }

  const rebalanced = await rebalanceHermesPoolImpl(
    {
      home: homeDir,
      homeDir,
      env,
      observedAt,
      usageByProvider,
    },
    state,
  );
  const postStatuses = discoverHermesHomes({ homeDir }).map((home) => readHermesHomeStatus({ state, homeDir, homeId: home.homeId }));
  const receipt = {
    action: "hermes_watch",
    status: rebalanced.status,
    observedAt,
    thresholdPct: effectiveThresholdPct,
    homeCount: homeStatuses.length,
    currentAssignmentsBefore: sanitizeForStatus(currentAssignmentsBefore),
    currentAssignmentsAfter: sanitizeForStatus(buildHermesAssignmentsByHome(postStatuses, { includeUnmapped: true })),
    lowestPrimaryRemainingPctBefore,
    triggeredRebalance: true,
    needsSyncHomeIds: sanitizeForStatus(needsSyncHomeIds),
    belowThresholdHomeIds,
    ineligibleHomeIds,
    rebalanceReceipt: rebalanced.receipt,
    warnings: [
      ...warnings,
      ...(Array.isArray(rebalanced.receipt?.warnings) ? rebalanced.receipt.warnings : []),
    ],
    blockers: Array.isArray(rebalanced.receipt?.blockers) ? rebalanced.receipt.blockers : [],
  };
  fleet.lastWatchReceipt = receipt;
  return { status: rebalanced.status, receipt, wrote: Array.isArray(rebalanced.writes) && rebalanced.writes.some((entry) => entry?.wrote?.auth === true) };
}
