import { closeRedisRuntime, loadRedisRuntime, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { rebalanceOpenclawPool } from "../../openclaw/rebalance.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleRebalance(context) {
  const {
    opts,
    positional,
    homeDir,
    env,
    stdout,
    setExitCode,
    probeUsageSnapshotsByProviderImpl,
    readOpenclawAgentsListFromConfigImpl,
    rebalanceHermesPoolImpl,
    connectRedisStoreImpl,
  } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing rebalance target. Usage: aim rebalance openclaw | aim rebalance hermes");
  }
  if (system === "openclaw") {
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      const rebalanced = await rebalanceOpenclawPool({ ...opts, homeDir, env }, runtime.state, {
        probeUsageSnapshotsByProviderImpl,
        readOpenclawAgentsListFromConfigImpl,
      });
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
      if (rebalanced.status === "blocked") {
        setExitCode(1);
      }
    } finally {
      await closeRedisRuntime(runtime);
    }
    return;
  }
  if (system === "hermes") {
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      const rebalanced = await rebalanceHermesPoolImpl({ ...opts, homeDir, env }, runtime.state, {
        probeUsageSnapshotsByProviderImpl,
      });
      writeRedisLocalStateFromView({ homeDir, state: runtime.state, localState: runtime.localState });
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
      if (rebalanced.status === "blocked") {
        setExitCode(1);
      }
    } finally {
      await closeRedisRuntime(runtime);
    }
    return;
  }
  throw new Error(`Unsupported rebalance target: ${system} (supported: openclaw, hermes).`);
}
