import { readAimgrConfig } from "../../config/aimgr-config.js";
import { buildLocalMachineInfo } from "../../coordination/machine.js";
import { closeRedisStore, connectRedisStore, publishLabel, publishSession, readSnapshot, registerMachine } from "../../coordination/redis-store.js";
import { normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

async function withConfiguredRedis(context, fn) {
  const { homeDir, nowMs } = context;
  const redis = readAimgrConfig({ homeDir }).config.redis;
  if (!redis.url) {
    throw new Error("AIM Redis is not configured. Run `aim redis configure --url redis://amirs-mac-studio:6380 --primary-host agents@amirs-mac-studio`.");
  }
  const connectImpl = context.connectRedisStoreImpl ?? connectRedisStore;
  const store = await connectImpl({ url: redis.url, keyPrefix: redis.keyPrefix });
  try {
    const machine = buildLocalMachineInfo({ homeDir, now: new Date(nowMs) });
    await registerMachine(store, machine);
    return await fn({ store, machine, snapshot: await readSnapshot(store) });
  } finally {
    await closeRedisStore(store);
  }
}

function findOneLabel(snapshot, { label, provider }) {
  const normalizedLabel = normalizeLabel(label);
  const normalizedProvider = provider ? normalizeProviderId(provider) : null;
  const matches = (snapshot.labels ?? []).filter(
    (record) => record.label === normalizedLabel && (!normalizedProvider || record.provider === normalizedProvider),
  );
  if (matches.length === 0) {
    throw new Error(`No Redis label found for ${normalizedProvider ? `${normalizedProvider}:` : ""}${normalizedLabel}.`);
  }
  if (matches.length > 1) {
    throw new Error(`Multiple providers have label=${normalizedLabel}; pass --provider.`);
  }
  return matches[0];
}

function findSession(snapshot, { provider, label, machineId }) {
  return (snapshot.sessions ?? []).find(
    (session) => session.provider === provider && session.label === label && session.machineId === machineId,
  ) ?? null;
}

export async function handleLabel(context) {
  const { opts, positional, stdout, nowMs } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (subcmd !== "rebind") {
    throw new Error("Missing or unsupported label subcommand. Usage: aim label rebind <label> --machine <machineId> --confirm");
  }
  if (!opts.confirm) {
    throw new Error("Label rebind requires --confirm.");
  }
  const labelArg = positional[2];
  const sourceMachineId = String(opts.machine ?? "").trim();
  if (!sourceMachineId) {
    throw new Error("Label rebind requires --machine <machineId>.");
  }
  await withConfiguredRedis(context, async ({ store, machine, snapshot }) => {
    const label = findOneLabel(snapshot, { label: labelArg, provider: opts.provider });
    const session = findSession(snapshot, {
      provider: label.provider,
      label: label.label,
      machineId: sourceMachineId,
    });
    if (!session) {
      throw new Error(`No Redis session found for ${label.provider}:${label.label} on machine ${sourceMachineId}.`);
    }
    const result = await publishLabel(store, {
      expectedVersion: label.version,
      machineId: machine.machineId,
      observedAt: new Date(nowMs).toISOString(),
      labelRecord: {
        ...label,
        stableIdentity: session.identity ?? {},
      },
    });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: result.ok, rebind: { label: label.label, provider: label.provider, sourceMachineId, result } }), null, 2)}\n`);
  });
}

export async function handleSession(context) {
  const { opts, positional, stdout, nowMs } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (subcmd !== "handoff") {
    throw new Error("Missing or unsupported session subcommand. Usage: aim session handoff <label> --from <machineId> --to <machineId> --confirm");
  }
  if (!opts.confirm) {
    throw new Error("Session handoff requires --confirm.");
  }
  const fromMachineId = String(opts.from ?? "").trim();
  const toMachineId = String(opts.to ?? "").trim();
  if (!fromMachineId || !toMachineId) {
    throw new Error("Session handoff requires --from <machineId> and --to <machineId>.");
  }
  await withConfiguredRedis(context, async ({ store, machine, snapshot }) => {
    const label = findOneLabel(snapshot, { label: positional[2], provider: opts.provider });
    const source = findSession(snapshot, { provider: label.provider, label: label.label, machineId: fromMachineId });
    if (!source) {
      throw new Error(`No Redis source session found for ${label.provider}:${label.label} on machine ${fromMachineId}.`);
    }
    const destination = findSession(snapshot, { provider: label.provider, label: label.label, machineId: toMachineId });
    const observedAt = new Date(nowMs).toISOString();
    const sourceResult = await publishSession(store, {
      expectedVersion: source.version,
      machineId: machine.machineId,
      observedAt,
      sessionRecord: {
        ...source,
        health: { status: "stale", reason: `handed_off_to:${toMachineId}` },
        lineage: { ...(source.lineage ?? {}), mode: "handoff-source", handedOffTo: toMachineId, handedOffAt: observedAt },
      },
    });
    if (!sourceResult.ok) {
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: false, handoff: { source: sourceResult } }), null, 2)}\n`);
      return;
    }
    const destinationResult = await publishSession(store, {
      expectedVersion: destination?.version ?? null,
      machineId: machine.machineId,
      observedAt,
      sessionRecord: {
        ...source,
        machineId: toMachineId,
        sessionId: `${label.provider}:${label.label}:${toMachineId}`,
        health: { status: "ready", reason: null },
        lineage: { ...(source.lineage ?? {}), mode: "handoff", handedOffFrom: fromMachineId, handedOffAt: observedAt },
      },
    });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: destinationResult.ok, handoff: { label: label.label, provider: label.provider, fromMachineId, toMachineId, source: sourceResult, destination: destinationResult } }), null, 2)}\n`);
  });
}
