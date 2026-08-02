import { renderStatusText } from "../../status/render.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { renderStatusCompactText } from "../../status/table.js";
import { buildRedisStatusView } from "../../status/redis-view.js";

export async function handleStatus(context) {
  const {
    opts,
    homeDir,
    env,
    stdout,
    probeUsageSnapshotsByProviderImpl,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
    nowMs,
  } = context;
  const redisStatus = await buildRedisStatusView({
    homeDir,
    env,
    probeUsageSnapshotsByProviderImpl,
    fetchJsonWithTimeoutImpl,
    connectRedisStoreImpl,
    nowMs,
  });
  const view = redisStatus.view;
  if (opts.json) {
    stdout.write(`${JSON.stringify(sanitizeForStatus(view), null, 2)}\n`);
    return;
  }
  if (opts.compact) {
    stdout.write(renderStatusCompactText(view));
    return;
  }
  stdout.write(
    renderStatusText(view, {
      showAssignments: opts.assignments === true,
      ...(opts.accounts === true ? { showAccounts: true } : {}),
      claudeUsageStatus: redisStatus.claudeUsageStatus,
    }),
  );
}
