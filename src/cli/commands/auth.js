import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime } from "../../coordination/runtime.js";
import { normalizeLabel } from "../../core/normalize.js";
import { loadAimgrState } from "../../state/schema.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { writeHermesAuthFromState } from "../../targets/hermes-auth.js";

export async function handleAuth(context) {
  const { opts, positional, statePath, homeDir, stdout, connectRedisStoreImpl } = context;
  const subcmd = String(positional[1] ?? "").trim().toLowerCase();
  if (!subcmd) {
    throw new Error("Missing auth subcommand. Usage: aim auth write hermes <label> --auth-file <abs-path>");
  }
  if (subcmd !== "write") {
    throw new Error(`Unsupported auth subcommand: ${subcmd} (supported: write).`);
  }
  const system = String(positional[2] ?? "").trim().toLowerCase();
  if (!system) {
    throw new Error("Missing auth target. Usage: aim auth write hermes <label> --auth-file <abs-path>");
  }
  if (system !== "hermes") {
    throw new Error(`Unsupported auth target: ${system} (supported: hermes).`);
  }
  const label = normalizeLabel(positional[3]);
  if (isRedisConfigured({ homeDir })) {
    const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl });
    try {
      const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, runtime.state);
      stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
      return;
    } finally {
      await closeRedisRuntime(runtime);
    }
  }
  const state = loadAimgrState(statePath);
  const written = writeHermesAuthFromState({ label, authPath: opts.authFile }, state);
  stdout.write(`${JSON.stringify(sanitizeForStatus({ ok: true, written }), null, 2)}\n`);
  return;
}
