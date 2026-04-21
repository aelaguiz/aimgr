import path from "node:path";
import { importAnthropicFromAuthority } from "../../credentials/authority.js";
import { importCodexFromAuthority } from "../../credentials/authority.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { syncOpenclawFromState } from "../../openclaw/sync.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activateClaudeLabelSelection } from "../../targets/claude-cli.js";

export async function handleSync(context) {
  const { opts, positional, statePath, homeDir, env, stdout } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error(
      "Missing sync target. Usage: aim sync openclaw | aim sync codex --from agents@amirs-mac-studio | aim sync claude --from agents@amirs-mac-studio",
    );
  }
  const state = loadAimgrState(statePath);
  if (system === "openclaw") {
    const synced = await syncOpenclawFromState({ ...opts, homeDir, env }, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, synced }), null, 2)}\n`);
    return;
  }
  if (system === "codex") {
    const imported = importCodexFromAuthority({
      from: opts.from,
      state,
      homeDir,
      env,
      discardDirty: opts.discardDirty === true,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, imported }), null, 2)}\n`);
    return;
  }
  if (system === "claude") {
    const imported = importAnthropicFromAuthority({
      from: opts.from,
      state,
      homeDir,
      env,
      discardDirty: opts.discardDirty === true,
    });
    writeJsonFileWithBackup(statePath, state);
    const activeLabel = state.targets?.claudeCli?.activeLabel;
    const liveApply = { liveApplied: null, liveApplyError: null };
    if (typeof activeLabel === "string" && imported.importedLabels.includes(activeLabel)) {
      try {
        const activation = activateClaudeLabelSelection({ state, homeDir, env, label: activeLabel });
        writeJsonFileWithBackup(statePath, state);
        liveApply.liveApplied = { label: activeLabel, status: activation.status };
      } catch (err) {
        liveApply.liveApplyError = String(err?.message ?? err);
      }
    }
    stdout.write(
      `${JSON.stringify(sanitizeForStatus({ ok: true, imported, ...liveApply }), null, 2)}\n`,
    );
    return;
  }
  if (system === "hermes") {
    throw new Error(
      "`aim sync hermes` was removed. Use `aim auth write hermes <label> --auth-file <abs-path>` and manage Hermes runtime files outside AIM.",
    );
  }
  throw new Error(`Unsupported sync target: ${system} (supported: openclaw, codex, claude).`);
}
