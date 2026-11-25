import { isObject } from "../core/normalize.js";
import { renderAccountNotes } from "./account-notes.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { buildClaudeStatusAccountTable, renderClaudeStatusAccountTable } from "./claude-redis-view.js";
import { formatClaudeEgress, formatClaudeProxyHealth, hasNoLocalClaudeRoute } from "./claude-egress.js";
import {
  PLAN_WEEK_WEIGHTS,
  buildPoolAccountRow,
  buildStatusAccountFlags,
  buildStatusPool,
  buildStatusPoolAccountTableRow,
  formatInteractiveLoginSummary,
  formatPoolCapacityLines,
  formatStatusAccountExpiryCell,
  formatStatusAccountResetCell,
  formatStatusAccountUsedCell,
  formatStatusTable,
  readStatusAccountResetCredits,
  renderCurrentCodexUsageText,
} from "./table.js";

export function buildStatusAccountTable(accounts, now, { codex = false } = {}) {
  const weights = codex ? PLAN_WEEK_WEIGHTS.codex : PLAN_WEEK_WEIGHTS.claude;
  const entries = accounts.map((account) => {
    const planKey = codex ? account.plan?.split(" ")[0] : account.plan?.split("/").at(-1);
    const knownPlan = Object.hasOwn(weights, planKey);
    const usage = account.usage;
    const windows = usage?.ok === true ? usage.windows : null;
    return {
      weight: knownPlan ? weights[planKey] : 1,
      planKey: planKey === "--" ? null : planKey,
      knownPlan,
      week: windows?.[codex ? 0 : 1] ?? null,
      session: codex ? null : windows?.[0] ?? null,
      observedAtMs: usage?.observedAtMs ?? usage?.usageObservedAtMs,
    };
  });
  const accountRows = accounts.map((account, index) => buildPoolAccountRow(entries[index], {
    label: account.label,
    status: account.operator?.status || "unknown",
    plan: account.plan || "--",
    resetCredits: codex ? readStatusAccountResetCredits(account.usage) : null,
  }));
  const ready = accountRows.filter((row) => row.status === "ready").length;
  const smallerPlan = codex ? "pro" : "team";
  const pool = buildStatusPool(entries, accountRows, now, {
    unit: codex ? "Pro Max weeks" : "Max 20x weeks",
    weightNote: entries.some((entry) => entry.planKey === smallerPlan)
      ? `a ${smallerPlan} account counts ${weights[smallerPlan]}` : "",
    counts: {
      ready,
      limited: codex ? accounts.length - ready : accountRows.filter((row) => row.status === "limited").length,
      needsLogin: accountRows.filter((row) => row.status === "reauth").length,
    },
    fable: codex ? null : { usedPercent: null, atLimit: 0 },
    resetCredits: codex ? accountRows.reduce((total, row) => total + (row.resetCredits ?? 0), 0) : null,
  });
  return { ...pool, accounts, entries };
}

export function buildStatusAccountTables(view, { claudeUsageStatus, includeBlocked = false } = {}) {
  const now = view?.nowMs ?? Date.now();
  const accounts = Array.isArray(view?.accounts) ? view.accounts : [];
  const visibleAccounts = accounts.filter((account) => includeBlocked || account?.operator?.status !== "blocked");
  const codex = buildStatusAccountTable(
    visibleAccounts.filter((account) => account?.provider === OPENAI_CODEX_PROVIDER), now, { codex: true },
  );
  const claudeAccounts = visibleAccounts.filter((account) => account?.provider === ANTHROPIC_PROVIDER);
  const blockedClaudeLabels = new Set(accounts
    .filter((account) => !includeBlocked && account?.provider === ANTHROPIC_PROVIDER && account?.operator?.status === "blocked")
    .map((account) => account.label));
  const claude = claudeUsageStatus
    ? buildClaudeStatusAccountTable({
      ...claudeUsageStatus,
      accounts: claudeUsageStatus.accounts?.filter((account) => !blockedClaudeLabels.has(account.label)),
    })
    : buildStatusAccountTable(claudeAccounts, now);
  return { codex, claude };
}

function pushStatusAccountTable(lines, { heading, table, now, codex = false, includeBlocked = false }) {
  const { accounts, entries, pool, poolOptions } = table;
  lines.push(`${heading} (${accounts.length})`);
  const windowHeaders = codex ? ["wk_used", "wk_in"] : ["5h_used", "5h_in", "wk_used", "wk_in"];
  const accountRows = [
    ["label", "st", "plan", "lock", "login", "exp", ...windowHeaders, "resets", "provider", "usage_src", "flags"],
    ...accounts.map((account, index) => [
      pool.accountRows[index].label,
      pool.accountRows[index].status,
      pool.accountRows[index].plan,
      account.lock?.status || "unknown",
      formatInteractiveLoginSummary(account.login) || "--",
      formatStatusAccountExpiryCell(account.credentials?.expiresIn),
      formatStatusAccountUsedCell(account.usage, 0),
      formatStatusAccountResetCell(account.usage, 0, now),
      ...(codex ? [] : [
        formatStatusAccountUsedCell(account.usage, 1),
        formatStatusAccountResetCell(account.usage, 1, now),
      ]),
      String(pool.accountRows[index].resetCredits ?? "--"),
      account.provider || "unknown",
      account.usage?.source || "unavailable",
      [buildStatusAccountFlags(account),
        ...(includeBlocked && account.operator?.status === "blocked" && account.credentials?.status
          ? [`auth=${account.credentials.status}`] : []),
        ...(account.provider === ANTHROPIC_PROVIDER ? [`proxy=${formatClaudeEgress(account.egress)}`] : []),
        ...(account.egress?.mode === "proxy" ? [`proxy_health=${formatClaudeProxyHealth(account.egress)}`] : []),
        ...(hasNoLocalClaudeRoute(account) ? ["don't have a route to this account"] : []),
      ].filter(Boolean).join(" "),
    ]),
  ];
  if (accounts.length > 0) accountRows.push(buildStatusPoolAccountTableRow(accounts, entries, pool, now, { codex }));
  lines.push(...formatStatusTable(accountRows));
  lines.push(...formatPoolCapacityLines(pool, poolOptions));
}

export function renderStatusText(view, {
  showAssignments = false,
  showAccounts = true,
  claudeUsageStatus = null,
  includeBlocked = false,
  tables = null,
} = {}) {
  const lines = [];
  const now = Number.isFinite(Number(view?.nowMs)) ? Number(view.nowMs) : Date.now();

  const redisStatus = typeof view?.redis?.status === "string" ? view.redis.status : "unknown";
  const cacheAgeMs = Number(view?.redis?.cacheAgeMs);
  lines.push(
    `COORDINATION redis=${redisStatus}`
      + (Number.isFinite(cacheAgeMs) ? ` cache_age_seconds=${Math.floor(cacheAgeMs / 1000)}` : ""),
    "",
  );

  if (showAccounts) {
    const { codex, claude } = tables ?? buildStatusAccountTables(view, { claudeUsageStatus, includeBlocked });
    pushStatusAccountTable(lines, { heading: "CODEX ACCOUNTS", table: codex, now, codex: true, includeBlocked });
    lines.push("");
    if (claudeUsageStatus) {
      lines.push(...renderClaudeStatusAccountTable(claude).trimEnd().split("\n"));
    } else {
      pushStatusAccountTable(lines, { heading: "CLAUDE ACCOUNTS", table: claude, now, includeBlocked });
    }
  }

  const notes = renderAccountNotes(view?.accountNotes);
  if (notes) lines.push("", ...notes.trimEnd().split("\n"));

  const assignments = isObject(view.openclaw?.assignments) ? view.openclaw.assignments : {};
  const assignmentEntries = Object.entries(assignments);
  if (showAssignments && assignmentEntries.length > 0) {
    lines.push("");
    lines.push("OpenClaw assignments");
    for (const [agentId, label] of assignmentEntries.toSorted((x, y) => x[0].localeCompare(y[0]))) {
      lines.push(`- ${agentId} -> ${label}`);
    }
  }

  const hermesHomes = Array.isArray(view.hermesFleet?.homes) ? view.hermesFleet.homes : [];
  if (showAssignments && hermesHomes.length > 0) {
    lines.push("");
    lines.push("Hermes homes");
    for (const home of hermesHomes.toSorted((a, b) => String(a?.homeId ?? "").localeCompare(String(b?.homeId ?? "")))) {
      lines.push(`- ${home.homeId} -> ${home.currentLabel || "unmapped"}`);
    }
  }

  lines.push("");
  lines.push("CODEX ACTIVE");
  lines.push(renderCurrentCodexUsageText(view, { now }).trimEnd());
  lines.push("");
  lines.push("CLAUDE LAST RUN");
  const lastRunClaudeLabel =
    typeof view?.claudeCli?.lastRunLabel === "string" && view.claudeCli.lastRunLabel.trim()
      ? view.claudeCli.lastRunLabel.trim()
      : typeof view?.claudeCli?.inferredLabel === "string" && view.claudeCli.inferredLabel.trim()
        ? view.claudeCli.inferredLabel.trim()
        : view?.claudeCli?.status === "unreadable"
          ? "unknown"
          : "none";
  lines.push(`label=${lastRunClaudeLabel}`);

  return `${lines.join("\n")}\n`;
}
