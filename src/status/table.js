import { normalizeBrowserBindingMode, normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { normalizeLabel } from "../core/normalize.js";
import { formatDurationRough, parseExpiresAtToMs } from "../core/time.js";

export function formatInteractiveLoginSummary(login) {
  const mode = normalizeInteractiveOAuthMode(login?.mode);
  if (mode === REAUTH_MODE_NATIVE_CLAUDE) {
    return REAUTH_MODE_NATIVE_CLAUDE;
  }
  if (mode === REAUTH_MODE_MANUAL_CALLBACK) {
    return "manual-callback";
  }
  const bindingMode = normalizeBrowserBindingMode(login?.binding?.mode);
  if (bindingMode === BROWSER_MODE_AIM_PROFILE) {
    return "aim-profile";
  }
  if (bindingMode === BROWSER_MODE_CHROME_PROFILE) {
    return "chrome-profile";
  }
  if (bindingMode === BROWSER_MODE_AGENT_BROWSER) {
    const session = String(login?.binding?.agentBrowserSession ?? "").trim();
    return session ? `agent-browser:${session}` : "agent-browser";
  }
  if (mode === REAUTH_MODE_BROWSER_MANAGED) {
    return "browser-managed";
  }
  return null;
}

export function formatStatusAccountExpiryCell(expiresIn) {
  const raw = String(expiresIn ?? "").trim();
  if (!raw || raw === "unknown") return "--";
  const expiredMatch = raw.match(/^expired \((.+)\)$/i);
  if (expiredMatch?.[1]) {
    return expiredMatch[1].trim();
  }
  return raw;
}

export function readStatusAccountUsedPercent(usage, index) {
  if (!usage || usage.ok !== true) return null;
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const usedPercent = Number(windows[index]?.usedPercent);
  return Number.isFinite(usedPercent) ? usedPercent : null;
}

export function formatStatusAccountUsedCell(usage, index) {
  const usedPercent = readStatusAccountUsedPercent(usage, index);
  if (!Number.isFinite(usedPercent)) return "--";
  return `${Math.round(usedPercent)}%`;
}

export function formatStatusAccountResetCreditsCell(usage) {
  const count = usage?.resetCreditsAvailable;
  return Number.isInteger(count) && count >= 0 ? String(count) : "--";
}

export function formatStatusDeltaMsCell(deltaMs) {
  if (!Number.isFinite(deltaMs)) return "--";
  const deltaHours = deltaMs / 3600000;
  if (deltaHours <= 0) return "0h";
  if (deltaHours >= 48) {
    return `${(deltaHours / 24).toFixed(1)}d`;
  }
  return `${deltaHours.toFixed(1)}h`;
}

export function readStatusAccountResetDeltaMs(usage, index, now = Date.now()) {
  if (!usage || usage.ok !== true) return null;
  const windows = Array.isArray(usage.windows) ? usage.windows : [];
  const resetAt = windows[index]?.resetAt;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  return ms - now;
}

export function readStatusAccountExpiryDeltaMs(credentials, now = Date.now()) {
  const expiresAt = typeof credentials?.expiresAt === "string" ? credentials.expiresAt.trim() : "";
  const ms = parseExpiresAtToMs(expiresAt);
  if (!Number.isFinite(ms)) return null;
  return ms - now;
}

export function formatStatusAccountResetCell(usage, index, now = Date.now()) {
  return formatStatusDeltaMsCell(readStatusAccountResetDeltaMs(usage, index, now));
}

export function averageStatusNumbers(values) {
  const normalizedValues = (Array.isArray(values) ? values : []).filter((value) => Number.isFinite(value));
  if (normalizedValues.length === 0) return null;
  return normalizedValues.reduce((sum, value) => sum + value, 0) / normalizedValues.length;
}

export function buildStatusAverageAccountTableRow(accounts, now = Date.now()) {
  const normalizedAccounts = Array.isArray(accounts) ? accounts : [];
  const averageExpiryDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountExpiryDeltaMs(account?.credentials, now)),
  );
  const averageFiveHourUsedPct = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountUsedPercent(account?.usage, 0)),
  );
  const averageFiveHourResetDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountResetDeltaMs(account?.usage, 0, now)),
  );
  const averageWeekUsedPct = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountUsedPercent(account?.usage, 1)),
  );
  const averageWeekResetDeltaMs = averageStatusNumbers(
    normalizedAccounts.map((account) => readStatusAccountResetDeltaMs(account?.usage, 1, now)),
  );

  return [
    "average",
    "--",
    "--",
    "--",
    Number.isFinite(averageExpiryDeltaMs) ? formatDurationRough(averageExpiryDeltaMs) : "--",
    Number.isFinite(averageFiveHourUsedPct) ? `${Math.round(averageFiveHourUsedPct)}%` : "--",
    formatStatusDeltaMsCell(averageFiveHourResetDeltaMs),
    Number.isFinite(averageWeekUsedPct) ? `${Math.round(averageWeekUsedPct)}%` : "--",
    formatStatusDeltaMsCell(averageWeekResetDeltaMs),
    "--",
    "all",
    "--",
    "-",
  ];
}

export function buildStatusAccountFlags(account) {
  const flags = [];
  const detailReason = String(account?.operator?.detailReason ?? "").trim();
  if (account?.authorityImport?.dirtyLocal === true) {
    flags.push("dirty_authority");
  }
  if (detailReason === "missing_browser" || detailReason === "binding_missing_for_future_reauth") {
    flags.push("missing_browser");
  } else if (detailReason && detailReason !== "manual_mode" && detailReason !== "native_claude") {
    flags.push(detailReason);
  }

  if (account?.usage?.ok === true) {
    const windows = Array.isArray(account.usage.windows) ? account.usage.windows : [];
    if (Number(windows[0]?.usedPercent) >= 100) {
      flags.push("5h_full");
    }
    if (Number(windows[1]?.usedPercent) >= 100) {
      flags.push("week_full");
    }
  }

  return flags.length > 0 ? flags.join(",") : "-";
}

export function formatStatusTable(rows) {
  const normalizedRows = Array.isArray(rows) ? rows : [];
  if (normalizedRows.length === 0) return [];
  const widths = normalizedRows[0].map((header, index) => (
    normalizedRows.reduce((max, row) => Math.max(max, String(row[index] ?? "").length), String(header ?? "").length)
  ));
  return normalizedRows.map((row) => (
    row
      .map((value, index) => String(value ?? "").padEnd(widths[index]))
      .join("  ")
      .trimEnd()
  ));
}

export function renderStatusCompactText(view) {
  const redis = typeof view?.redis?.status === "string" ? view.redis.status : "unknown";
  const codex = resolveCurrentConfiguredCodexLabel(view) || "none";
  const claude = typeof view?.claudeCli?.lastRunLabel === "string" && view.claudeCli.lastRunLabel.trim()
    ? view.claudeCli.lastRunLabel.trim()
    : typeof view?.claudeCli?.inferredLabel === "string" && view.claudeCli.inferredLabel.trim()
      ? view.claudeCli.inferredLabel.trim()
      : "none";
  const accounts = Array.isArray(view?.accounts) ? view.accounts.length : 0;
  const cacheAgeMs = Number(view?.redis?.cacheAgeMs);
  return `redis=${redis}  accounts=${accounts}  codex=${codex}  claude_last=${claude}`
    + (Number.isFinite(cacheAgeMs) ? `  cache_age=${Math.floor(cacheAgeMs / 1000)}s` : "")
    + "\n";
}

export function resolveCurrentConfiguredCodexLabel(view) {
  const inferredLabel = typeof view.codexCli?.inferredLabel === "string" ? normalizeLabel(view.codexCli.inferredLabel) : "";
  if (inferredLabel) return inferredLabel;
  const activeLabel = typeof view.codexCli?.activeLabel === "string" ? normalizeLabel(view.codexCli.activeLabel) : "";
  return activeLabel || "";
}

export function renderCurrentCodexUsageText(view, { now = view?.nowMs ?? Date.now() } = {}) {
  const label = resolveCurrentConfiguredCodexLabel(view) || "none";
  const account = Array.isArray(view.accounts) ? view.accounts.find((entry) => entry?.label === label) ?? null : null;
  return (
    `label=${label}` +
    `  5h_used=${formatStatusAccountUsedCell(account?.usage, 0)}` +
    `  5h_in=${formatStatusAccountResetCell(account?.usage, 0, now)}` +
    `  wk_used=${formatStatusAccountUsedCell(account?.usage, 1)}` +
    `  wk_in=${formatStatusAccountResetCell(account?.usage, 1, now)}\n`
  );
}
