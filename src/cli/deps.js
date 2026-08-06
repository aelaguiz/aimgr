import { createFetchJsonWithTimeout } from "../io/fetch.js";

// Keep process primitives cheap and command-independent. Provider, browser,
// panel, and native-client modules are loaded only after dispatch selects the
// command that needs them.
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
    watchLoopMaxIterations: Number.POSITIVE_INFINITY,
  };
}

async function loadUsageDeps() {
  const { probeUsageSnapshotsByProvider } = await import("../pool/usage.js");
  return { probeUsageSnapshotsByProviderImpl: probeUsageSnapshotsByProvider };
}

export async function loadCommandDefaultDeps(command) {
  if (command === "status" || command === "pi" || command === "prime") {
    return loadUsageDeps();
  }

  if (command === "codex") {
    const [{ probeUsageSnapshotsByProvider }, { activateCodexPoolSelection }, { sleep }] = await Promise.all([
      import("../pool/usage.js"),
      import("../targets/codex-cli.js"),
      import("../io/streams.js"),
    ]);
    return {
      probeUsageSnapshotsByProviderImpl: probeUsageSnapshotsByProvider,
      activateCodexPoolSelectionImpl: activateCodexPoolSelection,
      sleepImpl: sleep,
    };
  }

  if (command === "hermes" || command === "rebalance") {
    const [usage, hermes, openclaw, streams] = await Promise.all([
      import("../pool/usage.js"),
      import("../pool/hermes-rebalance.js"),
      import("../openclaw/config.js"),
      import("../io/streams.js"),
    ]);
    return {
      probeUsageSnapshotsByProviderImpl: usage.probeUsageSnapshotsByProvider,
      rebalanceHermesPoolImpl: hermes.rebalanceHermesPool,
      readOpenclawAgentsListFromConfigImpl: openclaw.readOpenclawAgentsListFromConfig,
      sleepImpl: streams.sleep,
    };
  }

  if (command === "claude") {
    const [usage, runner, nativeStorage, processIo] = await Promise.all([
      import("../pool/usage.js"),
      import("../targets/claude-runner.js"),
      import("../credentials/claude-native-storage.js"),
      import("../io/process.js"),
    ]);
    return {
      probeUsageSnapshotsByProviderImpl: usage.probeUsageSnapshotsByProvider,
      runClaudeCliImpl: runner.runClaudeCli,
      readClaudeNativeKeychainOauthImpl: nativeStorage.readClaudeNativeKeychainOauth,
      writeClaudeNativeKeychainOauthImpl: nativeStorage.writeClaudeNativeKeychainOauth,
      deleteClaudeNativeKeychainOauthImpl: nativeStorage.deleteClaudeNativeKeychainOauth,
      resolveExecutableOnPathImpl: processIo.resolveExecutableOnPath,
    };
  }

  if (command === "auth") {
    const { resolveExecutableOnPath } = await import("../io/process.js");
    return { resolveExecutableOnPathImpl: resolveExecutableOnPath };
  }

  if (command === "credential-helper") {
    const { resolveExecutableOnPath } = await import("../io/process.js");
    return { resolveExecutableOnPathImpl: resolveExecutableOnPath };
  }

  if (command === "login") {
    const [browser, prompts, openclaw, panels, codexAuth, runner, nativeStorage, processIo] = await Promise.all([
      import("../browser/launch.js"),
      import("../io/prompts.js"),
      import("../openclaw/config.js"),
      import("../panels/actions.js"),
      import("@mariozechner/pi-ai"),
      import("../targets/claude-runner.js"),
      import("../credentials/claude-native-storage.js"),
      import("../io/process.js"),
    ]);
    return {
      promptLineImpl: prompts.promptLine,
      promptImpl: prompts.promptRequiredLine,
      openUrlImpl: browser.launchBrowserBindingForUrl,
      readOpenclawBindingsFromConfigImpl: openclaw.readOpenclawBindingsFromConfig,
      readOpenclawAgentsListFromConfigImpl: openclaw.readOpenclawAgentsListFromConfig,
      runLabelControlPanelImpl: panels.runLabelControlPanel,
      loginOpenAICodexImpl: codexAuth.loginOpenAICodex,
      refreshOpenAICodexImpl: codexAuth.refreshOpenAICodexToken,
      runClaudeCliImpl: runner.runClaudeCli,
      readClaudeNativeKeychainOauthImpl: nativeStorage.readClaudeNativeKeychainOauth,
      writeClaudeNativeKeychainOauthImpl: nativeStorage.writeClaudeNativeKeychainOauth,
      deleteClaudeNativeKeychainOauthImpl: nativeStorage.deleteClaudeNativeKeychainOauth,
      resolveExecutableOnPathImpl: processIo.resolveExecutableOnPath,
    };
  }

  if (command === "sakana") {
    const { promptRequiredLine } = await import("../io/prompts.js");
    return { promptImpl: promptRequiredLine };
  }

  return {};
}
