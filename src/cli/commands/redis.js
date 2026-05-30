import fs from "node:fs";
import path from "node:path";
import { normalizeAimgrConfig, readAimgrConfig, writeAimgrConfig } from "../../config/aimgr-config.js";
import { buildLocalMachineInfo } from "../../coordination/machine.js";
import {
  closeRedisStore,
  connectRedisStore,
  importSnapshot,
  readSnapshot,
  registerMachine,
} from "../../coordination/redis-store.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { resolveCliPath } from "../../io/paths.js";
import {
  applyRedisMigrationPlan,
  buildRedisMigrationPlan,
  collectRedisMigrationBundle,
  createMigrationRefreshCandidateImpl,
  defaultMigrationDir,
  readMigrationBundlesFromDir,
} from "../../migration/redis-migration.js";

function requireRedisUrl(opts) {
  const url = String(opts.url ?? "").trim();
  if (!url) throw new Error("Missing --url for `aim redis configure`.");
  return url;
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(sanitizeForStatus(value), null, 2)}\n`);
}

function writeJsonOutput(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
}

async function withRedisStore({ homeDir, opts }, fn) {
  const { redis } = readAimgrConfig({ homeDir }).config;
  if (!redis.url) {
    throw new Error("AIM Redis is not configured. Run `aim redis configure --url redis://amirs-mac-studio:6380 --primary-host agents@amirs-mac-studio`.");
  }
  const store = await connectRedisStore({
    url: opts.url ?? redis.url,
    keyPrefix: opts.keyPrefix ?? redis.keyPrefix,
  });
  try {
    return await fn(store, redis);
  } finally {
    await closeRedisStore(store);
  }
}

export async function handleRedis(context) {
  const { opts, positional, homeDir, stdout, nowMs, refreshOpenAICodexImpl, refreshAnthropicImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing redis subcommand. Usage: aim redis configure|config|ping|snapshot|export|import|migrate ...");
  }

  if (subcmd === "configure") {
    const existing = readAimgrConfig({ homeDir }).config;
    const config = normalizeAimgrConfig({
      ...existing,
      redis: {
        ...existing.redis,
        url: requireRedisUrl(opts),
        keyPrefix: opts.keyPrefix ?? existing.redis.keyPrefix,
        primaryHost: opts.primaryHost ?? existing.redis.primaryHost,
        transport: opts.transport ?? existing.redis.transport ?? "tailscale",
      },
    });
    const written = writeAimgrConfig({ homeDir, config });
    const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
    printJson(stdout, { ok: true, path: written.path, redis: written.config.redis, machineId: machine.machineId });
    return;
  }

  if (subcmd === "config") {
    const read = readAimgrConfig({ homeDir });
    const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
    printJson(stdout, {
      ok: true,
      path: read.path,
      exists: read.exists,
      redis: read.config.redis,
      machineId: machine.machineId,
      machineIdPath: machine.machineIdPath,
    });
    return;
  }

  if (subcmd === "ping") {
    await withRedisStore({ homeDir, opts }, async (store, redis) => {
      const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
      const pong = await store.client.ping();
      const registered = await registerMachine(store, machine);
      printJson(stdout, { ok: pong === "PONG", pong, redis, machineId: machine.machineId, registered });
    });
    return;
  }

  if (subcmd === "snapshot") {
    await withRedisStore({ homeDir, opts }, async (store) => {
      const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
      await registerMachine(store, machine);
      printJson(stdout, { ok: true, snapshot: await readSnapshot(store), machineId: machine.machineId });
    });
    return;
  }

  if (subcmd === "export") {
    await withRedisStore({ homeDir, opts }, async (store) => {
      const snapshot = await readSnapshot(store);
      if (opts.outFile) {
        const outPath = resolveCliPath(opts.outFile, { homeDir, optionName: "--out" });
        fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        printJson(stdout, { ok: true, outFile: outPath, counts: { labels: snapshot.labels.length, sessions: snapshot.sessions.length, machines: snapshot.machines.length } });
      } else {
        printJson(stdout, { ok: true, snapshot });
      }
    });
    return;
  }

  if (subcmd === "import") {
    const inPath = resolveCliPath(opts.inFile, { homeDir, optionName: "--in" });
    const snapshot = JSON.parse(fs.readFileSync(inPath, "utf8"));
    await withRedisStore({ homeDir, opts }, async (store) => {
      const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
      const results = await importSnapshot(store, snapshot, { machineId: machine.machineId, observedAt: new Date(nowMs).toISOString() });
      printJson(stdout, {
        ok: results.every((result) => result.ok),
        inFile: inPath,
        results,
      });
    });
    return;
  }

  if (subcmd === "migrate") {
    const action = String(positional[2] ?? "").trim().toLowerCase();
    if (action === "collect") {
      const bundle = collectRedisMigrationBundle({
        homeDir,
        machineId: opts.machine,
        aimVersion: "0.0.0",
        now: new Date(nowMs),
      });
      const outPath = opts.outFile
        ? resolveCliPath(opts.outFile, { homeDir, optionName: "--out" })
        : `${defaultMigrationDir({ homeDir })}/${bundle.machine.machineId}.json`;
      writeJsonOutput(outPath, bundle);
      printJson(stdout, { ok: true, outFile: outPath, bundleId: bundle.bundleId, machine: bundle.machine, summary: bundle.summary });
      return;
    }

    if (action === "plan") {
      const fromDir = opts.from
        ? resolveCliPath(opts.from, { homeDir, optionName: "--from" })
        : defaultMigrationDir({ homeDir });
      const bundles = readMigrationBundlesFromDir(fromDir);
      if (bundles.length === 0) {
        throw new Error(`No migration bundles found in ${fromDir}.`);
      }
      const plan = await buildRedisMigrationPlan({
        bundles,
        now: new Date(nowMs),
        refreshCandidateImpl: createMigrationRefreshCandidateImpl({
          refreshOpenAICodexImpl,
          refreshAnthropicImpl,
        }),
      });
      const outPath = opts.outFile
        ? resolveCliPath(opts.outFile, { homeDir, optionName: "--out" })
        : `${fromDir}/plan.json`;
      writeJsonOutput(outPath, plan);
      printJson(stdout, { ok: plan.blocked.length === 0 && plan.reloginRequired.length === 0, outFile: outPath, planId: plan.planId, summary: plan.summary, blocked: plan.blocked, reloginRequired: plan.reloginRequired });
      return;
    }

    if (action === "apply") {
      if (!opts.confirmBreakingCutover) {
        throw new Error("Migration apply requires --confirm-breaking-cutover.");
      }
      const planPath = resolveCliPath(opts.planFile, { homeDir, optionName: "--plan" });
      const plan = JSON.parse(fs.readFileSync(planPath, "utf8"));
      await withRedisStore({ homeDir, opts }, async (store) => {
        const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
        const result = await applyRedisMigrationPlan(store, plan, {
          machineId: machine.machineId,
          observedAt: new Date(nowMs).toISOString(),
          requireEmpty: !opts.allowNonEmpty,
        });
        printJson(stdout, { ok: result.ok, planFile: planPath, result });
      });
      return;
    }

    throw new Error("Missing redis migrate subcommand. Usage: aim redis migrate collect|plan|apply ...");
  }

  throw new Error(`Unsupported redis subcommand: ${subcmd}.`);
}
