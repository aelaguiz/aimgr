import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { describeClaudeOperatorState, findOverallWeeklyWindow, formatClaudePlan, usageColumns } from "./claude-redis-view.js";
import {
  buildStatusAccountFlags,
  buildStatusAverageAccountTableRow,
  formatStatusAccountResetCell,
  formatStatusAccountUsedCell,
  formatStatusTable,
  formatWeeklyCapacityFreeingNextDayLine,
  summarizeWeeklyCapacityFreeingNextDay,
} from "./table.js";

// One table per provider for the whole cluster: a row per account, its usage
// (an account-wide fact, read from the freshest machine that has it signed in),
// and one "machines" cell naming only the exceptions, so the table stays one
// screen wide however many machines join. A short grid above the tables gives
// each machine's own login counts.

const CLAUDE_SIGNED_IN = new Set(["READY", "LIMITED", "IN USE"]);
// When no machine has the account signed in, the most actionable state wins.
const CLAUDE_UNSIGNED_ORDER = [
  "NEEDS YOU", "PROXY DOWN", "PROXY STARTING", "PROXY UNKNOWN", "PROXY ERROR", "UNKNOWN", "NO ROUTE", "NOT SIGNED IN",
];
const NO_ANSWER = "x";

const LEGEND = "machines: where each account is signed in, counting machines that answered · name! needs sign-in again · name? unknown";

function claudeCell(status) {
  if (CLAUDE_SIGNED_IN.has(status)) return "✓";
  if (status === "NOT SIGNED IN") return "-";
  if (status === "NEEDS YOU") return "!";
  return "?";
}

function codexCell(status) {
  if (status === "ready") return "✓";
  if (status === "blocked") return "-";
  if (status === "reauth") return "!";
  return "?";
}

function observedAt(usage, account) {
  const value = Number(account?.usageObservedAtMs ?? usage?.usageObservedAtMs);
  return Number.isFinite(value) ? value : -Infinity;
}

function freshest(entries, usageOf) {
  return entries.reduce((best, entry) => (
    best === null || observedAt(usageOf(entry.account), entry.account) > observedAt(usageOf(best.account), best.account)
      ? entry
      : best
  ), null);
}

function withWindows(account) {
  const usage = account?.usage && typeof account.usage === "object" ? account.usage : {};
  return { ...account, usage: { ...usage, windows: Array.isArray(usage.windows) ? usage.windows : [] } };
}

// machines: [{ name, error?, claude?: <aim claude status --json>, view?: <aim status --json> }]
function collectByLabel(machines, accountsOf) {
  const byLabel = new Map();
  for (const machine of machines) {
    if (machine.error) continue;
    for (const account of accountsOf(machine)) {
      if (typeof account?.label !== "string" || !account.label) continue;
      if (!byLabel.has(account.label)) byLabel.set(account.label, new Map());
      byLabel.get(account.label).set(machine.name, account);
    }
  }
  return [...byLabel.entries()].sort(([left], [right]) => left.localeCompare(right));
}

function coverageLine(rows, answered) {
  const all = rows.filter((row) => row.on === answered).length;
  const none = rows.filter((row) => row.on === 0).length;
  return `Signed in on all ${answered} machines: ${all} · on some: ${rows.length - all - none} · on none: ${none}`;
}

// Name the minority: "all", "all but mini-4, mini-5", or the few machines with
// a login. A machine whose login needs attention keeps its ! or ? mark.
function machinesCell(row, machines) {
  const answered = machines.filter((machine) => !machine.error).map((machine) => machine.name);
  const on = answered.filter((name) => row.cells[name] === "✓");
  const marked = (name) => (row.cells[name] === "-" ? name : `${name}${row.cells[name]}`);
  const off = answered.filter((name) => row.cells[name] !== "✓");
  const flagged = off.filter((name) => row.cells[name] !== "-").map(marked);
  if (answered.length === 0) return "--";
  if (off.length === 0) return "all";
  if (on.length > answered.length / 2) return `all but ${off.map(marked).join(", ")}`;
  if (on.length === 0 && flagged.length === 0) return "none";
  return [...on, ...flagged].join(", ");
}

const signedInCount = (rows, machine) => (
  machine.error ? NO_ANSWER : String(rows.filter((row) => row.cells[machine.name] === "✓").length)
);

function machineGrid(machines, claudeRows, codexRows) {
  return formatStatusTable([
    ["signed in", ...machines.map((machine) => machine.name)],
    ["claude", ...machines.map((machine) => signedInCount(claudeRows, machine))],
    ["codex", ...machines.map((machine) => signedInCount(codexRows, machine))],
  ]);
}

// Usage columns with no reading on any account (the Opus pair, today) only add width.
function dropEmptyColumns(table, from) {
  const keep = table[0].map((_, index) => index < from
    || table.slice(1).some((row) => row[index] !== undefined && row[index] !== "" && row[index] !== "--"));
  return table.map((row) => row.filter((_, index) => keep[index]));
}

function claudeRows(machines, nowMs) {
  return collectByLabel(machines, (machine) => machine.claude?.accounts ?? []).map(([label, byMachine]) => {
    const entries = [...byMachine.entries()].map(([machine, account]) => ({
      machine,
      account: withWindows(account),
      status: describeClaudeOperatorState(account, nowMs).status,
    }));
    const signedIn = entries.filter((entry) => CLAUDE_SIGNED_IN.has(entry.status));
    const best = freshest(signedIn, (account) => account.usage)
      ?? freshest(entries.filter((entry) => entry.account.usage.ok === true), (account) => account.usage)
      ?? entries[0];
    const status = signedIn.length > 0
      ? describeClaudeOperatorState(best.account, nowMs).status
      : CLAUDE_UNSIGNED_ORDER.find((candidate) => entries.some((entry) => entry.status === candidate)) ?? "UNKNOWN";
    const cells = Object.fromEntries(machines.map((machine) => [
      machine.name,
      machine.error ? NO_ANSWER : byMachine.has(machine.name) ? claudeCell(entries.find((entry) => entry.machine === machine.name).status) : "-",
    ]));
    return { label, status, on: signedIn.length, account: best.account, cells };
  });
}

function renderClaude(machines, rows, answered, nowMs) {
  const columns = usageColumns(rows.map((row) => row.account), nowMs);
  const count = (status) => rows.filter((row) => row.status === status).length;
  const unsigned = count("NOT SIGNED IN");
  const table = [
    ["account", "status", "on", "plan", ...columns.headers, "machines"],
    ...rows.map((row) => [
      row.label,
      row.status,
      `${row.on}/${answered}`,
      formatClaudePlan(row.account),
      ...columns.values(row.account),
      machinesCell(row, machines),
    ]),
  ];
  if (rows.length > 0) table.push(["average", "--", "--", "--", ...columns.averageValues(), ""]);
  const otherStates = ["NO ROUTE", "PROXY DOWN", "PROXY STARTING", "PROXY UNKNOWN", "PROXY ERROR"]
    .filter((status) => count(status)).map((status) => `${count(status)} ${status.toLowerCase()} · `).join("");
  return [
    `CLAUDE: ${rows.length} accounts · ${otherStates}${count("READY")} ready · ${count("LIMITED")} limited · ${count("IN USE")} in use · `
      + `${unsigned ? `${unsigned} not signed in anywhere · ` : ""}${count("NEEDS YOU")} needs you · ${count("UNKNOWN")} unknown`,
    coverageLine(rows, answered),
    ...formatStatusTable(dropEmptyColumns(table, 4)),
    formatWeeklyCapacityFreeingNextDayLine(
      summarizeWeeklyCapacityFreeingNextDay(rows.map((row) => findOverallWeeklyWindow(row.account.usage)), nowMs),
    ),
  ];
}

function codexRows(machines) {
  const codexAccounts = (machine) => (Array.isArray(machine.view?.accounts) ? machine.view.accounts : [])
    .filter((account) => account?.provider === OPENAI_CODEX_PROVIDER);
  return collectByLabel(machines, codexAccounts).map(([label, byMachine]) => {
    const entries = [...byMachine.entries()].map(([machine, account]) => ({
      machine,
      account,
      status: typeof account?.operator?.status === "string" ? account.operator.status : "unknown",
    }));
    const ready = entries.filter((entry) => entry.status === "ready");
    const best = freshest(ready, (account) => account?.usage) ?? entries[0];
    const status = ready.length > 0 ? "ready"
      : entries.some((entry) => entry.status === "reauth") ? "reauth"
        : entries.find((entry) => entry.status !== "blocked")?.status ?? "blocked";
    const cells = Object.fromEntries(machines.map((machine) => [
      machine.name,
      machine.error ? NO_ANSWER : byMachine.has(machine.name) ? codexCell(entries.find((entry) => entry.machine === machine.name).status) : "-",
    ]));
    return { label, status, on: ready.length, account: best.account, cells };
  }).filter((row) => row.status !== "blocked");
}

function renderCodex(machines, rows, answered, nowMs) {
  const table = [
    ["account", "st", "on", "plan", "wk_used", "wk_in", "flags", "machines"],
    ...rows.map((row) => [
      row.label,
      row.status,
      `${row.on}/${answered}`,
      row.status === "ready" ? row.account?.plan || "--" : "--",
      row.status === "ready" ? formatStatusAccountUsedCell(row.account?.usage, 0) : "--",
      row.status === "ready" ? formatStatusAccountResetCell(row.account?.usage, 0, nowMs) : "--",
      row.status === "ready" ? buildStatusAccountFlags(row.account) : "-",
      machinesCell(row, machines),
    ]),
  ];
  if (rows.length > 0) {
    const average = buildStatusAverageAccountTableRow(
      rows.filter((row) => row.status === "ready").map((row) => row.account), nowMs, { codex: true },
    );
    table.push(["average", "--", "--", "--", average[6], average[7], "--", ""]);
  }
  const readyCount = rows.filter((row) => row.status === "ready").length;
  return [
    `CODEX: ${rows.length} accounts · ${readyCount} ready · ${rows.length - readyCount} not signed in anywhere`,
    coverageLine(rows, answered),
    ...formatStatusTable(table),
    formatWeeklyCapacityFreeingNextDayLine(summarizeWeeklyCapacityFreeingNextDay(
      rows.map((row) => (row.status === "ready" && row.account?.usage?.ok === true ? row.account.usage.windows?.[0] ?? null : null)),
      nowMs,
    )),
  ];
}

export function renderClusterStatusText(machines, { nowMs = Date.now() } = {}) {
  const answered = machines.filter((machine) => !machine.error);
  const failed = machines.filter((machine) => machine.error);
  const claude = claudeRows(machines, nowMs);
  const codex = codexRows(machines);
  const lines = [
    `AIM CLUSTER: ${answered.length} of ${machines.length} machines answered`
      + (failed.length ? ` · ${failed.map((machine) => `${machine.name}: ${machine.error}`).join(" · ")}` : ""),
    ...machineGrid(machines, claude, codex),
    LEGEND,
    "",
    ...renderClaude(machines, claude, answered.length, nowMs),
    "",
    ...renderCodex(machines, codex, answered.length, nowMs),
  ];
  return `${lines.join("\n")}\n`;
}
