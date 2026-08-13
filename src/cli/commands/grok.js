import { XAI_PROVIDER } from "../../core/constants.js";
import {
  closeRedisRuntime,
  isRedisConfigured,
  loadRedisRuntime,
} from "../../coordination/runtime.js";
import { normalizeLabel } from "../../core/normalize.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import {
  collectXaiRedisAccountInventory,
  collectXaiRedisAccountUsageStatus,
  renderXaiRedisAccountInventory,
  renderXaiRedisAccountUsageStatus,
} from "../../status/xai-redis-view.js";

function requestedLabels(positional) {
  return positional.slice(2).map((value) => normalizeLabel(value));
}

export async function handleGrok(context) {
  const { positional, opts, stdout, homeDir, connectRedisStoreImpl } = context;
  const sub = positional[1] ?? "status";
  if (!["status", "inventory", "usage"].includes(sub)) {
    throw new Error("Missing or unsupported grok subcommand. Usage: aim grok status | aim grok inventory");
  }
  if (!isRedisConfigured({ homeDir })) {
    throw new Error("`aim grok status` requires Redis.");
  }
  const labels = requestedLabels(positional);
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl,
    provider: XAI_PROVIDER,
  });
  try {
    if (sub === "inventory") {
      const rows = collectXaiRedisAccountInventory(runtime.snapshot, { labels });
      if (opts.json) {
        stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, provider: XAI_PROVIDER, rows }), null, 2)}\n`);
        return;
      }
      stdout.write(renderXaiRedisAccountInventory(rows));
      return;
    }
    const rows = await collectXaiRedisAccountUsageStatus(runtime.snapshot, { labels });
    if (opts.json) {
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, provider: XAI_PROVIDER, rows }), null, 2)}\n`);
      return;
    }
    stdout.write(renderXaiRedisAccountUsageStatus(rows));
  } finally {
    await closeRedisRuntime(runtime);
  }
}
