import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { findCredentialRecord } from "../../coordination/snapshot.js";
import { publishCredential } from "../../coordination/redis-store.js";
import { buildStableIdentityForCredential, identitiesAreCompatible } from "../../coordination/login-publish.js";
import {
  AIMGR_REDIS_PRIMARY_HOST,
  AIMGR_REDIS_PRIMARY_URL,
  SAKANA_PROVIDER,
} from "../../core/constants.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { readTextFromStream } from "../../io/streams.js";
import {
  buildSakanaCredential,
  buildSakanaKeyFingerprint,
  normalizeSakanaApiKey,
  redactSakanaApiKey,
} from "../../providers/sakana.js";
import { activateSakanaCodexEnvSelection } from "../../targets/sakana-codex-env.js";

const SAKANA_USAGE =
  "Usage: aim sakana add <account-name> [--key <api-key>] [--tier standard|pro|max|payg] [--subscription <name>] [--notes <text>] | aim sakana use <account-name> | aim sakana list [--json] | aim sakana show <account-name> [--json] | aim sakana remove <account-name>";

function requireRedis(homeDir) {
  if (!isRedisConfigured({ homeDir })) {
    throw new Error(
      `\`aim sakana\` requires Redis. Run \`aim redis configure --url ${AIMGR_REDIS_PRIMARY_URL} --primary-host ${AIMGR_REDIS_PRIMARY_HOST}\`.`,
    );
  }
}

async function resolveApiKey({ opts, stdin, promptImpl }) {
  if (typeof opts.key === "string" && opts.key.trim()) {
    return normalizeSakanaApiKey(opts.key);
  }
  // Piped/non-TTY stdin: read the key from the stream so it never lands in shell history.
  if (stdin && stdin.isTTY === false && typeof stdin[Symbol.asyncIterator] === "function") {
    const piped = (await readTextFromStream(stdin)).trim();
    if (piped) return normalizeSakanaApiKey(piped);
  }
  if (typeof promptImpl === "function") {
    const answer = await promptImpl("Sakana API key:");
    return normalizeSakanaApiKey(answer);
  }
  throw new Error("No Sakana API key provided. Pass --key <api-key>, pipe it on stdin, or run interactively.");
}

function summarizeRecord(record) {
  const credential = record?.credential ?? {};
  return {
    name: record.label,
    keyId: record?.identity?.keyFingerprint ?? null,
    keyHint: credential.apiKey ? redactSakanaApiKey(credential.apiKey) : null,
    tier: credential.tier ?? null,
    subscription: credential.subscription ?? null,
    notes: credential.notes ?? null,
    poolEnabled: record?.policy?.pool?.enabled !== false,
    health: record?.health?.status ?? null,
    createdAt: credential.createdAt ?? null,
    updatedAt: record.updatedAt ?? null,
  };
}

function summarizeSakanaCodexTarget(target) {
  if (!target || typeof target !== "object") return null;
  if (!target.activeLabel) return null;
  return {
    homeDir: target.homeDir ?? null,
    envPath: target.envPath ?? null,
    activeName: target.activeLabel ?? null,
    keyId: target.activeKeyFingerprint ?? target.expectedKeyFingerprint ?? null,
    lastAppliedAt: target.lastAppliedAt ?? null,
    receipt: target.lastSelectionReceipt ?? null,
  };
}

function listSakanaRecords(snapshot) {
  return (snapshot?.credentials ?? [])
    .filter((record) => record.provider === SAKANA_PROVIDER)
    .sort((a, b) => String(a.label).localeCompare(String(b.label)));
}

async function handleAdd(context) {
  const { opts, positional, homeDir, stdin, stdout, connectRedisStoreImpl, promptImpl } = context;
  const label = normalizeLabel(positional[2]);
  const apiKey = await resolveApiKey({ opts, stdin, promptImpl });
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const existingForLabel = (runtime.snapshot?.credentials ?? []).find((record) => record.label === label);
    if (existingForLabel && existingForLabel.provider !== SAKANA_PROVIDER) {
      throw new Error(
        `Account name=${label} already exists for provider=${existingForLabel.provider}; refusing to reuse it for sakana.`,
      );
    }
    const current = findCredentialRecord(runtime.snapshot, { provider: SAKANA_PROVIDER, label });
    const credential = buildSakanaCredential({
      apiKey,
      tier: opts.tier,
      subscription: opts.subscription,
      notes: opts.notes,
      createdAt: current?.credential?.createdAt,
    });
    const identity = buildStableIdentityForCredential(SAKANA_PROVIDER, credential);
    if (!identitiesAreCompatible(current?.identity, identity)) {
      throw new Error(
        `Refusing to change the API key for existing account name=${label}. Remove it first with \`aim sakana remove ${label}\`, then re-add.`,
      );
    }
    const result = await publishCredential(runtime.store, {
      expectedVersion: current?.version ?? null,
      updatedBy: runtime.updatedBy,
      credentialRecord: {
        ...(current ?? {}),
        provider: SAKANA_PROVIDER,
        label,
        credential,
        identity,
        policy: {
          expect: current?.policy?.expect ?? {},
          reauth: current?.policy?.reauth ?? { mode: "api-key-manual" },
          browser: current?.policy?.browser ?? {},
          pool: current?.policy?.pool ?? { enabled: true },
        },
        health: current?.health ?? { status: "ready", reason: null },
        provenance: {
          ...(current?.provenance ?? {}),
          lastSourceType: "sakana-config",
        },
      },
    });
    if (!result.ok) {
      throw new Error(`Redis stale_version while saving sakana account name=${label}; reload and retry.`);
    }
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          action: current ? "updated" : "added",
          account: summarizeRecord(result.record),
        }),
        null,
        2,
      )}\n`,
    );
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleList(context) {
  const { homeDir, stdout, connectRedisStoreImpl } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const accounts = listSakanaRecords(runtime.snapshot).map(summarizeRecord);
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: true,
          count: accounts.length,
          accounts,
          target: summarizeSakanaCodexTarget(runtime.state.targets?.sakanaCodex),
        }),
        null,
        2,
      )}\n`,
    );
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleShow(context) {
  const { positional, homeDir, stdout, connectRedisStoreImpl } = context;
  const label = normalizeLabel(positional[2]);
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const record = findCredentialRecord(runtime.snapshot, { provider: SAKANA_PROVIDER, label });
    if (!record) {
      throw new Error(`No sakana account named ${label}. Add it with \`aim sakana add ${label} --key <api-key>\`.`);
    }
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, account: summarizeRecord(record) }), null, 2)}\n`);
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleUse(context) {
  const { positional, homeDir, stdout, connectRedisStoreImpl } = context;
  const label = normalizeLabel(positional[2]);
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const record = findCredentialRecord(runtime.snapshot, { provider: SAKANA_PROVIDER, label });
    if (!record) {
      throw new Error(`No sakana account named ${label}. Add it with \`aim sakana add ${label} --key <api-key>\`.`);
    }
    const apiKey = normalizeSakanaApiKey(record?.credential?.apiKey);
    const target = activateSakanaCodexEnvSelection({
      state: runtime.state,
      homeDir,
      label,
      apiKey,
    });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus({
          ok: target.lastSelectionReceipt?.status === "activated",
          action: "used",
          account: summarizeRecord(record),
          target: summarizeSakanaCodexTarget(target),
        }),
        null,
        2,
      )}\n`,
    );
  } finally {
    await closeRedisRuntime(runtime);
  }
}

async function handleRemove(context) {
  const { positional, homeDir, stdout, connectRedisStoreImpl } = context;
  const label = normalizeLabel(positional[2]);
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const record = findCredentialRecord(runtime.snapshot, { provider: SAKANA_PROVIDER, label });
    if (!record) {
      throw new Error(`No sakana account named ${label}.`);
    }
    const key = runtime.store.keys.credential({ provider: SAKANA_PROVIDER, label });
    await runtime.store.client.del(key);
    if (runtime.state.targets?.sakanaCodex?.activeLabel === label) {
      runtime.state.targets.sakanaCodex = {};
    }
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, action: "removed", name: label }), null, 2)}\n`);
  } finally {
    await closeRedisRuntime(runtime);
  }
}

export async function handleSakana(context) {
  const { positional, homeDir } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error(`Missing sakana subcommand. ${SAKANA_USAGE}`);
  }
  requireRedis(homeDir);
  if (subcmd === "add" || subcmd === "set") {
    await handleAdd(context);
    return;
  }
  if (subcmd === "list" || subcmd === "ls") {
    await handleList(context);
    return;
  }
  if (subcmd === "use") {
    await handleUse(context);
    return;
  }
  if (subcmd === "show") {
    await handleShow(context);
    return;
  }
  if (subcmd === "remove" || subcmd === "rm" || subcmd === "delete") {
    await handleRemove(context);
    return;
  }
  throw new Error(`Unsupported sakana subcommand: ${subcmd} (supported: add, use, list, show, remove). ${SAKANA_USAGE}`);
}

export { buildSakanaKeyFingerprint };
