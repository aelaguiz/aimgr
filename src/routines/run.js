import { randomUUID, createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { createConnection } from "node:net";
import path from "node:path";
import lockfile from "proper-lockfile";
import {
  resolveAimgrRoutineBootstrapLockPath,
  resolveAimgrRoutineLocksDir,
  resolveAimgrRoutineRunsDir,
  resolveManagedPrimeAgentDir,
} from "../io/paths.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import {
  readLatestPrimeUserText,
  readPrimeLatestTurn,
  readPrimeSessionProfile,
  resolvePrimeSessionDir,
} from "../targets/prime-sessions.js";
import { preparePrimeInvocation, resolvePrimeLauncher } from "../targets/prime-launcher.js";
import { readRoutineDefinition } from "./config.js";
import { deriveRoutineOccurrence } from "./schedule.js";

const PIN_PROMPT = "AIM routine binding check. Do not use tools. Reply exactly AIM_ROUTINE_PIN_OK.";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function safeError(error) {
  return String(error?.message ?? error).replace(/[\r\n]+/g, " ").slice(0, 1000);
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

function ensureRoutineDirs({ homeDir }) {
  for (const directory of [
    resolveAimgrRoutineRunsDir({ homeDir }),
    resolveAimgrRoutineLocksDir({ homeDir }),
  ]) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    try {
      fs.chmodSync(directory, 0o700);
    } catch {
      // Best effort on non-POSIX filesystems.
    }
  }
}

function receiptPathFor({ homeDir, fireKey }) {
  if (!/^[A-Za-z0-9+_.-]+$/.test(fireKey)) throw new Error("Invalid routine fire key.");
  return path.join(resolveAimgrRoutineRunsDir({ homeDir }), `${fireKey}.json`);
}

function lockPathFor({ homeDir, routineId }) {
  return path.join(resolveAimgrRoutineLocksDir({ homeDir }), routineId);
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function writeReceipt(filePath, receipt) {
  writeJsonFileIfChanged(filePath, receipt, { mode: 0o600 });
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Best effort on non-POSIX filesystems.
  }
  return receipt;
}

function createReceipt(filePath, receipt) {
  let fd;
  try {
    fd = fs.openSync(filePath, "wx", 0o600);
    fs.writeFileSync(fd, `${JSON.stringify(receipt, null, 2)}\n`, "utf8");
    return true;
  } catch (error) {
    if (error?.code === "EEXIST") return false;
    throw error;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function configuredReceipt(routine) {
  return {
    calendar: routine.calendar,
    cwd: routine.cwd,
    promptFile: routine.promptFile,
    provider: routine.provider,
    model: routine.model,
    thinking: routine.thinking,
    herdrSession: routine.herdrSession,
    spaceTitleFormat: routine.spaceTitleFormat,
  };
}

function emitReceipt(context, receipt) {
  if (context.opts.json) {
    context.stdout.write(`${JSON.stringify(receipt, null, 2)}\n`);
    return;
  }
  context.stdout.write(
    `AIM routine ${receipt.routineId}: ${receipt.outcome} · ${receipt.fireKey} · ${receipt.receiptPath}\n`,
  );
}

function resolveAimNodeCommand(context) {
  if (Array.isArray(context.routineAimCommand) && context.routineAimCommand.length > 0) {
    return context.routineAimCommand.map(String);
  }
  return [process.execPath, path.resolve(process.argv[1])];
}

function runJsonSync(command, args, options, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, {
    ...options,
    encoding: "utf8",
  });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? "").trim();
    throw new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : ""}`);
  }
  try {
    return JSON.parse(String(result.stdout ?? ""));
  } catch {
    throw new Error(`${path.basename(command)} returned invalid JSON.`);
  }
}

function runStatusSync(command, args, options, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl(command, args, { ...options, encoding: "utf8" });
  if (result?.error) throw result.error;
  if (result?.status !== 0) {
    const detail = String(result?.stderr ?? result?.stdout ?? "").trim();
    throw new Error(`${path.basename(command)} failed${detail ? `: ${detail}` : ""}`);
  }
}

function verifyHerdrSessionReady(response) {
  const result = response?.result;
  if (result?.type !== "workspace_list" || !Array.isArray(result.workspaces)) {
    throw new Error("Herdr workspace list returned an unexpected response.");
  }
  if (!result.workspaces.some((workspace) => workspace?.focused === true)) {
    throw new Error("Herdr session has no existing focused workspace; refusing a create that would steal focus.");
  }
}

function herdrIds(response, { expectedTitle, expectedCwd }) {
  const result = response?.result;
  const workspace = result?.workspace;
  const tab = result?.tab;
  const pane = result?.root_pane;
  if (result?.type !== "workspace_created" || !workspace || !tab || !pane) {
    throw new Error("Herdr workspace create returned an unexpected response.");
  }
  const workspaceId = String(workspace.workspace_id ?? "");
  const tabId = String(tab.tab_id ?? "");
  const paneId = String(pane.pane_id ?? "");
  if (!workspaceId || !tabId || !paneId) {
    throw new Error("Herdr workspace create response is missing opaque IDs.");
  }
  if (
    workspace.label !== expectedTitle
    || workspace.focused !== false
    || pane.focused !== false
    || path.resolve(pane.cwd ?? "") !== path.resolve(expectedCwd)
    || String(tab.workspace_id ?? "") !== workspaceId
    || String(pane.workspace_id ?? "") !== workspaceId
    || String(pane.tab_id ?? "") !== tabId
  ) {
    throw new Error("Herdr workspace create response failed title/cwd/focus/cross-link verification.");
  }
  return { workspaceId, tabId, paneId, title: workspace.label };
}

function sendHerdrSocketRequest(socketPath, request, timeoutMs = HERDR_API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    let settled = false;
    let buffer = "";
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolve(value);
    };
    const timer = setTimeout(() => {
      finish(new Error(`Herdr workspace move exceeded ${timeoutMs}ms.`));
    }, timeoutMs);
    socket.setEncoding("utf8");
    socket.once("error", (error) => finish(error));
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline === -1) return;
      try {
        finish(null, JSON.parse(buffer.slice(0, newline)));
      } catch {
        finish(new Error("Herdr workspace move returned invalid JSON."));
      }
    });
    socket.once("end", () => {
      if (!settled) finish(new Error("Herdr workspace move ended without a response."));
    });
  });
}

async function moveHerdrWorkspaceToTop({ routine, workspaceId, context }) {
  const sessions = runJsonSync("herdr", ["session", "list", "--json"], {
    cwd: routine.cwd,
    env: context.env,
    timeout: HERDR_API_TIMEOUT_MS,
  }, context.spawnSyncImpl)?.sessions;
  const session = Array.isArray(sessions)
    ? sessions.find((candidate) => candidate?.name === routine.herdrSession)
    : null;
  if (!session?.running || typeof session.socket_path !== "string" || !path.isAbsolute(session.socket_path)) {
    throw new Error(`Herdr session ${routine.herdrSession} has no running API socket.`);
  }
  const response = await sendHerdrSocketRequest(session.socket_path, {
    id: `aimgr:routine:workspace-top:${randomUUID()}`,
    method: "workspace.move",
    params: { workspace_id: workspaceId, insert_index: 0 },
  });
  const workspaces = response?.result?.workspaces;
  if (
    response?.error
    || response?.result?.type !== "workspace_list"
    || !Array.isArray(workspaces)
    || workspaces[0]?.workspace_id !== workspaceId
  ) {
    const detail = response?.error?.message ?? response?.error?.code ?? "unexpected response";
    throw new Error(`Herdr could not move the routine Space to the top: ${detail}.`);
  }
  return { requested: "top", verified: true, position: 1 };
}

function selectAccount(routine, context) {
  const [command, ...prefix] = resolveAimNodeCommand(context);
  const flavor = routine.provider === "anthropic" ? "claude" : "codex";
  const output = runJsonSync(command, [
    ...prefix,
    "prime",
    "use",
    flavor,
    "--home",
    context.homeDir,
  ], {
    cwd: routine.cwd,
    env: context.env,
    timeout: ACCOUNT_SELECTION_TIMEOUT_MS,
  }, context.spawnSyncImpl);
  const selected = output?.receipt?.providers?.find((entry) => (
    entry.provider === routine.provider && typeof entry.binding === "string"
  ));
  if (!output?.ok || !selected) {
    throw new Error(`AIM did not select an eligible ${routine.provider} account.`);
  }
  const authPath = path.join(
    resolveManagedPrimeAgentDir({ homeDir: context.homeDir, env: context.env }),
    "auth.json",
  );
  const descriptor = readJson(authPath)?.[routine.provider];
  if (
    descriptor?.type !== "external"
    || descriptor?.source !== "aimgr"
    || descriptor.binding !== selected.binding
    || typeof descriptor.expectedIdentityFingerprint !== "string"
  ) {
    throw new Error(`Prime AIM descriptor did not preserve the selected ${routine.provider} identity.`);
  }
  return {
    binding: selected.binding,
    identityFingerprint: descriptor.expectedIdentityFingerprint,
  };
}

const BOOTSTRAP_LOCK_WAIT_MS = 60_000;
const ACCOUNT_SELECTION_TIMEOUT_MS = 60_000;
const PIN_TIMEOUT_MS = 120_000;
const PROMPT_ADMISSION_TIMEOUT_MS = 30_000;
const INITIAL_TURN_TIMEOUT_MS = 2 * 60 * 60 * 1_000;
const LIFECYCLE_POLL_MS = 250;
const HERDR_API_TIMEOUT_MS = 3_000;

async function acquireBootstrapLock(lockPath, lockfileImpl = lockfile) {
  let compromised = null;
  const lockTarget = path.join(path.dirname(lockPath), "routine-bootstrap");
  let release;
  try {
    release = await lockfileImpl.lock(lockTarget, {
      realpath: false,
      lockfilePath: lockPath,
      stale: Number.MAX_SAFE_INTEGER,
      update: 1_000,
      retries: {
        retries: BOOTSTRAP_LOCK_WAIT_MS / 250,
        factor: 1,
        minTimeout: 250,
        maxTimeout: 250,
        randomize: false,
      },
      onCompromised: (error) => {
        compromised = error;
      },
    });
  } catch (error) {
    if (error?.code === "ELOCKED") {
      throw new Error(`Routine bootstrap lock remained busy for ${BOOTSTRAP_LOCK_WAIT_MS}ms.`);
    }
    throw error;
  }
  return {
    assertHealthy() {
      if (compromised) throw new Error("Routine bootstrap lock was compromised.");
    },
    async release() {
      await release();
    },
  };
}

function releaseOwnership(lockPath, token) {
  try {
    const owner = readJson(path.join(lockPath, "owner.json"));
    if (owner.token !== token) return;
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    // A crashed or externally changed owner is intentionally left for manual cleanup.
  }
}

function markParentFailure({ receiptPath, receipt, error, lockPath, token }) {
  const failed = writeReceipt(receiptPath, {
    ...receipt,
    outcome: "failed_before_prompt",
    completedAt: new Date().toISOString(),
    error: safeError(error),
    exitCode: 1,
    needsAttention: false,
  });
  releaseOwnership(lockPath, token);
  return failed;
}

export async function launchRoutineOccurrence(context) {
  if (context.positional.length !== 3) {
    throw new Error("Usage: aim routine run <id> [--manual] [--json]");
  }
  const routineId = String(context.positional[2] ?? "").trim();
  const { routine } = readRoutineDefinition({ homeDir: context.homeDir, id: routineId });
  if (!fs.existsSync(routine.cwd) || !fs.statSync(routine.cwd).isDirectory()) {
    throw new Error(`Routine ${routineId} cwd is unavailable: ${routine.cwd}`);
  }
  if (!fs.existsSync(routine.promptFile) || !fs.statSync(routine.promptFile).isFile()) {
    throw new Error(`Routine ${routineId} promptFile is unavailable: ${routine.promptFile}`);
  }
  const promptSource = fs.readFileSync(routine.promptFile, "utf8");
  const effectivePrompt = promptSource.trim();
  if (!effectivePrompt) {
    throw new Error(`Routine ${routineId} promptFile is empty after trimming.`);
  }

  ensureRoutineDirs({ homeDir: context.homeDir });
  const occurrence = deriveRoutineOccurrence(routine, {
    now: context.routineNow ?? new Date(),
    manual: context.opts.routineManual === true,
  });
  const receiptPath = receiptPathFor({ homeDir: context.homeDir, fireKey: occurrence.fireKey });
  const baseReceipt = {
    schemaVersion: 2,
    routineId,
    fireKey: occurrence.fireKey,
    manual: occurrence.manual,
    scheduledAt: occurrence.scheduledAt.toISOString(),
    scheduledLocal: occurrence.scheduledLocal,
    actualStart: new Date().toISOString(),
    configured: configuredReceipt(routine),
    observed: null,
    herdr: null,
    prime: null,
    initialTurn: null,
    interactiveTui: null,
    prompt: {
      sourceSha256: sha256(promptSource),
      effectiveSha256: sha256(effectivePrompt),
      admittedAt: null,
      persistedSha256: null,
    },
    receiptPath,
    outcome: occurrence.admitted ? "claiming" : "missed_window",
    exitCode: occurrence.admitted ? null : 0,
    needsAttention: false,
  };

  if (!createReceipt(receiptPath, baseReceipt)) {
    const existing = readJson(receiptPath);
    emitReceipt(context, { ...existing, outcome: "duplicate", receiptPath });
    return;
  }
  if (!occurrence.admitted) {
    emitReceipt(context, baseReceipt);
    return;
  }

  const token = randomUUID();
  const lockPath = lockPathFor({ homeDir: context.homeDir, routineId });
  try {
    fs.mkdirSync(lockPath, { mode: 0o700 });
    writeJsonFileIfChanged(path.join(lockPath, "owner.json"), {
      token,
      fireKey: occurrence.fireKey,
      receiptPath,
      createdAt: new Date().toISOString(),
    }, { mode: 0o600 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
    const skipped = writeReceipt(receiptPath, {
      ...baseReceipt,
      outcome: "overlap",
      completedAt: new Date().toISOString(),
      exitCode: 0,
    });
    emitReceipt(context, skipped);
    return;
  }

  let currentReceipt = baseReceipt;
  try {
    const listResponse = runJsonSync("herdr", [
      "--session",
      routine.herdrSession,
      "workspace",
      "list",
    ], { cwd: routine.cwd, env: context.env }, context.spawnSyncImpl);
    verifyHerdrSessionReady(listResponse);
    const createResponse = runJsonSync("herdr", [
      "--session",
      routine.herdrSession,
      "workspace",
      "create",
      "--cwd",
      routine.cwd,
      "--label",
      occurrence.title,
      "--no-focus",
    ], { cwd: routine.cwd, env: context.env }, context.spawnSyncImpl);
    const ids = herdrIds(createResponse, {
      expectedTitle: occurrence.title,
      expectedCwd: routine.cwd,
    });
    let workspaceOrder;
    try {
      const moveImpl = context.routineWorkspaceMoveImpl ?? moveHerdrWorkspaceToTop;
      workspaceOrder = await moveImpl({ routine, workspaceId: ids.workspaceId, context });
    } catch (error) {
      workspaceOrder = { requested: "top", verified: false, error: safeError(error) };
      context.stderr?.write?.(`AIM routine ${routineId}: Space created but could not move to top: ${safeError(error)}\n`);
    }
    currentReceipt = writeReceipt(receiptPath, {
      ...currentReceipt,
      herdr: {
        session: routine.herdrSession,
        title: ids.title,
        workspaceId: ids.workspaceId,
        tabId: ids.tabId,
        paneId: ids.paneId,
        workspaceOrder,
      },
      outcome: "space_created",
    });
  } catch (error) {
    const failed = markParentFailure({ receiptPath, receipt: currentReceipt, error, lockPath, token });
    emitReceipt(context, failed);
    context.setExitCode(1);
    return;
  }

  const [aimCommand, ...aimPrefix] = resolveAimNodeCommand(context);
  const workerCommand = [
    aimCommand,
    ...aimPrefix,
    "routine",
    "__execute",
    routineId,
    occurrence.fireKey,
    token,
    "--home",
    context.homeDir,
  ].map(shellQuote).join(" ");
  currentReceipt = writeReceipt(receiptPath, {
    ...currentReceipt,
    outcome: "queued",
  });
  try {
    runStatusSync("herdr", [
      "--session",
      routine.herdrSession,
      "pane",
      "run",
      currentReceipt.herdr.paneId,
      workerCommand,
    ], { cwd: routine.cwd, env: context.env }, context.spawnSyncImpl);
  } catch (error) {
    const failed = markParentFailure({ receiptPath, receipt: currentReceipt, error, lockPath, token });
    emitReceipt(context, failed);
    context.setExitCode(1);
    return;
  }
  emitReceipt(context, readJson(receiptPath));
}

function startStreaming(command, args, {
  cwd,
  env,
  stdinText = null,
  stdout = process.stdout,
  stderr = process.stderr,
  spawnImpl = spawn,
  timeoutMs = null,
} = {}) {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "";
  let errorOutput = "";
  let settled = false;
  let timedOut = false;
  child.stdout?.on("data", (chunk) => {
    const text = chunk.toString();
    output += text;
    stdout.write(text);
  });
  child.stderr?.on("data", (chunk) => {
    const text = chunk.toString();
    errorOutput += text;
    stderr.write(text);
  });
  const result = new Promise((resolve) => {
    const finish = (value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve(value);
    };
    const timer = Number.isFinite(timeoutMs) && timeoutMs > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill?.("SIGTERM");
        }, timeoutMs)
      : null;
    child.once("error", (error) => finish({
      status: 1,
      stdout: output,
      stderr: errorOutput,
      timedOut,
      error,
    }));
    child.once("close", (code) => finish({
      status: Number.isInteger(code) ? code : 1,
      stdout: output,
      stderr: errorOutput,
      timedOut,
      error: null,
    }));
  });
  if (stdinText !== null) child.stdin?.end(stdinText);
  else child.stdin?.end();
  return { child, result, isSettled: () => settled };
}

async function runStreaming(command, args, options = {}) {
  const result = await startStreaming(command, args, options).result;
  if (result.error) throw result.error;
  return result;
}

function parsePrintedSessionId(output) {
  for (const line of String(output ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry?.type === "session" && typeof entry.id === "string") return entry.id;
    } catch {
      // Prime may emit ordinary diagnostics around JSON-mode output.
    }
  }
  throw new Error("Prime pin run did not emit a session header.");
}

function verifyWorkerConfiguration(routine, receipt) {
  const configured = configuredReceipt(routine);
  if (JSON.stringify(configured) !== JSON.stringify(receipt.configured)) {
    throw new Error("Routine configuration changed after the occurrence was claimed.");
  }
}

function verifyWorkerEnvironment(routine, receipt, env, cwd) {
  if (path.resolve(cwd) !== path.resolve(routine.cwd)) {
    throw new Error(`Routine worker cwd mismatch: expected=${routine.cwd} actual=${cwd}.`);
  }
  const expected = receipt.herdr;
  const observedSession = String(env.HERDR_SESSION ?? "");
  const observedWorkspace = String(env.HERDR_WORKSPACE_ID ?? "");
  const observedPane = String(env.HERDR_PANE_ID ?? "");
  if (
    observedSession !== expected.session
    || observedWorkspace !== expected.workspaceId
    || observedPane !== expected.paneId
  ) {
    throw new Error(
      `Routine worker Herdr mismatch: expected=${expected.session}/${expected.workspaceId}/${expected.paneId} actual=${observedSession}/${observedWorkspace}/${observedPane}.`,
    );
  }
}

function verifyPrimeProfile(profile, routine, selectedAccount) {
  const mismatches = [];
  if (profile.provider !== routine.provider) mismatches.push(`provider=${profile.provider}`);
  if (profile.model !== routine.model) mismatches.push(`model=${profile.model}`);
  if (profile.thinking !== routine.thinking) mismatches.push(`thinking=${profile.thinking}`);
  if (path.resolve(profile.cwd ?? "") !== path.resolve(routine.cwd)) mismatches.push(`cwd=${profile.cwd}`);
  if (profile.binding !== selectedAccount.binding) mismatches.push(`binding=${profile.binding}`);
  if (
    selectedAccount.identityFingerprint
    && profile.identityFingerprint !== selectedAccount.identityFingerprint
  ) {
    mismatches.push(`identityFingerprint=${profile.identityFingerprint}`);
  }
  if (mismatches.length) {
    throw new Error(`Prime pin mismatch: ${mismatches.join(", ")}.`);
  }
}

function readOwner(lockPath, token, fireKey) {
  const ownerPath = path.join(lockPath, "owner.json");
  if (!fs.existsSync(ownerPath)) throw new Error("Routine ownership is missing.");
  const owner = readJson(ownerPath);
  if (owner.token !== token || owner.fireKey !== fireKey) {
    throw new Error("Routine ownership token does not match.");
  }
  return owner;
}

function privateTimeout(context, key, fallback) {
  const value = context.routineTimeouts?.[key];
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function lifecycleSleep(context, milliseconds) {
  const sleepImpl = context.routineSleepImpl
    ?? ((delay) => new Promise((resolve) => setTimeout(resolve, delay)));
  return sleepImpl(milliseconds);
}

function startInteractivePrime(command, args, { cwd, env, spawnImpl = spawn } = {}) {
  const child = spawnImpl(command, args, {
    cwd,
    env,
    stdio: "inherit",
    detached: false,
  });
  let running = true;
  const exit = new Promise((resolve) => {
    const finish = (value) => {
      if (!running) return;
      running = false;
      resolve(value);
    };
    child.once("error", (error) => finish({ code: 1, signal: null, error }));
    child.once("close", (code, signal) => finish({
      code: Number.isInteger(code) ? code : 1,
      signal: signal ?? null,
      error: null,
    }));
  });
  return {
    child,
    exit,
    isRunning: () => running,
    terminate() {
      if (running) child.kill?.("SIGTERM");
    },
  };
}

async function waitForPromptAdmission({ context, sessionPath, baselineSha256, effectiveSha256, tui }) {
  const timeoutMs = privateTimeout(context, "promptAdmissionMs", PROMPT_ADMISSION_TIMEOUT_MS);
  const pollMs = privateTimeout(context, "pollMs", LIFECYCLE_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  let lastReadError = null;
  while (Date.now() < deadline) {
    try {
      const persisted = readLatestPrimeUserText(sessionPath);
      const persistedSha256 = persisted === null ? null : sha256(persisted);
      if (persistedSha256 === effectiveSha256) return persistedSha256;
      if (persistedSha256 !== null && persistedSha256 !== baselineSha256) {
        throw new Error("Prime persisted a different user message while admitting the routine prompt.");
      }
    } catch (error) {
      if (/different user message/.test(String(error?.message ?? ""))) throw error;
      lastReadError = error;
    }
    if (!tui.isRunning()) {
      const exited = await tui.exit;
      throw new Error(`Prime interactive TUI exited during prompt admission with code ${exited.code}.`);
    }
    await lifecycleSleep(context, pollMs);
  }
  const detail = lastReadError ? ` Last read error: ${safeError(lastReadError)}` : "";
  throw new Error(`Routine prompt admission was not proven within ${timeoutMs}ms.${detail}`);
}

async function waitForInitialTurnSettlement({ context, sessionPath, effectiveSha256, tui }) {
  const timeoutMs = privateTimeout(context, "initialTurnMs", INITIAL_TURN_TIMEOUT_MS);
  const pollMs = privateTimeout(context, "pollMs", LIFECYCLE_POLL_MS);
  const deadline = Date.now() + timeoutMs;
  let lastReadError = null;
  while (Date.now() < deadline) {
    try {
      const turn = readPrimeLatestTurn(sessionPath);
      const userSha256 = turn.userText === null ? null : sha256(turn.userText);
      if (userSha256 !== effectiveSha256) {
        throw new Error("Prime active turn changed before the routine initial turn settled.");
      }
      const stopReason = turn.assistant?.stopReason;
      if (["stop", "length"].includes(stopReason)) {
        return { status: "idle", stopReason };
      }
      if (stopReason && stopReason !== "toolUse") {
        throw new Error(`Prime initial turn ended with stopReason=${stopReason}.`);
      }
    } catch (error) {
      if (/active turn changed|stopReason=/.test(String(error?.message ?? ""))) throw error;
      lastReadError = error;
    }
    if (!tui.isRunning()) {
      const exited = await tui.exit;
      throw new Error(`Prime interactive TUI exited before initial-turn settlement with code ${exited.code}.`);
    }
    await lifecycleSleep(context, pollMs);
  }
  const detail = lastReadError ? ` Last read error: ${safeError(lastReadError)}` : "";
  throw new Error(`Prime initial turn did not settle within ${timeoutMs}ms.${detail}`);
}

export async function executeRoutineWorker(context) {
  if (context.positional.length !== 5) {
    throw new Error("Invalid private routine worker invocation.");
  }
  const routineId = String(context.positional[2] ?? "");
  const fireKey = String(context.positional[3] ?? "");
  const token = String(context.positional[4] ?? "");
  const { routine } = readRoutineDefinition({ homeDir: context.homeDir, id: routineId });
  const receiptPath = receiptPathFor({ homeDir: context.homeDir, fireKey });
  const lockPath = lockPathFor({ homeDir: context.homeDir, routineId });
  const bootstrapLock = resolveAimgrRoutineBootstrapLockPath({ homeDir: context.homeDir });
  readOwner(lockPath, token, fireKey);
  let receipt = readJson(receiptPath);
  let bootstrapLease = null;
  let tui = null;
  let promptSubmissionStarted = false;
  let ownershipReleased = false;
  const releaseRoutineOwnership = () => {
    if (ownershipReleased) return;
    releaseOwnership(lockPath, token);
    ownershipReleased = true;
  };

  try {
    verifyWorkerConfiguration(routine, receipt);
    verifyWorkerEnvironment(routine, receipt, context.env, context.cwd ?? process.cwd());
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      workerStartedAt: new Date().toISOString(),
      outcome: "waiting_for_bootstrap",
    });
    bootstrapLease = await acquireBootstrapLock(bootstrapLock, context.routineLockfileImpl);
    bootstrapLease.assertHealthy();
    const account = selectAccount(routine, context);
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      selectedAccount: account,
      outcome: "verifying_pin",
    });

    const launcher = context.primeLauncher ?? resolvePrimeLauncher({ env: context.env });
    // Print pins use Prime's process-owned frontend so they cannot replace a
    // separate busy interactive daemon. The resumed product process below is a
    // normal inherited-TTY interactive client.
    const primeEnv = {
      ...context.env,
      PRIME_AGENT_INTERNAL_LEGACY_OWNED_WORKER_FRONTEND: "1",
    };
    const sessionDir = resolvePrimeSessionDir({ homeDir: context.homeDir, env: primeEnv });
    fs.mkdirSync(sessionDir, { recursive: true, mode: 0o700 });
    const pinInvocation = preparePrimeInvocation({
      command: launcher,
      args: [
        "--provider",
        routine.provider,
        "--model",
        routine.model,
        "--thinking",
        routine.thinking,
        "--cwd",
        routine.cwd,
        "--session-dir",
        sessionDir,
        "--no-tools",
        "--print",
        "--mode",
        "json",
        "--",
        PIN_PROMPT,
      ],
    });
    const pinResult = await runStreaming(pinInvocation.command, pinInvocation.args, {
      cwd: routine.cwd,
      env: primeEnv,
      stdout: context.stdout,
      stderr: context.stderr ?? process.stderr,
      spawnImpl: context.spawnImpl,
      timeoutMs: PIN_TIMEOUT_MS,
    });
    if (pinResult.timedOut) throw new Error(`Prime pin run exceeded ${PIN_TIMEOUT_MS}ms.`);
    if (pinResult.status !== 0) {
      throw new Error(`Prime pin run exited ${pinResult.status}.`);
    }
    const sessionId = parsePrintedSessionId(pinResult.stdout);
    const profile = readPrimeSessionProfile({
      selector: sessionId,
      homeDir: context.homeDir,
      env: primeEnv,
      cwd: routine.cwd,
      requireThinking: true,
    });
    verifyPrimeProfile(profile, routine, receipt.selectedAccount);
    bootstrapLease.assertHealthy();
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      observed: {
        provider: profile.provider,
        model: profile.model,
        thinking: profile.thinking,
        cwd: profile.cwd,
        herdrSession: receipt.herdr.session,
        spaceTitle: receipt.herdr.title,
      },
      prime: {
        sessionId: profile.sessionId,
        sessionPath: profile.sessionPath,
        binding: profile.binding,
        identityFingerprint: profile.identityFingerprint,
      },
      outcome: "pin_verified",
    });

    const promptSource = fs.readFileSync(routine.promptFile, "utf8");
    const effectivePrompt = promptSource.trim();
    const sourceSha256 = sha256(promptSource);
    const effectiveSha256 = sha256(effectivePrompt);
    if (
      !effectivePrompt
      || sourceSha256 !== receipt.prompt.sourceSha256
      || effectiveSha256 !== receipt.prompt.effectiveSha256
    ) {
      throw new Error("Routine prompt changed after the occurrence was claimed.");
    }
    const baselinePrompt = readLatestPrimeUserText(profile.sessionPath);
    const baselineSha256 = baselinePrompt === null ? null : sha256(baselinePrompt);

    promptSubmissionStarted = true;
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      prompt: {
        ...receipt.prompt,
        submissionStartedAt: new Date().toISOString(),
      },
      interactiveTui: {
        status: "starting",
        startedAt: new Date().toISOString(),
        readyAt: null,
        sessionPath: profile.sessionPath,
        exitedAt: null,
        exitCode: null,
        exitSignal: null,
      },
      outcome: "starting_interactive_tui",
    });
    const interactiveInvocation = preparePrimeInvocation({
      command: launcher,
      args: [
        "--cwd",
        routine.cwd,
        "--session-dir",
        sessionDir,
        "--resume",
        profile.sessionPath,
        "--",
        effectivePrompt,
      ],
    });
    tui = startInteractivePrime(interactiveInvocation.command, interactiveInvocation.args, {
      cwd: routine.cwd,
      env: primeEnv,
      spawnImpl: context.spawnImpl,
    });
    const persistedSha256 = await waitForPromptAdmission({
      context,
      sessionPath: profile.sessionPath,
      baselineSha256,
      effectiveSha256,
      tui,
    });
    const liveProfile = readPrimeSessionProfile({
      selector: profile.sessionPath,
      homeDir: context.homeDir,
      env: primeEnv,
      cwd: routine.cwd,
      requireThinking: true,
    });
    verifyPrimeProfile(liveProfile, routine, receipt.selectedAccount);
    if (liveProfile.sessionId !== profile.sessionId) {
      throw new Error("Prime interactive TUI wrote the prompt to a different session ID.");
    }
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      prompt: {
        ...receipt.prompt,
        admittedAt: new Date().toISOString(),
        persistedSha256,
      },
      interactiveTui: {
        ...receipt.interactiveTui,
        status: "live",
        readyAt: new Date().toISOString(),
        sessionPath: liveProfile.sessionPath,
      },
      outcome: "prompt_admitted",
    });
    bootstrapLease.assertHealthy();
    await bootstrapLease.release();
    bootstrapLease = null;

    const settlement = await waitForInitialTurnSettlement({
      context,
      sessionPath: liveProfile.sessionPath,
      effectiveSha256,
      tui,
    });
    const finalProfile = readPrimeSessionProfile({
      selector: liveProfile.sessionPath,
      homeDir: context.homeDir,
      env: primeEnv,
      cwd: routine.cwd,
      requireThinking: true,
    });
    verifyPrimeProfile(finalProfile, routine, receipt.selectedAccount);
    const finalPrompt = readLatestPrimeUserText(finalProfile.sessionPath);
    const finalPersistedSha256 = finalPrompt === null ? null : sha256(finalPrompt);
    if (finalPersistedSha256 !== effectiveSha256) {
      throw new Error("Persisted Prime prompt hash does not match the configured prompt file.");
    }

    receipt = writeReceipt(receiptPath, {
      ...receipt,
      observed: {
        ...receipt.observed,
        provider: finalProfile.provider,
        model: finalProfile.model,
        thinking: finalProfile.thinking,
        cwd: finalProfile.cwd,
      },
      prime: {
        sessionId: finalProfile.sessionId,
        sessionPath: finalProfile.sessionPath,
        binding: finalProfile.binding,
        identityFingerprint: finalProfile.identityFingerprint,
      },
      prompt: {
        ...receipt.prompt,
        persistedSha256: finalPersistedSha256,
      },
      initialTurn: {
        status: settlement.status,
        stopReason: settlement.stopReason,
        settledAt: new Date().toISOString(),
      },
      outcome: "completed",
      completedAt: new Date().toISOString(),
      exitCode: 0,
      needsAttention: false,
    });
    releaseRoutineOwnership();

    const tuiExit = await tui.exit;
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      interactiveTui: {
        ...receipt.interactiveTui,
        status: "exited",
        exitedAt: new Date().toISOString(),
        exitCode: tuiExit.code,
        exitSignal: tuiExit.signal,
      },
    });
    return receipt;
  } catch (error) {
    const needsAttention = promptSubmissionStarted;
    receipt = writeReceipt(receiptPath, {
      ...receipt,
      initialTurn: receipt.initialTurn ?? {
        status: needsAttention ? "uncertain" : "not_started",
        settledAt: new Date().toISOString(),
      },
      outcome: needsAttention ? "needs_attention" : "failed_before_prompt",
      completedAt: receipt.completedAt ?? new Date().toISOString(),
      error: safeError(error),
      exitCode: 1,
      needsAttention,
    });
    context.setExitCode(1);
    if (bootstrapLease) {
      try {
        await bootstrapLease.release();
        bootstrapLease = null;
      } catch {
        // The receipt is authoritative; a compromised lease stays visible.
      }
    }
    releaseRoutineOwnership();
    if (tui) {
      const promptAdmitted = Boolean(receipt.prompt?.admittedAt);
      if (!promptAdmitted) {
        tui.terminate();
      } else {
        context.stderr?.write?.(`AIM routine ${routineId} needs attention; leaving its Prime TUI alive.\n`);
      }
      const tuiExit = await tui.exit;
      receipt = writeReceipt(receiptPath, {
        ...receipt,
        interactiveTui: {
          ...receipt.interactiveTui,
          status: "exited",
          exitedAt: new Date().toISOString(),
          exitCode: tuiExit.code,
          exitSignal: tuiExit.signal,
        },
      });
    }
    throw error;
  } finally {
    if (bootstrapLease) {
      try {
        await bootstrapLease.release();
      } catch {
        // The terminal receipt already records the primary failure. A remaining
        // proper-lockfile lock is intentionally left for manual inspection.
      }
    }
    releaseRoutineOwnership();
  }
}

export async function handleRoutineCommand(context) {
  const command = context.positional[1];
  if (command === "run") return launchRoutineOccurrence(context);
  if (command === "__execute") return executeRoutineWorker(context);
  throw new Error("Usage: aim routine run <id> [--manual] [--json]");
}
