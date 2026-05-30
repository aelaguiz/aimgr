import { readAimgrConfig } from "../../config/aimgr-config.js";
import { buildStableIdentityForCredential } from "../../coordination/login-publish.js";
import { closeRedisStore, connectRedisStore, publishCredential, readSnapshot } from "../../coordination/redis-store.js";
import { AIMGR_REDIS_PRIMARY_HOST, AIMGR_REDIS_PRIMARY_URL } from "../../core/constants.js";
import { normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

async function withConfiguredRedis(context, fn) {
  const { homeDir } = context;
  const redis = readAimgrConfig({ homeDir }).config.redis;
  if (!redis.url) {
    throw new Error(`AIM Redis is not configured. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`);
  }
  const connectImpl = context.connectRedisStoreImpl ?? connectRedisStore;
  const store = await connectImpl({ url: redis.url, keyPrefix: redis.keyPrefix });
  try {
    return await fn({ store, snapshot: await readSnapshot(store) });
  } finally {
    await closeRedisStore(store);
  }
}

function findOneCredential(snapshot, { label, provider }) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedProvider = provider ? normalizeProviderId(provider) : null;
  const matches = (snapshot.credentials ?? []).filter(
    (record) => record.label === normalizedLabel && (!normalizedProvider || record.provider === normalizedProvider),
  );
  if (matches.length === 0) {
    throw new Error(`No Redis credential found for ${normalizedProvider ? `${normalizedProvider}:` : ""}${normalizedLabel}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple providers have label=${normalizedLabel}; pass --provider.`);
  }
  return matches[0];
}

export async function handleLabel(context) {
  const { opts, positional, stdout, nowMs } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (subcmd !== "rebind") {
    throw new Error("Missing or unsupported label subcommand. Usage: aim label rebind <label> --provider <provider> --confirm");
  }
  if (!opts.confirm) {
    throw new Error("Label rebind requires --confirm.");
  }
  const labelArg = positional[2];
  if (!opts.provider) {
    throw new Error("Label rebind requires --provider <provider>.");
  }
  await withConfiguredRedis(context, async ({ store, snapshot }) => {
    const credential = findOneCredential(snapshot, { label: labelArg, provider: opts.provider });
    const identity = buildStableIdentityForCredential(credential.provider, credential.credential);
    if (Object.keys(identity).length === 0) {
      throw new Error(`Cannot rebind ${credential.provider}:${credential.label}; current credential has no stable identity.`);
    }
    const result = await publishCredential(store, {
      expectedVersion: credential.version,
      updatedBy: "aimgr-cli",
      observedAt: new Date(nowMs).toISOString(),
      credentialRecord: {
        ...credential,
        identity,
      },
    });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: result.ok, rebind: { label: credential.label, provider: credential.provider, identity, result } }), null, 2)}\n`);
  });
}

export async function handleSession(context) {
  throw new Error("`aim session` was removed. Redis credentials are shared globally; use `aim label rebind <label> --provider <provider> --confirm` only for identity repair.");
}
