import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { resolveCodexWatchThresholdPct } from "../core/watch-options.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { resolveManagedCodexHomeDir } from "../io/paths.js";
import { sleep } from "../io/streams.js";
import { watchCodexPoolSelectionOnce } from "../pool/watch.js";
import { loadAimgrState } from "../state/schema.js";
import { activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel } from "./codex-cli.js";
import { getCodexThreadGoal, listCodexThreads } from "./codex-app-server.js";

const STOPPED_FOR_ROTATION_STATUSES = new Set(["usageLimited"]);
const CODEX_SESSION_ID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

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
    if (/Resume paused goal\?/i.test(pane) && /Resume goal/i.test(pane)) {
      tmux.sendEnter(sessionName);
      events.push({ type: "resume_prompt_confirmed" });
      return true;
    }
    if (/Goal active|Pursuing goal|Goal achieved/i.test(pane)) {
      events.push({ type: "resume_prompt_already_active" });
      return true;
    }
    await sleepImpl(pollMs);
  }
  events.push({ type: "resume_prompt_timeout" });
  return false;
}

async function rotateCodexAccount({
  statePath,
  homeDir,
  env,
  observedAt,
  probeUsageSnapshotsByProviderImpl,
  activateCodexPoolSelectionImpl,
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
    probeUsageSnapshotsByProviderImpl,
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
  const attachProcess = attach ? tmux.attach(sessionName) : null;
  if (threadId) {
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
    const shouldRotate = STOPPED_FOR_ROTATION_STATUSES.has(goalStatus);

    if (!sessionAlive && !shouldRotate) {
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

    if (shouldRotate) {
      if (restarts >= effectiveMaxRestarts) {
        events.push({ type: "max_restarts_reached", goalStatus });
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

      if (sessionAlive) {
        tmux.sendExit(sessionName);
        events.push({ type: "session_exit_requested", goalStatus });
        const exited = await waitForSessionGone({
          tmux,
          sessionName,
          sleepImpl,
          pollMs: Math.min(effectivePollMs, 1_000),
          maxWaitMs: exitTimeoutMs,
        });
        if (!exited && typeof tmux.killSession === "function") {
          tmux.killSession(sessionName);
          events.push({ type: "session_killed_after_exit_timeout", goalStatus });
        }
      }

      const rotation = await rotateCodexAccount({
        statePath,
        homeDir,
        env,
        observedAt: new Date().toISOString(),
        probeUsageSnapshotsByProviderImpl,
        activateCodexPoolSelectionImpl,
      });
      rotations.push(rotation);
      events.push({
        type: "rotation",
        status: rotation.activated.status,
        preserveStatus: rotation.preserved.status,
      });
      if (rotation.activated.status === "blocked") {
        return {
          status: "blocked",
          reason: "rotation_blocked",
          sessionName,
          threadId,
          restarts,
          preflight: preflightResult,
          rotations,
          events,
        };
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
      if (attach && attachProcess?.exitCode !== null) {
        tmux.attach(sessionName);
      }
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
