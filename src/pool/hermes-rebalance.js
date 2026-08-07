import { DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeHermesHomeId, normalizeLabel } from "../core/normalize.js";
import { resolveHomeDir } from "../io/paths.js";
import { refreshHermesHomeDemandLedger } from "./demand-ledger.js";
import { collectCodexPoolStatusWithExhaustionHistory } from "./history.js";
import { buildHermesDemandUnreadableBlocker, buildHermesHomeBlockers, buildWarningsFromHermesHomeStatus, discoverHermesHomes, readHermesHomeStatus } from "./token-usage.js";
import { probeUsageSnapshotsByProvider } from "./usage.js";
import { planWeightedHermesRebalance } from "./weighted-planner.js";
import { getHermesFleetState } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { writeHermesAuthFromState } from "../targets/hermes-auth.js";
import { isCodexStateCredentialUseAllowed } from "../targets/codex-desktop-drain.js";

export function buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped = false } = {}) {
  const entries = [];
  for (const home of Array.isArray(homeStatuses) ? homeStatuses : []) {
    const homeId = typeof home?.homeId === "string" ? normalizeHermesHomeId(home.homeId) : null;
    if (!homeId) continue;
    if (typeof home?.currentLabel === "string" && home.currentLabel.trim()) {
      entries.push([homeId, normalizeLabel(home.currentLabel)]);
      continue;
    }
    if (includeUnmapped) {
      entries.push([homeId, null]);
    }
  }
  return Object.fromEntries(entries);
}

export function buildHermesAuthWriteFailedBlocker(error) {
  const blocker = {
    reason: "hermes_home_auth_write_failed",
  };
  if (typeof error?.homeId === "string" && error.homeId.trim()) {
    blocker.homeId = error.homeId.trim();
  }
  if (typeof error?.label === "string" && error.label.trim()) {
    blocker.label = error.label.trim();
  }
  if (typeof error?.authPath === "string" && error.authPath.trim()) {
    blocker.authPath = error.authPath.trim();
  }
  const detail = String(error?.cause?.message ?? error?.message ?? error ?? "").trim();
  if (detail) {
    blocker.detail = detail;
  }
  return blocker;
}

function wrapHermesAuthWriteError(error, { homeId, label, authPath }) {
  const detail = String(error?.message ?? error ?? "unknown error").trim();
  const wrapped = new Error(
    `Failed to write Hermes auth for home=${homeId} label=${label}: ${detail || "unknown error"}`,
    { cause: error },
  );
  wrapped.code = "HERMES_HOME_AUTH_WRITE_FAILED";
  wrapped.homeId = homeId;
  wrapped.label = label;
  wrapped.authPath = authPath;
  return wrapped;
}

export function syncHermesHomesForLabel(
  {
    state,
    label,
    homeDir,
  },
  {
    discoverHermesHomesImpl = discoverHermesHomes,
    readHermesHomeStatusImpl = readHermesHomeStatus,
    writeHermesAuthFromStateImpl = writeHermesAuthFromState,
  } = {},
) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const homes = discoverHermesHomesImpl({ homeDir });
  const statuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const matchingHomes = statuses.filter((home) => home.currentLabel === normalizedLabel);
  const homesNeedingSync = matchingHomes.filter((home) => home.needsSync);
  const writes = [];
  const syncedHomeIds = [];
  for (const home of homesNeedingSync.toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    try {
      writes.push(
        writeHermesAuthFromStateImpl(
          { label: normalizedLabel, authPath: home.authPath },
          state,
        ),
      );
      syncedHomeIds.push(home.homeId);
    } catch (error) {
      return {
        status: "blocked",
        checkedHomeCount: homes.length,
        matchedHomeCount: matchingHomes.length,
        syncedHomeIds,
        blockers: [
          buildHermesAuthWriteFailedBlocker(
            wrapHermesAuthWriteError(error, {
              homeId: home.homeId,
              label: normalizedLabel,
              authPath: home.authPath,
            }),
          ),
        ],
        writes,
      };
    }
  }
  return {
    status: homesNeedingSync.length > 0 ? "applied" : "noop",
    checkedHomeCount: homes.length,
    matchedHomeCount: matchingHomes.length,
    syncedHomeIds,
    blockers: [],
    writes,
  };
}

export async function rebalanceHermesPool(
  params,
  state,
  {
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    discoverHermesHomesImpl = discoverHermesHomes,
    readHermesHomeStatusImpl = readHermesHomeStatus,
    refreshHermesHomeDemandLedgerImpl = refreshHermesHomeDemandLedger,
    writeHermesAuthFromStateImpl = writeHermesAuthFromState,
  } = {},
) {
  ensureStateShape(state);
  const homeDir = typeof params.homeDir === "string" && params.homeDir.trim()
    ? params.homeDir
    : resolveHomeDir(params.home, { env: params.env });
  const observedAt =
    typeof params?.observedAt === "string" && params.observedAt.trim()
      ? params.observedAt.trim()
      : new Date().toISOString();
  const usageByProvider = isObject(params?.usageByProvider)
    ? params.usageByProvider
    : await probeUsageSnapshotsByProviderImpl(state, { env: params.env });
  const usageByLabel = usageByProvider[OPENAI_CODEX_PROVIDER];
  const poolStatus = collectCodexPoolStatusWithExhaustionHistory({
    state,
    homeDir,
    usageByLabel,
    observedAt,
  });
  // A Desktop-reserved Codex identity (or same-account alias) never becomes a
  // Hermes home assignment; the write path enforces the same gate fail-closed.
  const eligibleLabels = poolStatus.eligibleLabels.filter((label) => isCodexStateCredentialUseAllowed(state, {
    label,
    accountId: state.credentials[OPENAI_CODEX_PROVIDER]?.[label]?.accountId ?? null,
  }));

  const fleet = getHermesFleetState(state);
  const homes = discoverHermesHomesImpl({ homeDir });
  const homeStatuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const homeWarnings = homeStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const homeBlockers = homeStatuses.flatMap((home) => buildHermesHomeBlockers(home));
  fleet.lastRebalancedAt = observedAt;

  if (homeBlockers.length > 0) {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: null,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: [],
      perAccountLoad: [],
      warnings: homeWarnings,
      blockers: homeBlockers,
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }

  let demandRefresh;
  try {
    demandRefresh = refreshHermesHomeDemandLedgerImpl({
      state,
      homeDir,
      homes,
      now: Date.parse(observedAt),
      lookbackDays: DEFAULT_AGENT_DEMAND_LOOKBACK_DAYS,
    });
  } catch (error) {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: null,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: [],
      perAccountLoad: [],
      warnings: homeWarnings,
      blockers: [buildHermesDemandUnreadableBlocker(error)],
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }
  const plan = planWeightedHermesRebalance({
    configuredHomes: homeStatuses.map((home) => home.homeId),
    currentAssignments: buildHermesAssignmentsByHome(homeStatuses),
    eligibleLabels,
    usage: usageByLabel,
    homeDemand: demandRefresh.demandByHome,
    now: Date.parse(observedAt),
  });

  if (plan.status === "blocked") {
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: plan.allocationMode,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(homeStatuses, { includeUnmapped: true })),
      moved: [],
      unchanged: [],
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: homeWarnings,
      blockers: plan.blockers,
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt };
  }

  const writes = [];
  const appliedMoved = [];
  const resynced = [];
  const buildWriteFailureResult = (error) => {
    const postStatuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
    const postWarnings = postStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
    const resyncedHomeIds = new Set(resynced.map((entry) => entry.homeId));
    const receipt = {
      action: "rebalance_hermes",
      status: "blocked",
      observedAt,
      allocationMode: plan.allocationMode,
      assignments: sanitizeForStatus(buildHermesAssignmentsByHome(postStatuses, { includeUnmapped: true })),
      moved: appliedMoved,
      resynced,
      unchanged: plan.unchanged.filter((entry) => !resyncedHomeIds.has(entry.homeId)),
      skipped: plan.skipped,
      perAccountLoad: plan.perAccountLoad,
      warnings: postWarnings,
      blockers: [buildHermesAuthWriteFailedBlocker(error)],
      writes,
    };
    fleet.lastApplyReceipt = receipt;
    return { status: "blocked", receipt, writes };
  };

  for (const moved of [...plan.moved].toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    const homeStatus = homeStatuses.find((home) => home.homeId === moved.homeId);
    if (!homeStatus) {
      throw new Error(`Missing Hermes home for planned rebalance move: ${moved.homeId}`);
    }
    try {
      writes.push(
        writeHermesAuthFromStateImpl(
          { label: moved.to, authPath: homeStatus.authPath },
          state,
        ),
      );
      appliedMoved.push(moved);
    } catch (error) {
      return buildWriteFailureResult(
        wrapHermesAuthWriteError(error, { homeId: moved.homeId, label: moved.to, authPath: homeStatus.authPath }),
      );
    }
  }
  for (const homeStatus of homeStatuses.toSorted((a, b) => a.homeId.localeCompare(b.homeId))) {
    if (!homeStatus.currentLabel || !homeStatus.needsSync) continue;
    if (plan.moved.some((entry) => entry.homeId === homeStatus.homeId)) continue;
    try {
      writes.push(
        writeHermesAuthFromStateImpl(
          { label: homeStatus.currentLabel, authPath: homeStatus.authPath },
          state,
        ),
      );
    } catch (error) {
      return buildWriteFailureResult(
        wrapHermesAuthWriteError(error, {
          homeId: homeStatus.homeId,
          label: homeStatus.currentLabel,
          authPath: homeStatus.authPath,
        }),
      );
    }
    resynced.push({
      homeId: homeStatus.homeId,
      label: homeStatus.currentLabel,
      matchMode: homeStatus.matchMode,
    });
  }

  const postStatuses = homes.map((home) => readHermesHomeStatusImpl({ state, homeDir, homeId: home.homeId }));
  const postWarnings = postStatuses.flatMap((home) => buildWarningsFromHermesHomeStatus(home));
  const resyncedHomeIds = new Set(resynced.map((entry) => entry.homeId));
  const wroteAuth = writes.some((entry) => entry?.wrote?.auth === true);
  let status = "applied";
  if (plan.status === "noop" && !wroteAuth) {
    status = postWarnings.length > 0 ? "applied_with_warnings" : "noop";
  } else if (plan.status === "applied_with_warnings" || postWarnings.length > 0) {
    status = "applied_with_warnings";
  }

  const receipt = {
    action: "rebalance_hermes",
    status,
    observedAt,
    allocationMode: plan.allocationMode,
    assignments: sanitizeForStatus(buildHermesAssignmentsByHome(postStatuses, { includeUnmapped: true })),
    moved: appliedMoved,
    resynced,
    unchanged: plan.unchanged.filter((entry) => !resyncedHomeIds.has(entry.homeId)),
    skipped: plan.skipped,
    perAccountLoad: plan.perAccountLoad,
    warnings: postWarnings,
    blockers: [],
    writes,
  };
  fleet.lastApplyReceipt = receipt;
  return { status, receipt, writes };
}
