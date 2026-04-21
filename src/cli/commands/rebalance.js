import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { rebalanceOpenclawPool } from "../../openclaw/rebalance.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";

export async function handleRebalance(context) {
  const {
    opts,
    positional,
    statePath,
    homeDir,
    env,
    stdout,
    setExitCode,
    probeUsageSnapshotsByProviderImpl,
    readOpenclawAgentsListFromConfigImpl,
    rebalanceHermesPoolImpl,
  } = context;
  const system = String(positional[1] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing rebalance target. Usage: aim rebalance openclaw | aim rebalance hermes");
  }
  if (system === "openclaw") {
    const state = loadAimgrState(statePath);
    const rebalanced = await rebalanceOpenclawPool({ ...opts, homeDir, env }, state, {
      probeUsageSnapshotsByProviderImpl,
      readOpenclawAgentsListFromConfigImpl,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
    if (rebalanced.status === "blocked") {
      setExitCode(1);
    }
    return;
  }
  if (system === "hermes") {
    const state = loadAimgrState(statePath);
    const rebalanced = await rebalanceHermesPoolImpl({ ...opts, homeDir, env }, state, {
      probeUsageSnapshotsByProviderImpl,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: rebalanced.status !== "blocked", rebalanced }), null, 2)}\n`);
    if (rebalanced.status === "blocked") {
      setExitCode(1);
    }
    return;
  }
  throw new Error(`Unsupported rebalance target: ${system} (supported: openclaw, hermes).`);
}
