import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { resolveCodexWatchThresholdPct } from "../core/watch-options.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { resolveManagedCodexHomeDir } from "../io/paths.js";
import { sleep } from "../io/streams.js";
import { isUsageSnapshotHardRateLimited } from "../pool/account-status.js";
import { getCodexUsagePercents, probeUsageSnapshotsByProvider } from "../pool/usage.js";
import { watchCodexPoolSelectionOnce } from "../pool/watch.js";
import { loadAimgrState } from "../state/schema.js";
import { activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel, readCodexCliTargetStatus } from "./codex-cli.js";
import { getCodexThreadGoal, listCodexThreads } from "./codex-app-server.js";

const STOPPED_FOR_ROTATION_STATUSES = new Set(["usageLimited"]);
const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const RATE_LIMIT_USAGE_CHECK_MS = 15_000;
const PANE_RATE_LIMIT_PATTERNS = [
  /Usage limit reached/i,
  /You've hit your usage limit/i,
  /Rate limit reached/i,
  /Too many requests/i,
  /exceeded retry limit, last status:\s*429/i,
  /rate_limit_exceeded/i,
];

function parsePositiveInteger(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  const parsed = Number(value);
  if (parsed === Number.POSITIVE_INFINITY) return Number.POSITIVE_INFINITY;
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative integer, got ${value}.`);
  }
  return Math.floor(parsed);
}

function parsePositiveNumber(value, fallback) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Expected a non-negative number, got ${value}.`);
  }
  return parsed;
}

function shellQuote(value) {
  const raw = String(value ?? "");
  if (/^[A-Za-z0-9_/:=.,@%+-]+$/.test(raw)) return raw;
  return `'${raw.replaceAll("'", "'\\''")}'`;
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
  if (!CODEX_SESSION_ID_PATTERN.test(sessionId)) {
    throw new Error(
      `Codex session id from ${source} must be a UUID copied from "codex resume <SESSION_ID>"; got ${sessionId}.`,
    );
  }
  return sessionId;
}

function normalizeCodexInvocation({ codexProfile, codexArgs, resumeSessionId }) {
  const normalized = extractCodexProfile({ codexProfile, codexArgs });
  let effectiveResumeSessionId =
    resumeSessionId === undefined || resumeSessionId === null || resumeSessionId === ""
      ? null
      : normalizeCodexSessionId(resumeSessionId, "AIMGR options");

  if (normalized.codexArgs[0] === "resume") {
    if (normalized.codexArgs.length < 2) {
      throw new Error('Codex resume passthrough requires a UUID: aim codex run --tend -- resume <SESSION_ID>.');
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

function buildCodexCommand({ codexBin, mode, threadId, codexArgs, codexProfile }) {
  const args = [codexBin, "--no-alt-screen"];
  if (codexProfile) {
    args.push("-p", codexProfile);
  }
  if (mode === "resume") {
    args.push("resume", threadId);
  } else {
    args.push(...codexArgs);
  }
  return args.map(shellQuote).join(" ");
}

function tmuxError(result, action) {
  const stderr = String(result?.stderr ?? "").trim();
  const detail = stderr ? `: ${stderr}` : "";
  return new Error(`tmux ${action} failed with exit ${result?.status ?? 1}${detail}`);
}

export function buildCodexTenderSessionName(nowMs = Date.now()) {
  return `aimgr-codex-tend-${Math.floor(Number(nowMs) || Date.now())}`;
}

export function createTmuxAdapter({ tmuxBin = "tmux", spawnImpl = spawn, spawnSyncImpl = spawnSync } = {}) {
  const run = (args, action, options = {}) => {
    const result = spawnSyncImpl(tmuxBin, args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      ...options,
    });
    if (result.error) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw tmuxError(result, action);
    }
    return String(result.stdout ?? "");
  };

  return {
    newSession({ sessionName, cwd, command }) {
      run(["new-session", "-d", "-s", sessionName, "-c", cwd, command], "new-session");
    },
    hasSession(sessionName) {
      const result = spawnSyncImpl(tmuxBin, ["has-session", "-t", sessionName], {
        encoding: "utf8",
        stdio: ["ignore", "ignore", "ignore"],
      });
      return result.status === 0;
    },
    capturePane(sessionName) {
      return run(["capture-pane", "-pt", sessionName, "-S", "-240"], "capture-pane");
    },
    sendEnter(sessionName) {
      run(["send-keys", "-t", sessionName, "Enter"], "send-keys Enter");
    },
    sendExit(sessionName) {
      run(["send-keys", "-t", sessionName, "/exit", "Enter", "Enter"], "send-keys /exit");
    },
    killSession(sessionName) {
      run(["kill-session", "-t", sessionName], "kill-session");
    },
    attach(sessionName) {
      return spawnImpl(tmuxBin, ["attach-session", "-t", sessionName], { stdio: "inherit" });
    },
  };
}

async function waitForSessionGone({ tmux, sessionName, sleepImpl, pollMs, maxWaitMs }) {
  const deadline = Date.now() + maxWaitMs;
  while (tmux.hasSession(sessionName) && Date.now() < deadline) {
    await sleepImpl(pollMs);
  }
  return !tmux.hasSession(sessionName);
}

function threadTimestampMatches(thread, { cwd, startedAtSeconds }) {
  if (thread?.cwd && path.resolve(thread.cwd) !== path.resolve(cwd)) {
    return false;
  }
  const createdAt = Number(thread?.createdAt ?? thread?.created_at ?? 0);
  if (Number.isFinite(createdAt) && createdAt > 0 && createdAt < startedAtSeconds - 5) {
    return false;
  }
  return true;
}

async function discoverThreadId({
  appServerClient,
  codexBin,
  codexHome,
  env,
  cwd,
  startedAtSeconds,
  events,
}) {
  try {
    const threads = await appServerClient.listThreads({ codexBin, codexHome, env, limit: 20 });
    const candidates = threads
      .filter((thread) => threadTimestampMatches(thread, { cwd, startedAtSeconds }))
      .sort((a, b) => Number(b.updatedAt ?? b.updated_at ?? 0) - Number(a.updatedAt ?? a.updated_at ?? 0));
    const thread = candidates[0] ?? null;
    return thread?.id ?? thread?.sessionId ?? thread?.session_id ?? null;
  } catch (err) {
    events.push({
      type: "thread_list_failed",
      error: String(err?.message ?? err),
    });
    return null;
  }
}

async function readGoal({ appServerClient, codexBin, codexHome, env, threadId, events }) {
  if (!threadId) return null;
  try {
    return await appServerClient.getThreadGoal({ codexBin, codexHome, env, threadId });
  } catch (err) {
    events.push({
      type: "goal_read_failed",
      threadId,
      error: String(err?.message ?? err),
    });
    return null;
  }
}

async function confirmResumePrompt({
  tmux,
  sessionName,
  sleepImpl,
  pollMs,
  timeoutMs,
  events,
}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!tmux.hasSession(sessionName)) {
      events.push({ type: "resume_prompt_missing", reason: "session_ended" });
      return false;
    }
    const pane = tmux.capturePane(sessionName);
    if (hasResumeGoalPrompt(pane)) {
      tmux.sendEnter(sessionName);
      events.push({ type: "resume_prompt_confirmed" });
      return true;
    }
    if (hasActiveGoalPane(pane)) {
      events.push({ type: "resume_prompt_already_active" });
      return true;
    }
    await sleepImpl(pollMs);
  }
  events.push({ type: "resume_prompt_timeout" });
  return false;
}

function hasResumeGoalPrompt(pane) {
  return /Resume paused goal\?/i.test(String(pane ?? "")) && /Resume goal/i.test(String(pane ?? ""));
}

function hasActiveGoalPane(pane) {
  return /Goal active|Pursuing goal|Goal achieved/i.test(String(pane ?? ""));
}

function maybeConfirmResumePrompt({ tmux, sessionName, events }) {
  if (!tmux.hasSession(sessionName)) {
    events.push({ type: "resume_prompt_skipped", reason: "session_ended" });
    return false;
  }
  const pane = tmux.capturePane(sessionName);
  if (hasResumeGoalPrompt(pane)) {
    tmux.sendEnter(sessionName);
    events.push({ type: "resume_prompt_confirmed" });
    return true;
  }
  if (hasActiveGoalPane(pane)) {
    events.push({ type: "resume_prompt_already_active" });
    return true;
  }
  events.push({ type: "resume_prompt_not_present" });
  return false;
}

function findPaneRateLimitMatches(pane) {
  return String(pane ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && PANE_RATE_LIMIT_PATTERNS.some((pattern) => pattern.test(line)));
}

function capturePaneRateLimitMatchCount({ tmux, sessionName, events }) {
  try {
    return findPaneRateLimitMatches(tmux.capturePane(sessionName)).length;
  } catch (err) {
    events.push({
      type: "pane_rate_limit_scan_failed",
      error: String(err?.message ?? err),
    });
    return 0;
  }
}

function detectNewPaneRateLimit({ tmux, sessionName, seenMatchCount, events }) {
  let matches;
  try {
    matches = findPaneRateLimitMatches(tmux.capturePane(sessionName));
  } catch (err) {
    events.push({
      type: "pane_rate_limit_scan_failed",
      error: String(err?.message ?? err),
    });
    return { seenMatchCount, trigger: null };
  }
  const nextSeenMatchCount = Math.max(seenMatchCount, matches.length);
  if (matches.length <= seenMatchCount) {
    return { seenMatchCount: nextSeenMatchCount, trigger: null };
  }
  const match = matches[matches.length - 1] ?? "";
  return {
    seenMatchCount: nextSeenMatchCount,
    trigger: {
      source: "pane",
      reason: "non_goal_rate_limit",
      confirmGoalPrompt: false,
      match: match.slice(0, 240),
    },
  };
}

function buildUsageRateLimitSummary(snapshot) {
  const { primaryUsedPct, secondaryUsedPct } = getCodexUsagePercents(snapshot);
  return {
    ok: snapshot?.ok === true,
    status: snapshot?.status ?? undefined,
    allowed: snapshot?.allowed,
    limitReached: snapshot?.limitReached,
    rateLimitReachedType: snapshot?.rateLimitReachedType,
    primaryUsedPct,
    secondaryUsedPct,
  };
}

async function detectActiveCodexUsageRateLimit({
  statePath,
  homeDir,
  env,
  probeUsageSnapshotsByProviderImpl,
  events,
}) {
  let state;
  let activeLabel;
  try {
    state = loadAimgrState(statePath);
    const targetStatus = readCodexCliTargetStatus({ state, homeDir, env });
    activeLabel = targetStatus.activeLabel ?? targetStatus.inferredLabel ?? null;
  } catch (err) {
    events.push({
      type: "usage_rate_limit_scan_failed",
      error: String(err?.message ?? err),
    });
    return null;
  }

  if (!activeLabel) {
    events.push({ type: "usage_rate_limit_scan_skipped", reason: "active_label_missing" });
    return null;
  }

  try {
    const usageByProvider = await probeUsageSnapshotsByProviderImpl(state, { env });
    const snapshot = usageByProvider?.[OPENAI_CODEX_PROVIDER]?.[activeLabel] ?? null;
    if (!isUsageSnapshotHardRateLimited(snapshot)) {
      return null;
    }
    return {
      source: "usage",
      reason: "non_goal_rate_limit",
      confirmGoalPrompt: false,
      label: activeLabel,
      snapshot: buildUsageRateLimitSummary(snapshot),
    };
  } catch (err) {
    events.push({
      type: "usage_rate_limit_scan_failed",
      label: activeLabel,
      error: String(err?.message ?? err),
    });
    return null;
  }
}

function getRotationBlockedReason(rotation) {
  return rotation?.activated?.receipt?.blockers?.[0]?.reason || "rotation_blocked";
}

async function rotateCodexAccount({
  statePath,
  homeDir,
  env,
  observedAt,
  probeUsageSnapshotsByProviderImpl,
  activateCodexPoolSelectionImpl,
  avoidCurrentLabel = false,
}) {
  const state = loadAimgrState(statePath);
  const preserved = preserveLiveCodexAuthForActiveLabel({ state, homeDir, env, observedAt });
  const activated = await activateCodexPoolSelectionImpl({
    state,
    homeDir,
    env,
    observedAt,
    probeUsageSnapshotsByProviderImpl,
    selectionMode: "weighted_usage",
    avoidCurrentLabel,
  });
  writeJsonFileWithBackup(statePath, state);
  return { activated, preserved };
}

export async function runCodexTender(
  {
    statePath,
    homeDir,
    env = {},
    cwd = process.cwd(),
    codexBin = "codex",
    codexProfile,
    resumeSessionId,
    codexArgs = [],
    sessionName = buildCodexTenderSessionName(),
    attach = true,
    preflight = true,
    thresholdPct,
    pollSeconds = 5,
    promptTimeoutSeconds = 60,
    exitTimeoutSeconds = 15,
    maxRestarts = Number.POSITIVE_INFINITY,
    maxPollIterations = Number.POSITIVE_INFINITY,
    startedAtMs = Date.now(),
  },
  {
    tmux = createTmuxAdapter(),
    appServerClient = {
      listThreads: listCodexThreads,
      getThreadGoal: getCodexThreadGoal,
    },
    sleepImpl = sleep,
    probeUsageSnapshotsByProviderImpl = probeUsageSnapshotsByProvider,
    activateCodexPoolSelectionImpl = activateCodexPoolSelection,
  } = {},
) {
  const effectivePollMs = parsePositiveNumber(pollSeconds, 5) * 1000;
  const promptTimeoutMs = parsePositiveNumber(promptTimeoutSeconds, 60) * 1000;
  const exitTimeoutMs = parsePositiveNumber(exitTimeoutSeconds, 15) * 1000;
  const effectiveMaxRestarts = parsePositiveInteger(maxRestarts, Number.POSITIVE_INFINITY);
  const effectiveMaxPollIterations = parsePositiveInteger(maxPollIterations, Number.POSITIVE_INFINITY);
  const normalizedCodexArgs = normalizeCodexInvocation({ codexProfile, codexArgs, resumeSessionId });
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  const events = [];
  const rotations = [];
  const startedAtSeconds = Math.floor(Number(startedAtMs) / 1000);
  let threadId = normalizedCodexArgs.resumeSessionId;
  let preflightResult = null;
  let restarts = 0;
  let paneRateLimitMatchCount = 0;
  let pendingRateLimitRecovery = null;
  let nextUsageRateLimitCheckAtMs = 0;

  if (preflight) {
    const state = loadAimgrState(statePath);
    const preflightPreserve = preserveLiveCodexAuthForActiveLabel({
      state,
      homeDir,
      env,
      observedAt: new Date().toISOString(),
    });
    preflightResult = await watchCodexPoolSelectionOnce(
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
    writeJsonFileWithBackup(statePath, state);
    events.push({ type: "preflight_preserve_live_auth", status: preflightPreserve.status });
    events.push({ type: "preflight_watch", status: preflightResult.status });
    if (preflightResult.status === "blocked") {
      return {
        status: "blocked",
        reason: "preflight_watch_blocked",
        sessionName,
        threadId,
        restarts,
        preflight: preflightResult,
        rotations,
        events,
      };
    }
  }

  if (threadId) {
    events.push({ type: "thread_provided", threadId });
  }
  const startMode = threadId ? "resume" : "start";
  tmux.newSession({
    sessionName,
    cwd,
    command: buildCodexCommand({
      codexBin,
      mode: startMode,
      threadId,
      codexProfile: normalizedCodexArgs.codexProfile,
      codexArgs: normalizedCodexArgs.codexArgs,
    }),
  });
  events.push({ type: "session_started", mode: startMode, sessionName, threadId });
  paneRateLimitMatchCount = capturePaneRateLimitMatchCount({ tmux, sessionName, events });
  const attachProcess = attach ? tmux.attach(sessionName) : null;
  if (threadId) {
    maybeConfirmResumePrompt({ tmux, sessionName, events });
  }

  for (let pollIteration = 0; pollIteration < effectiveMaxPollIterations; pollIteration += 1) {
    const sessionAlive = tmux.hasSession(sessionName);
    if (!threadId) {
      threadId = await discoverThreadId({
        appServerClient,
        codexBin,
        codexHome,
        env,
        cwd,
        startedAtSeconds,
        events,
      });
      if (threadId) {
        events.push({ type: "thread_discovered", threadId });
      }
    }

    const goal = await readGoal({ appServerClient, codexBin, codexHome, env, threadId, events });
    const goalStatus = goal?.status ?? null;
    let recoveryTrigger = STOPPED_FOR_ROTATION_STATUSES.has(goalStatus)
      ? {
          source: "goal",
          reason: "goal_usage_limited",
          goalStatus,
          confirmGoalPrompt: true,
        }
      : null;

    if (!recoveryTrigger && pendingRateLimitRecovery && threadId) {
      recoveryTrigger = pendingRateLimitRecovery;
      pendingRateLimitRecovery = null;
    }

    if (!recoveryTrigger && sessionAlive) {
      const paneDetection = detectNewPaneRateLimit({
        tmux,
        sessionName,
        seenMatchCount: paneRateLimitMatchCount,
        events,
      });
      paneRateLimitMatchCount = paneDetection.seenMatchCount;
      recoveryTrigger = paneDetection.trigger;
    }

    if (!recoveryTrigger && Date.now() >= nextUsageRateLimitCheckAtMs) {
      const observedMs = Date.now();
      nextUsageRateLimitCheckAtMs = observedMs + RATE_LIMIT_USAGE_CHECK_MS;
      recoveryTrigger = await detectActiveCodexUsageRateLimit({
        statePath,
        homeDir,
        env,
        probeUsageSnapshotsByProviderImpl,
        events,
      });
    }

    if (recoveryTrigger && !threadId) {
      pendingRateLimitRecovery = recoveryTrigger;
      events.push({
        type: "rate_limit_recovery_waiting_for_thread",
        source: recoveryTrigger.source,
        reason: recoveryTrigger.reason,
      });
      await sleepImpl(effectivePollMs);
      continue;
    }

    if (!sessionAlive && !recoveryTrigger) {
      events.push({ type: "session_ended", goalStatus });
      return {
        status: threadId ? "ended" : "ended_without_thread",
        sessionName,
        threadId,
        restarts,
        preflight: preflightResult,
        rotations,
        events,
      };
    }

    if (recoveryTrigger) {
      events.push({
        type: "recovery_triggered",
        source: recoveryTrigger.source,
        reason: recoveryTrigger.reason,
        goalStatus: recoveryTrigger.goalStatus ?? goalStatus,
        label: recoveryTrigger.label,
        match: recoveryTrigger.match,
        snapshot: recoveryTrigger.snapshot,
      });

      if (restarts >= effectiveMaxRestarts) {
        events.push({
          type: "max_restarts_reached",
          source: recoveryTrigger.source,
          goalStatus: recoveryTrigger.goalStatus ?? goalStatus,
        });
        return {
          status: "max_restarts_reached",
          sessionName,
          threadId,
          restarts,
          preflight: preflightResult,
          rotations,
          events,
        };
      }

      const rotation = await rotateCodexAccount({
        statePath,
        homeDir,
        env,
        observedAt: new Date().toISOString(),
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
        avoidCurrentLabel: true,
      });
      rotations.push(rotation);
      events.push({
        type: "rotation",
        status: rotation.activated.status,
        preserveStatus: rotation.preserved.status,
        source: recoveryTrigger.source,
      });
      if (rotation.activated.status === "blocked") {
        return {
          status: "blocked",
          reason: getRotationBlockedReason(rotation),
          sessionName,
          threadId,
          restarts,
          preflight: preflightResult,
          rotations,
          events,
        };
      }

      if (tmux.hasSession(sessionName)) {
        tmux.sendExit(sessionName);
        events.push({
          type: "session_exit_requested",
          source: recoveryTrigger.source,
          goalStatus: recoveryTrigger.goalStatus ?? goalStatus,
        });
        const exited = await waitForSessionGone({
          tmux,
          sessionName,
          sleepImpl,
          pollMs: Math.min(effectivePollMs, 1_000),
          maxWaitMs: exitTimeoutMs,
        });
        if (!exited && typeof tmux.killSession === "function") {
          tmux.killSession(sessionName);
          events.push({
            type: "session_killed_after_exit_timeout",
            source: recoveryTrigger.source,
            goalStatus: recoveryTrigger.goalStatus ?? goalStatus,
          });
        }
      }

      restarts += 1;
      tmux.newSession({
        sessionName,
        cwd,
        command: buildCodexCommand({
          codexBin,
          mode: "resume",
          threadId,
          codexProfile: normalizedCodexArgs.codexProfile,
          codexArgs: normalizedCodexArgs.codexArgs,
        }),
      });
      events.push({ type: "session_started", mode: "resume", sessionName, threadId });
      paneRateLimitMatchCount = capturePaneRateLimitMatchCount({ tmux, sessionName, events });
      if (attach && attachProcess?.exitCode !== null) {
        tmux.attach(sessionName);
      }
      if (recoveryTrigger.confirmGoalPrompt) {
        const promptConfirmed = await confirmResumePrompt({
          tmux,
          sessionName,
          sleepImpl,
          pollMs: Math.min(effectivePollMs, 1_000),
          timeoutMs: promptTimeoutMs,
          events,
        });
        if (!promptConfirmed) {
          return {
            status: "blocked",
            reason: "resume_prompt_unconfirmed",
            sessionName,
            threadId,
            restarts,
            preflight: preflightResult,
            rotations,
            events,
          };
        }
      } else {
        maybeConfirmResumePrompt({ tmux, sessionName, events });
      }
      await sleepImpl(Math.min(effectivePollMs, 1_000));
      continue;
    }

    await sleepImpl(effectivePollMs);
  }

  events.push({ type: "poll_limit_reached" });
  return {
    status: "poll_limit_reached",
    sessionName,
    threadId,
    restarts,
    preflight: preflightResult,
    rotations,
    events,
  };
}
