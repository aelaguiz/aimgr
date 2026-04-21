import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activatePiPoolSelection } from "../../targets/pi-cli.js";

export async function handlePi(context) {
  const { positional, statePath, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing pi subcommand. Usage: aim pi use");
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported pi subcommand: ${subcmd} (supported: use).`);
  }
  const state = loadAimgrState(statePath);
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim pi use <label>` was removed. Use `aim pi use` for next-best selection or `aim <label>` if the account needs reauth.");
  }
  const activated = await activatePiPoolSelection({ state, homeDir, env, probeUsageSnapshotsByProviderImpl });
  writeJsonFileWithBackup(statePath, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
  if (activated.status === "blocked") {
    setExitCode(1);
  }
  return;
}
