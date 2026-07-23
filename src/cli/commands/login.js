import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { buildCoordinationView } from "../../coordination/snapshot.js";
import { closeRedisStore, connectRedisStore, readSnapshot } from "../../coordination/redis-store.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, publishRedisCredentialPolicyFromState, refreshRedisRuntimeSnapshot, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { isInteractiveTerminal } from "../tty.js";
import { normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import { resolveAgentsRepoRoot } from "../../io/paths.js";
import { performLabelMaintenance } from "../../panels/maintenance.js";
import { ensureStateShape, loadAimgrState } from "../../state/schema.js";
import { loadLocalState } from "../../state/local-state.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { createManualCallbackStdioProtocol, writeJsonLine } from "../manual-callback-stdio.js";

async function performRedisLabelMaintenance(context, { label, manualCallbackAutomation = null, writeImpl }) {
  const {
    homeDir,
    env,
    promptLineImpl,
    promptImpl,
    openUrlImpl,
    loginOpenAICodexImpl,
    refreshOpenAICodexImpl,
    nowMs,
  } = context;
  const config = readAimgrConfig({ homeDir }).config;
  if (!config.redis.url) return null;

  const connectImpl = context.connectRedisStoreImpl ?? connectRedisStore;
  const store = await connectImpl({ url: config.redis.url, keyPrefix: config.redis.keyPrefix });
  try {
    const snapshot = await readSnapshot(store);
    const state = buildCoordinationView(snapshot, {
      localState: loadLocalState({ homeDir }),
    });
    const normalizedLabel = normalizeLabel(label);
    if (normalizeProviderId(state?.accounts?.[normalizedLabel]?.provider) === ANTHROPIC_PROVIDER) {
      throw new Error(
        `Redis-backed Claude maintenance for label=${normalizedLabel} is owned by ` +
          "`aim claude capture-native`, `aim claude import-native`, and `aim claude run`.",
      );
    }
    const result = await performLabelMaintenance({
      state,
      label,
      homeDir,
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      allowAnthropicNativeMaintenance: false,
      manualCallbackAutomation,
      writeImpl,
    });
    const published = await publishMaintainedCredential({
      store,
      snapshot,
      state,
      label,
      provider: result.provider,
      observedAt: result.maintenance?.observedAt ?? new Date(nowMs).toISOString(),
    });
    if (!published.ok) {
      throw new Error(`Redis publish failed for label=${label}: ${published.credential?.code ?? "unknown"}`);
    }
    writeRedisLocalStateFromView({ homeDir, state, localState: loadLocalState({ homeDir }) });
    return {
      ...result,
      redis: {
        credentialVersion: published.credential.record.version,
      },
    };
  } finally {
    await closeRedisStore(store);
  }
}

async function persistRedisPanelState({ runtime, state, label, homeDir, nowMs }) {
  const observedAt = new Date(nowMs).toISOString();
  const normalizedLabel = normalizeLabel(label);
  const provider = normalizeProviderId(state?.accounts?.[normalizedLabel]?.provider);
  const credential = provider ? state?.credentials?.[provider]?.[normalizedLabel] : null;
  if (credential) {
    const published = await publishMaintainedCredential({
      store: runtime.store,
      snapshot: runtime.snapshot,
      state,
      label: normalizedLabel,
      provider,
      observedAt,
    });
    if (!published.ok) {
      throw new Error(`Redis publish failed for label=${normalizedLabel}: ${published.credential?.code ?? "unknown"}`);
    }
    await refreshRedisRuntimeSnapshot(runtime);
    writeRedisLocalStateFromView({ homeDir, state, localState: runtime.localState });
    return { credential: published.credential.record };
  }
  const publishedCredential = await publishRedisCredentialPolicyFromState({
    runtime,
    state,
    label,
    observedAt,
  });
  writeRedisLocalStateFromView({ homeDir, state, localState: runtime.localState });
  return { credential: publishedCredential };
}

async function runRedisLabelControlPanel(context, { label, writeImpl }) {
  const {
    homeDir,
    env,
    repoRoot,
    promptLineImpl,
    promptImpl,
    openUrlImpl,
    readOpenclawBindingsFromConfigImpl,
    readOpenclawAgentsListFromConfigImpl,
    runLabelControlPanelImpl,
    loginOpenAICodexImpl,
    refreshOpenAICodexImpl,
    connectRedisStoreImpl,
    nowMs,
  } = context;
  const runtime = await loadRedisRuntime({ homeDir, connectRedisStoreImpl, now: new Date(nowMs) });
  try {
    const normalizedLabel = normalizeLabel(label);
    if (normalizeProviderId(runtime.state?.accounts?.[normalizedLabel]?.provider) === ANTHROPIC_PROVIDER) {
      throw new Error(
        `Redis-backed Claude maintenance for label=${normalizedLabel} is owned by ` +
          "`aim claude capture-native`, `aim claude import-native`, and `aim claude run`.",
      );
    }
    await runLabelControlPanelImpl({
      statePath: null,
      state: runtime.state,
      label,
      homeDir,
      repoRoot: resolveAgentsRepoRoot({ repoRoot, env }),
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      allowAnthropicNativeMaintenance: false,
      persistStateImpl: () => persistRedisPanelState({ runtime, state: runtime.state, label, homeDir, nowMs }),
      writeImpl,
    });
  } finally {
    await closeRedisRuntime(runtime);
  }
}

export async function handleLogin(context) {
  const { opts, positional, statePath, homeDir, shorthandLabel, stdin, stdout, env, setExitCode, repoRoot, promptLineImpl, promptImpl, openUrlImpl, readOpenclawBindingsFromConfigImpl, readOpenclawAgentsListFromConfigImpl, runLabelControlPanelImpl, loginOpenAICodexImpl, refreshOpenAICodexImpl } = context;
  const rawLabel = shorthandLabel ?? positional[1];
  const writeImpl = (chunk) => stdout.write(chunk);
  if (opts.manualCallbackStdio) {
    let label = null;
    let state = null;
    try {
      label = normalizeLabel(rawLabel);
      const redisResult = await performRedisLabelMaintenance(context, {
        label,
        manualCallbackAutomation: createManualCallbackStdioProtocol({
          stdin,
          stdout,
          label,
          provider: OPENAI_CODEX_PROVIDER,
        }),
        writeImpl: () => {},
      });
      if (redisResult) {
        writeJsonLine(stdout, sanitizeForStatus({ type: "result", ...redisResult }));
        return;
      }
      state = loadAimgrState(statePath);
      ensureStateShape(state);
      const manualCallbackAutomation = createManualCallbackStdioProtocol({
        stdin,
        stdout,
        label,
        provider: OPENAI_CODEX_PROVIDER,
      });
      const result = await performLabelMaintenance({
        state,
        label,
        homeDir,
        promptLineImpl,
        promptImpl,
        openUrlImpl,
        loginOpenAICodexImpl,
        refreshOpenAICodexImpl,
        manualCallbackAutomation,
        writeImpl: () => {},
      });
      writeJsonFileWithBackup(statePath, state);
      writeJsonLine(stdout, sanitizeForStatus({ type: "result", ...result }));
      return;
    } catch (err) {
      if (state) {
        writeJsonFileWithBackup(statePath, state);
      }
      writeJsonLine(
        stdout,
        sanitizeForStatus({
          type: "error",
          ok: false,
          ...(label ? { label } : {}),
          error: String(err?.message ?? err),
        }),
      );
      setExitCode(1);
      return;
    }
  }

  const label = normalizeLabel(rawLabel);
  if (shorthandLabel && isInteractiveTerminal({ stdin, stdout }) && isRedisConfigured({ homeDir })) {
    await runRedisLabelControlPanel(context, { label, writeImpl });
    return;
  }
  const redisResult = await performRedisLabelMaintenance(context, { label, writeImpl });
  if (redisResult) {
    stdout.write(`${JSON.stringify(sanitizeForStatus(redisResult), null, 2)}\n`);
    return;
  }
  const state = loadAimgrState(statePath);
  ensureStateShape(state);
  if (shorthandLabel && isInteractiveTerminal({ stdin, stdout })) {
    await runLabelControlPanelImpl({
      statePath,
      state,
      label,
      homeDir,
      repoRoot: resolveAgentsRepoRoot({ repoRoot, env }),
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      readOpenclawBindingsFromConfigImpl,
      readOpenclawAgentsListFromConfigImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      writeImpl,
    });
    return;
  }

  try {
    const result = await performLabelMaintenance({
      state,
      label,
      homeDir,
      promptLineImpl,
      promptImpl,
      openUrlImpl,
      loginOpenAICodexImpl,
      refreshOpenAICodexImpl,
      writeImpl,
    });
    writeJsonFileWithBackup(statePath, state);
    stdout.write(
      `${JSON.stringify(
        sanitizeForStatus(result),
        null,
        2,
      )}\n`,
    );
    return;
  } catch (err) {
    writeJsonFileWithBackup(statePath, state);
    throw err;
  }
}
