import fs from "node:fs";
import path from "node:path";
import { normalizeAimgrConfig, readAimgrConfig, writeAimgrConfig } from "../../config/aimgr-config.js";
import {
  closeRedisStore,
  connectRedisStore,
  deleteLegacyRedisCredentialKeys,
  importCredentialsSnapshot,
  readSnapshot,
} from "../../coordination/redis-store.js";
import {
  AIMGR_REDIS_PRIMARY_HOST,
  AIMGR_REDIS_PRIMARY_URL,
  AIMGR_REDIS_TRANSPORT,
  ANTHROPIC_PROVIDER,
} from "../../core/constants.js";
import { isObject, normalizeProviderId } from "../../core/normalize.js";
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

function assertGenericRedisImportHasNoClaudeCredential(snapshot) {
  for (const record of Array.isArray(snapshot?.credentials) ? snapshot.credentials : []) {
    if (normalizeProviderId(record?.provider) !== ANTHROPIC_PROVIDER) continue;
    if (
      Object.keys(isObject(record.credential) ? record.credential : {}).length > 0
      || Object.keys(isObject(record.identity) ? record.identity : {}).length > 0
      || Object.keys(isObject(record.stableIdentity) ? record.stableIdentity : {}).length > 0
    ) {
      throw new Error(
        "Generic Redis import cannot write Claude credential or identity material; use `aim claude import-native`.",
      );
    }
  }
}

async function withRedisStore({ homeDir, opts }, fn) {
  const { redis } = readAimgrConfig({ homeDir }).config;
  if (!redis.url) {
    throw new Error(`AIM Redis is not configured. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
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
  const { opts, positional, homeDir, stdout, nowMs, refreshOpenAICodexImpl } = context;
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
        transport: opts.transport ?? existing.redis.transport ?? AIMGR_REDIS_TRANSPORT,
      },
    });
    const written = writeAimgrConfig({ homeDir, config });
    printJson(stdout, { ok: true, path: written.path, redis: written.config.redis });
    return;
  }

  if (subcmd === "config") {
    const read = readAimgrConfig({ homeDir });
    printJson(stdout, {
      ok: true,
      path: read.path,
      exists: read.exists,
      redis: read.config.redis,
    });
    return;
  }

  if (subcmd === "ping") {
    await withRedisStore({ homeDir, opts }, async (store, redis) => {
      const pong = await store.client.ping();
      printJson(stdout, { ok: pong === "PONG", pong, redis });
    });
    return;
  }

  if (subcmd === "snapshot") {
    await withRedisStore({ homeDir, opts }, async (store) => {
      printJson(stdout, { ok: true, snapshot: await readSnapshot(store) });
    });
    return;
  }

  if (subcmd === "export") {
    await withRedisStore({ homeDir, opts }, async (store) => {
      const snapshot = await readSnapshot(store);
      if (opts.outFile) {
        const outPath = resolveCliPath(opts.outFile, { homeDir, optionName: "--out" });
        fs.writeFileSync(outPath, `${JSON.stringify(snapshot, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
        printJson(stdout, { ok: true, outFile: outPath, counts: { credentials: snapshot.credentials.length, meta: snapshot.meta ? 1 : 0 } });
      } else {
        printJson(stdout, { ok: true, snapshot });
      }
    });
    return;
  }

  if (subcmd === "import") {
    const inPath = resolveCliPath(opts.inFile, { homeDir, optionName: "--in" });
    const snapshot = JSON.parse(fs.readFileSync(inPath, "utf8"));
    assertGenericRedisImportHasNoClaudeCredential(snapshot);
    await withRedisStore({ homeDir, opts }, async (store) => {
      const results = await importCredentialsSnapshot(store, snapshot, { updatedBy: "aimgr-cli", observedAt: new Date(nowMs).toISOString() });
      printJson(stdout, {
        ok: results.every((result) => result.ok),
        inFile: inPath,
        counts: {
          credentials: Array.isArray(snapshot.credentials) ? snapshot.credentials.length : 0,
          meta: snapshot.meta ? 1 : 0,
        },
      });
    });
    return;
  }

  if (subcmd === "migrate") {
    const action = String(positional[2] ?? "").trim().toLowerCase();
    if (action === "collect") {
      const bundle = collectRedisMigrationBundle({
        homeDir,
        aimVersion: "0.0.0",
        now: new Date(nowMs),
      });
      const outPath = opts.outFile
        ? resolveCliPath(opts.outFile, { homeDir, optionName: "--out" })
        : `${defaultMigrationDir({ homeDir })}/${bundle.bundleId}.json`;
      writeJsonOutput(outPath, bundle);
      printJson(stdout, { ok: true, outFile: outPath, bundleId: bundle.bundleId, source: bundle.source, summary: bundle.summary });
      return;
    }

    if (action === "cleanup-legacy") {
      if (!opts.confirmBreakingCutover) {
        throw new Error("Legacy Redis cleanup requires --confirm-breaking-cutover.");
      }
      await withRedisStore({ homeDir, opts }, async (store) => {
        const result = await deleteLegacyRedisCredentialKeys(store);
        printJson(stdout, result);
      });
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
        const result = await applyRedisMigrationPlan(store, plan, {
          updatedBy: "aimgr-cli",
          observedAt: new Date(nowMs).toISOString(),
          requireEmpty: !opts.allowNonEmpty,
        });
        printJson(stdout, { ok: result.ok, planFile: planPath, counts: result.counts });
      });
      return;
    }

    throw new Error("Missing redis migrate subcommand. Usage: aim redis migrate collect|plan|apply|cleanup-legacy ...");
  }

  throw new Error(`Unsupported redis subcommand: ${subcmd}.`);
}
