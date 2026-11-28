import { withAgyConnection } from "../credentials/agy-local.js";
import { runAgyNative } from "../privacy/agy-native-invocation.js";
import { parseAgyNativeObservation, readAgyUsageCache, writeAgyUsageCache } from "./agy-observation.js";
import { AGY_STATUS_STALE_MS, readLocalAgyStatus } from "./agy-view.js";

export async function refreshAgyUsage(connection, { homeDir, config, env, nowMs, runAgyNativeImpl = runAgyNative }) {
  const { label, accountHome, profileRef } = connection;
  const request = { label, accountHome, profileRef, homeDir, config, env, args: [] };
  const usage = await runAgyNativeImpl({ ...request, operation: "usage" });
  if (usage?.exitCode !== 0) throw new Error(`Antigravity could not refresh quota for ${label}.`);
  // The approved commands share this connection's grant. Keep the quota if
  // Google lacks a credits plan, and serialize native calls under the lock.
  let credits;
  try { credits = await runAgyNativeImpl({ ...request, operation: "credits" }); }
  catch { /* The quota response can still be used. */ }
  const observation = parseAgyNativeObservation(usage.statusReport, credits?.exitCode === 0 ? credits.statusReport : undefined, nowMs);
  if (!observation) throw new Error(`Antigravity did not return supported status fields for ${label}.`);
  return observation;
}

function shouldRefresh(cache, nowMs) {
  const elapsed = nowMs - cache?.lastAttemptAtMs;
  if (!(elapsed >= 0 && elapsed < AGY_STATUS_STALE_MS)) return true;
  // As with Claude's status, a reset invalidates the previous window. If a
  // refresh has already failed since the reset, honor its retry interval.
  return cache.observation?.buckets.some(({ resetAtMs }) => resetAtMs > cache.lastAttemptAtMs && resetAtMs <= nowMs) ?? false;
}

export async function collectAgyUsageStatus({
  homeDir, config, env, label, nowMs = Date.now(), runAgyNativeImpl, readLocalAgyStatusImpl = readLocalAgyStatus,
}) {
  const report = readLocalAgyStatusImpl(homeDir, { config, label });
  const ready = report.connections.filter((connection) => connection.availability === "ready"
    && (!connection.observation || shouldRefresh({
      observation: connection.observation, lastAttemptAtMs: connection.observation.observedAtMs,
    }, nowMs)));
  async function refresh({ label: accountLabel }) {
    try {
      await withAgyConnection(homeDir, accountLabel, async (connection) => {
        if (connection.status !== "ready") return;
        const old = readAgyUsageCache(connection.accountHome);
        if (!shouldRefresh(old, nowMs)) return;
        let observation = old?.observation;
        try { observation = await refreshAgyUsage(connection, { homeDir, config, env, nowMs, runAgyNativeImpl }); }
        catch { /* Retain the last reading and back off, as with other providers. */ }
        writeAgyUsageCache(connection.accountHome, observation, nowMs);
      });
    } catch { /* Busy or inaccessible connections still get a local status row. */ }
  }
  if (ready.length === 0) return report;
  for (let offset = 0; offset < ready.length; offset += 3) {
    await Promise.all(ready.slice(offset, offset + 3).map(refresh));
  }
  return readLocalAgyStatusImpl(homeDir, { config, label });
}
