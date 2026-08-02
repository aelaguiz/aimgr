import { isObject } from "../core/normalize.js";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { renderClaudeRedisAccountUsageStatus } from "./claude-redis-view.js";
import { buildStatusAccountFlags, buildStatusAverageAccountTableRow, formatInteractiveLoginSummary, formatStatusAccountExpiryCell, formatStatusAccountResetCell, formatStatusAccountUsedCell, formatStatusTable, renderCurrentCodexUsageText } from "./table.js";

function pushStatusAccountTable(lines, { heading, accounts, now }) {
  lines.push(`${heading} (${accounts.length})`);
  const averageAccountRow = accounts.length > 0 ? buildStatusAverageAccountTableRow(accounts, now) : null;
  const accountRows = [
    ["label", "st", "lock", "login", "exp", "5h_used", "5h_in", "wk_used", "wk_in", "provider", "usage_src", "flags"],
    ...accounts.map((account) => [
      account.label,
      account.operator?.status || "unknown",
      account.lock?.status || "unknown",
      formatInteractiveLoginSummary(account.login) || "--",
      formatStatusAccountExpiryCell(account.credentials?.expiresIn),
      formatStatusAccountUsedCell(account.usage, 0),
      formatStatusAccountResetCell(account.usage, 0, now),
      formatStatusAccountUsedCell(account.usage, 1),
      formatStatusAccountResetCell(account.usage, 1, now),
      account.provider || "unknown",
      account.usage?.source || "unavailable",
      buildStatusAccountFlags(account),
    ]),
    ...(averageAccountRow ? [averageAccountRow] : []),
  ];
  lines.push(...formatStatusTable(accountRows));
}

export function renderStatusText(view, {
  showAssignments = false,
  showAccounts = true,
  claudeUsageStatus = null,
} = {}) {
  const lines = [];
  const now = Number.isFinite(Number(view?.nowMs)) ? Number(view.nowMs) : Date.now();
  const accounts = Array.isArray(view?.accounts) ? view.accounts : [];
  const codexAccounts = accounts.filter((account) => account?.provider === OPENAI_CODEX_PROVIDER);
  const claudeAccounts = accounts.filter((account) => account?.provider === ANTHROPIC_PROVIDER);

  const redisStatus = typeof view?.redis?.status === "string" ? view.redis.status : "unknown";
  const cacheAgeMs = Number(view?.redis?.cacheAgeMs);
  lines.push(
    `COORDINATION redis=${redisStatus}`
      + (Number.isFinite(cacheAgeMs) ? ` cache_age_seconds=${Math.floor(cacheAgeMs / 1000)}` : ""),
    "",
  );

  if (showAccounts) {
    pushStatusAccountTable(lines, { heading: "CODEX ACCOUNTS", accounts: codexAccounts, now });
    lines.push("");
    if (claudeUsageStatus) {
      lines.push(
        ...renderClaudeRedisAccountUsageStatus(claudeUsageStatus).trimEnd().split("\n"),
      );
    } else {
      pushStatusAccountTable(lines, { heading: "CLAUDE ACCOUNTS", accounts: claudeAccounts, now });
    }
  }

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
