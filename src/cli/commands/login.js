import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../../core/constants.js";
import { readAimgrConfig } from "../../config/aimgr-config.js";
import { acquireRedisCredentialLease } from "../../coordination/redis-credential-lease.js";
import {
  clearRedisClaudeRotationFence,
  createRedisClaudeRotationFence,
  isRedisClaudeRotationFenceSuccessor,
  readRedisClaudeRotationFence,
} from "../../coordination/redis-claude-rotation-fence.js";
import { buildCoordinationView } from "../../coordination/snapshot.js";
import { closeRedisStore, connectRedisStore, readSnapshot } from "../../coordination/redis-store.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, publishRedisCredentialPolicyFromState, refreshRedisRuntimeSnapshot, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { persistAnthropicNativeBundleForLabel } from "../../credentials/claude-native.js";
import {
  CLAUDE_MANAGED_FILE_STORAGE_MODE,
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
  readManagedClaudeNativeBundleFromFiles,
  readClaudeNativeOauthAccountAtPath,
} from "../../credentials/claude-native-storage.js";
import { isInteractiveTerminal } from "../tty.js";
import { normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import {
  resolveAgentsRepoRoot,
  resolveAimgrClaudeLabelHomeDir,
  resolveAimgrStateDir,
  resolveManagedClaudeDir,
} from "../../io/paths.js";
import { performLabelMaintenance } from "../../panels/maintenance.js";
import { ensureStateShape, loadAimgrState } from "../../state/schema.js";
import { ensureLocalInstallationId, loadLocalState } from "../../state/local-state.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { prepareClaudeCliLaunch, runClaudeCli } from "../../targets/claude-runner.js";
import { createManualCallbackStdioProtocol, writeJsonLine } from "../manual-callback-stdio.js";

const CLAUDE_LOGIN_STAGING_DIRNAME = ".login-staging";
const CLAUDE_LOGIN_RECOVERY_CONTRACT = `${CLAUDE_MANAGED_FILE_STORAGE_MODE}:login-staging-v1`;

function buildClaudeTokenLineageFingerprint(credential) {
  const access = typeof credential?.access === "string" ? credential.access.trim() : "";
  const refresh = typeof credential?.refresh === "string" ? credential.refresh.trim() : "";
  if (!access || !refresh) return null;
  return `sha256:${createHash("sha256")
    .update(JSON.stringify({ access, refresh }))
    .digest("hex")}`;
}

function currentAnthropicRecord(snapshot, label) {
  return (snapshot?.credentials ?? []).find(
    (record) => record.provider === ANTHROPIC_PROVIDER && record.label === label,
  ) ?? null;
}

function clearClaudeRotationPublicationPending(state, label) {
  const target = state?.targets?.claudeCli;
  const pending = target?.rotationPublicationPendingByLabel;
  if (!pending || typeof pending !== "object" || Array.isArray(pending)) return;
  delete pending[label];
  if (Object.keys(pending).length === 0) {
    delete target.rotationPublicationPendingByLabel;
  }
}

function buildClaudeLoginRecoveryStorageId({ installationId, configDir }) {
  return `sha256:${createHash("sha256")
    .update(`${CLAUDE_LOGIN_RECOVERY_CONTRACT}\0${installationId}\0${path.resolve(configDir).normalize("NFC")}`)
    .digest("hex")}`;
}

function resolveClaudeLoginStaging({ homeDir, label, expectedEmail }) {
  const labelHome = resolveAimgrClaudeLabelHomeDir({ homeDir, label });
  const stagingHome = path.join(labelHome, CLAUDE_LOGIN_STAGING_DIRNAME);
  const configDir = resolveManagedClaudeDir({ homeDir: stagingHome });
  const descriptor = buildManagedClaudeNativeStorageDescriptor({
    configDir,
    defaultConfigDir: resolveManagedClaudeDir({ homeDir }),
    expectedEmail,
    managedRootDir: resolveAimgrStateDir({ homeDir }),
  });
  return { labelHome, stagingHome, configDir, descriptor };
}

function removeClaudeLoginStaging({ homeDir, label, stagingHome }) {
  const expected = path.join(
    resolveAimgrClaudeLabelHomeDir({ homeDir, label }),
    CLAUDE_LOGIN_STAGING_DIRNAME,
  );
  if (path.resolve(stagingHome) !== path.resolve(expected)) {
    throw new Error("Refusing to remove an unexpected Claude login staging directory.");
  }
  let stat;
  try {
    stat = fs.lstatSync(stagingHome);
  } catch (error) {
    if (error?.code === "ENOENT") return { removed: false };
    throw new Error("Could not inspect Claude login staging.");
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
    || (stat.mode & 0o077) !== 0
  ) {
    throw new Error("Refusing to remove unsafe Claude login staging.");
  }
  fs.rmSync(stagingHome, { recursive: true, force: false });
  if (fs.existsSync(stagingHome)) {
    throw new Error("Claude login staging could not be removed.");
  }
  return { removed: true };
}

async function assertClaudeLoginLeaseOwned({ lease, phase }) {
  if (await lease.renew() !== true) {
    throw new Error(`Claude credential lease was lost ${phase}.`);
  }
}

async function withClaudeLoginLease({ store, label, phase }, operation) {
  const lease = await acquireRedisCredentialLease(store, {
    provider: ANTHROPIC_PROVIDER,
    label,
  });
  if (!lease) {
    throw new Error(`Claude credential maintenance is already active for label=${label}.`);
  }
  let result;
  let failure = null;
  try {
    result = await operation(lease);
  } catch (error) {
    failure = error;
  }
  const released = await lease.release().catch(() => false);
  if (failure) throw failure;
  if (!released) {
    throw new Error(`Claude credential lease was lost ${phase}.`);
  }
  return result;
}

async function clearClaudeLoginFence({ store, label, fence, lease }) {
  const cleared = await clearRedisClaudeRotationFence(store, {
    label,
    fenceId: fence.fenceId,
    lease,
  });
  if (!cleared) {
    throw new Error(`Claude label=${label} login fence could not be cleared safely.`);
  }
}

async function publishClaudeLoginBundle({
  store,
  snapshot,
  state,
  label,
  nativeClaudeBundle,
  fence,
  observedAt,
}) {
  persistAnthropicNativeBundleForLabel({
    state,
    label,
    nativeClaudeBundle,
  });
  const published = await publishMaintainedCredential({
    store,
    snapshot,
    state,
    label,
    provider: ANTHROPIC_PROVIDER,
    observedAt,
    rotationFence: fence,
  });
  if (!published.ok) {
    throw new Error(
      `Redis publish failed for label=${label}: ${published.credential?.code ?? "unknown"}`,
    );
  }
  return published.credential.record;
}

async function recoverClaudeLoginFence({
  store,
  snapshot,
  state,
  homeDir,
  label,
  descriptor,
  stagingHome,
  recoveryStorageId,
  fence,
  lease,
  nowMs,
}) {
  const current = currentAnthropicRecord(snapshot, label);
  const currentFingerprint = buildClaudeTokenLineageFingerprint(current?.credential);
  if (!current || !currentFingerprint) {
    throw new Error(`Claude label=${label} has no valid Redis lineage for login recovery.`);
  }
  if (currentFingerprint !== fence.baseTokenLineageFingerprint) {
    if (!isRedisClaudeRotationFenceSuccessor(current, {
      fence,
      tokenLineageFingerprint: currentFingerprint,
    })) {
      throw new Error(`Claude label=${label} changed outside its login fence.`);
    }
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before clearing a published login fence",
    });
    await clearClaudeLoginFence({ store, label, fence, lease });
    removeClaudeLoginStaging({ homeDir, label, stagingHome });
    return { recovered: true, record: current };
  }
  if (fence.recoveryStorageId !== recoveryStorageId) {
    throw new Error(`Claude label=${label} has an unresolved non-login rotation fence.`);
  }

  const staged = readManagedClaudeNativeBundleFromFiles({ descriptor });
  if (staged.ok !== true) {
    const identity = readClaudeNativeOauthAccountAtPath({
      appStatePath: descriptor.appStatePath,
      expectedEmail: descriptor.expectedEmail,
    });
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before abandoning empty login staging",
    });
    await clearClaudeLoginFence({ store, label, fence, lease });
    removeClaudeLoginStaging({ homeDir, label, stagingHome });
    if (identity.errorKind === "identity_mismatch") {
      throw new Error(`Claude login for label=${label} failed identity_mismatch validation.`);
    }
    return { recovered: false, record: null };
  }

  let record;
  try {
    record = await publishClaudeLoginBundle({
      store,
      snapshot,
      state,
      label,
      nativeClaudeBundle: staged.nativeClaudeBundle,
      fence,
      observedAt: new Date(nowMs).toISOString(),
    });
  } catch (error) {
    if (/identity_mismatch|already stored on label=/i.test(String(error?.message ?? error))) {
      await assertClaudeLoginLeaseOwned({
        lease,
        phase: "before rejecting recovered login identity",
      });
      await clearClaudeLoginFence({ store, label, fence, lease });
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
    }
    throw error;
  }
  await assertClaudeLoginLeaseOwned({
    lease,
    phase: "before clearing a recovered login fence",
  });
  await clearClaudeLoginFence({ store, label, fence, lease });
  removeClaudeLoginStaging({ homeDir, label, stagingHome });
  return { recovered: true, record };
}

async function performRedisClaudeLogin(context, {
  store,
  state,
  localState,
  label,
}) {
  const {
    homeDir,
    env,
    runClaudeCliImpl = runClaudeCli,
    resolveExecutableOnPathImpl,
    nowMs,
  } = context;
  const expectedEmail = typeof state?.accounts?.[label]?.expect?.email === "string"
    ? state.accounts[label].expect.email.trim().toLowerCase()
    : "";
  if (!expectedEmail) {
    throw new Error(`Claude label=${label} requires an expected email before login.`);
  }
  const {
    stagingHome,
    configDir,
    descriptor,
  } = resolveClaudeLoginStaging({ homeDir, label, expectedEmail });
  const discoveredCommand = resolveExecutableOnPathImpl?.("claude");
  if (!discoveredCommand || !path.isAbsolute(discoveredCommand)) {
    throw new Error("Could not resolve the installed Claude executable for managed login.");
  }
  const prepareLaunchImpl = typeof resolveExecutableOnPathImpl?.prepareClaudeCliLaunchImpl === "function"
    ? resolveExecutableOnPathImpl.prepareClaudeCliLaunchImpl
    : prepareClaudeCliLaunch;
  const preparedLaunch = await prepareLaunchImpl({
    command: discoveredCommand,
    userHomeDir: homeDir,
    homeDir: stagingHome,
    configDir,
  });
  const installationId = ensureLocalInstallationId(localState);
  writeRedisLocalStateFromView({ homeDir, state, localState });
  const recoveryStorageId = buildClaudeLoginRecoveryStorageId({ installationId, configDir });

  const preparation = await withClaudeLoginLease({
    store,
    label,
    phase: "before browser login",
  }, async (lease) => {
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before native login recovery",
    });
    const preparationSnapshot = await readSnapshot(store);
    const preparationState = buildCoordinationView(preparationSnapshot, {
      localState,
      provider: ANTHROPIC_PROVIDER,
    });
    const existingFence = await readRedisClaudeRotationFence(store, { label });
    if (existingFence) {
      const recovered = await recoverClaudeLoginFence({
        store,
        snapshot: preparationSnapshot,
        state: preparationState,
        homeDir,
        label,
        descriptor,
        stagingHome,
        recoveryStorageId,
        fence: existingFence,
        lease,
        nowMs,
      });
      if (recovered.recovered) {
        clearClaudeRotationPublicationPending(preparationState, label);
        writeRedisLocalStateFromView({ homeDir, state: preparationState, localState });
        return {
          result: {
            ok: true,
            label,
            provider: ANTHROPIC_PROVIDER,
            maintenance: {
              action: "recovered-native-login",
              observedAt: recovered.record.updatedAt,
            },
            redis: { credentialVersion: recovered.record.version },
          },
        };
      }
    }

    removeClaudeLoginStaging({ homeDir, label, stagingHome });
    ensureSafeManagedClaudeStorage({ descriptor });
    const current = currentAnthropicRecord(preparationSnapshot, label);
    const baseTokenLineageFingerprint = buildClaudeTokenLineageFingerprint(current?.credential);
    if (!current || !Number.isInteger(current.version) || !baseTokenLineageFingerprint) {
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      throw new Error(`Claude label=${label} has no valid Redis lineage for fresh login.`);
    }
    const fence = await createRedisClaudeRotationFence(store, {
      label,
      recoveryStorageId,
      baseTokenLineageFingerprint,
      baseCredentialVersion: current.version,
      observedAt: new Date(nowMs).toISOString(),
    });
    if (!fence) {
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      throw new Error(`Claude label=${label} has an unresolved shared rotation fence.`);
    }
    return { fence };
  });
  if (preparation.result) return preparation.result;
  const fence = preparation.fence;

  const loginEnv = { ...(env ?? {}) };
  delete loginEnv.BROWSER;
  delete loginEnv.DISPLAY;
  delete loginEnv.WAYLAND_DISPLAY;
  let launched = null;
  let launchError = null;
  try {
    launched = await runClaudeCliImpl({
      command: preparedLaunch.command,
      userHomeDir: homeDir,
      homeDir: stagingHome,
      configDir,
      cwd: process.cwd(),
      args: ["auth", "login", "--claudeai"],
      env: loginEnv,
      preparedLaunch,
    });
  } catch (error) {
    launchError = error;
  }

  return await withClaudeLoginLease({
    store,
    label,
    phase: "after browser login",
  }, async (lease) => {
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before reconciling browser login",
    });
    const completionSnapshot = await readSnapshot(store);
    const completionState = buildCoordinationView(completionSnapshot, {
      localState,
      provider: ANTHROPIC_PROVIDER,
    });
    const completionFence = await readRedisClaudeRotationFence(store, { label });
    if (
      !completionFence
      || completionFence.fenceId !== fence.fenceId
      || completionFence.recoveryStorageId !== fence.recoveryStorageId
      || completionFence.baseCredentialVersion !== fence.baseCredentialVersion
      || completionFence.baseTokenLineageFingerprint !== fence.baseTokenLineageFingerprint
    ) {
      throw new Error(`Claude label=${label} login coordination changed while the browser was open.`);
    }
    const current = currentAnthropicRecord(completionSnapshot, label);
    const currentFingerprint = buildClaudeTokenLineageFingerprint(current?.credential);
    if (
      !current
      || !currentFingerprint
      || current.version !== fence.baseCredentialVersion
      || currentFingerprint !== fence.baseTokenLineageFingerprint
    ) {
      if (isRedisClaudeRotationFenceSuccessor(current, {
        fence,
        tokenLineageFingerprint: currentFingerprint,
      })) {
        await assertClaudeLoginLeaseOwned({
          lease,
          phase: "before clearing an already-published login fence",
        });
        await clearClaudeLoginFence({ store, label, fence, lease });
        removeClaudeLoginStaging({ homeDir, label, stagingHome });
        clearClaudeRotationPublicationPending(completionState, label);
        writeRedisLocalStateFromView({ homeDir, state: completionState, localState });
        return {
          ok: true,
          label,
          provider: ANTHROPIC_PROVIDER,
          maintenance: {
            action: "recovered-native-login",
            observedAt: current.updatedAt,
          },
          redis: { credentialVersion: current.version },
        };
      }
      throw new Error(`Claude label=${label} changed outside its login fence.`);
    }

    const staged = readManagedClaudeNativeBundleFromFiles({ descriptor });
    if (launchError) {
      if (staged.ok !== true) {
        await assertClaudeLoginLeaseOwned({
          lease,
          phase: "before cleaning failed login staging",
        });
        await clearClaudeLoginFence({ store, label, fence, lease });
        removeClaudeLoginStaging({ homeDir, label, stagingHome });
      }
      if (staged.ok === true) {
        throw new Error(
          `Claude login for label=${label} failed after producing credentials; recovery is pending.`,
        );
      }
      throw launchError;
    }

    const cleanExit = launched?.status === 0 && !launched?.signal;
    if (!cleanExit) {
      if (staged.ok !== true) {
        await assertClaudeLoginLeaseOwned({
          lease,
          phase: "before cleaning cancelled login staging",
        });
        await clearClaudeLoginFence({ store, label, fence, lease });
        removeClaudeLoginStaging({ homeDir, label, stagingHome });
      }
      throw new Error(
        staged.ok === true
          ? `Claude login for label=${label} ended noncleanly after producing credentials; recovery is pending.`
          : `Claude login for label=${label} was cancelled or failed.`,
      );
    }
    if (staged.ok !== true) {
      const identity = readClaudeNativeOauthAccountAtPath({
        appStatePath: descriptor.appStatePath,
        expectedEmail: descriptor.expectedEmail,
      });
      await assertClaudeLoginLeaseOwned({
        lease,
        phase: "before cleaning incomplete login staging",
      });
      await clearClaudeLoginFence({ store, label, fence, lease });
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      if (identity.errorKind === "identity_mismatch") {
        throw new Error(`Claude login for label=${label} failed identity_mismatch validation.`);
      }
      throw new Error(`Claude login for label=${label} did not produce a complete file-backed credential.`);
    }

    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before publishing the fresh login",
    });
    let record;
    try {
      record = await publishClaudeLoginBundle({
        store,
        snapshot: completionSnapshot,
        state: completionState,
        label,
        nativeClaudeBundle: staged.nativeClaudeBundle,
        fence,
        observedAt: new Date().toISOString(),
      });
    } catch (error) {
      if (/identity_mismatch|already stored on label=/i.test(String(error?.message ?? error))) {
        await assertClaudeLoginLeaseOwned({
          lease,
          phase: "before rejecting fresh login identity",
        });
        await clearClaudeLoginFence({ store, label, fence, lease });
        removeClaudeLoginStaging({ homeDir, label, stagingHome });
      }
      throw error;
    }
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before clearing the published login fence",
    });
    await clearClaudeLoginFence({ store, label, fence, lease });
    removeClaudeLoginStaging({ homeDir, label, stagingHome });
    clearClaudeRotationPublicationPending(completionState, label);
    writeRedisLocalStateFromView({ homeDir, state: completionState, localState });
    return {
      ok: true,
      label,
      provider: ANTHROPIC_PROVIDER,
      maintenance: {
        action: "native-login",
        observedAt: record.updatedAt,
      },
      redis: { credentialVersion: record.version },
    };
  });
}

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
    const normalizedLabel = normalizeLabel(label);
    const localState = loadLocalState({ homeDir });
    const anthropicRecord = currentAnthropicRecord(snapshot, normalizedLabel);
    if (anthropicRecord) {
      if (manualCallbackAutomation) {
        throw new Error("Anthropic login does not use the Codex manual-callback JSONL protocol.");
      }
      const state = buildCoordinationView(snapshot, {
        localState,
        provider: ANTHROPIC_PROVIDER,
      });
      return await performRedisClaudeLogin(context, {
        store,
        state,
        localState,
        label: normalizedLabel,
      });
    }
    const state = buildCoordinationView(snapshot, { localState });
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
