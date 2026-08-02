import { parseArgs } from "./args.js";
import { createDefaultDeps, loadCommandDefaultDeps } from "./deps.js";
import { printHelp } from "./help.js";
import { createFetchJsonWithTimeout } from "../io/fetch.js";
import { resolveAimgrStatePath, resolveHomeDir } from "../io/paths.js";

const COMMAND_LOADERS = new Map([
  ["status", async () => (await import("./commands/status.js")).handleStatus],
  ["login", async () => (await import("./commands/login.js")).handleLogin],
  ["redis", async () => (await import("./commands/redis.js")).handleRedis],
  ["label", async () => (await import("./commands/repair.js")).handleLabel],
  ["rebalance", async () => (await import("./commands/rebalance.js")).handleRebalance],
  ["auth", async () => (await import("./commands/auth.js")).handleAuth],
  ["codex", async () => (await import("./commands/codex.js")).handleCodex],
  ["hermes", async () => (await import("./commands/hermes.js")).handleHermes],
  ["claude", async () => (await import("./commands/claude.js")).handleClaude],
  ["pi", async () => (await import("./commands/pi.js")).handlePi],
  ["sakana", async () => (await import("./commands/sakana.js")).handleSakana],
  ["browser", async () => (await import("./commands/browser.js")).handleBrowser],
]);

const RETIRED_COMMANDS = new Set(["apply", "autopin", "internal", "pin", "promote", "session", "sync"]);

export async function main(argv, injectedDeps = {}) {
  const baseDeps = createDefaultDeps();
  const parseEnv = injectedDeps?.env ?? baseDeps.env;
  const parseStdout = injectedDeps?.stdout ?? baseDeps.stdout;
  const { opts, positional } = parseArgs(argv);
  let cmd = positional[0];
  let shorthandLabel = null;

  if (opts.help || !cmd) {
    printHelp({ stdout: parseStdout });
    return;
  }
  if (RETIRED_COMMANDS.has(cmd)) {
    throw new Error(`Unknown command: ${cmd}`);
  }
  if (!COMMAND_LOADERS.has(cmd)) {
    shorthandLabel = cmd;
    cmd = "login";
  }

  const [handler, commandDefaults] = await Promise.all([
    COMMAND_LOADERS.get(cmd)(),
    loadCommandDefaultDeps(cmd),
  ]);
  const deps = { ...baseDeps, ...commandDefaults, ...(injectedDeps ?? {}) };
  const fetchJsonWithTimeoutImpl = injectedDeps?.fetchJsonWithTimeoutImpl
    ?? createFetchJsonWithTimeout({
      fetchImpl: deps.fetchImpl,
      setTimeoutImpl: deps.setTimeoutImpl,
      clearTimeoutImpl: deps.clearTimeoutImpl,
    });
  const probeUsageSnapshotsByProviderImpl = injectedDeps?.probeUsageSnapshotsByProviderImpl
    ?? (typeof deps.probeUsageSnapshotsByProviderImpl === "function"
      ? (state, options = {}) => deps.probeUsageSnapshotsByProviderImpl(state, {
          ...options,
          fetchJsonWithTimeoutImpl,
          env: options.env ?? deps.env,
        })
      : undefined);
  const homeDir = resolveHomeDir(opts.home, { env: parseEnv });

  return handler({
    ...deps,
    opts,
    positional,
    // Recovery-only handlers still need the canonical legacy path. It is not
    // operator-selectable: the retired state-file override is intentionally
    // absent from parsing and help.
    statePath: resolveAimgrStatePath({ home: homeDir }, { env: parseEnv }),
    homeDir,
    shorthandLabel,
    nowMs: deps.nowImpl(),
    fetchJsonWithTimeoutImpl,
    probeUsageSnapshotsByProviderImpl,
  });
}
