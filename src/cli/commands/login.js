import fs from "node:fs";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER, XAI_PROVIDER } from "../../core/constants.js";
import {
  acquireRedisCredentialLease,
  renewOrReacquireRedisCredentialLease,
} from "../../coordination/redis-credential-lease.js";
import { buildCoordinationView } from "../../coordination/snapshot.js";
import { readSnapshot, REDIS_CONNECTION_POLICY_LEASED } from "../../coordination/redis-store.js";
import { publishMaintainedCredential } from "../../coordination/login-publish.js";
import { closeRedisRuntime, isRedisConfigured, loadRedisRuntime, publishRedisCredentialPolicyFromState, refreshRedisRuntimeSnapshot, writeRedisLocalStateFromView } from "../../coordination/runtime.js";
import { persistAnthropicNativeBundleForLabel } from "../../credentials/claude-native.js";
import { hasCompleteClaudeNativeBundle } from "../../credentials/claude-bundle.js";
import { ensureProviderConfiguredForLabel, resolveSupportedProviderFromInput } from "../../credentials/oauth.js";
import { loginXaiDevice, storeXaiLoginCredential } from "../../credentials/xai-login.js";

import {
  buildManagedClaudeNativeStorageDescriptor,
  ensureSafeManagedClaudeStorage,
  readClaudeNativeOauthAccountAtPath,
  readManagedClaudeNativeBundleFromFiles,
} from "../../credentials/claude-native-storage.js";
import { isInteractiveTerminal } from "../tty.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../../core/normalize.js";
import { writeJsonFileWithBackup } from "../../io/json-store.js";
import {
  resolveAgentsRepoRoot,
  resolveAimgrClaudeLabelHomeDir,
  resolveAimgrStateDir,
  resolveManagedClaudeDir,
} from "../../io/paths.js";
import { performLabelMaintenance } from "../../panels/maintenance.js";
import { ensureStateShape, loadAimgrState } from "../../state/schema.js";
import { loadLocalState } from "../../state/local-state.js";
import { sanitizeForStatus } from "../../core/sanitize.js";
import { prepareClaudeCliLaunch, runClaudeCli } from "../../targets/claude-runner.js";
import { createManualCallbackStdioProtocol, writeJsonLine } from "../manual-callback-stdio.js";

const CLAUDE_LOGIN_STAGING_DIRNAME = ".login-staging";
const CLAUDE_LOGIN_LEASE_RENEW_INTERVAL_MS = 10_000;

function currentAnthropicRecord(snapshot, label) {
  return (snapshot?.credentials ?? []).find(
    (record) => record.provider === ANTHROPIC_PROVIDER && record.label === label,
  ) ?? null;
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
  if (await renewOrReacquireRedisCredentialLease(lease) !== true) {
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
  let renewalTimer = null;
  let renewalInFlight = null;
  let leaseLost = false;
  let stopped = false;
  const scheduleRenewal = () => {
    if (stopped || leaseLost) return;
    renewalTimer = setTimeout(() => {
      renewalTimer = null;
      renewalInFlight = Promise.resolve(renewOrReacquireRedisCredentialLease(lease))
        .then((renewed) => {
          if (renewed !== true) leaseLost = true;
        }, () => {})
        .finally(() => {
          renewalInFlight = null;
          scheduleRenewal();
        });
    }, CLAUDE_LOGIN_LEASE_RENEW_INTERVAL_MS);
    renewalTimer.unref?.();
  };
  scheduleRenewal();
  let result;
  let failure = null;
  try {
    result = await operation(lease);
  } catch (error) {
    failure = error;
  }
  stopped = true;
  if (renewalTimer) clearTimeout(renewalTimer);
  if (renewalInFlight) await renewalInFlight;
  if (!failure && leaseLost) {
    failure = new Error(`Claude credential lease was lost ${phase}.`);
  }
  const released = await lease.release().catch(() => false);
  if (failure) throw failure;
  if (!released) {
    throw new Error(`Claude credential lease was lost ${phase}.`);
  }
  return result;
}

async function publishClaudeLoginBundle({
  store,
  snapshot,
  state,
  label,
  nativeClaudeBundle,
  observedAt,
}) {
  const current = state?.credentials?.[ANTHROPIC_PROVIDER]?.[label];
  if (current && !hasCompleteClaudeNativeBundle(current)) {
    state.credentials[ANTHROPIC_PROVIDER][label] = {};
  }
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
  });
  if (!published.ok) {
    throw new Error(
      `Redis publish failed for label=${label}: ${published.credential?.code ?? "unknown"}`,
    );
  }
  return published.credential.record;
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
  return await withClaudeLoginLease({
    store,
    label,
    phase: "during browser login",
  }, async (lease) => {
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before browser login",
    });
    removeClaudeLoginStaging({ homeDir, label, stagingHome });
    ensureSafeManagedClaudeStorage({ descriptor });

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
    const staged = readManagedClaudeNativeBundleFromFiles({ descriptor });
    if (launchError) {
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      throw launchError;
    }
    if (launched?.status !== 0 || launched?.signal) {
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      throw new Error(`Claude login for label=${label} was cancelled or failed.`);
    }
    if (staged.ok !== true) {
      const stagedIdentity = readClaudeNativeOauthAccountAtPath({
        appStatePath: descriptor.appStatePath,
        expectedEmail: descriptor.expectedEmail,
      });
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
      if (stagedIdentity.errorKind === "identity_mismatch") {
        throw new Error(`Claude login for label=${label} failed identity_mismatch validation.`);
      }
      throw new Error(`Claude login for label=${label} did not produce a complete file-backed credential.`);
    }
    await assertClaudeLoginLeaseOwned({
      lease,
      phase: "before reconciling browser login",
    });
    const completionSnapshot = await readSnapshot(store);
    const completionState = buildCoordinationView(completionSnapshot, {
      localState,
      provider: ANTHROPIC_PROVIDER,
    });
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
        observedAt: new Date().toISOString(),
      });
    } finally {
      removeClaudeLoginStaging({ homeDir, label, stagingHome });
    }
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

async function performRedisXaiLogin(context, { store, snapshot, state, localState, label, writeImpl }) {
  const {
    homeDir,
    promptLineImpl,
    openUrlImpl,
    fetchImpl,
    nowMs,
  } = context;
  const existing = state.accounts[label];
  const expectedEmail = String(
    existing?.expect?.email
    || await promptLineImpl(`Expected SuperGrok email for "${label}":`),
  ).trim().toLowerCase();
  if (!expectedEmail) {
    throw new Error(`xAI label=${label} requires an expected email before login.`);
  }
  if (!isObject(existing) || !existing.provider) {
    state.accounts[label] = {
      ...(isObject(existing) ? existing : {}),
      provider: XAI_PROVIDER,
      expect: {
        ...(existing?.expect ?? {}),
        email: expectedEmail,
      },
      pool: existing?.pool ?? { enabled: true },
    };
  } else {
    state.accounts[label] = {
      ...existing,
      expect: {
        ...(existing.expect ?? {}),
        email: expectedEmail,
      },
    };
  }
  const credential = await loginXaiDevice({
    expectedEmail,
    fetchImpl: fetchImpl ?? globalThis.fetch.bind(globalThis),
    openUrlImpl,
    writeImpl,
  });
  storeXaiLoginCredential({ state, label, credential });
  const published = await publishMaintainedCredential({
    store,
    snapshot,
    state,
    label,
    provider: XAI_PROVIDER,
    observedAt: new Date(nowMs).toISOString(),
  });
  if (!published.ok) {
    throw new Error(`Redis publish failed for label=${label}: ${published.credential?.code ?? "unknown"}`);
  }
  writeRedisLocalStateFromView({ homeDir, state, localState });
  return {
    ok: true,
    label,
    provider: XAI_PROVIDER,
    maintenance: {
      action: "xai-login",
      observedAt: published.credential.record.updatedAt,
    },
    redis: { credentialVersion: published.credential.record.version },
  };
}

async function performRedisLabelMaintenance(context, { label, manualCallbackAutomation = null, writeImpl }) {
  const {
    homeDir,
    promptLineImpl,
    promptImpl,
    openUrlImpl,
    loginOpenAICodexImpl,
    refreshOpenAICodexImpl,
    nowMs,
  } = context;
  if (!isRedisConfigured({ homeDir })) return null;

  // Login holds a credential lease across an interactive browser round-trip, so
  // it needs the leased connection policy. The one-shot policy sets
  // socketTimeout with reconnectStrategy:false, which closes the socket after a
  // few seconds of idle and never reconnects — the lease renewal then throws
  // "Redis credential lease recovery failed" and the grant is never published.
  const runtime = await loadRedisRuntime({
    homeDir,
    connectRedisStoreImpl: context.connectRedisStoreImpl,
    now: new Date(nowMs),
    connectionPolicy: REDIS_CONNECTION_POLICY_LEASED,
  });
  try {
    const { store, snapshot, localState } = runtime;
    const normalizedLabel = normalizeLabel(label);
    const requestedProvider = resolveSupportedProviderFromInput(context.opts?.provider);
    if (requestedProvider === XAI_PROVIDER) {
      if (manualCallbackAutomation) {
        throw new Error("xAI login does not use the Codex manual-callback JSONL protocol.");
      }
      return await performRedisXaiLogin(context, {
        store,
        snapshot,
        state: runtime.state,
        localState,
        label: normalizedLabel,
        writeImpl,
      });
    }
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
    const state = runtime.state;
    const provider = await ensureProviderConfiguredForLabel({
      state,
      label: normalizedLabel,
      explicitProvider: context.opts?.provider,
      promptLineImpl,
      writeImpl,
    });
    if (provider === XAI_PROVIDER) {
      if (manualCallbackAutomation) {
        throw new Error("xAI login does not use the Codex manual-callback JSONL protocol.");
      }
      return await performRedisXaiLogin(context, {
        store,
        snapshot,
        state,
        localState,
        label: normalizedLabel,
        writeImpl,
      });
    }
    if (provider === ANTHROPIC_PROVIDER) {
      if (manualCallbackAutomation) {
        throw new Error("Anthropic login does not use the Codex manual-callback JSONL protocol.");
      }
      const expectedEmail = String(
        await promptLineImpl(`Expected Claude email for "${normalizedLabel}":`),
      ).trim().toLowerCase();
      if (!expectedEmail) {
        throw new Error(`Claude label=${normalizedLabel} requires an expected email before login.`);
      }
      const account = state.accounts[normalizedLabel];
      state.accounts[normalizedLabel] = {
        ...account,
        expect: {
          ...(account?.expect ?? {}),
          email: expectedEmail,
        },
      };
      await publishRedisCredentialPolicyFromState({
        runtime,
        state,
        label: normalizedLabel,
        observedAt: new Date(nowMs).toISOString(),
      });
      const anthropicState = buildCoordinationView(runtime.snapshot, {
        localState,
        provider: ANTHROPIC_PROVIDER,
      });
      return await performRedisClaudeLogin(context, {
        store,
        state: anthropicState,
        localState,
        label: normalizedLabel,
      });
    }
    const result = await performLabelMaintenance({
      state,
      label: normalizedLabel,
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
      label: normalizedLabel,
      provider: result.provider,
      observedAt: result.maintenance?.observedAt ?? new Date(nowMs).toISOString(),
    });
    if (!published.ok) {
      throw new Error(`Redis publish failed for label=${normalizedLabel}: ${published.credential?.code ?? "unknown"}`);
    }
    writeRedisLocalStateFromView({ homeDir, state, localState: loadLocalState({ homeDir }) });
    return {
      ...result,
      redis: {
        credentialVersion: published.credential.record.version,
      },
    };
  } finally {
    await closeRedisRuntime(runtime);
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
