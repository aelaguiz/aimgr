import { isObject } from "../core/normalize.js";
import { formatAgeSince } from "../core/time.js";
import { formatMetricValue, formatStatusBlockRows } from "./metrics.js";
import { buildStatusAccountFlags, buildStatusAverageAccountTableRow, formatInteractiveLoginSummary, formatStatusAccountExpiryCell, formatStatusAccountResetCell, formatStatusAccountUsedCell, formatStatusTable, renderCurrentCodexUsageText } from "./table.js";

function pushStatusWarningField(parts, name, value, { outputName = name } = {}) {
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed) parts.push(`${outputName}=${trimmed}`);
    return;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    parts.push(`${outputName}=${value}`);
    return;
  }
  if (value === true) {
    parts.push(`${outputName}=true`);
  }
}

function pushStatusWarningListField(parts, name, value) {
  const values = (Array.isArray(value) ? value : [])
    .map((entry) => String(entry ?? "").trim())
    .filter(Boolean);
  if (values.length > 0) {
    parts.push(`${name}=${values.join(",")}`);
  }
}

export function formatStatusWarningLine(w) {
  const parts = [`- ${String(w?.kind ?? "warning").trim() || "warning"}`];
  pushStatusWarningField(parts, "system", w?.system);
  pushStatusWarningField(parts, "label", w?.label);
  pushStatusWarningField(parts, "provider", w?.provider);
  pushStatusWarningListField(parts, "labels", w?.labels);
  pushStatusWarningField(parts, "agentId", w?.agentId, { outputName: "agent" });
  pushStatusWarningField(parts, "homeId", w?.homeId);
  pushStatusWarningField(parts, "accountId", w?.accountId);
  pushStatusWarningField(parts, "expectedAccountId", w?.expectedAccountId);
  pushStatusWarningField(parts, "actualLabel", w?.actualLabel);
  pushStatusWarningField(parts, "expiresAt", w?.expiresAt);
  pushStatusWarningField(parts, "status", w?.status);
  pushStatusWarningField(parts, "authMethod", w?.authMethod);
  pushStatusWarningListField(parts, "env", w?.env);
  pushStatusWarningField(parts, "matchMode", w?.matchMode);
  pushStatusWarningField(parts, "missingScope", w?.missingScope);
  pushStatusWarningField(parts, "tokenExpired", w?.tokenExpired);
  return parts.join(" ");
}

export function renderStatusText(view, { showAssignments = false, showAccounts = true } = {}) {
  const lines = [];
  const now = Number.isFinite(Number(view?.nowMs)) ? Number(view.nowMs) : Date.now();
  lines.push(`aim SSOT: ${view.statePath}`);

  const codexAuthoritySource =
    typeof view.imports?.authority?.codex?.source === "string" ? view.imports.authority.codex.source.trim() : "";
  const codexAuthorityImportedAt =
    typeof view.imports?.authority?.codex?.importedAt === "string" ? view.imports.authority.codex.importedAt.trim() : "";
  const codexDirtyImportedLabels = Array.isArray(view.imports?.authority?.codex?.dirtyLabels) ? view.imports.authority.codex.dirtyLabels : [];
  const codexImportedLabels = Array.isArray(view.codexCli?.importedLabels) ? view.codexCli.importedLabels : [];
  if (codexAuthoritySource || codexImportedLabels.length > 0) {
    lines.push(`Authority import (Codex): source=${codexAuthoritySource || "none"} labels=${codexImportedLabels.length}`);
    if (codexAuthorityImportedAt) {
      lines.push(`Authority import age (Codex): ${formatAgeSince(codexAuthorityImportedAt, now)}`);
    }
    if (codexDirtyImportedLabels.length > 0) {
      lines.push(`Authority dirty (Codex): ${codexDirtyImportedLabels.length} label(s) pending promote`);
    }
  }
  const claudeAuthoritySource =
    typeof view.imports?.authority?.anthropic?.source === "string" ? view.imports.authority.anthropic.source.trim() : "";
  const claudeAuthorityImportedAt =
    typeof view.imports?.authority?.anthropic?.importedAt === "string"
      ? view.imports.authority.anthropic.importedAt.trim()
      : "";
  const claudeDirtyImportedLabels =
    Array.isArray(view.imports?.authority?.anthropic?.dirtyLabels) ? view.imports.authority.anthropic.dirtyLabels : [];
  const claudeImportedLabels = Array.isArray(view.claudeCli?.importedLabels) ? view.claudeCli.importedLabels : [];
  if (claudeAuthoritySource || claudeImportedLabels.length > 0) {
    lines.push(`Authority import (Claude): source=${claudeAuthoritySource || "none"} labels=${claudeImportedLabels.length}`);
    if (claudeAuthorityImportedAt) {
      lines.push(`Authority import age (Claude): ${formatAgeSince(claudeAuthorityImportedAt, now)}`);
    }
    if (claudeDirtyImportedLabels.length > 0) {
      lines.push(`Authority dirty (Claude): ${claudeDirtyImportedLabels.length} label(s) pending promote`);
    }
  }
  lines.push("");

  lines.push("POOL NOW");
  lines.push(
    ...formatStatusBlockRows([
      ["ready_accounts", `${view.pool_now?.ready_accounts ?? 0}/${view.pool_now?.total_accounts ?? 0}`],
      ["active_agents", `${view.pool_now?.active_agents ?? 0}/${view.pool_now?.total_agents ?? 0}`],
      ["assigned_load_w", formatMetricValue(view.pool_now?.assigned_load_w, { integer: true })],
      ["usable_capacity_w", formatMetricValue(view.pool_now?.usable_capacity_w, { integer: true })],
      ["pool_load_pct", formatMetricValue(view.pool_now?.pool_load_pct, { decimals: 1 })],
      ["spare_w", formatMetricValue(view.pool_now?.spare_w, { integer: true })],
      ["spare_heavy", formatMetricValue(view.pool_now?.spare_heavy, { integer: true })],
      ["spare_medium", formatMetricValue(view.pool_now?.spare_medium, { integer: true })],
      ["spare_light", formatMetricValue(view.pool_now?.spare_light, { integer: true })],
    ]),
  );

  lines.push("");
  lines.push("WINDOWS");
  lines.push(
    ...formatStatusBlockRows([
      ["pool_5h_used_pct", formatMetricValue(view.windows?.pool_5h_used_pct, { decimals: 1 })],
      ["pool_5h_remaining_w", formatMetricValue(view.windows?.pool_5h_remaining_w, { integer: true })],
      ["pool_7d_used_pct", formatMetricValue(view.windows?.pool_7d_used_pct, { decimals: 1 })],
      ["pool_7d_remaining_w", formatMetricValue(view.windows?.pool_7d_remaining_w, { integer: true })],
      ["floor_5h_pct", formatMetricValue(view.windows?.floor_5h_pct, { decimals: 1 }), view.windows?.floor_5h_label ? `label=${view.windows.floor_5h_label}` : ""],
      ["floor_7d_pct", formatMetricValue(view.windows?.floor_7d_pct, { decimals: 1 }), view.windows?.floor_7d_label ? `label=${view.windows.floor_7d_label}` : ""],
    ]),
  );

  lines.push("");
  lines.push("PRESSURE");
  lines.push(
    ...formatStatusBlockRows([
      ["recent_overflows_14d", formatMetricValue(view.pressure?.recent_overflows_14d, { integer: true })],
      ["rebalances_blocked_14d", formatMetricValue(view.pressure?.rebalances_blocked_14d, { integer: true })],
      ["rebalances_warn_14d", formatMetricValue(view.pressure?.rebalances_warn_14d, { integer: true })],
      ["cold_start_agents", formatMetricValue(view.pressure?.cold_start_agents, { integer: true })],
      ["over_target_accounts", formatMetricValue(view.pressure?.over_target_accounts, { integer: true })],
    ]),
  );

  lines.push("");
  lines.push("PROJECTION @ CURRENT RATE");
  lines.push(
    ...formatStatusBlockRows([
      ["load_pct_6h", formatMetricValue(view.projection?.load_pct_6h, { decimals: 1 })],
      ["load_pct_24h", formatMetricValue(view.projection?.load_pct_24h, { decimals: 1 })],
      ["load_pct_72h", formatMetricValue(view.projection?.load_pct_72h, { decimals: 1 })],
      ["load_pct_7d", formatMetricValue(view.projection?.load_pct_7d, { decimals: 1 })],
      ["overflow_eta_h", formatMetricValue(view.projection?.overflow_eta_h, { decimals: 1 })],
      ["first_constraint", view.projection?.first_constraint || "--"],
      ["first_constraint_label", view.projection?.first_constraint_label || "--"],
    ]),
  );

  if (showAccounts) {
    lines.push("");
    lines.push(`ACCOUNTS (${view.accounts.length})`);
    const averageAccountRow = view.accounts.length > 0 ? buildStatusAverageAccountTableRow(view.accounts, now) : null;
    const accountRows = [
      ["label", "st", "login", "exp", "5h_used", "5h_in", "wk_used", "wk_in", "provider", "flags"],
      ...view.accounts.map((account) => [
        account.label,
        account.operator?.status || "unknown",
        formatInteractiveLoginSummary(account.login) || "--",
        formatStatusAccountExpiryCell(account.credentials?.expiresIn),
        formatStatusAccountUsedCell(account.usage, 0),
        formatStatusAccountResetCell(account.usage, 0, now),
        formatStatusAccountUsedCell(account.usage, 1),
        formatStatusAccountResetCell(account.usage, 1, now),
        account.provider || "unknown",
        buildStatusAccountFlags(account),
      ]),
      ...(averageAccountRow ? [averageAccountRow] : []),
    ];
    lines.push(...formatStatusTable(accountRows));
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

  if (view.openclaw?.lastApplyReceipt?.status) {
    lines.push("");
    lines.push("LAST REBALANCE");
    lines.push(
      ...formatStatusBlockRows([
        ["status", view.openclaw.lastApplyReceipt.status || "--"],
        ["observed_at", view.openclaw.lastApplyReceipt.observedAt || "--"],
        ["allocation_mode", view.openclaw.lastApplyReceipt.allocationMode || "--"],
        ["moved_agents", formatMetricValue(view.openclaw.lastApplyReceipt.moved?.length ?? 0, { integer: true })],
      ]),
    );
    const perAccountLoad = Array.isArray(view.openclaw?.lastApplyReceipt?.perAccountLoad)
      ? view.openclaw.lastApplyReceipt.perAccountLoad
      : [];
    if (perAccountLoad.length > 0) {
      const spread = perAccountLoad
        .map((entry) => `${entry.label}=${entry.carriedAgentCount} agent(s)/${entry.carriedDemandWeight}w`)
        .join(", ");
      lines.push(`Spread: ${spread}`);
    }
  }

  if (view.codexCli) {
    lines.push("");
    lines.push("CODEX");
    lines.push(
      ...formatStatusBlockRows([
        ["active_label", view.codexCli.activeLabel || "none"],
        ["account_id", view.codexCli.actualAccountId || "--"],
        ["store", view.codexCli.storeMode || "unknown"],
        ["synced_age", view.codexCli.importedAt ? formatAgeSince(view.codexCli.importedAt.trim(), now) : "--"],
        ["last_watch", view.codexCli.lastWatchReceipt?.status || "--"],
        ["last_watch_at", view.codexCli.lastWatchReceipt?.observedAt || "--"],
      ]),
    );
  }

  if (view.hermesFleet) {
    lines.push("");
    lines.push("HERMES");
    lines.push(
      ...formatStatusBlockRows([
        ["homes", formatMetricValue(view.hermesFleet.homeCount ?? 0, { integer: true })],
        ["mapped_homes", `${view.hermesFleet.mappedHomeCount ?? 0}/${view.hermesFleet.homeCount ?? 0}`],
        ["warning_homes", formatMetricValue(view.hermesFleet.warningHomeCount ?? 0, { integer: true })],
        ["last_apply", view.hermesFleet.lastApplyReceipt?.status || "--"],
        ["last_watch", view.hermesFleet.lastWatchReceipt?.status || "--"],
      ]),
    );
    const hermesSpread = Array.isArray(view.hermesFleet.spread) ? view.hermesFleet.spread : [];
    if (hermesSpread.length > 0) {
      lines.push(
        `Spread: ${hermesSpread.map((entry) => `${entry.label}=${entry.carriedHomeCount} home(s)/${entry.carriedDemandWeight}w`).join(", ")}`,
      );
    }
  }

  if (view.claudeCli) {
    lines.push("");
    lines.push("CLAUDE");
    lines.push(
      ...formatStatusBlockRows([
        ["active_label", view.claudeCli.activeLabel || "none"],
        ["subscription", view.claudeCli.actualSubscriptionType || view.claudeCli.expectedSubscriptionType || "--"],
        ["auth_method", view.claudeCli.authStatus?.authMethod || "--"],
        ["auth_status", view.claudeCli.authStatus?.available === true
          ? (view.claudeCli.authStatus.ok === true
            ? (view.claudeCli.authStatus.loggedIn === true ? "logged_in" : "logged_out")
            : "error")
          : "unavailable"],
        ["synced_age", view.claudeCli.importedAt ? formatAgeSince(view.claudeCli.importedAt.trim(), now) : "--"],
        ["credentials_path", view.claudeCli.credentialsPath || "--"],
        ["app_state_path", view.claudeCli.appStatePath || "--"],
      ]),
    );
  }

  if (view.nextBestCandidate?.label) {
    lines.push("");
    lines.push("NEXT BEST CODEX");
    lines.push(
      ...formatStatusBlockRows([
        ["label", view.nextBestCandidate.label],
        ["primary_used_pct", formatMetricValue(view.nextBestCandidate.primaryUsedPct, { integer: true })],
        ["secondary_used_pct", formatMetricValue(view.nextBestCandidate.secondaryUsedPct, { integer: true })],
      ]),
    );
  }

  lines.push("");
  const warnings = Array.isArray(view.warnings) ? view.warnings : [];
  lines.push(`WARNINGS (${warnings.length})`);
  for (const w of warnings.slice(0, 50)) {
    lines.push(formatStatusWarningLine(w));
  }

  lines.push("");
  lines.push(renderCurrentCodexUsageText(view, { now }).trimEnd());

  return `${lines.join("\n")}\n`;
}
