import { syncOpenclawFromState } from "../../openclaw/sync.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleApply(context) {
  const { opts, statePath, homeDir, env, stdout } = context;
  const state = loadAimgrState(statePath);
  const synced = await syncOpenclawFromState({ ...opts, homeDir, env }, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
  return;
}
