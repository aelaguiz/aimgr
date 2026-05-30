import { loginOpenAICodex, refreshAnthropicToken, refreshOpenAICodexToken } from "@mariozechner/pi-ai";
import { launchBrowserBindingForUrl } from "../browser/launch.js";
import { promptLine, promptRequiredLine } from "../io/prompts.js";
import { sleep } from "../io/streams.js";
import { createFetchJsonWithTimeout } from "../io/fetch.js";
import { readOpenclawAgentsListFromConfig, readOpenclawBindingsFromConfig } from "../openclaw/config.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { rebalanceHermesPool } from "../pool/hermes-rebalance.js";
import { runLabelControlPanel } from "../panels/actions.js";
import { activateCodexPoolSelection } from "../targets/codex-cli.js";
import { runCodexTender } from "../targets/codex-tender.js";
import { runClaudeCli } from "../targets/claude-runner.js";

// CLI dependencies cross the process/IO boundary here so command tests can inject fakes without global side effects.
export function createDefaultDeps() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    env: process.env,
    setExitCode: (code) => {
      process.exitCode = code;
    },
    nowImpl: Date.now,
    fetchImpl: globalThis.fetch?.bind(globalThis),
    setTimeoutImpl: setTimeout,
    clearTimeoutImpl: clearTimeout,
    fetchJsonWithTimeoutImpl: createFetchJsonWithTimeout(),
    promptLineImpl: promptLine,
    promptImpl: promptRequiredLine,
    openUrlImpl: launchBrowserBindingForUrl,
    readOpenclawBindingsFromConfigImpl: readOpenclawBindingsFromConfig,
    readOpenclawAgentsListFromConfigImpl: readOpenclawAgentsListFromConfig,
    runLabelControlPanelImpl: runLabelControlPanel,
    loginOpenAICodexImpl: loginOpenAICodex,
    refreshOpenAICodexImpl: refreshOpenAICodexToken,
    refreshAnthropicImpl: refreshAnthropicToken,
    probeUsageSnapshotsByProviderImpl: probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl: activateCodexPoolSelection,
    runCodexTenderImpl: runCodexTender,
    runClaudeCliImpl: runClaudeCli,
    rebalanceHermesPoolImpl: rebalanceHermesPool,
    sleepImpl: sleep,
    watchLoopMaxIterations: Number.POSITIVE_INFINITY,
  };
}
