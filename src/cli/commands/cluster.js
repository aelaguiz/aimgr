import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { closeRedisStore, connectRedisStore, REDIS_CONNECTION_POLICY_OBSERVE } from "../../coordination/redis-store.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { buildClusterPools, renderClusterStatusText } from "../../status/cluster-view.js";
import { recordStatusPoolPace } from "../../status/pool-pace.js";
import { buildRedisStatusView } from "../../status/redis-view.js";

// Match the AIM machines in docs/FLEET.md and the addresses in devcluster's
// fixer.toml. The Air is personal and not an AIM target.
export const AIM_FLEET = Object.freeze([
  { name: "m5", target: "aelaguiz@amir-m5.fairy-salmon.ts.net" },
  { name: "home", target: "aelaguiz@home.fairy-salmon.ts.net" },
  { name: "m3-max", target: "aelaguiz@amirs-m3-max-new.fairy-salmon.ts.net" },
  { name: "m3-36gb", target: "aelaguiz@amir-m3-36gb.fairy-salmon.ts.net" },
  { name: "mini-1", target: "aelaguiz@amir-mini-1.fairy-salmon.ts.net" },
  { name: "mini-2", target: "aelaguiz@amir-mini-2.fairy-salmon.ts.net" },
  { name: "mini-3", target: "aelaguiz@amir-mini-3.fairy-salmon.ts.net" },
  { name: "mini-4", target: "aelaguiz@amir-mini-4.fairy-salmon.ts.net" },
  { name: "mini-5", target: "aelaguiz@amir-mini-5.fairy-salmon.ts.net" },
  { name: "studio", target: "agents@amirs-mac-studio.fairy-salmon.ts.net" },
  { name: "old-m1", target: "aelaguiz@amir-old-m1.fairy-salmon.ts.net" },
]);

// Each remote machine prints its own `aim status --json` and `aim claude status --json`,
// separated by this line. `aim claude status` exits 1 whenever an account is not ready,
// so the remote command always exits 0 and a missing report is caught when parsing.
export const CLAUDE_STATUS_SEPARATOR = "--- aim cluster: claude status ---";
const REMOTE_COMMAND = `"$HOME/.local/bin/aim" status --json --all-accounts; echo '${CLAUDE_STATUS_SEPARATOR}'; `
  + `"$HOME/.local/bin/aim" claude status --json; exit 0`;

const execFileAsync = promisify(execFile);

async function remoteStatus(target) {
  const { stdout } = await execFileAsync("ssh", [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "ServerAliveInterval=10",
    "-o", "ServerAliveCountMax=2", target, REMOTE_COMMAND,
  ], { timeout: 120_000, maxBuffer: 16 * 1024 * 1024 });
  return stdout;
}

export function parseRemoteStatus(output) {
  const [viewText, claudeText] = String(output ?? "").split(`\n${CLAUDE_STATUS_SEPARATOR}\n`);
  if (claudeText === undefined) throw new Error("Incomplete status response.");
  const view = JSON.parse(viewText);
  let claude = null;
  try { claude = JSON.parse(claudeText); } catch { /* The general status report can still be read. */ }
  return { view, claude };
}

// Pace comes from the shared reading history, as it does for `aim status`.
// Without the store the pools still go out, with no pace.
async function recordClusterPoolPace(context, pools, nowMs) {
  let store = null;
  try {
    const redis = readAimgrConfig({ homeDir: context.homeDir }).config.redis;
    if (!redis.url) return;
    store = await (context.connectRedisStoreImpl ?? connectRedisStore)({
      url: redis.url,
      keyPrefix: redis.keyPrefix,
      connectionPolicy: REDIS_CONNECTION_POLICY_OBSERVE,
    });
    await recordStatusPoolPace(store, pools, nowMs);
  } catch {
    // The current readings do not depend on the history.
  } finally {
    try { await closeRedisStore(store); } catch { /* nothing to report */ }
  }
}

export async function handleCluster(context) {
  const { positional, opts, homeDir, stdout, setExitCode } = context;
  if (positional.length !== 2 || positional[1] !== "status" || opts.compact
      || opts.accounts || opts.allAccounts || opts.assignments || opts.afterDoubleDash.length) {
    throw new Error("Usage: aim cluster status [--json]");
  }
  let localMachine;
  try {
    localMachine = (await readFile(path.join(homeDir, ".devcluster", "machine"), "utf8")).trim();
  } catch {
    throw new Error("Cannot identify this machine: ~/.devcluster/machine is unavailable.");
  }
  if (!AIM_FLEET.some((machine) => machine.name === localMachine)) {
    throw new Error(`Machine ${localMachine || "(empty)"} is not in the AIM fleet.`);
  }
  const nowMs = Number.isFinite(Number(context.nowMs)) ? Number(context.nowMs) : Date.now();
  const runRemote = context.clusterRemoteStatusImpl ?? remoteStatus;
  const runLocal = context.clusterLocalStatusImpl ?? (async () => {
    const { view, claudeUsageStatus } = await buildRedisStatusView({
      homeDir: context.homeDir,
      env: context.env,
      probeUsageSnapshotsByProviderImpl: context.probeUsageSnapshotsByProviderImpl,
      fetchJsonWithTimeoutImpl: context.fetchJsonWithTimeoutImpl,
      connectRedisStoreImpl: context.connectRedisStoreImpl,
      readCodexEnvironmentImpl: context.readCodexEnvironmentImpl,
      readClaudeEnvironmentImpl: context.readClaudeEnvironmentImpl,
      runAgyNativeImpl: context.runAgyNativeImpl,
      readLocalAgyStatusImpl: context.readLocalAgyStatusImpl,
      nowMs,
      includeBlocked: true,
    });
    return { view: sanitizeForStatus(view), claude: claudeUsageStatus };
  });
  const results = await Promise.all(AIM_FLEET.map(async (machine) => {
    try {
      const status = machine.name === localMachine ? await runLocal() : parseRemoteStatus(await runRemote(machine.target));
      if (!Array.isArray(status?.view?.accounts)) {
        throw new Error("incomplete status response");
      }
      const claude = Array.isArray(status.claude?.accounts) ? status.claude : null;
      return { ...machine, view: status.view, claude };
    } catch (error) {
      // SSH stderr can contain paths or arbitrary remote output; report a bounded reason.
      const reason = error?.killed || error?.code === "ETIMEDOUT" ? "timed out"
        : error?.code === 255 ? "SSH connection failed" : "status unavailable";
      return { ...machine, error: reason };
    }
  }));
  if (opts.json) {
    const pools = buildClusterPools(results, { nowMs });
    const { claude, codex } = pools;
    await recordClusterPoolPace(context, { claude, codex }, nowMs);
    stdout.write(`${JSON.stringify({
      checkedAtMs: nowMs,
      machines: results.map(({ name, error, claude }) => ({
        name,
        ...(error ? { error } : !claude ? { claudeError: "status unavailable" } : {}),
      })),
      pools,
    })}\n`);
  } else {
    stdout.write(renderClusterStatusText(results, { nowMs }));
  }
  if (results.some((result) => result.error || !result.claude)) setExitCode(1);
}
