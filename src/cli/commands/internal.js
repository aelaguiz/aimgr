import { readTextFromStream } from "../../io/streams.js";
import { applyClaudePromotionPayloadToState } from "../../credentials/authority.js";
import { applyCodexPromotionPayloadToState } from "../../credentials/authority.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleInternal(context) {
  const { positional, statePath, stdin, stdout } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing internal subcommand.");
  }
  if (subcmd !== "apply-codex-promotion" && subcmd !== "apply-claude-promotion") {
    throw new Error(`Unsupported internal subcommand: ${subcmd}.`);
  }
  const rawPayload = await readTextFromStream(stdin);
  if (!String(rawPayload ?? "").trim()) {
    throw new Error(`Missing ${subcmd === "apply-codex-promotion" ? "codex" : "Claude"} promotion payload on stdin.`);
  }
  let payload;
  try {
    payload = JSON.parse(rawPayload);
  } catch (err) {
    throw new Error(`Invalid ${subcmd === "apply-codex-promotion" ? "codex" : "Claude"} promotion payload JSON: ${String(err?.message ?? err)}`);
  }
  const state = loadAimgrState(statePath);
  const applied =
    subcmd === "apply-codex-promotion"
      ? applyCodexPromotionPayloadToState({
          state,
          payload,
          authorityDisplay: statePath,
        })
      : applyClaudePromotionPayloadToState({
          state,
          payload,
          authorityDisplay: statePath,
        });
  if (applied.status === "applied") {
    writeJsonFileWithBackup(statePath, state);
  }
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, applied }), null, 2)}\n`);
  return;
}
