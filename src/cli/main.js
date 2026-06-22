import { parseArgs } from "./args.js";
import { createDefaultDeps } from "./deps.js";
import { printHelp } from "./help.js";
import { createFetchJsonWithTimeout } from "../io/fetch.js";
import { resolveAimgrStatePath, resolveHomeDir } from "../io/paths.js";
import { handleApply } from "./commands/apply.js";
import { handleAuth } from "./commands/auth.js";
import { handleBrowser } from "./commands/browser.js";
import { handleClaude } from "./commands/claude.js";
import { handleCodex } from "./commands/codex.js";
import { handleHermes } from "./commands/hermes.js";
import { handleInternal } from "./commands/internal.js";
import { handleLogin } from "./commands/login.js";
import { handlePi } from "./commands/pi.js";
import { handlePromote } from "./commands/promote.js";
import { handleRedis } from "./commands/redis.js";
import { handleSakana } from "./commands/sakana.js";
import { handleLabel, handleSession } from "./commands/repair.js";
import { handleAutopin, handlePin } from "./commands/removed.js";
import { handleRebalance } from "./commands/rebalance.js";
import { handleStatus } from "./commands/status.js";
import { handleSync } from "./commands/sync.js";

const COMMAND_HANDLERS = new Map([
  ["status", handleStatus],
  ["login", handleLogin],
  ["redis", handleRedis],
  ["label", handleLabel],
  ["session", handleSession],
  ["pin", handlePin],
  ["autopin", handleAutopin],
  ["rebalance", handleRebalance],
  ["apply", handleApply],
  ["sync", handleSync],
  ["promote", handlePromote],
  ["auth", handleAuth],
  ["codex", handleCodex],
  ["hermes", handleHermes],
  ["claude", handleClaude],
  ["pi", handlePi],
  ["sakana", handleSakana],
  ["browser", handleBrowser],
  ["internal", handleInternal],
]);

export async function main(argv, deps = createDefaultDeps()) {
  const defaultDeps = createDefaultDeps();
  const {
    stdin = defaultDeps.stdin,
    stdout = defaultDeps.stdout,
    env = defaultDeps.env,
    setExitCode = defaultDeps.setExitCode,
    nowImpl = defaultDeps.nowImpl,
    fetchImpl = defaultDeps.fetchImpl,
    setTimeoutImpl = defaultDeps.setTimeoutImpl,
    clearTimeoutImpl = defaultDeps.clearTimeoutImpl,
    fetchJsonWithTimeoutImpl = createFetchJsonWithTimeout({ fetchImpl, setTimeoutImpl, clearTimeoutImpl }),
    repoRoot,
    promptLineImpl = defaultDeps.promptLineImpl,
    promptImpl = defaultDeps.promptImpl,
    openUrlImpl = defaultDeps.openUrlImpl,
    readOpenclawBindingsFromConfigImpl = defaultDeps.readOpenclawBindingsFromConfigImpl,
    readOpenclawAgentsListFromConfigImpl = defaultDeps.readOpenclawAgentsListFromConfigImpl,
    runLabelControlPanelImpl = defaultDeps.runLabelControlPanelImpl,
    loginOpenAICodexImpl = defaultDeps.loginOpenAICodexImpl,
    refreshOpenAICodexImpl = defaultDeps.refreshOpenAICodexImpl,
    refreshAnthropicImpl = defaultDeps.refreshAnthropicImpl,
    probeUsageSnapshotsByProviderImpl = (state) =>
      defaultDeps.probeUsageSnapshotsByProviderImpl(state, { fetchJsonWithTimeoutImpl, env }),
    activateCodexPoolSelectionImpl = defaultDeps.activateCodexPoolSelectionImpl,
    runCodexTenderImpl = defaultDeps.runCodexTenderImpl,
    runClaudeCliImpl = defaultDeps.runClaudeCliImpl,
    rebalanceHermesPoolImpl = defaultDeps.rebalanceHermesPoolImpl,
    connectRedisStoreImpl = defaultDeps.connectRedisStoreImpl,
    sleepImpl = defaultDeps.sleepImpl,
    watchLoopMaxIterations = defaultDeps.watchLoopMaxIterations,
  } = deps ?? {};
  const { opts, positional } = parseArgs(argv);
  let cmd = positional[0];
  let shorthandLabel = null;

  if (opts.help || !cmd) {
    printHelp({ stdout });
    return;
  }
  if (!COMMAND_HANDLERS.has(cmd)) {
    shorthandLabel = cmd;
    cmd = "login";
  }

  const handler = COMMAND_HANDLERS.get(cmd);
  if (!handler) {
    throw new Error(`Unknown command: ${cmd}`);
  }

  return handler({
    opts,
    positional,
    statePath: resolveAimgrStatePath(opts, { env }),
    homeDir: resolveHomeDir(opts.home, { env }),
    shorthandLabel,
    stdin,
    stdout,
    env,
    setExitCode,
    nowMs: nowImpl(),
    repoRoot,
    promptLineImpl,
    promptImpl,
    openUrlImpl,
    readOpenclawBindingsFromConfigImpl,
    readOpenclawAgentsListFromConfigImpl,
    runLabelControlPanelImpl,
    loginOpenAICodexImpl,
    refreshOpenAICodexImpl,
    refreshAnthropicImpl,
    probeUsageSnapshotsByProviderImpl,
    activateCodexPoolSelectionImpl,
    runCodexTenderImpl,
    runClaudeCliImpl,
    rebalanceHermesPoolImpl,
    connectRedisStoreImpl,
    sleepImpl,
    watchLoopMaxIterations,
  });
}
