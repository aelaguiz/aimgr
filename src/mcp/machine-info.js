// Facts the `aim` CLI does not already print: machine identity, disk headroom,
// Redis reachability, watcher log freshness, and the newest routine receipt per
// routine. Every collector is best effort and reports a per-field `error` string
// instead of throwing, and nothing here grades or summarizes — interpretation
// belongs to the calling agent.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { resolveAimgrRoutineRunsDir } from "../io/paths.js";
import { buildAimLogMap, statLogFile } from "./logs.js";
import { runAimCommand } from "./exec.js";

export const TAILSCALE_LOOKUP_TIMEOUT_MS = 2_000;
const TAILSCALE_CGNAT_PATTERN = /^100\.(6[4-9]|[7-9]\d|1[0-1]\d|12[0-7])\./u;

export function resolveAimgrRepoRoot() {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
}

// Node's spawnSync option is `timeout`, not `timeoutMs`; the misspelling silently
// disables the bound, so every collector here must go through this one helper.
export function runCommandCapture(command, args, { timeoutMs = 5_000, cwd } = {}) {
  const result = spawnSync(command, args, {
    cwd,
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    encoding: "utf8",
  });
  if (result.error) return { ok: false, error: String(result.error.message ?? result.error) };
  if (result.status !== 0) {
    return {
      ok: false,
      error: String(result.stderr ?? "").trim() || `exit ${result.status}`,
    };
  }
  return { ok: true, stdout: String(result.stdout ?? "") };
}

export function resolveTailscaleIpv4({
  runCommandImpl = runCommandCapture,
  networkInterfacesImpl = os.networkInterfaces,
} = {}) {
  const cli = runCommandImpl("tailscale", ["ip", "-4"], { timeoutMs: TAILSCALE_LOOKUP_TIMEOUT_MS });
  const cliIp = String(cli?.stdout ?? "").trim().split("\n")[0]?.trim();
  if (cli?.ok && cliIp) return cliIp;
  const interfaces = networkInterfacesImpl() ?? {};
  for (const entries of Object.values(interfaces)) {
    for (const entry of entries ?? []) {
      if (entry?.family === "IPv4" && TAILSCALE_CGNAT_PATTERN.test(String(entry.address))) {
        return entry.address;
      }
    }
  }
  return null;
}

function collectAimgrRev({ runCommandImpl, repoRoot }) {
  const result = runCommandImpl("git", ["rev-parse", "--short", "HEAD"], { cwd: repoRoot, timeoutMs: 5_000 });
  if (!result?.ok) return { error: String(result?.error ?? "unavailable") };
  return { rev: String(result.stdout ?? "").trim() };
}

export function parseDfKilobytes(stdout) {
  const lines = String(stdout ?? "").trim().split("\n");
  if (lines.length < 2) return { error: "df returned no rows" };
  const fields = lines[lines.length - 1].trim().split(/\s+/u);
  if (fields.length < 5) return { error: "df row was not parseable" };
  const [, totalKb, usedKb, availableKb, capacity] = fields;
  return {
    totalKb: Number(totalKb),
    usedKb: Number(usedKb),
    availableKb: Number(availableKb),
    capacityPct: Number(String(capacity).replace("%", "")),
  };
}

function collectDiskFree({ runCommandImpl, homeDir }) {
  const result = runCommandImpl("df", ["-k", homeDir], { timeoutMs: 5_000 });
  if (!result?.ok) return { path: homeDir, error: String(result?.error ?? "unavailable") };
  return { path: homeDir, ...parseDfKilobytes(result.stdout) };
}

async function collectRedisPing({ runAimCommandImpl, homeDir }) {
  try {
    const result = await runAimCommandImpl(["redis", "ping", "--home", homeDir], { timeoutMs: 10_000 });
    return result.ok
      ? { ok: true, ms: result.durationMs }
      : { ok: false, ms: result.durationMs, error: String(result.stderr ?? "").trim().slice(0, 500) || `exit ${result.exitCode}` };
  } catch (error) {
    return { ok: false, error: String(error?.message ?? error) };
  }
}

function collectLogs({ logMap, fsImpl, nowMs }) {
  const logs = {};
  for (const [name, streams] of Object.entries(logMap)) {
    logs[name] = {
      out: statLogFile(streams.out, { fsImpl, nowMs }),
      err: statLogFile(streams.err, { fsImpl, nowMs }),
    };
  }
  return logs;
}

export function readNewestRoutineReceipts({ homeDir, fsImpl = fs, nowMs = Date.now() } = {}) {
  const runsDir = resolveAimgrRoutineRunsDir({ homeDir });
  let entries;
  try {
    entries = fsImpl.readdirSync(runsDir);
  } catch {
    return [];
  }
  const newestByRoutineId = new Map();
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const receiptPath = path.join(runsDir, entry);
    let receipt;
    let mtimeMs;
    try {
      mtimeMs = fsImpl.statSync(receiptPath).mtimeMs;
      receipt = JSON.parse(fsImpl.readFileSync(receiptPath, "utf8"));
    } catch {
      continue;
    }
    const routineId = String(receipt?.routineId ?? "").trim();
    if (!routineId) continue;
    const previous = newestByRoutineId.get(routineId);
    if (previous && previous.mtimeMs >= mtimeMs) continue;
    newestByRoutineId.set(routineId, {
      mtimeMs,
      record: {
        routineId,
        fireKey: receipt?.fireKey ?? null,
        outcome: receipt?.outcome ?? null,
        ageSeconds: Math.max(0, Math.round((nowMs - mtimeMs) / 1000)),
      },
    });
  }
  return [...newestByRoutineId.values()]
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .map((entry) => entry.record);
}

export async function collectMachineInfo({
  homeDir = os.homedir(),
  nowMs = Date.now(),
  repoRoot = resolveAimgrRepoRoot(),
  hostnameImpl = os.hostname,
  networkInterfacesImpl = os.networkInterfaces,
  runCommandImpl = runCommandCapture,
  runAimCommandImpl = runAimCommand,
  readRoutineReceiptsImpl = readNewestRoutineReceipts,
  logMap = buildAimLogMap({ homeDir }),
  fsImpl = fs,
} = {}) {
  const rev = collectAimgrRev({ runCommandImpl, repoRoot });
  return {
    collectedAt: new Date(nowMs).toISOString(),
    hostname: hostnameImpl(),
    tailscaleIp: resolveTailscaleIpv4({ runCommandImpl, networkInterfacesImpl }),
    aimgrRev: rev.rev ?? null,
    ...(rev.error ? { aimgrRevError: rev.error } : {}),
    repoRoot,
    diskFree: collectDiskFree({ runCommandImpl, homeDir }),
    redisPingMs: await collectRedisPing({ runAimCommandImpl, homeDir }),
    logs: collectLogs({ logMap, fsImpl, nowMs }),
    routineReceipts: readRoutineReceiptsImpl({ homeDir, fsImpl, nowMs }),
  };
}
