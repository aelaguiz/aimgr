import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { formatAccountNote } from "./account-notes.js";
import { parseAgyStatusReport } from "./agy-view.js";
import { buildClaudeStatusAccountTable, describeClaudeOperatorState, formatClaudePlan, usageColumns } from "./claude-redis-view.js";
import { buildStatusAccountTable } from "./render.js";
import {
  PLAN_WEEK_WEIGHTS,
  agyUsageColumns,
  buildStatusAccountFlags,
  formatAgyAvailability,
  formatPoolCapacityLines,
  formatStatusAccountResetCell,
  formatStatusAccountUsedCell,
  formatStatusDeltaMsCell,
  formatStatusTable,
  summarizePoolCapacity,
} from "./table.js";

// One table per provider for the whole cluster: a row per account, its usage
// (an account-wide fact, read from the freshest machine that has it signed in),
// and one "machines" cell naming only the exceptions, so the table stays one
// screen wide however many machines join. A short grid above the tables gives
// each machine's own login counts and remaining weekly capacity.

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
  const value = Number(account?.usageObservedAtMs ?? usage?.usageObservedAtMs ?? usage?.observedAtMs);
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

function agyGrantCount(machine) {
  if (machine.error) return NO_ANSWER;
  if (!Object.hasOwn(machine.view ?? {}, "agy")) return "old";
  if (!machine.agy) return "?";
  const { runtime, localState, connections } = machine.agy;
  const present = connections.filter(({ status }) => status === "ready").length;
  const hasInvalid = connections.some(({ status }) => status === "invalid-state");
  const count = localState === "unavailable" ? "?" : `${present}${hasInvalid ? "+?" : ""}`;
  return `${count}${runtime === "unsupported" ? "*" : ""}`;
}

function machineGrid(machines, claude, codex, nowMs) {
  const left = ({ rows, entries }, machine) => {
    if (machine.error) return NO_ANSWER;
    const signedIn = entries.filter((_, index) => rows[index].cells[machine.name] === "✓");
    return summarizePoolCapacity(signedIn, nowMs).left.toFixed(1);
  };
  return formatStatusTable([
    ["signed in", ...machines.map((machine) => machine.name)],
    ["claude", ...machines.map((machine) => machine.claude ? signedInCount(claude.rows, machine) : NO_ANSWER)],
    ["codex", ...machines.map((machine) => signedInCount(codex.rows, machine))],
    ["claude left", ...machines.map((machine) => machine.claude ? left(claude, machine) : NO_ANSWER)],
    ["codex left", ...machines.map((machine) => left(codex, machine))],
    ["agy grants", ...machines.map(agyGrantCount)],
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

function renderClaude(machines, rows, answered, nowMs, columns) {
  const pool = summarizePoolCapacity(columns.entries, nowMs);
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
  if (rows.length > 0) table.push(["pool", "--", "--", "--", ...columns.poolValues(pool), ""]);
  const otherStates = ["NO ROUTE", "PROXY DOWN", "PROXY STARTING", "PROXY UNKNOWN", "PROXY ERROR"]
    .filter((status) => count(status)).map((status) => `${count(status)} ${status.toLowerCase()} · `).join("");
  return [
    `CLAUDE: ${rows.length} accounts · ${otherStates}${count("READY")} ready · ${count("LIMITED")} limited · ${count("IN USE")} in use · `
      + `${unsigned ? `${unsigned} not signed in anywhere · ` : ""}${count("NEEDS YOU")} needs you · ${count("UNKNOWN")} unknown`,
    coverageLine(rows, answered),
    ...formatStatusTable(dropEmptyColumns(table, 4)),
    ...formatPoolCapacityLines(pool, columns.poolOptions),
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

function renderCodex(machines, { rows, entries }, answered, nowMs) {
  const pool = summarizePoolCapacity(entries, nowMs);
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
    const week = pool.measured > 0 ? `${Math.round(100 * pool.used / pool.capacity)}%` : "--";
    table.push(["pool", "--", "--", "--", week, formatStatusDeltaMsCell(pool.halfBackMs), "--", ""]);
  }
  const ready = rows.filter((row) => row.status === "ready");
  const credits = ready.map((row) => row.account.usage?.resetCreditsAvailable)
    .filter((count) => Number.isInteger(count) && count >= 0);
  const withCredits = credits.filter((count) => count > 0).length;
  return [
    `CODEX: ${rows.length} accounts · ${ready.length} ready · ${rows.length - ready.length} not signed in anywhere`,
    coverageLine(rows, answered),
    ...formatStatusTable(table),
    ...formatPoolCapacityLines(pool, {
      unit: "Pro Max weeks",
      weightNote: entries.some((entry) => entry.planKey === "pro") ? "a pro account counts 0.46" : "",
    }),
    ...(credits.length > 0 ? [
      `Reset credits unused: ${credits.reduce((sum, count) => sum + count, 0)} on ${withCredits} ${withCredits === 1 ? "account" : "accounts"}`,
    ] : []),
  ];
}

function parseAgyMachines(reports) {
  return reports.map((machine) => ({ ...machine, agy: parseAgyStatusReport(machine.view?.agy) }));
}

function agyRows(machines) {
  return collectByLabel(machines, (machine) => machine.agy?.connections ?? []).map(([label, byMachine]) => ({
    label,
    byMachine,
    observation: [...byMachine.values()].reduce((latest, { observation }) => (
      observation && (!latest || observation.observedAtMs > latest.observedAtMs) ? observation : latest
    ), null),
  }));
}

function agyMachineConnection({ name, agy }, byMachine) {
  const local = byMachine.get(name);
  const status = local?.status ?? (agy.localState === "available" ? "not-enrolled" : "unknown");
  const availability = agy.runtime === "unsupported" ? "unsupported"
    : local?.availability ?? (local ? undefined : status);
  return { status, ...(availability ? { availability } : {}), ...(local?.route ? { route: local.route } : {}) };
}

// The pools `aim status --json` reports for one machine, built here from every
// machine's freshest reading of each account. A machine whose own logins have
// lapsed cannot read usage and reports days-old figures as its pool, so this is
// the one to show or act on (see buildStatusPool). `readings` marks it.
export function buildClusterPools(machines, { nowMs = Date.now() } = {}) {
  const claudeAccounts = claudeRows(machines, nowMs).map((row) => row.account);
  const codexAccounts = codexRows(machines).map((row) => (
    row.status === "ready" ? row.account : { ...row.account, plan: null, usage: null }
  ));
  const everyMachine = (pool) => ({ ...pool, readings: "every machine" });
  const reportingAgy = parseAgyMachines(machines).filter((machine) => !machine.error && machine.agy);
  return {
    claude: everyMachine(buildClaudeStatusAccountTable({ accounts: claudeAccounts, checkedAtMs: nowMs }).pool),
    codex: everyMachine(buildStatusAccountTable(codexAccounts, nowMs, { codex: true }).pool),
    agy: everyMachine({
      accountRows: agyRows(reportingAgy).map(({ label, byMachine, observation }) => ({
        label,
        observation,
        machines: Object.fromEntries(reportingAgy.map((machine) => (
          [machine.name, agyMachineConnection(machine, byMachine)]
        ))),
      })),
    }),
  };
}

const AGY_MACHINE_MARKS = { ready: "", "needs-sign-in": "!", "not-enrolled": "-", "invalid-state": "?" };

function agyMachineAvailability(machines, byMachine) {
  const groups = new Map();
  for (const machine of machines) {
    const availability = formatAgyAvailability(agyMachineConnection(machine, byMachine));
    if (!groups.has(availability)) groups.set(availability, []);
    groups.get(availability).push(machine.name);
  }
  return [...groups.entries()].map(([availability, names]) => `${availability} ${names.join(", ")}`).join(" · ") || "--";
}

function renderAgy(reportingAgy, nowMs) {
  const reporterMachines = reportingAgy.filter((machine) => machine.agy.localState === "available");
  const rows = agyRows(reportingAgy);
  const hasAvailability = reportingAgy.some(({ agy }) => agy.connections.some((connection) => connection.availability));
  const quota = agyUsageColumns(rows, nowMs);
  const showUsage = hasAvailability || rows.some((row) => row.observation);
  const lines = [`ANTIGRAVITY: ${rows.length} ${rows.length === 1 ? "connection" : "connections"}${quota.hasQuota ? "" : " · quota unavailable"}`];
  if (rows.length === 0) return lines;
  const table = [
    ["account", "local grants", hasAvailability ? "grant on" : "machines",
      ...(showUsage ? quota.headers : []), ...(hasAvailability ? ["availability by machine"] : [])],
    ...rows.map(({ label, byMachine, observation }) => {
      const states = reporterMachines.map(({ name }) => [name, byMachine.get(name)?.status ?? "not-enrolled"]);
      const grants = states.filter(([, state]) => state === "ready").map(([name]) => name);
      const known = states.filter(([, state]) => state !== "invalid-state").length;
      const grantMachines = hasAvailability ? grants : states.map(([name, state]) => `${name}${AGY_MACHINE_MARKS[state]}`);
      return [label, `${grants.length}/${known}`, grantMachines.join(", ") || "--",
        ...(showUsage ? quota.values({ observation }) : []),
        ...(hasAvailability ? [agyMachineAvailability(reportingAgy, byMachine)] : [])];
    }),
  ];
  lines.push("local grants: grant files present / machines with known grant state");
  if (!hasAvailability) lines.push("machines: name has a grant file · name! sign-in required · name- not enrolled · name? invalid local state");
  lines.push(...formatStatusTable(table));
  for (const { label } of rows) {
    for (const { view } of reportingAgy) {
      if (!Array.isArray(view.accountNotes)) continue;
      const record = view.accountNotes.find((entry) => entry?.provider === "antigravity" && entry.label === label && typeof entry.note === "string");
      if (!record) continue;
      lines.push(formatAccountNote(record));
      break;
    }
  }
  return lines;
}

export function renderClusterStatusText(reports, { nowMs = Date.now() } = {}) {
  const machines = parseAgyMachines(reports);
  const answered = machines.filter((machine) => !machine.error);
  const failed = machines.filter((machine) => machine.error);
  const claudeMachines = answered.filter((machine) => machine.claude);
  const claudeUnavailable = answered.filter((machine) => !machine.claude);
  const reportingAgy = answered.filter((machine) => machine.agy);
  const claude = claudeRows(claudeMachines, nowMs);
  const codex = codexRows(machines);
  const columns = usageColumns(claude.map((row) => row.account), nowMs);
  const codexEntries = codex.map(({ status, account }) => {
    const usage = status === "ready" ? account.usage : null;
    const planKey = status === "ready" ? account.plan?.split(" ")[0] : null;
    const knownPlan = Object.hasOwn(PLAN_WEEK_WEIGHTS.codex, planKey);
    return {
      weight: knownPlan ? PLAN_WEEK_WEIGHTS.codex[planKey] : 1,
      planKey,
      knownPlan,
      week: usage?.ok === true ? usage.windows?.[0] ?? null : null,
      session: null,
      observedAtMs: observedAt(usage, account),
    };
  });
  const claudePool = { rows: claude, entries: columns.entries };
  const codexPool = { rows: codex, entries: codexEntries };
  const lines = [
    `AIM CLUSTER: ${answered.length} of ${machines.length} machines answered`
      + (failed.length ? ` · ${failed.map((machine) => `${machine.name}: ${machine.error}`).join(" · ")}` : ""),
    ...machineGrid(machines, claudePool, codexPool, nowMs),
    LEGEND,
    "agy grants: local grant files · * unsupported platform · old older AIM · ? unknown · x no machine status",
    "",
    ...renderClaude(claudeMachines, claude, claudeMachines.length, nowMs, columns),
    ...(claudeUnavailable.length ? [`Claude status unavailable: ${claudeUnavailable.map(({ name }) => name).join(", ")}`] : []),
    "",
    ...renderCodex(machines, codexPool, answered.length, nowMs),
    ...(reportingAgy.length ? ["", ...renderAgy(reportingAgy, nowMs)] : []),
  ];
  return `${lines.join("\n")}\n`;
}
