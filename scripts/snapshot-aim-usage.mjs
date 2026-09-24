#!/usr/bin/env node

// Capture the public, redacted AIM status surfaces without exporting credentials.
// Run once with --once (the default), or keep this process in the foreground with --watch.

import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_OUT_DIR = path.join(os.homedir(), ".aimgr", "usage-snapshots");
const ACTIVITY_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "snapshot-agent-activity.py");
const CSV_COLUMNS = [
  "captured_at", "observed_at", "provider", "label", "window", "reset_at",
  "used", "limit", "remaining", "unit", "source", "stale", "usage_ok",
  "account_status", "elapsed_hours", "delta_used", "drain_per_hour",
];
const ACTIVITY_CSV_COLUMNS = [
  "captured_at", "host", "runtime", "provider", "session_id", "account_label",
  "account_evidence", "account_confidence", "project", "title", "model", "last_activity_at",
  "live_process", "recently_active", "weekly_reset_at", "token_events_in_tail",
  "model_responses_in_tail", "session_kind", "parent_session_id",
  "tool_counts_in_tail", "edited_paths_in_tail",
];

function parseArgs(args) {
  let watch = false;
  let rebuild = false;
  let outDir = DEFAULT_OUT_DIR;
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--watch") watch = true;
    else if (args[i] === "--once") watch = false;
    else if (args[i] === "--rebuild") rebuild = true;
    else if (args[i] === "--out-dir" && args[i + 1]) outDir = path.resolve(args[++i]);
    else throw new Error(`Unknown argument: ${args[i]}`);
  }
  if (watch && rebuild) throw new Error("Choose --watch or --rebuild.");
  return { watch, rebuild, outDir };
}

function runAim(args) {
  const startedAt = new Date().toISOString();
  return new Promise((resolve) => {
    execFile("aim", args, { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 120_000 },
      (error, stdout) => {
        let data = null;
        try {
          data = JSON.parse(stdout);
        } catch {
          // Preserve the failure classification, never raw stderr or credential material.
        }
        resolve({
          command: ["aim", ...args],
          startedAt,
          endedAt: new Date().toISOString(),
          exitCode: error?.code ?? 0,
          ...(data ? { data } : { errorKind: error?.killed ? "timeout" : "invalid_or_missing_json" }),
        });
      });
  });
}

function runActivity() {
  return new Promise((resolve) => {
    execFile("python3", [ACTIVITY_SCRIPT, "--fleet"],
      { encoding: "utf8", maxBuffer: 4 * 1024 * 1024, timeout: 45_000 },
      (error, stdout) => {
        try {
          const data = JSON.parse(stdout);
          if (Array.isArray(data.hosts)) return resolve(data);
        } catch {
          // A failed sampler must not stop the usage snapshot.
        }
        resolve({ schemaVersion: 1, hosts: [], errors: [{ host: "activity_sampler", errorKind: error?.killed ? "timeout" : "unavailable" }] });
      });
  });
}

function stripEmailFields(value) {
  if (Array.isArray(value)) return value.map(stripEmailFields);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value)
    .filter(([key]) => !["email", "emailAddress"].includes(key))
    .map(([key, child]) => [key, stripEmailFields(child)]));
}

function linkActivityAccounts(activity, status) {
  const labelsByReset = new Map();
  for (const account of status?.accounts ?? []) {
    if (account.provider !== "openai-codex") continue;
    for (const window of account.usage?.windows ?? []) {
      if (window.label !== "Week" || !Number.isFinite(window.resetAt)) continue;
      const labels = labelsByReset.get(window.resetAt) ?? new Set();
      labels.add(account.label);
      labelsByReset.set(window.resetAt, labels);
    }
  }
  for (const host of activity.hosts ?? []) {
    for (const session of host.sessions ?? []) {
      session.liveProcess = (host.processes ?? []).some((process) => process.sessionIds?.includes(session.sessionId));
      const ageMs = Date.now() - Date.parse(session.lastActivityAt);
      session.recentlyActive = Number.isFinite(ageMs) && ageMs >= 0 && ageMs <= 5 * 60_000;
      if (session.accountLabel) {
        session.accountConfidence = "exact";
        continue;
      }
      if (session.provider !== "openai-codex" || !session.weeklyResetAt) continue;
      const labels = labelsByReset.get(Date.parse(session.weeklyResetAt));
      if (labels?.size === 1) {
        session.accountLabel = [...labels][0];
        session.accountEvidence = "rate_limit_reset_match";
        session.accountConfidence = "inferred";
      }
    }
  }
  return activity;
}

function iso(value) {
  const timestamp = typeof value === "number" ? value : Date.parse(value ?? "");
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toISOString() : "";
}

function percentageRows(snapshot) {
  const status = snapshot.status.data;
  if (!Array.isArray(status?.accounts)) return [];
  const rows = [];
  for (const account of status.accounts) {
    const usage = account.usage ?? {};
    const observedAt = iso(usage.observedAtMs ?? usage.usageObservedAtMs)
      || iso(status.generatedAt);
    const common = {
      captured_at: snapshot.capturedAt,
      observed_at: observedAt,
      provider: account.provider,
      label: account.label,
      source: usage.source ?? "unavailable",
      stale: usage.stale === true,
      usage_ok: usage.ok === true,
      account_status: account.operator?.status ?? "unknown",
    };
    if (!Array.isArray(usage.windows) || usage.windows.length === 0) {
      rows.push(common);
      continue;
    }
    for (const window of usage.windows) {
      const used = Number(window.usedPercent);
      if (!Number.isFinite(used)) continue;
      rows.push({
        ...common,
        window: window.label,
        reset_at: iso(window.resetAt),
        used,
        limit: 100,
        remaining: 100 - used,
        unit: "percent",
      });
    }
  }
  return rows;
}

function grokRows(snapshot) {
  const rows = snapshot.grokStatus.data?.rows;
  if (!Array.isArray(rows)) return [];
  return rows.map((account) => {
    const usage = account.usage ?? {};
    return {
      captured_at: snapshot.capturedAt,
      observed_at: snapshot.grokStatus.endedAt,
      provider: "xai",
      label: account.label,
      window: usage.ok ? "Month" : "",
      reset_at: iso(usage.periodEnd),
      used: Number.isFinite(usage.used) ? usage.used : "",
      limit: Number.isFinite(usage.limit) ? usage.limit : "",
      remaining: Number.isFinite(usage.remaining) ? usage.remaining : "",
      unit: usage.ok ? "provider_units" : "",
      source: usage.ok ? "live" : "unavailable",
      stale: false,
      usage_ok: usage.ok === true,
      account_status: account.health ?? "unknown",
    };
  });
}

function addDrainRates(rows) {
  const previous = new Map();
  for (const row of rows) {
    if (!row.window || !row.reset_at || !Number.isFinite(row.used)) continue;
    const key = `${row.provider}\0${row.label}\0${row.window}`;
    const before = previous.get(key);
    const elapsedHours = before
      ? (Date.parse(row.observed_at) - Date.parse(before.observed_at)) / HOUR_MS
      : 0;
    // Claude rounds reset timestamps differently across reads (usually <1 second).
    const sameWindow = before?.reset_at
      && Math.abs(Date.parse(before.reset_at) - Date.parse(row.reset_at)) <= 60_000;
    if (sameWindow && elapsedHours > 0 && row.used >= before.used) {
      row.elapsed_hours = elapsedHours;
      row.delta_used = row.used - before.used;
      row.drain_per_hour = row.delta_used / elapsedHours;
    }
    if (!before || Date.parse(row.observed_at) > Date.parse(before.observed_at)) {
      previous.set(key, row);
    }
  }
  return rows;
}

function csvCell(value) {
  if (value === undefined || value === null) return "";
  const string = String(value);
  return /[",\r\n]/.test(string) ? `"${string.replaceAll('"', '""')}"` : string;
}

async function writeAtomic(file, contents) {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, contents, { encoding: "utf8", mode: 0o600, flag: "wx" });
  await fs.rename(temporary, file);
}

async function rebuildCsv(outDir) {
  const snapshotsDir = path.join(outDir, "snapshots");
  const files = (await fs.readdir(snapshotsDir)).filter((file) => file.endsWith(".json")).sort();
  const rows = [];
  const activityRows = [];
  for (const file of files) {
    const snapshot = JSON.parse(await fs.readFile(path.join(snapshotsDir, file), "utf8"));
    rows.push(...percentageRows(snapshot), ...grokRows(snapshot));
    for (const host of snapshot.activity?.hosts ?? []) {
      for (const session of host.sessions ?? []) {
        activityRows.push({
          captured_at: snapshot.capturedAt,
          host: host.host,
          runtime: session.runtime,
          provider: session.provider,
          session_id: session.sessionId,
          account_label: session.accountLabel,
          account_evidence: session.accountEvidence,
          account_confidence: session.accountConfidence,
          project: session.project,
          title: session.title,
          model: session.model,
          last_activity_at: session.lastActivityAt,
          live_process: session.liveProcess,
          recently_active: session.recentlyActive,
          weekly_reset_at: session.weeklyResetAt,
          token_events_in_tail: session.tokenEventsInTail,
          model_responses_in_tail: session.modelResponsesInTail,
          session_kind: session.sessionKind,
          parent_session_id: session.parentSessionId,
          tool_counts_in_tail: JSON.stringify(session.toolCountsInTail ?? {}),
          edited_paths_in_tail: (session.editedPathsInTail ?? []).join("; "),
        });
      }
    }
  }
  addDrainRates(rows);
  const csv = [CSV_COLUMNS.join(","), ...rows.map((row) => CSV_COLUMNS.map((key) => csvCell(row[key])).join(","))].join("\n") + "\n";
  const csvPath = path.join(outDir, "usage-samples.csv");
  await writeAtomic(csvPath, csv);
  const activityCsv = [
    ACTIVITY_CSV_COLUMNS.join(","),
    ...activityRows.map((row) => ACTIVITY_CSV_COLUMNS.map((key) => csvCell(row[key])).join(",")),
  ].join("\n") + "\n";
  const activityCsvPath = path.join(outDir, "activity-sessions.csv");
  await writeAtomic(activityCsvPath, activityCsv);
  return { csvPath, activityCsvPath, rows: rows.length, activityRows: activityRows.length, snapshots: files.length };
}

async function capture(outDir) {
  const capturedAt = new Date().toISOString();
  const claudeUsage = await runAim(["claude", "usage", "--fresh", "--json"]);
  const status = await runAim(["status", "--json"]);
  const grokStatus = await runAim(["grok", "status", "--json"]);
  claudeUsage.data = stripEmailFields(claudeUsage.data);
  status.data = stripEmailFields(status.data);
  grokStatus.data = stripEmailFields(grokStatus.data);
  const activity = linkActivityAccounts(await runActivity(), status.data);

  const snapshot = {
    schemaVersion: 1,
    capturedAt,
    completedAt: new Date().toISOString(),
    claudeUsage,
    status,
    grokStatus,
    activity,
  };
  const snapshotsDir = path.join(outDir, "snapshots");
  await fs.mkdir(snapshotsDir, { recursive: true, mode: 0o700 });
  await fs.chmod(outDir, 0o700);
  await fs.chmod(snapshotsDir, 0o700);
  const filename = `${capturedAt.replaceAll(":", "-")}-${process.pid}.json`;
  const snapshotPath = path.join(snapshotsDir, filename);
  await writeAtomic(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`);
  const csv = await rebuildCsv(outDir);
  const counts = {
    codex: status.data?.accounts?.filter((account) => account.provider === "openai-codex").length ?? 0,
    claude: claudeUsage.data?.accounts?.length ?? 0,
    grok: grokStatus.data?.rows?.length ?? 0,
  };
  process.stdout.write(`${snapshot.completedAt} saved ${snapshotPath}\n`);
  process.stdout.write(`${csv.snapshots} snapshot(s), ${csv.rows} usage row(s), ${csv.activityRows} activity row(s), accounts=${JSON.stringify(counts)}\n`);
  if (status.data?.redis?.status !== "live" || !status.data || !grokStatus.data || activity.errors?.length) {
    process.stdout.write("Capture is partial; the next hourly run will retry.\n");
  }
}

async function waitForNextHourlyCapture(outDir) {
  const snapshotsDir = path.join(outDir, "snapshots");
  let files = [];
  try {
    files = (await fs.readdir(snapshotsDir)).filter((file) => file.endsWith(".json")).sort();
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (!files.length) return;
  const last = JSON.parse(await fs.readFile(path.join(snapshotsDir, files.at(-1)), "utf8"));
  const nextAtMs = Date.parse(last.completedAt) + HOUR_MS;
  const delayMs = nextAtMs - Date.now();
  if (!Number.isFinite(delayMs) || delayMs <= 0) return;
  process.stdout.write(`Next capture: ${new Date(nextAtMs).toISOString()}\n`);
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

async function main() {
  const { watch, rebuild, outDir } = parseArgs(process.argv.slice(2));
  await fs.mkdir(outDir, { recursive: true, mode: 0o700 });
  if (rebuild) {
    const result = await rebuildCsv(outDir);
    process.stdout.write(`Rebuilt ${result.csvPath} and ${result.activityCsvPath} from ${result.snapshots} snapshots.\n`);
    return;
  }
  if (watch) {
    process.stdout.write(`Hourly foreground capture started (PID ${process.pid}); output: ${outDir}\n`);
    await waitForNextHourlyCapture(outDir);
  }
  do {
    try {
      await capture(outDir);
    } catch (error) {
      process.stderr.write(`Capture failed: ${error?.message ?? error}\n`);
      if (!watch) process.exitCode = 1;
    }
    if (watch) await new Promise((resolve) => setTimeout(resolve, HOUR_MS));
  } while (watch);
}

await main();
