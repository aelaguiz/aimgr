import { closeRedisRuntime, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { activatePiPoolSelection } from "../../targets/pi-cli.js";

export async function handlePi(context) {
  const { positional, homeDir, env, stdout, setExitCode, probeUsageSnapshotsByProviderImpl, connectRedisStoreImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing pi subcommand. Usage: aim pi use");
  }
  if (subcmd !== "use") {
    throw new Error(`Unsupported pi subcommand: ${subcmd} (supported: use).`);
  }
  if (String(positional[2] ?? "").trim()) {
    throw new Error("`aim pi use` does not accept a label.");
  }
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
  try {
    const activated = await activatePiPoolSelection({
      state: runtime.state,
      homeDir,
      env,
      probeUsageSnapshotsByProviderImpl,
    });
    writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: activated.status !== "blocked", activated }), null, 2)}\n`);
    if (activated.status === "blocked") {
      setExitCode(1);
    }
  } finally {
    await closeRedisRuntime(runtime);
  }
}
