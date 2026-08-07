import fs from "node:fs";
import { normalizeAimgrConfig, readAimgrConfig, writeAimgrConfig } from "../../config/aimgr-config.js";
import {
  closeRedisStore,
  connectRedisStore,
  importCredentialsSnapshot,
  readSnapshot,
} from "../../coordination/redis-store.js";
import { publishCodexCredentialRecordGuarded } from "../../coordination/codex-identity.js";
import {
  AIMGR_REDIS_PRIMARY_HOST,
  AIMGR_REDIS_PRIMARY_URL,
  AIMGR_REDIS_TRANSPORT,
  ANTHROPIC_PROVIDER,
  OPENAI_CODEX_PROVIDER,
} from "../../core/constants.js";
import { isObject, normalizeProviderId } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { resolveCliPath } from "../../io/paths.js";

function requireRedisUrl(opts) {
  const url = String(opts.url ?? "").trim();
  if (!url) throw new Error("Missing --url for `aim redis configure`.");
  return url;
}

function printJson(stdout, value) {
  stdout.write(`${JSON.stringify(sanitizeForStatus(value), null, 2)}\n`);
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

async function withRedisStore({ homeDir, opts, connectRedisStoreImpl }, fn) {
  const { redis } = readAimgrConfig({ homeDir }).config;
  if (!redis.url) {
    throw new Error(`AIM Redis is not configured. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
  }
  const connectImpl = connectRedisStoreImpl ?? connectRedisStore;
  const store = await connectImpl({
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
  const { opts, positional, homeDir, stdout, nowMs, connectRedisStoreImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing redis subcommand. Usage: aim redis configure|config|ping|snapshot|export|import ...");
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
    await withRedisStore({ homeDir, opts, connectRedisStoreImpl }, async (store, redis) => {
      const pong = await store.client.ping();
      printJson(stdout, { ok: pong === "PONG", pong, redis });
    });
    return;
  }

  if (subcmd === "snapshot") {
    await withRedisStore({ homeDir, opts, connectRedisStoreImpl }, async (store) => {
      printJson(stdout, { ok: true, snapshot: await readSnapshot(store) });
    });
    return;
  }

  if (subcmd === "export") {
    await withRedisStore({ homeDir, opts, connectRedisStoreImpl }, async (store) => {
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
    await withRedisStore({ homeDir, opts, connectRedisStoreImpl }, async (store) => {
      const observedAt = new Date(nowMs).toISOString();
      const credentials = Array.isArray(snapshot.credentials) ? snapshot.credentials : [];
      const codexRecords = credentials.filter(
        (record) => normalizeProviderId(record?.provider) === OPENAI_CODEX_PROVIDER,
      );
      // Codex records go through the guarded publisher first: each write
      // acquires the provider-wide identity-catalog lease, fresh-scans the raw
      // record set (including credential-empty reserved records), and rejects
      // any import that aliases a Desktop-reserved account, re-adds credential
      // material to a reserved record, or drops/edits the reservation object.
      // An exact reserved policy round-trip is the only permitted reserved
      // write. Running these before the generic import keeps a reservation
      // violation from landing any snapshot data.
      const results = [];
      for (const record of codexRecords) {
        results.push(await publishCodexCredentialRecordGuarded(store, {
          expectedVersion: null,
          credentialRecord: record,
          updatedBy: "aimgr-cli",
          observedAt,
          operation: "codex credential import",
          allowReservedPolicyRoundTrip: true,
        }));
      }
      const remainder = {
        ...snapshot,
        credentials: credentials.filter(
          (record) => normalizeProviderId(record?.provider) !== OPENAI_CODEX_PROVIDER,
        ),
      };
      results.push(...await importCredentialsSnapshot(store, remainder, { updatedBy: "aimgr-cli", observedAt }));
      printJson(stdout, {
        ok: results.every((result) => result.ok),
        inFile: inPath,
        counts: {
          credentials: credentials.length,
          meta: snapshot.meta ? 1 : 0,
        },
      });
    });
    return;
  }

  throw new Error(`Unsupported redis subcommand: ${subcmd}.`);
}
