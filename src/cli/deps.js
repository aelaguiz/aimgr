import { createFetchJsonWithTimeout } from "../io/fetch.js";

// Keep process primitives cheap and command-independent. Provider, browser,
// panel, and native-client modules are loaded only after dispatch selects the
// command that needs them.
export function createDefaultDeps() {
  return {
    stdin: process.stdin,
    stdout: process.stdout,
    stderr: process.stderr,
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
  if (command === "status" || command === "cluster" || command === "pi" || command === "prime") {
    return loadUsageDeps();
  }

  if (command === "codex") {
    const [{ probeUsageSnapshotsByProvider }, { activateCodexPoolSelection }, { sleep }, { runCodexInteractive }] = await Promise.all([
      import("../pool/usage.js"),
      import("../targets/codex-cli.js"),
      import("../io/streams.js"),
      import("../targets/codex-runner.js"),
    ]);
    const { spawnSync } = await import("node:child_process");
    return {
      probeUsageSnapshotsByProviderImpl: probeUsageSnapshotsByProvider,
      activateCodexPoolSelectionImpl: activateCodexPoolSelection,
      sleepImpl: sleep,
      runCodexInteractiveImpl: runCodexInteractive,
      spawnSyncImpl: spawnSync,
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
    const { promptLine } = await import("../io/prompts.js");
    return { promptLineImpl: promptLine };
  }

  if (command === "sakana") {
    const { promptRequiredLine } = await import("../io/prompts.js");
    return { promptImpl: promptRequiredLine };
  }

  return {};
}
