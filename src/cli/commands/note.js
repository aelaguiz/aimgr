import { closeRedisRuntime, loadRedisRuntime } from "../../coordination/runtime.js";
import { readAccountNote, writeAccountNote } from "../../coordination/redis-store.js";
import { normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { formatAccountNote } from "../../status/account-notes.js";

import { readCodexAccountMetadata } from "../../coordination/codex-metadata.js";

export async function handleNote(context) {
  const { positional, opts, homeDir, connectRedisStoreImpl, stdout } = context;
  const action = positional[1];
  if (!["set", "show", "clear"].includes(action)
    || positional.length !== (action === "set" ? 4 : 3)) {
    throw new Error('Usage: aim note set <label> <text> [--provider <provider>] | aim note show|clear <label> [--provider <provider>]');
  }
  const label = normalizeLabel(positional[2]);
  const requestedProvider = opts.provider ? normalizeProviderId(opts.provider) : null;
  if (!label || (opts.provider && !requestedProvider)) throw new Error("A valid account label and provider are required.");
  const note = action === "set" ? positional[3] : null;
  if (action === "set" && !note.trim()) throw new Error("The note cannot be empty; use `aim note clear` to remove it.");
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl, excludeCodexGrants: true });
  try {
    const records = [...runtime.snapshot.credentials,
      ...(await readCodexAccountMetadata(runtime.store)).map(record => ({ ...record, provider: "openai-codex" }))];
    const matches = records.filter((record) => record.label === label
      && (!requestedProvider || record.provider === requestedProvider));
    if (!matches.length) throw new Error(`No managed account found for ${requestedProvider ? `${requestedProvider}:` : ""}${label}.`);
    if (matches.length > 1) throw new Error(`Account ${label} exists for multiple providers: ${matches.map((r) => r.provider).sort().join(", ")}. Specify --provider.`);
    const provider = matches[0].provider;
    const current = await readAccountNote(runtime.store, { provider, label });
    let resultNote = current?.note ?? null;
    if (action !== "show") {
      const result = await writeAccountNote(runtime.store, { provider, label, note, expectedVersion: current?.version ?? null });
      if (!result.ok) throw new Error(`The note for ${provider}:${label} changed concurrently; read it and retry.`);
      resultNote = note;
    }
    const result = { ok: true, provider, label, note: resultNote };
    stdout.write(opts.json ? `${JSON.stringify(result, null, 2)}\n`
      : resultNote === null ? `${provider} / ${label}: no note\n` : `${formatAccountNote(result)}\n`);
  } finally {
    await closeRedisRuntime(runtime);
  }
}
