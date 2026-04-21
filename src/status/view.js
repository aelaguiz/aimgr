import { normalizeBrowserBindingMode, readBrowserFacts } from "../browser/bindings.js";
import { getAnthropicCredential, getCodexCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeProviderId } from "../core/normalize.js";
import { buildAuthorityAnthropicImportStatus, buildAuthorityCodexImportStatus } from "../credentials/codex-portable.js";
import { derivePoolAccountStatus } from "../pool/account-status.js";
import { projectPoolCapacity } from "../pool/capacity.js";
import { collectCodexPoolStatus, pickNextBestLocalCliPoolLabel, rankPoolCandidates } from "../pool/ranking.js";
import { formatExpiresIn } from "../core/time.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { discoverStatusConfiguredOpenclawCodexAgents, getAccountPoolState, getOpenclawAssignments, getOpenclawExclusions, getOpenclawTargetState } from "../state/accounts.js";
import { getAuthorityAnthropicImportLabelStatus } from "../state/authority-anthropic.js";
import { getAuthorityCodexImportLabelStatus } from "../state/authority-codex.js";
import { ensureStateShape } from "../state/schema.js";
import { buildPoolInstrumentSummary } from "./instruments.js";
import { sanitizeForStatus } from "../core/sanitize.js";
import { buildInteractiveLoginStatus, buildWarningsFromState, buildWarningsFromStatusAccounts } from "./warnings.js";
import { buildWarningsFromClaudeTargetStatus, readClaudeCliTargetStatus } from "../targets/claude-status.js";
import { buildWarningsFromCodexTargetStatus, readCodexCliTargetStatus } from "../targets/codex-cli.js";
import { buildWarningsFromHermesFleetStatus, readHermesFleetStatus } from "../targets/hermes-home.js";
import { buildWarningsFromPiTargetStatus, readPiCliTargetStatus } from "../targets/pi-cli.js";

export async function buildStatusView({
  statePath,
  state,
  homeDir,
  env = {},
  probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
  nowMs = Date.now(),
}) {
  ensureStateShape(state);
  const authorityCodexImportStatus = buildAuthorityCodexImportStatus(state);
  const authorityAnthropicImportStatus = buildAuthorityAnthropicImportStatus(state);
  const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env });
  const configuredCodexAgents = discoverStatusConfiguredOpenclawCodexAgents(state);
  const codexPool = collectCodexPoolStatus({
    state,
    homeDir,
    usageByLabel: usageByProvider[OPENAI_CODEX_PROVIDER],
    now: nowMs,
  });
  const accounts = [];

  for (const [label, account] of Object.entries(state.accounts)) {
    if (!isObject(account)) continue;
    const provider = normalizeProviderId(account.provider);
    const expectEmail = typeof account.expect?.email === "string" ? account.expect.email : null;
    const browserFacts = homeDir
      ? readBrowserFacts({ account, homeDir, label })
      : { exists: false, bindingPresent: false, mode: null };
    const login = buildInteractiveLoginStatus({ state, label });
    const cred =
      provider === OPENAI_CODEX_PROVIDER
        ? getCodexCredential(state, label)
        : provider === ANTHROPIC_PROVIDER
          ? getAnthropicCredential(state, label)
          : null;
    const expiresAt = cred && typeof cred.expiresAt === "string" ? cred.expiresAt : null;
    const accountId = cred && typeof cred.accountId === "string" ? cred.accountId : null;
    const usage = usageByProvider[provider]?.[label] ?? { provider, ok: false, status: cred ? "unknown" : "n/a" };
    const authorityImportStatus =
      provider === OPENAI_CODEX_PROVIDER
        ? getAuthorityCodexImportLabelStatus(state, label)
        : provider === ANTHROPIC_PROVIDER
          ? getAuthorityAnthropicImportLabelStatus(state, label)
          : null;
    const operator =
      provider === OPENAI_CODEX_PROVIDER
        ? (codexPool.byLabel[label]
          ?? {
            ...derivePoolAccountStatus({ account, label, credentials: cred, browserFacts, now: nowMs }),
            eligible: false,
            poolEnabled: getAccountPoolState(state, label)?.enabled !== false,
          })
        : derivePoolAccountStatus({ account, label, credentials: cred, browserFacts, now: nowMs });

    accounts.push({
      label,
      provider: provider || "unknown",
      operator: {
        status: operator?.operatorStatus ?? "blocked",
        detailReason: operator?.detailReason ?? null,
        eligible: operator?.eligible === true,
        actionRequired: operator?.actionRequired ?? null,
        reason: operator?.reason ?? "Unknown account state.",
      },
      ...(login ? { login } : {}),
      browser: {
        bindingPresent: browserFacts.bindingPresent === true,
        exists: browserFacts.exists === true,
        ...(normalizeBrowserBindingMode(account.browser?.mode) ? { mode: normalizeBrowserBindingMode(account.browser?.mode) } : {}),
        ...(typeof account.browser?.seededFromOpenclawProfileId === "string" && account.browser.seededFromOpenclawProfileId.trim()
          ? { seededFromOpenclawProfileId: account.browser.seededFromOpenclawProfileId.trim() }
          : {}),
        ...(typeof account.browser?.seededAt === "string" && account.browser.seededAt.trim()
          ? { seededAt: account.browser.seededAt.trim() }
          : {}),
        ...(typeof account.browser?.verifiedAt === "string" && account.browser.verifiedAt.trim()
          ? { verifiedAt: account.browser.verifiedAt.trim() }
          : {}),
        ...(browserFacts.userDataDir ? { resolvedPath: browserFacts.userDataDir } : {}),
        ...(browserFacts.mode ? { resolvedMode: browserFacts.mode } : {}),
      },
      identity: {
        ...(expectEmail ? { expectEmail } : {}),
        ...(accountId ? { accountId } : {}),
        ...(browserFacts.userName ? { browserUserName: browserFacts.userName } : {}),
        ...(browserFacts.gaiaName ? { browserGaiaName: browserFacts.gaiaName } : {}),
      },
      credentials: {
        status: cred ? "ok" : "missing",
        ...(expiresAt ? { expiresAt } : {}),
        ...(expiresAt ? { expiresIn: formatExpiresIn(expiresAt, nowMs) } : {}),
      },
      usage,
      ...(authorityImportStatus?.imported
        ? {
            authorityImport: {
              dirtyLocal: authorityImportStatus.dirty,
            },
          }
        : {}),
    });
  }

  const codexCli = readCodexCliTargetStatus({ state, homeDir, env });
  const claudeCli = readClaudeCliTargetStatus({ state, homeDir, env });
  const piCli = readPiCliTargetStatus({ state, homeDir, env });
  const hermesFleet = readHermesFleetStatus({ state, homeDir });
  const openclawTarget = getOpenclawTargetState(state);
  const nextBestCandidate = pickNextBestLocalCliPoolLabel({
    rankedCandidates: rankPoolCandidates({
      labels: codexPool.eligibleLabels,
      usage: usageByProvider[OPENAI_CODEX_PROVIDER],
      currentLabel: codexCli.activeLabel,
      currentAssignments: getOpenclawAssignments(state),
      configuredAgents: configuredCodexAgents,
      agentDemand: state.pool.openaiCodex.agentDemand,
      lastApplyReceipt: openclawTarget.lastApplyReceipt ?? null,
      now: nowMs,
    }),
  });
  const capacity = projectPoolCapacity({
    history: state.pool.openaiCodex.history,
    liveUsage: usageByProvider[OPENAI_CODEX_PROVIDER],
    agentDemand: state.pool.openaiCodex.agentDemand,
    lastApplyReceipt: openclawTarget.lastApplyReceipt ?? null,
    now: nowMs,
  });
  codexPool.capacityProjection = capacity;
  const poolInstrument = buildPoolInstrumentSummary({
    state,
    accounts,
    codexPool,
    liveUsage: usageByProvider[OPENAI_CODEX_PROVIDER],
    agentDemand: state.pool.openaiCodex.agentDemand,
    currentAssignments: getOpenclawAssignments(state),
    lastApplyReceipt: getOpenclawTargetState(state).lastApplyReceipt ?? null,
    configuredCodexAgents,
    now: nowMs,
  });

  const statusRank = { blocked: 0, reauth: 1, ready: 2 };
  const sortedAccounts = accounts.toSorted((a, b) => {
    const aRank = statusRank[a.operator?.status] ?? 99;
    const bRank = statusRank[b.operator?.status] ?? 99;
    if (aRank !== bRank) return aRank - bRank;
    return a.label.localeCompare(b.label);
  });

  return {
    generatedAt: new Date(nowMs).toISOString(),
    nowMs,
    statePath,
    accounts: sortedAccounts,
    openclaw: {
      assignments: sanitizeForStatus(getOpenclawAssignments(state)),
      exclusions: sanitizeForStatus(getOpenclawExclusions(state)),
      lastApplyReceipt: sanitizeForStatus(getOpenclawTargetState(state).lastApplyReceipt ?? null),
      lastRebalancedAt:
        typeof getOpenclawTargetState(state).lastRebalancedAt === "string"
          ? getOpenclawTargetState(state).lastRebalancedAt
          : null,
    },
    nextBestCandidate: sanitizeForStatus(nextBestCandidate),
    pool_now: sanitizeForStatus(poolInstrument.pool_now),
    windows: sanitizeForStatus(poolInstrument.windows),
    pressure: sanitizeForStatus(poolInstrument.pressure),
    projection: sanitizeForStatus(poolInstrument.projection),
    capacity: sanitizeForStatus(capacity),
    imports: {
      authority: {
        codex: sanitizeForStatus(authorityCodexImportStatus),
        anthropic: sanitizeForStatus(authorityAnthropicImportStatus),
      },
    },
    codexCli: sanitizeForStatus(codexCli),
    claudeCli: sanitizeForStatus(claudeCli),
    piCli: sanitizeForStatus(piCli),
    hermesFleet: sanitizeForStatus(hermesFleet),
    warnings: [
      ...buildWarningsFromState(state),
      ...buildWarningsFromStatusAccounts(sortedAccounts, { now: nowMs }),
      ...buildWarningsFromCodexTargetStatus(codexCli),
      ...buildWarningsFromClaudeTargetStatus(claudeCli),
      ...buildWarningsFromPiTargetStatus(piCli),
      ...buildWarningsFromHermesFleetStatus(hermesFleet),
    ],
  };
}
