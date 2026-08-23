import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { executeRoutineWorker } from "../../src/routines/run.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

function routineDefinition(home, overrides = {}) {
  const cwd = path.join(home, "work");
  const promptFile = path.join(home, ".aimgr", "routines", "prompts", "demo.md");
  fs.mkdirSync(cwd, { recursive: true });
  fs.mkdirSync(path.dirname(promptFile), { recursive: true });
  fs.writeFileSync(promptFile, "Perform the harmless test task exactly once.\n");
  return {
    calendar: [{ hour: 7, minute: 0 }],
    cwd,
    promptFile,
    provider: "anthropic",
    model: "claude-fable-5",
    thinking: "xhigh",
    herdrSession: "growth",
    spaceTitleFormat: "demo · {scheduled_local}",
    ...overrides,
  };
}

function configure(home, routine = routineDefinition(home)) {
  writeAimgrConfig({
    homeDir: home,
    config: {
      redis: { url: "redis://example.test:6379" },
      routines: { demo: routine },
    },
  });
  return routine;
}

function fakeParentSpawn(calls, home) {
  return (command, args) => {
    calls.push({ command, args });
    if (command === "fake-aim") {
      assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), true);
      const provider = args.includes("codex") ? "openai-codex" : "anthropic";
      const binding = provider === "openai-codex" ? "sol-a" : "fable-a";
      const authPath = path.join(home, ".prime", "agent", "auth.json");
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify({
        [provider]: {
          type: "external",
          source: "aimgr",
          binding,
          expectedIdentityFingerprint: `fingerprint:${binding}`,
        },
      }));
      return {
        status: 0,
        stdout: JSON.stringify({
          ok: true,
          receipt: { providers: [{ provider, binding }] },
        }),
        stderr: "",
      };
    }
    if (command === "herdr" && args.includes("list")) {
      return {
        status: 0,
        stdout: JSON.stringify({
          result: { type: "workspace_list", workspaces: [{ workspace_id: "w-existing", focused: true }] },
        }),
        stderr: "",
      };
    }
    if (command === "herdr" && args.includes("create")) {
      const title = args[args.indexOf("--label") + 1];
      const cwd = args[args.indexOf("--cwd") + 1];
      return {
        status: 0,
        stdout: JSON.stringify({
          result: {
            type: "workspace_created",
            workspace: { workspace_id: "w-test", label: title, focused: false },
            tab: { tab_id: "t-test", workspace_id: "w-test" },
            root_pane: {
              pane_id: "p-test",
              workspace_id: "w-test",
              tab_id: "t-test",
              cwd,
              focused: false,
            },
          },
        }),
        stderr: "",
      };
    }
    if (command === "herdr" && args.includes("run")) {
      return { status: 0, stdout: "", stderr: "" };
    }
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`);
  };
}
function receiptFiles(home) {
  const directory = path.join(home, ".aimgr", "routine-runs");
  return fs.existsSync(directory)
    ? fs.readdirSync(directory).map((name) => path.join(directory, name))
    : [];
}

async function fakeWorkspaceMove({ workspaceId }) {
  return { requested: "top", verified: true, position: 1, workspaceId };
}

test("manual routine runs use unique fire keys while overlap still creates no second Space", async () => {
  const home = mkTempHome();
  configure(home);
  const calls = [];
  const deps = {
    env: { HOME: home },
    routineNow: new Date(2026, 7, 15, 12, 34, 56),
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: fakeParentSpawn(calls, home),
    routineWorkspaceMoveImpl: fakeWorkspaceMove,
  };

  const first = JSON.parse(await runCli([
    "routine", "run", "demo", "--manual", "--json", "--home", home,
  ], deps));
  assert.equal(first.outcome, "queued");
  assert.equal(first.herdr.session, "growth");
  assert.equal(first.herdr.workspaceOrder.verified, true);
  assert.equal(first.herdr.workspaceOrder.position, 1);
  assert.match(first.herdr.title, /^demo · 2026-08-15 12:34 /);
  assert.equal(calls.filter((call) => call.command === "herdr").length, 3);
  assert.equal(calls.filter((call) => call.command === "fake-aim").length, 0);
  const paneRun = calls.find((call) => call.command === "herdr" && call.args.includes("run"));
  assert.doesNotMatch(paneRun.args.at(-1), /PRIME_AGENT_LAUNCHER_PATH/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), true);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);

  const second = JSON.parse(await runCli([
    "routine", "run", "demo", "--manual", "--json", "--home", home,
  ], deps));
  assert.equal(second.outcome, "overlap");
  assert.notEqual(second.fireKey, first.fireKey);
  assert.equal(calls.filter((call) => call.command === "herdr").length, 3);
  assert.equal(receiptFiles(home).length, 2);
});

test("late scheduled fire writes a missed receipt without selecting an account or creating a Space", async () => {
  const home = mkTempHome();
  configure(home);
  const calls = [];
  const result = JSON.parse(await runCli([
    "routine", "run", "demo", "--json", "--home", home,
  ], {
    env: { HOME: home },
    routineNow: new Date(2026, 7, 15, 7, 11, 0),
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: fakeParentSpawn(calls, home),
  }));
  assert.equal(result.outcome, "missed_window");
  assert.equal(calls.length, 0);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
});


test("duplicate scheduled launch for the same local slot creates no second Space", async () => {
  const home = mkTempHome();
  configure(home);
  const calls = [];
  const deps = {
    env: { HOME: home },
    routineNow: new Date(2026, 7, 15, 7, 5, 0),
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: fakeParentSpawn(calls, home),
    routineWorkspaceMoveImpl: fakeWorkspaceMove,
  };
  const argv = ["routine", "run", "demo", "--json", "--home", home];
  const first = JSON.parse(await runCli(argv, deps));
  const second = JSON.parse(await runCli(argv, deps));
  assert.equal(first.outcome, "queued");
  assert.equal(second.outcome, "duplicate");
  assert.equal(calls.filter((call) => call.command === "herdr").length, 3);
  assert.equal(receiptFiles(home).length, 1);
});

test("workspace-order failure stays visible but does not block the routine", async () => {
  const home = mkTempHome();
  configure(home);
  const result = JSON.parse(await runCli([
    "routine", "run", "demo", "--manual", "--json", "--home", home,
  ], {
    env: { HOME: home },
    routineNow: new Date(2026, 7, 15, 12, 35, 0),
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: fakeParentSpawn([], home),
    async routineWorkspaceMoveImpl() {
      throw new Error("synthetic ordering failure");
    },
  }));
  assert.equal(result.outcome, "queued");
  assert.equal(result.herdr.workspaceOrder.requested, "top");
  assert.equal(result.herdr.workspaceOrder.verified, false);
  assert.match(result.herdr.workspaceOrder.error, /synthetic ordering failure/);
});

function writePinSession(sessionPath, {
  sessionId,
  cwd,
  provider = "anthropic",
  model = "claude-fable-5",
  binding = "fable-a",
}) {
  const entries = [
    { type: "session", version: 3, id: sessionId, timestamp: new Date().toISOString(), cwd },
    { type: "model_change", id: "model", parentId: null, timestamp: new Date().toISOString(), provider, modelId: model },
    { type: "thinking_level_change", id: "thinking", parentId: "model", timestamp: new Date().toISOString(), thinkingLevel: "xhigh" },
    {
      type: "custom",
      customType: "aimgr_credential_binding_v1",
      id: "binding",
      parentId: "thinking",
      timestamp: new Date().toISOString(),
      data: {
        source: "aimgr",
        provider,
        binding,
        identityFingerprint: `fingerprint:${binding}`,
      },
    },
    { type: "message", id: "pin-user", parentId: "binding", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: "pin" }] } },
    {
      type: "message",
      id: "pin-assistant",
      parentId: "pin-user",
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [], provider, model, stopReason: "stop" },
    },
  ];
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function appendTurn(sessionPath, prompt, { provider, model, suffix = "real", stopReason = "stop" }) {
  const entries = [
    { type: "message", id: `${suffix}-user`, parentId: "pin-assistant", timestamp: new Date().toISOString(), message: { role: "user", content: [{ type: "text", text: prompt }] } },
    {
      type: "message",
      id: `${suffix}-assistant`,
      parentId: `${suffix}-user`,
      timestamp: new Date().toISOString(),
      message: { role: "assistant", content: [], provider, model, stopReason },
    },
  ];
  fs.appendFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
}

function makeInteractiveRuntime({
  home,
  cwd,
  provider = "anthropic",
  pinModel = "claude-fable-5",
  binding = "fable-a",
  appendPrompt = true,
  assistantStopReason = "stop",
} = {}) {
  const sessionId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const sessionPath = path.join(home, ".prime", "agent", "sessions", `${sessionId}.jsonl`);
  const primeArgvs = [];
  const primeOptions = [];
  const promptSubmissions = [];
  const events = [];
  let tuiChild = null;
  let tuiRunning = false;
  let pinCalls = 0;
  const spawnSyncImpl = fakeParentSpawn([], home);

  const spawnImpl = (command, args, options = {}) => {
    if (command === "fake-prime" && options.stdio !== "inherit") {
      pinCalls += 1;
      primeArgvs.push(args);
      primeOptions.push(options);
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
      assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), true);
      writePinSession(sessionPath, { sessionId, cwd, provider, model: pinModel, binding });
      child.stdout.end(`${JSON.stringify({ type: "session", id: sessionId })}\n`);
      child.stderr.end();
      setImmediate(() => child.emit("close", 0));
      return child;
    }
    if (command === "fake-prime" && options.stdio === "inherit") {
      primeArgvs.push(args);
      primeOptions.push(options);
      events.push("tui_started");
      const separator = args.indexOf("--");
      const prompt = separator === -1 ? null : args[separator + 1];
      if (prompt !== null) promptSubmissions.push(prompt);
      if (appendPrompt && prompt !== null) {
        appendTurn(sessionPath, prompt, {
          provider,
          model: pinModel,
          stopReason: assistantStopReason,
        });
        events.push("prompt_persisted");
        events.push("prompt_settled");
      }
      tuiChild = new EventEmitter();
      tuiRunning = true;
      const close = (code = 0, signal = null) => {
        if (!tuiRunning) return;
        tuiRunning = false;
        setImmediate(() => tuiChild.emit("close", code, signal));
      };
      tuiChild.kill = (signal) => close(143, signal);
      tuiChild.closeTui = close;
      return tuiChild;
    }
    throw new Error(`unexpected async command: ${command} ${args.join(" ")}`);
  };

  return {
    spawnImpl,
    spawnSyncImpl,
    primeArgvs,
    primeOptions,
    promptSubmissions,
    events,
    sessionPath,
    pinCalls: () => pinCalls,
    isTuiRunning: () => tuiRunning,
    closeTui(code = 0) {
      assert.ok(tuiChild, "interactive TUI was not started");
      tuiChild.closeTui(code);
    },
    submitFollowUp(text) {
      assert.equal(tuiRunning, true);
      appendTurn(sessionPath, text, { provider, model: pinModel, suffix: "followup" });
    },
  };
}

async function prepareQueuedWorker(home, definition = routineDefinition(home)) {
  const routine = configure(home, definition);
  const calls = [];
  const output = JSON.parse(await runCli([
    "routine", "run", "demo", "--manual", "--json", "--home", home,
  ], {
    env: { HOME: home },
    routineNow: new Date(2026, 7, 15, 12, 34, 0),
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: fakeParentSpawn(calls, home),
    routineWorkspaceMoveImpl: fakeWorkspaceMove,
  }));
  return { routine, receipt: output };
}

function workerContext(home, receipt, runtime) {
  let exitCode = 0;
  return {
    positional: ["routine", "__execute", "demo", receipt.fireKey, JSON.parse(
      fs.readFileSync(path.join(home, ".aimgr", "routine-locks", "demo", "owner.json"), "utf8"),
    ).token],
    homeDir: home,
    cwd: receipt.configured.cwd,
    env: {
      HOME: home,
      PRIME_AGENT_CODING_AGENT_DIR: path.join(home, ".prime", "agent"),
      HERDR_SESSION: receipt.herdr.session,
      HERDR_WORKSPACE_ID: receipt.herdr.workspaceId,
      HERDR_PANE_ID: receipt.herdr.paneId,
    },
    stdout: { write() {} },
    stderr: { write() {} },
    primeLauncher: "fake-prime",
    routineAimCommand: ["fake-aim"],
    spawnSyncImpl: runtime.spawnSyncImpl,
    spawnImpl: runtime.spawnImpl,
    routineTimeouts: {
      promptAdmissionMs: 20,
      initialTurnMs: 100,
      pollMs: 1,
    },
    routineSleepImpl: () => new Promise((resolve) => setImmediate(resolve)),
    setExitCode(code) { exitCode = code; },
    getExitCode() { return exitCode; },
  };
}

async function waitUntil(predicate, message) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.fail(message);
}

function latestUserText(sessionPath) {
  const entries = fs.readFileSync(sessionPath, "utf8").trim().split("\n").map(JSON.parse);
  const users = entries.filter((entry) => entry?.type === "message" && entry.message?.role === "user");
  return users.at(-1)?.message?.content?.[0]?.text ?? null;
}

test("worker admits one prompt into an exact inherited-TTY Prime TUI and releases occurrence ownership while it stays live", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  const runtime = makeInteractiveRuntime({ home, cwd: receipt.configured.cwd });
  const context = workerContext(home, receipt, runtime);
  let workerSettled = false;
  const worker = executeRoutineWorker(context).finally(() => { workerSettled = true; });

  await waitUntil(() => JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8")).outcome === "completed", "initial turn did not settle");
  const completedWhileLive = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.equal(workerSettled, false);
  assert.equal(runtime.isTuiRunning(), true);
  assert.equal(completedWhileLive.initialTurn.status, "idle");
  assert.equal(completedWhileLive.interactiveTui.status, "live");
  assert.equal(completedWhileLive.prompt.persistedSha256, completedWhileLive.prompt.effectiveSha256);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);

  assert.equal(runtime.primeArgvs.length, 2);
  assert.equal(runtime.primeArgvs[0].includes("--dist"), false);
  assert.equal(runtime.primeArgvs[1].includes("--dist"), false);
  assert.ok(runtime.primeArgvs[0].includes("--no-tools"));
  assert.ok(runtime.primeArgvs[0].includes("--print"));
  assert.equal(runtime.primeOptions[1].stdio, "inherit");
  assert.equal(runtime.primeOptions[1].detached, false);
  assert.equal(runtime.primeArgvs[1].includes("--print"), false);
  assert.equal(runtime.primeArgvs[1].includes("--mode"), false);
  assert.equal(runtime.primeArgvs[1][runtime.primeArgvs[1].indexOf("--resume") + 1], runtime.sessionPath);
  assert.equal(runtime.promptSubmissions.length, 1);
  assert.equal(runtime.primeArgvs[1].filter((arg) => arg === "--").length, 1);
  assert.equal(runtime.primeArgvs[1][runtime.primeArgvs[1].indexOf("--") + 1], "Perform the harmless test task exactly once.");
  assert.ok(runtime.events.indexOf("tui_started") < runtime.events.indexOf("prompt_persisted"));
  assert.ok(runtime.events.indexOf("prompt_persisted") < runtime.events.indexOf("prompt_settled"));

  runtime.submitFollowUp("AIM_SCHEDULE_FOLLOWUP_OK");
  assert.equal(latestUserText(runtime.sessionPath), "AIM_SCHEDULE_FOLLOWUP_OK");
  runtime.closeTui();
  const afterExit = await worker;
  assert.equal(afterExit.outcome, "completed");
  assert.equal(afterExit.interactiveTui.status, "exited");
  assert.equal(context.getExitCode(), 0);
});

test("worker supports the exact Sol X High pin and interactive same-session resume path", async () => {
  const home = mkTempHome();
  const definition = routineDefinition(home, {
    provider: "openai-codex",
    model: "gpt-5.6-sol",
  });
  const { receipt } = await prepareQueuedWorker(home, definition);
  const runtime = makeInteractiveRuntime({
    home,
    cwd: receipt.configured.cwd,
    provider: "openai-codex",
    pinModel: "gpt-5.6-sol",
    binding: "sol-a",
  });
  const worker = executeRoutineWorker(workerContext(home, receipt, runtime));
  await waitUntil(() => JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8")).outcome === "completed", "Sol initial turn did not settle");
  runtime.closeTui();
  const completed = await worker;
  assert.equal(completed.observed.provider, "openai-codex");
  assert.equal(completed.observed.model, "gpt-5.6-sol");
  assert.equal(completed.prime.binding, "sol-a");
  assert.equal(runtime.primeArgvs[1][runtime.primeArgvs[1].indexOf("--resume") + 1], runtime.sessionPath);
});

test("worker fails closed before prompt admission when the pinned model mismatches", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  const runtime = makeInteractiveRuntime({ home, cwd: receipt.configured.cwd, pinModel: "wrong-model" });
  const context = workerContext(home, receipt, runtime);

  await assert.rejects(() => executeRoutineWorker(context), /Prime pin mismatch/);
  const failed = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.equal(failed.outcome, "failed_before_prompt");
  assert.equal(failed.prompt.admittedAt, null);
  assert.equal(failed.needsAttention, false);
  assert.equal(runtime.pinCalls(), 1);
  assert.equal(runtime.promptSubmissions.length, 0);
});

test("worker marks an admitted provider error for attention without replaying", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  const runtime = makeInteractiveRuntime({
    home,
    cwd: receipt.configured.cwd,
    assistantStopReason: "error",
  });
  const context = workerContext(home, receipt, runtime);
  const worker = executeRoutineWorker(context);
  worker.catch(() => {});

  await waitUntil(() => JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8")).outcome === "needs_attention", "attention receipt was not written");
  const failedWhileLive = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.ok(failedWhileLive.prompt.admittedAt);
  assert.equal(failedWhileLive.needsAttention, true);
  assert.equal(runtime.promptSubmissions.length, 1);
  assert.equal(runtime.isTuiRunning(), true);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
  runtime.closeTui();
  await assert.rejects(() => worker, /stopReason=error/);
});

test("worker terminates an unadmitted startup client as ambiguous and never retries", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  const runtime = makeInteractiveRuntime({
    home,
    cwd: receipt.configured.cwd,
    appendPrompt: false,
  });
  const context = workerContext(home, receipt, runtime);

  await assert.rejects(() => executeRoutineWorker(context), /admission was not proven/);
  const ambiguous = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.equal(ambiguous.prompt.admittedAt, null);
  assert.equal(ambiguous.needsAttention, true);
  assert.equal(runtime.promptSubmissions.length, 1);
  assert.equal(runtime.isTuiRunning(), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
});


test("worker rejects routine config drift before starting Prime", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  configure(home, routineDefinition(home, { model: "changed-model" }));
  const runtime = makeInteractiveRuntime({ home, cwd: receipt.configured.cwd });
  const context = workerContext(home, receipt, runtime);

  await assert.rejects(() => executeRoutineWorker(context), /configuration changed/);
  const failed = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.equal(failed.outcome, "failed_before_prompt");
  assert.equal(failed.prompt.admittedAt, null);
  assert.equal(runtime.pinCalls(), 0);
});

test("busy bootstrap contention fails visibly inside the retained Space", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home);
  const runtime = makeInteractiveRuntime({ home, cwd: receipt.configured.cwd });
  const context = workerContext(home, receipt, runtime);
  context.routineLockfileImpl = {
    async lock() {
      throw Object.assign(new Error("busy"), { code: "ELOCKED" });
    },
  };

  await assert.rejects(() => executeRoutineWorker(context), /remained busy/);
  const failed = JSON.parse(fs.readFileSync(receipt.receiptPath, "utf8"));
  assert.equal(failed.outcome, "failed_before_prompt");
  assert.equal(failed.herdr.workspaceId, "w-test");
  assert.equal(failed.prompt.admittedAt, null);
  assert.equal(failed.exitCode, 1);
  assert.equal(runtime.pinCalls(), 0);
});
