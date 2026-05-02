import { promoteClaudeToAuthority } from "../../credentials/authority.js";
import { promoteCodexToAuthority } from "../../credentials/authority.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handlePromote(context) {
  const { opts, positional, statePath, stdout } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing promote target. Usage: aim promote codex --to <authority> <label> [<label>...] | aim promote claude --to <authority> <label> [<label>...]");
  }
  const labels = positional.slice(2);
  const state = loadAimgrState(statePath);
  const promoted =
    system === "codex"
      ? promoteCodexToAuthority({
          to: opts.to,
          labels,
          state,
        })
      : system === "claude"
        ? promoteClaudeToAuthority({
            to: opts.to,
            labels,
            state,
          })
        : (() => {
            throw new Error(`Unsupported promote target: ${system} (supported: codex, claude).`);
          })();
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, promoted }), null, 2)}\n`);
  return;
}
