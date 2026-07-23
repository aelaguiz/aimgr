import { loadAimgrState } from "../../state/schema.js";
import { renderStatusText } from "../../status/render.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { renderStatusCompactText } from "../../status/table.js";
import { buildStatusView } from "../../status/view.js";
import { buildRedisStatusView } from "../../status/redis-view.js";

export async function handleStatus(context) {
  const { opts, statePath, homeDir, env, stdout, probeUsageSnapshotsByProviderImpl, fetchJsonWithTimeoutImpl, nowMs } = context;
  const redisStatus = await buildRedisStatusView({
    homeDir,
    env,
    probeUsageSnapshotsByProviderImpl,
    fetchJsonWithTimeoutImpl,
    nowMs,
  });
  if (redisStatus.used) {
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
      }),
    );
    return;
  }
  const state = loadAimgrState(statePath);
  const view = await buildStatusView({
    statePath,
    state,
    homeDir,
    env,
    probeUsageSnapshotsByProviderImpl,
    nowMs,
  });
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
    }),
  );
  return;
}
