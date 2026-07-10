import crypto from "node:crypto";
import path from "node:path";
import { resolveCodexWatchThresholdPct } from "../core/watch-options.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { resolveManagedCodexHomeDir } from "../io/paths.js";
import { sleep } from "../io/streams.js";
import { watchCodexPoolSelectionOnce } from "../pool/watch.js";
import { probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { loadAimgrState } from "../state/schema.js";
import { activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel } from "./codex-cli.js";
import { createCodexForegroundRelaySession } from "./codex-foreground-relay.js";
import { createCodexPtySession, hasActiveGoalPane, hasResumeGoalPrompt } from "./codex-pty.js";
import { isCodexSessionId, resolveOwnedThreadFromRunTag, resolveRolloutForThreadId, tailGoalStatus } from "./codex-rollout.js";
import { acquireCodexTendThreadLock } from "./codex-tend-lock.js";

const STOPPED_FOR_ROTATION_STATUSES = new Set(["usageLimited"]);

function parseNonNegativeInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (parsed === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }
  return Math.floor(parsed);
}

function parseNonNegativeNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got ${value}.`);
  }
  return parsed;
}

function parsePositiveNumber(value, fallback, name) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive finite number; got ${value}.`);
  }
  return parsed;
}

function normalizeCodexProfileValue(value) {
  const profile = String(value ?? "").trim();
  if (!profile) {
    throw new Error("Codex profile requires a non-empty value.");
  }
  return profile;
}

function extractCodexProfile({ codexProfile, codexArgs }) {
  const args = Array.isArray(codexArgs) ? codexArgs : [];
  const cleanedArgs = [];
  let effectiveProfile = codexProfile === undefined || codexProfile === null || codexProfile === ""
    ? null
    : normalizeCodexProfileValue(codexProfile);
  let effectiveProfileSource = effectiveProfile ? "AIMGR options" : null;

  const acceptProfile = (value, source) => {
    const profile = normalizeCodexProfileValue(value);
    if (effectiveProfile && effectiveProfile !== profile) {
      throw new Error(
        `Conflicting Codex profiles: ${effectiveProfile} from ${effectiveProfileSource} and ${profile} from ${source}.`,
      );
    }
    effectiveProfile = profile;
    effectiveProfileSource = source;
  };

  for (let i = 0; i < args.length; i += 1) {
    const arg = String(args[i] ?? "");
    if (arg === "--") {
      cleanedArgs.push(...args.slice(i));
      break;
    }
    if (arg === "-p" || arg === "--profile") {
      if (i + 1 >= args.length) {
        throw new Error(`Codex profile option ${arg} requires a value.`);
      }
      acceptProfile(args[i + 1], arg);
      i += 1;
      continue;
    }
    if (arg.startsWith("--profile=")) {
      acceptProfile(arg.slice("--profile=".length), "--profile");
      continue;
    }
    if (arg.startsWith("-p") && arg.length > 2) {
      acceptProfile(arg.slice(2), "-p");
      continue;
    }
    cleanedArgs.push(args[i]);
  }

  return { codexArgs: cleanedArgs, codexProfile: effectiveProfile };
}

function normalizeCodexSessionId(value, source) {
  const sessionId = String(value ?? "").trim();
  if (!sessionId) {
    throw new Error(`Codex session id from ${source} requires a UUID copied from "codex resume <SESSION_ID>".`);
  }
  if (!isCodexSessionId(sessionId)) {
    throw new Error(
      `Codex session id from ${source} must be a UUID copied from "codex resume <SESSION_ID>"; got ${sessionId}.`,
    );
  }
  return sessionId;
}

function assertNoUserOwnedRemoteArgs(codexArgs) {
  const args = Array.isArray(codexArgs) ? codexArgs : [];
  for (const arg of args) {
    const raw = String(arg ?? "");
    if (raw === "--remote" || raw.startsWith("--remote=")) {
      throw new Error("Codex --remote is incompatible with the PTY/rollout Tend runtime.");
    }
    if (raw === "--remote-auth-token-env" || raw.startsWith("--remote-auth-token-env=")) {
      throw new Error("Codex --remote-auth-token-env is incompatible with the PTY/rollout Tend runtime.");
    }
  }
}

function normalizeCodexInvocation({ codexProfile, codexArgs, resumeSessionId }) {
  const normalized = extractCodexProfile({ codexProfile, codexArgs });
  assertNoUserOwnedRemoteArgs(normalized.codexArgs);
  let effectiveResumeSessionId =
    resumeSessionId === undefined || resumeSessionId === null || resumeSessionId === ""
      ? null
      : normalizeCodexSessionId(resumeSessionId, "AIMGR options");

  if (normalized.codexArgs[0] === "resume") {
    if (normalized.codexArgs.length < 2) {
      throw new Error("Codex resume passthrough requires a UUID: aim codex run --tend -- resume <SESSION_ID>.");
    }
    const passThroughSessionId = normalizeCodexSessionId(normalized.codexArgs[1], "Codex resume passthrough");
    if (effectiveResumeSessionId && effectiveResumeSessionId !== passThroughSessionId) {
      throw new Error(
        `Conflicting Codex session ids: ${effectiveResumeSessionId} from AIMGR options and ${passThroughSessionId} from Codex resume passthrough.`,
      );
    }
    if (normalized.codexArgs.length > 2) {
      throw new Error(
        "Codex resume passthrough only supports `resume <SESSION_ID>` for tended sessions; pass AIMGR options before `--`.",
      );
    }
    effectiveResumeSessionId = passThroughSessionId;
    normalized.codexArgs = [];
  }

  if (effectiveResumeSessionId && normalized.codexArgs.length > 0) {
    throw new Error(
      "Codex pass-through args are not supported with tended resume sessions; pass AIMGR options such as `-p yolo` before `--`.",
    );
  }

  return { ...normalized, resumeSessionId: effectiveResumeSessionId };
}

function buildCodexArgv({ codexBin, mode, threadId, codexArgs, codexProfile }) {
  const argv = [codexBin, "--no-alt-screen"];
  if (codexProfile) argv.push("-p", codexProfile);
  if (mode === "resume") {
    argv.push("resume", threadId);
  } else {
    argv.push(...codexArgs);
  }
  return argv;
}

function createRunId() {
  return `${process.pid}-${crypto.randomBytes(4).toString("hex")}`;
}

function getRotationBlockedReason(rotation) {
  return rotation?.activated?.receipt?.blockers?.[0]?.reason || "rotation_blocked";
}

function resolveSessionStartErrorReason({ attach, readyReason }) {
  if (readyReason === "python3_unavailable") return "python3_unavailable";
  if (attach && readyReason === "not_tty") return "foreground_relay_not_tty";
  return attach ? "foreground_relay_failed" : "pty_helper_failed";
}

async function rotateCodexAccount({
  statePath,
  stateRuntime,
  homeDir,
  env,
  observedAt,
  probeUsageSnapshotsByProviderImpl,
  activateCodexPoolSelectionImpl,
  avoidCurrentLabel = false,
}) {
  const mutate = stateRuntime?.withMutableState
    ? stateRuntime.withMutableState.bind(stateRuntime)
    : async (fn) => {
        const state = loadAimgrState(statePath);
        const result = await fn(state, { publishCodexPreserveResult: async () => null });
        writeJsonFileWithBackup(statePath, state);
        return result;
      };
  return mutate(async (state, helpers = {}) => {
    const preserved = preserveLiveCodexAuthForActiveLabel({ state, homeDir, env, observedAt });
    await helpers.publishCodexPreserveResult?.(preserved);
    const activated = await activateCodexPoolSelectionImpl({
      state,
      homeDir,
      env,
      observedAt,
      probeUsageSnapshotsByProviderImpl,
      avoidCurrentLabel,
    });
    return { activated, preserved };
  });
}

async function runPreflight({
  statePath,
  stateRuntime,
  homeDir,
  env,
  thresholdPct,
  probeUsageSnapshotsByProviderImpl,
  activateCodexPoolSelectionImpl,
}) {
  const mutate = stateRuntime?.withMutableState
    ? stateRuntime.withMutableState.bind(stateRuntime)
    : async (fn) => {
        const state = loadAimgrState(statePath);
        const result = await fn(state, { publishCodexPreserveResult: async () => null });
        writeJsonFileWithBackup(statePath, state);
        return result;
      };
  return mutate(async (state, helpers = {}) => {
    const preflightPreserve = preserveLiveCodexAuthForActiveLabel({
      state,
      homeDir,
      env,
      observedAt: new Date().toISOString(),
    });
    await helpers.publishCodexPreserveResult?.(preflightPreserve);
    const preflightResult = await watchCodexPoolSelectionOnce(
      {
        state,
        homeDir,
        env,
        thresholdPct: resolveCodexWatchThresholdPct(thresholdPct),
      },
      {
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
      },
    );
    return { preflightPreserve, preflightResult };
  });
}

async function waitForResumePrompt({ session, sleepImpl, pollMs, timeoutMs, events }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await Promise.resolve(session.snapshotOutput());
    if (hasResumeGoalPrompt(output)) {
      session.sendEnter();
      events.push({ type: "resume_prompt_confirmed" });
      return true;
    }
    if (hasActiveGoalPane(output)) {
      events.push({ type: "resume_prompt_already_active" });
      return true;
    }
    const exitInfo = await session.waitForExit({ timeoutMs: 0 });
    if (exitInfo) {
      events.push({ type: "resume_prompt_missing", reason: "session_ended" });
      return false;
    }
    await sleepImpl(pollMs);
  }
  events.push({ type: "resume_prompt_timeout" });
  return false;
}

async function waitForGoalStatus({ rolloutPath, threadId, status, sleepImpl, pollMs, timeoutMs, events, tailGoalStatusImpl }) {
  const deadline = Date.now() + timeoutMs;
  let offset = 0;
  while (Date.now() < deadline) {
    const next = await Promise.resolve(tailGoalStatusImpl({ rolloutPath, threadId, offset }));
    offset = next.offset;
    if (next.status === status) {
      events.push({ type: "goal_status_observed", status });
      return true;
    }
    await sleepImpl(pollMs);
  }
  events.push({ type: "goal_status_timeout", status });
  return false;
}

async function waitForResumeRollout({
  sessionsDir,
  threadId,
  bindTimeoutMs,
  sleepImpl,
  pollMs,
  resolveRolloutForThreadIdImpl,
}) {
  const deadline = Date.now() + bindTimeoutMs;
  while (Date.now() < deadline) {
    const resolved = resolveRolloutForThreadIdImpl({ sessionsDir, threadId });
    if (resolved.status === "found") return resolved;
    await sleepImpl(pollMs);
  }
  return { status: "missing", threadId };
}

export async function runCodexTender(
  {
    statePath,
    stateRuntime = null,
    homeDir,
    env = {},
    cwd = process.cwd(),
    codexBin = "codex",
    codexProfile,
    resumeSessionId,
    codexArgs = [],
    attach = true,
    preflight = true,
    thresholdPct,
    pollSeconds = 5,
    promptTimeoutSeconds = 60,
    exitTimeoutSeconds = 15,
    bindTimeoutSeconds = 120,
    maxRestarts = Number.POSITIVE_INFINITY,
    maxPollIterations = Number.POSITIVE_INFINITY,
    startedAtMs = Date.now(),
  },
  {
    createPtySessionImpl = createCodexPtySession,
    createForegroundSessionImpl = createCodexForegroundRelaySession,
    sleepImpl = sleep,
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
    acquireThreadLockImpl = acquireCodexTendThreadLock,
    resolveOwnedThreadFromRunTagImpl = resolveOwnedThreadFromRunTag,
    resolveRolloutForThreadIdImpl = resolveRolloutForThreadId,
    tailGoalStatusImpl = tailGoalStatus,
  } = {},
) {
  const effectivePollMs = parseNonNegativeNumber(pollSeconds, 5) * 1000;
  const promptTimeoutMs = parseNonNegativeNumber(promptTimeoutSeconds, 60) * 1000;
  const exitTimeoutMs = parseNonNegativeNumber(exitTimeoutSeconds, 15) * 1000;
  const bindTimeoutMs = parsePositiveNumber(bindTimeoutSeconds, 120, "bindTimeoutSeconds") * 1000;
  const effectiveMaxRestarts = parseNonNegativeInteger(maxRestarts, Number.POSITIVE_INFINITY);
  const effectiveMaxPollIterations = parseNonNegativeInteger(maxPollIterations, Number.POSITIVE_INFINITY);
  const normalizedCodexArgs = normalizeCodexInvocation({ codexProfile, codexArgs, resumeSessionId });
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  const sessionsDir = path.join(codexHome, "sessions");
  const events = [];
  const rotations = [];
  const runid = createRunId();
  const originator = `aimgr-tend-${runid}`;
  let preflightResult = null;
  let threadId = normalizedCodexArgs.resumeSessionId;
  let rolloutPath = null;
  let lock = null;
  let session = null;
  let restarts = 0;
  let goalIntentObservedAt = threadId ? startedAtMs : null;
  let goalOffset = 0;

  const finish = async (result) => {
    try {
      session?.dispose?.();
    } finally {
      lock?.release?.();
    }
    return {
      runid,
      originator,
      threadId,
      rolloutPath,
      attached: Boolean(attach),
      restarts,
      preflight: preflightResult,
      rotations,
      events,
      ...result,
    };
  };

  const onGoalIntent = () => {
    if (goalIntentObservedAt !== null) return;
    goalIntentObservedAt = Date.now();
    events.push({ type: "goal_intent_observed" });
  };

  const startSession = async (mode) => {
    const childEnv = {
      ...env,
      ...(mode === "start" ? { CODEX_INTERNAL_ORIGINATOR_OVERRIDE: originator } : {}),
    };
    const argv = buildCodexArgv({
      codexBin,
      mode,
      threadId,
      codexProfile: normalizedCodexArgs.codexProfile,
      codexArgs: normalizedCodexArgs.codexArgs,
    });
    const createSessionImpl = attach ? createForegroundSessionImpl : createPtySessionImpl;
    session = createSessionImpl({
      attach,
      env,
      onGoalIntent,
      pythonBin: env.AIMGR_PYTHON_BIN || "python3",
    });
    session.on?.("helper_error", (message) => {
      events.push({
        type: "pty_helper_error",
        reason: message?.reason ?? "helper_error",
        message: String(message?.message ?? message?.error?.message ?? message ?? ""),
      });
    });
    try {
      await Promise.resolve(session.start({ argv, cwd, env: childEnv }));
    } catch (err) {
      const reason = attach ? "foreground_relay_start_failed" : "pty_start_failed";
      events.push({ type: reason, reason, message: String(err?.message ?? err) });
      return { status: "blocked", reason };
    }
    if (session.waitForReady) {
      const ready = await session.waitForReady({ timeoutMs: 5_000 });
      if (!ready) {
        const reason = attach ? "foreground_relay_start_timeout" : "pty_start_timeout";
        events.push({ type: reason });
        return { status: "blocked", reason };
      }
      if (ready.status === "error") {
        const reason = resolveSessionStartErrorReason({ attach, readyReason: ready.reason });
        events.push({ type: attach ? "foreground_relay_start_failed" : "pty_start_failed", reason: ready.reason ?? reason });
        return { status: "blocked", reason };
      }
    }
    events.push({ type: "session_started", mode, argv, threadId });
    return { status: "started" };
  };

  if (preflight) {
    const preflightState = await runPreflight({
      statePath,
      stateRuntime,
      homeDir,
      env,
      thresholdPct,
      probeUsageSnapshotsByProviderImpl,
      activateCodexPoolSelectionImpl,
    });
    preflightResult = preflightState.preflightResult;
    events.push({ type: "preflight_preserve_live_auth", status: preflightState.preflightPreserve.status });
    events.push({ type: "preflight_watch", status: preflightResult.status });
    if (preflightResult.status === "blocked") {
      return finish({ status: "blocked", reason: "preflight_watch_blocked" });
    }
  }

  if (threadId) {
    const lockResult = acquireThreadLockImpl({ homeDir, threadId, runid, originator, cwd, mode: "resume" });
    if (lockResult.status === "blocked") {
      events.push({ type: "thread_lock_blocked", threadId, existing: lockResult.existing });
      return finish({ status: "blocked", reason: "thread_already_tended" });
    }
    lock = lockResult;
    events.push({ type: "thread_lock_acquired", threadId });
    const resolved = await waitForResumeRollout({
      sessionsDir,
      threadId,
      bindTimeoutMs,
      sleepImpl,
      pollMs: Math.min(effectivePollMs, 1_000),
      resolveRolloutForThreadIdImpl,
    });
    if (resolved.status !== "found") {
      return finish({ status: "blocked", reason: "resume_rollout_not_found" });
    }
    rolloutPath = resolved.rolloutPath;
  }

  const firstStart = await startSession(threadId ? "resume" : "start");
  if (firstStart.status !== "started") {
    return finish(firstStart);
  }
  if (threadId) {
    const promptConfirmed = await waitForResumePrompt({
      session,
      sleepImpl,
      pollMs: Math.min(effectivePollMs, 1_000),
      timeoutMs: promptTimeoutMs,
      events,
    });
    if (!promptConfirmed) {
      return finish({ status: "blocked", reason: "resume_prompt_unconfirmed" });
    }
  }

  for (let pollIteration = 0; pollIteration < effectiveMaxPollIterations; pollIteration += 1) {
    if (!threadId) {
      const binding = await Promise.resolve(
        resolveOwnedThreadFromRunTagImpl({ sessionsDir, originator, startedAtMs }),
      );
      if (binding.status === "ambiguous") {
        events.push({ type: "thread_binding_ambiguous", candidates: binding.candidates });
        return finish({
          status: "blocked",
          reason: "ambiguous_tagged_goal_rollouts",
        });
      }
      if (binding.status === "bound") {
        threadId = binding.threadId;
        rolloutPath = binding.rolloutPath;
        const lockResult = acquireThreadLockImpl({ homeDir, threadId, runid, originator, cwd, mode: "start" });
        if (lockResult.status === "blocked") {
          events.push({ type: "thread_lock_blocked", threadId, existing: lockResult.existing });
          return finish({ status: "blocked", reason: "thread_already_tended" });
        }
        lock = lockResult;
        events.push({ type: "thread_bound", threadId, rolloutPath });
      } else if (goalIntentObservedAt !== null && Date.now() - goalIntentObservedAt > bindTimeoutMs) {
        return finish({ status: "blocked", reason: "goal_bind_timeout" });
      } else {
        events.push({ type: "waiting_for_goal" });
      }
    }

    let goalStatus = null;
    if (rolloutPath && threadId) {
      const goal = await Promise.resolve(tailGoalStatusImpl({ rolloutPath, threadId, offset: goalOffset }));
      goalOffset = goal.offset ?? goalOffset;
      goalStatus = goal.status ?? null;
      if (!goalStatus && goalIntentObservedAt !== null && Date.now() - goalIntentObservedAt > bindTimeoutMs) {
        return finish({ status: "blocked", reason: "goal_bind_timeout" });
      }
    }

    const exitInfo = await session.waitForExit({ timeoutMs: 0 });
    if (exitInfo && !STOPPED_FOR_ROTATION_STATUSES.has(goalStatus)) {
      events.push({ type: "session_ended", goalStatus, exitInfo });
      return finish({ status: threadId ? "ended" : "ended_without_thread" });
    }

    if (STOPPED_FOR_ROTATION_STATUSES.has(goalStatus)) {
      events.push({ type: "recovery_triggered", source: "goal", reason: "goal_usage_limited", goalStatus });
      if (restarts >= effectiveMaxRestarts) {
        events.push({ type: "max_restarts_reached", goalStatus });
        return finish({ status: "max_restarts_reached" });
      }
      const rotation = await rotateCodexAccount({
        statePath,
        stateRuntime,
        homeDir,
        env,
        observedAt: new Date().toISOString(),
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
        avoidCurrentLabel: true,
      });
      rotations.push(rotation);
      events.push({ type: "rotation", status: rotation.activated.status, preserveStatus: rotation.preserved.status });
      if (rotation.activated.status === "blocked") {
        return finish({ status: "blocked", reason: getRotationBlockedReason(rotation) });
      }

      session.sendExit();
      events.push({ type: "session_exit_requested", goalStatus });
      const exited = await session.waitForExit({ timeoutMs: exitTimeoutMs });
      if (!exited) {
        session.terminate();
        events.push({ type: "session_terminated_after_exit_timeout", goalStatus });
      }
      session.dispose();

      restarts += 1;
      const restart = await startSession("resume");
      if (restart.status !== "started") {
        return finish(restart);
      }
      const promptConfirmed = await waitForResumePrompt({
        session,
        sleepImpl,
        pollMs: Math.min(effectivePollMs, 1_000),
        timeoutMs: promptTimeoutMs,
        events,
      });
      if (!promptConfirmed) {
        return finish({ status: "blocked", reason: "resume_prompt_unconfirmed" });
      }
      const active = await waitForGoalStatus({
        rolloutPath,
        threadId,
        status: "active",
        sleepImpl,
        pollMs: Math.min(effectivePollMs, 1_000),
        timeoutMs: promptTimeoutMs,
        events,
        tailGoalStatusImpl,
      });
      if (!active) {
        return finish({ status: "blocked", reason: "resume_goal_not_active" });
      }
    }

    await sleepImpl(effectivePollMs);
  }

  events.push({ type: "poll_limit_reached" });
  return finish({ status: "poll_limit_reached" });
}
