import { normalizeBrowserBindingMode, normalizeInteractiveOAuthMode } from "../browser/bindings.js";
import { BROWSER_MODE_AGENT_BROWSER, BROWSER_MODE_AIM_PROFILE, BROWSER_MODE_CHROME_PROFILE, OPENAI_CODEX_PROVIDER, REAUTH_MODE_BROWSER_MANAGED, REAUTH_MODE_MANUAL_CALLBACK, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { normalizeLabel } from "../core/normalize.js";
import { formatDurationRough, parseExpiresAtToMs } from "../core/time.js";
import { formatAccountNote } from "./account-notes.js";

// Measured from fleet transcripts: Claude 2026-11-24, Codex 2026-11-25.
// psbrain: pods/executive/cfo/work/2026-11-25-aim-pool-capacity-view/
export const PLAN_WEEK_WEIGHTS = Object.freeze({
  claude: Object.freeze({ max_20x: 1, team: 0.46 }),
  codex: Object.freeze({ promax: 1, pro: 0.46 }),
});

const HOUR_MS = 3_600_000;
const RETURN_HORIZONS = [["6h", 6], ["12h", 12], ["24h", 24], ["2d", 48], ["3d", 72], ["5d", 120]];

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

export function readStatusAccountResetCredits(usage) {
  const count = usage?.resetCreditsAvailable;
  return Number.isInteger(count) && count >= 0 ? count : null;
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

export function averageStatusNumbers(values, weights) {
  let total = 0;
  let totalWeight = 0;
  for (const [index, value] of values.entries()) {
    if (!Number.isFinite(value)) continue;
    const weight = weights?.[index] ?? 1;
    total += weight * value;
    totalWeight += weight;
  }
  return totalWeight > 0 ? total / totalWeight : null;
}

export function buildStatusPoolAccountTableRow(accounts, entries, summary, now, { codex = false } = {}) {
  const averageExpiryDeltaMs = averageStatusNumbers(
    accounts.map((account) => readStatusAccountExpiryDeltaMs(account?.credentials, now)),
  );
  const sessionUsedPercent = averageStatusNumbers(
    entries.map((entry) => entry.session?.usedPercent),
    entries.map((entry) => entry.weight),
  );

  return [
    "pool",
    "--",
    "--",
    "--",
    "--",
    Number.isFinite(averageExpiryDeltaMs) ? formatDurationRough(averageExpiryDeltaMs) : "--",
    ...(codex ? [] : [Number.isFinite(sessionUsedPercent) ? `${Math.round(sessionUsedPercent)}%` : "--", "--"]),
    summary.measured > 0 ? `${Math.round(100 * summary.used / summary.capacity)}%` : "--",
    formatStatusDeltaMsCell(summary.halfBackMs),
    "--",
    "all",
    "--",
    "-",
  ];
}

export function summarizePoolCapacity(entries, now) {
  let measured = 0;
  let capacity = 0;
  let used = 0;
  let nearlyFull = 0;
  let held = 0;
  let open = 0;
  let nextOpenMs = null;
  let stale = 0;
  let oldestAgeMs = 0;
  const unknownPlans = new Set();
  const resets = [];

  for (const { weight, planKey, knownPlan, week, session, observedAtMs } of entries) {
    if (!knownPlan && planKey) unknownPlans.add(planKey);
    if (!Number.isFinite(week?.usedPercent)) continue;
    measured += 1;
    capacity += weight;

    const resetInMs = Number.isFinite(week.resetAt) ? week.resetAt - now : null;
    const usedPercent = resetInMs !== null && resetInMs <= 0 ? 0 : week.usedPercent;
    const accountUsed = weight * (usedPercent / 100);
    const accountLeft = weight - accountUsed;
    used += accountUsed;
    if (resetInMs > 0 && accountUsed > 0) {
      resets.push({ resetInMs, accountUsed });
    }

    if (usedPercent >= 95) {
      nearlyFull += accountLeft;
    } else if (session?.usedPercent >= 100 && session.resetAt > now) {
      held += accountLeft;
      const opensInMs = session.resetAt - now;
      nextOpenMs = nextOpenMs === null ? opensInMs : Math.min(nextOpenMs, opensInMs);
    } else {
      open += accountLeft;
    }

    if (Number.isFinite(observedAtMs) && now - observedAtMs > HOUR_MS) {
      stale += 1;
      oldestAgeMs = Math.max(oldestAgeMs, now - observedAtMs);
    }
  }

  const returns = Object.fromEntries(RETURN_HORIZONS.map(([label, hours]) => [
    label,
    resets.reduce((total, { resetInMs, accountUsed }) => (
      resetInMs <= hours * HOUR_MS ? total + accountUsed : total
    ), 0),
  ]));
  let returned = 0;
  let halfBackMs = null;
  for (const { resetInMs, accountUsed } of resets.sort((a, b) => a.resetInMs - b.resetInMs)) {
    returned += accountUsed;
    if (returned >= used / 2) {
      halfBackMs = resetInMs;
      break;
    }
  }

  return {
    accounts: entries.length,
    measured,
    capacity,
    used,
    left: capacity - used,
    nearlyFull,
    held,
    open,
    nextOpenMs,
    returns,
    halfBackMs,
    stale,
    oldestAgeMs,
    unknownPlans: [...unknownPlans],
  };
}

export function buildPoolAccountRow({ weight, week, session, fable, observedAtMs }, {
  label, status, plan, freeAtMs = null, resetCredits = null,
}) {
  const numberOrNull = (value) => Number.isFinite(value) ? value : null;
  return {
    label,
    status,
    plan,
    weight,
    weekUsedPercent: numberOrNull(week?.usedPercent),
    weekResetAt: numberOrNull(week?.resetAt),
    sessionUsedPercent: numberOrNull(session?.usedPercent),
    sessionResetAt: numberOrNull(session?.resetAt),
    fableUsedPercent: numberOrNull(fable?.usedPercent),
    fableResetAt: numberOrNull(fable?.resetAt),
    freeAtMs,
    observedAtMs: numberOrNull(observedAtMs),
    resetCredits,
  };
}

export function buildStatusPool(entries, accountRows, now, { unit, weightNote, counts, fable = null, resetCredits = null }) {
  const { unknownPlans, ...summary } = summarizePoolCapacity(entries, now);
  return {
    pool: { unit, ...summary, counts, fable, resetCredits, pace: null, accountRows },
    poolOptions: { weightNote, unknownPlans, now },
  };
}

export function formatPoolCapacityLines(summary, {
  unit = summary.unit, weightNote, excluded, unknownPlans = summary.unknownPlans, now,
}) {
  if (summary.measured === 0) return ["Pool: no weekly usage readings"];
  const units = (count) => count.toFixed(1);
  const percent = (count) => Math.round(100 * count / summary.capacity);
  const left = [
    units(summary.open) !== "0.0" && `${units(summary.open)} open now`,
    units(summary.held) !== "0.0" && `${units(summary.held)} behind a 5-hour limit (next opens in ${formatStatusDeltaMsCell(summary.nextOpenMs)})`,
    units(summary.nearlyFull) !== "0.0" && `${units(summary.nearlyFull)} on accounts 95% or more used`,
  ].filter(Boolean);
  const returns = RETURN_HORIZONS.map(([label]) => `${units(summary.returns[label])} in ${label}`);
  if (summary.halfBackMs !== null) {
    returns.push(`half of what's used within ${formatStatusDeltaMsCell(summary.halfBackMs)}`);
  }
  const lines = [
    `Pool: ${units(summary.capacity)} ${unit}${weightNote ? ` (${weightNote})` : ""} · ${units(summary.used)} used (${percent(summary.used)}%) · ${units(summary.left)} left (${percent(summary.left)}%)`,
    `Left: ${left.join(" · ") || "nothing"}`,
    `Comes back: ${returns.join(" · ")}`,
  ];
  if (summary.pace) {
    const { hours, perDay, lastsUntilMs } = summary.pace;
    const forecast = lastsUntilMs === null ? "lasts the week"
      : `runs out in ${formatStatusDeltaMsCell(lastsUntilMs - now)}`;
    lines.push(`Pace: ${units(perDay)} a day over the last ${Number(hours.toFixed(1))}h; at this pace it ${forecast}`);
  }
  if (summary.stale > 0) {
    lines.push(`Readings: ${summary.stale} of ${summary.measured} are over an hour old (oldest ${formatStatusDeltaMsCell(summary.oldestAgeMs)}), so the pool is at least this used; aim cluster status reads every machine.`);
  }
  const unmeasured = summary.accounts - summary.measured;
  const notCounted = [
    unmeasured > 0 && `${unmeasured} ${unmeasured === 1 ? "account" : "accounts"} without a reading`,
    excluded,
  ].filter(Boolean);
  if (notCounted.length > 0) lines.push(`Not counted: ${notCounted.join(", ")}`);
  if (unknownPlans.length > 0) {
    lines.push(`Plans with no measured size, counted as 1: ${unknownPlans.join(", ")}`);
  }
  return lines;
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
    if (account?.provider === OPENAI_CODEX_PROVIDER) {
      if (Number(windows[0]?.usedPercent) >= 100) {
        flags.push("week_full");
      }
    } else {
      if (Number(windows[0]?.usedPercent) >= 100) {
        flags.push("5h_full");
      }
      if (Number(windows[1]?.usedPercent) >= 100) {
        flags.push("week_full");
      }
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
  const noteLines = Array.isArray(view?.accountNotes)
    ? view.accountNotes.map((entry) => `note ${formatAccountNote(entry)}\n`).join("")
    : "account notes unavailable (Redis could not be read)\n";
  return `redis=${redis}  accounts=${accounts}  codex=${codex}  claude_last=${claude}`
    + (Number.isFinite(cacheAgeMs) ? `  cache_age=${Math.floor(cacheAgeMs / 1000)}s` : "")
    + "\n" + noteLines;
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
    `  wk_used=${formatStatusAccountUsedCell(account?.usage, 0)}` +
    `  wk_in=${formatStatusAccountResetCell(account?.usage, 0, now)}\n`
  );
}
