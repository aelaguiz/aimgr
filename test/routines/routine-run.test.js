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
  assert.equal(runtime.primeArgvs.some((args) => args.includes("--dist")), false);
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

function codexDefinition(home, overrides = {}) {
  return routineDefinition(home, {
    agent: "codex", provider: "openai-codex", model: "gpt-6-astra", thinking: "xhigh", ...overrides,
  });
}

function makeCodexRuntime(home, options = {}) {
  const sessionId = "12345678-1234-4234-8234-123456789abc";
  const calls = [];
  let submitted = "";
  let tui;
  const kills = [];
  return {
    sessionId, calls, kills,
    get submitted() { return submitted; },
    closeTui(code = 0) { tui.emit("close", code, null); },
    spawnSyncImpl(command, args) {
      assert.equal(command, "fake-aim");
      assert.deepEqual(args, ["codex", "use", "--home", home]);
      const authPath = path.join(home, ".codex", "auth.json");
      fs.mkdirSync(path.dirname(authPath), { recursive: true });
      fs.writeFileSync(authPath, JSON.stringify({ tokens: { account_id: options.wrongAccount ? "wrong" : "acct-test" } }));
      return { status: 0, stdout: JSON.stringify({ ok: true, activated: { receipt: { label: "test", accountId: "acct-test" } } }) };
    },
    spawnImpl(command, args, spawnOptions) {
      calls.push({ command, args, options: spawnOptions });
      assert.equal(command, "codex");
      const child = new EventEmitter();
      if (args.includes("resume")) {
        assert.equal(spawnOptions.stdio, "inherit");
        assert.equal(args.at(-1), sessionId);
        assert.equal(args.includes("--last"), false);
        tui = child;
        if (options.resumeError) setImmediate(() => child.emit("error", new Error("resume unavailable")));
        return child;
      }
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) { submitted += chunk.toString(); callback(); } });
      child.kill = (signal) => {
        kills.push(signal);
        if (!options.ignoreTerm || signal === "SIGKILL") setImmediate(() => child.emit("close", null, signal));
      };
      setImmediate(() => {
        if (options.spawnError) { child.emit("error", Object.assign(new Error("spawn codex ENOENT"), { code: "ENOENT" })); return; }
        const events = options.events ?? [
          { type: "thread.started", thread_id: sessionId },
          { type: "turn.started" },
          { type: "item.completed", item: { type: "agent_message", text: "Done ✓" } },
          { type: "turn.completed", usage: { input_tokens: 10, output_tokens: 3 } },
        ];
        const bytes = Buffer.from(events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + (options.hang ? "\n" : ""));
        // Split every byte, including Unicode and the final line without LF.
        for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
        if (!options.hang) child.emit("close", options.exitCode ?? 0, null);
      });
      return child;
    },
  };
}

test("Codex routine executes the prompt once, saves events, and resumes that session while releasing overlap protection", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, codexDefinition(home));
  const runtime = makeCodexRuntime(home);
  const context = workerContext(home, receipt, runtime);
  context.env.CODEX_API_KEY = "must-not-use-this-key";
  context.env.OPENAI_API_KEY = "must-not-use-this-key";
  const worker = executeRoutineWorker(context);
  await waitUntil(() => runtime.calls.length === 2, "Codex TUI did not open");
  const saved = JSON.parse(fs.readFileSync(receipt.receiptPath));
  assert.equal(saved.outcome, "completed");
  assert.equal(saved.codex.sessionId, runtime.sessionId);
  assert.deepEqual(saved.codex.usage, { input_tokens: 10, output_tokens: 3 });
  assert.equal(saved.prompt.stdinSha256, saved.prompt.effectiveSha256);
  assert.equal(saved.prompt.persistedSha256, null);
  assert.equal(runtime.submitted, fs.readFileSync(receipt.configured.promptFile, "utf8").trim());
  assert.match(fs.readFileSync(saved.codex.eventsPath, "utf8"), /Done ✓/);
  assert.equal(fs.statSync(saved.codex.eventsPath).mode & 0o777, 0o600);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);
  for (const call of runtime.calls) {
    assert.equal(call.options.cwd, receipt.configured.cwd);
    assert.equal(call.options.env.CODEX_HOME, path.join(home, ".codex"));
    assert.equal(call.options.env.CODEX_API_KEY, undefined);
    assert.equal(call.options.env.OPENAI_API_KEY, undefined);
    assert.deepEqual(call.args.slice(0, 6), ["--profile", "yolo", "--model", "gpt-6-astra", "-c", 'model_reasoning_effort="xhigh"']);
  }
  assert.equal(runtime.calls[0].args.at(-1), "-");
  runtime.closeTui();
  const result = await worker;
  assert.equal(result.interactiveTui.status, "exited");
  assert.equal(context.getExitCode(), 0);
});

for (const [name, options, error, outcome] of [
  ["wrong selected account", { wrongAccount: true }, /selected AIM account/, "failed_before_prompt"],
  ["missing executable", { spawnError: true }, /ENOENT/, "failed_before_prompt"],
  ["missing completion", { events: [
    { type: "thread.started", thread_id: "12345678-1234-4234-8234-123456789abc" }, { type: "turn.started" },
  ] }, /without a completed turn/, "needs_attention"],
  ["failed turn", { events: [
    { type: "thread.started", thread_id: "12345678-1234-4234-8234-123456789abc" }, { type: "turn.started" },
    { type: "turn.failed", error: { message: "rate limited" } },
  ] }, /rate limited/, "needs_attention"],
  ["unclean exit", { exitCode: 1 }, /exited 1/, "needs_attention"],
  ["malformed event", { events: ["{broken-json"] }, /JSON/, "failed_before_prompt"],
  ["timeout", { hang: true, ignoreTerm: true, events: [
    { type: "thread.started", thread_id: "12345678-1234-4234-8234-123456789abc" }, { type: "turn.started" },
  ] }, /exceeded/, "needs_attention"],
]) {
  test(`Codex routine handles ${name} without a second prompt or retained ownership`, async () => {
    const home = mkTempHome();
    const { receipt } = await prepareQueuedWorker(home, codexDefinition(home));
    const runtime = makeCodexRuntime(home, options);
    const context = workerContext(home, receipt, runtime);
    context.routineTimeouts.killGraceMs = 5;
    await assert.rejects(executeRoutineWorker(context), error);
    const saved = JSON.parse(fs.readFileSync(receipt.receiptPath));
    assert.equal(saved.outcome, outcome);
    assert.equal(context.getExitCode(), 1);
    assert.equal(runtime.calls.some((call) => call.args.includes("resume")), false);
    assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
    assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);
    if (options.ignoreTerm) assert.deepEqual(runtime.kills, ["SIGTERM", "SIGKILL"]);
  });
}

test("Codex resume failure preserves the completed job and records the TUI error", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, codexDefinition(home));
  const runtime = makeCodexRuntime(home, { resumeError: true });
  const context = workerContext(home, receipt, runtime);
  const result = await executeRoutineWorker(context);
  assert.equal(result.outcome, "completed");
  assert.equal(result.needsAttention, true);
  assert.equal(result.interactiveTui.exitCode, 1);
  assert.match(result.interactiveTui.error, /resume unavailable/);
  assert.equal(context.getExitCode(), 1);
});

test("Codex prompt drift fails before launching the agent", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, codexDefinition(home));
  fs.appendFileSync(receipt.configured.promptFile, "Changed after claim");
  const runtime = makeCodexRuntime(home);
  await assert.rejects(executeRoutineWorker(workerContext(home, receipt, runtime)), /prompt changed/);
  assert.equal(runtime.calls.length, 0);
});

test("scheduled Codex occurrences deduplicate and prevent overlap through the shared scheduler", async () => {
  const home = mkTempHome();
  configure(home, codexDefinition(home));
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
  assert.equal(first.outcome, "queued");
  assert.equal(first.configured.agent, "codex");
  assert.equal(JSON.parse(await runCli(argv, deps)).outcome, "duplicate");
  assert.equal(JSON.parse(await runCli([...argv, "--manual"], deps)).outcome, "overlap");
  assert.equal(calls.filter((call) => call.args.includes("create")).length, 1);
});

test("interrupting a Codex routine stops its child and releases ownership", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, codexDefinition(home));
  const runtime = makeCodexRuntime(home, { hang: true, events: [
    { type: "thread.started", thread_id: "12345678-1234-4234-8234-123456789abc" }, { type: "turn.started" },
  ] });
  const context = workerContext(home, receipt, runtime);
  const listenersBefore = process.listenerCount("SIGTERM");
  const worker = executeRoutineWorker(context);
  const rejected = assert.rejects(worker, /interrupted by SIGTERM/);
  await waitUntil(() => JSON.parse(fs.readFileSync(receipt.receiptPath)).outcome === "prompt_admitted", "prompt was not admitted");
  process.emit("SIGTERM");
  await rejected;
  assert.deepEqual(runtime.kills, ["SIGTERM"]);
  assert.equal(process.listenerCount("SIGTERM"), listenersBefore);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
});

function claudeDefinition(home, overrides = {}) {
  return routineDefinition(home, { agent: "claude", model: "claude-fable-5-1", ...overrides });
}

function makeClaudeRuntime(home, options = {}) {
  let submitted;
  let resumeResolve;
  let leaseHeld = false;
  const calls = [];
  const kills = [];
  const abort = new AbortController();
  const configDir = path.join(home, ".aimgr", "claude-homes", "fable-a", ".claude");
  return {
    calls, kills, configDir, abort,
    get submitted() { return submitted; },
    get leaseHeld() { return leaseHeld; },
    closeTui(status = 0) { resumeResolve({ status, signal: null }); },
    async routineClaudeSessionImpl(context, { cwd, runSession }) {
      if (options.accountError) throw new Error("No unlocked Claude account with readable five-hour usage is available.");
      leaseHeld = true;
      try {
        const result = await runSession({
          label: "fable-a", command: "/fake/claude", cwd, configDir, env: context.env, signal: abort.signal,
          preparedLaunch: { command: "/fake/claude", userHomeDir: home, homeDir: path.dirname(configDir), configDir,
            adapterDir: path.join(home, "adapter"), userPluginDirs: ["/fake/plugin"], userHooksPath: "/fake/hooks.json" },
        });
        if (result.status !== 0) context.setExitCode(result.status);
      } finally { leaseHeld = false; }
    },
    async runClaudeCliImpl(launch) {
      assert.equal(leaseHeld, true);
      calls.push({ type: "resume", launch });
      if (options.resumeError) throw new Error("resume unavailable");
      return new Promise((resolve) => { resumeResolve = resolve; });
    },
    spawnImpl(command, args, spawnOptions) {
      assert.equal(leaseHeld, true);
      assert.equal(command, process.execPath);
      assert.match(args[0], /claude-supervisor\.js$/);
      assert.equal(args[1], "/fake/claude");
      assert.deepEqual(spawnOptions.stdio, ["pipe", "pipe", "pipe", "ipc"]);
      calls.push({ type: "print", command, args, options: spawnOptions });
      const sessionId = args[args.indexOf("--session-id") + 1];
      const child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.stdin = new Writable({ write(chunk, _encoding, callback) { submitted = JSON.parse(chunk.toString()); callback(); } });
      child.kill = (signal) => {
        kills.push(signal);
        if (!options.ignoreTerm || signal === "SIGKILL") setImmediate(() => child.emit("close", null, signal));
      };
      setImmediate(() => {
        if (options.spawnError) { child.emit("error", new Error("spawn claude ENOENT")); return; }
        const init = { type: "system", subtype: "init", session_id: sessionId, model: "claude-fable-5-1" };
        const replay = { ...submitted, isReplay: true };
        const result = { type: "result", subtype: "success", session_id: sessionId, is_error: false,
          result: "Done ✓", usage: { input_tokens: 10, output_tokens: 3 }, total_cost_usd: 0.01 };
        const events = options.events ? options.events({ init, replay, result }) : [init, replay, result];
        const bytes = Buffer.from(events.map((event) => typeof event === "string" ? event : JSON.stringify(event)).join("\n") + (options.hang ? "\n" : ""));
        for (const byte of bytes) child.stdout.write(Buffer.from([byte]));
        if (!options.hang) child.emit("close", options.exitCode ?? 0, null);
      });
      return child;
    },
  };
}

function claudeWorkerContext(home, receipt, runtime) {
  return { ...workerContext(home, receipt, runtime),
    routineClaudeSessionImpl: runtime.routineClaudeSessionImpl, runClaudeCliImpl: runtime.runClaudeCliImpl };
}

test("Claude routine keeps its managed account through one prompt and exact interactive resume", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, claudeDefinition(home));
  const runtime = makeClaudeRuntime(home);
  const context = claudeWorkerContext(home, receipt, runtime);
  Object.assign(context.env, { ANTHROPIC_API_KEY: "do-not-use", CLAUDE_CODE_OAUTH_TOKEN: "do-not-use", ANTHROPIC_BASE_URL: "https://wrong.test", PATH: "/bin" });
  const worker = executeRoutineWorker(context);
  await waitUntil(() => runtime.calls.length === 2, "Claude TUI did not open");
  const saved = JSON.parse(fs.readFileSync(receipt.receiptPath));
  assert.equal(saved.outcome, "completed");
  assert.equal(saved.selectedAccount.binding, "fable-a");
  assert.equal(saved.claude.sessionId, runtime.submitted.session_id);
  assert.equal(saved.claude.costUsd, 0.01);
  assert.deepEqual(saved.claude.usage, { input_tokens: 10, output_tokens: 3 });
  assert.equal(saved.prompt.stdinSha256, saved.prompt.effectiveSha256);
  assert.equal(saved.prompt.persistedSha256, null);
  assert.equal(runtime.submitted.message.content, fs.readFileSync(receipt.configured.promptFile, "utf8").trim());
  assert.equal(fs.statSync(saved.claude.eventsPath).mode & 0o777, 0o600);
  assert.match(fs.readFileSync(saved.claude.eventsPath, "utf8"), /Done ✓/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);
  assert.equal(runtime.leaseHeld, true);
  const [print, resume] = runtime.calls;
  assert.equal(print.options.env.CLAUDE_CONFIG_DIR, runtime.configDir);
  assert.equal(print.options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, runtime.configDir);
  assert.equal(print.options.env.HOME, home);
  assert.equal(print.options.env.ANTHROPIC_API_KEY, undefined);
  assert.equal(print.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(print.options.env.ANTHROPIC_BASE_URL, undefined);
  assert.ok(print.options.env.PATH.startsWith(path.join(home, "adapter")));
  assert.equal(print.args.includes("--plugin-dir"), true);
  assert.equal(print.args.includes("--replay-user-messages"), true);
  assert.deepEqual(resume.launch.args, ["--model", "claude-fable-5-1", "--effort", "xhigh", "--dangerously-skip-permissions", "--resume", saved.claude.sessionId]);
  runtime.closeTui();
  const completed = await worker;
  assert.equal(completed.interactiveTui.exitCode, 0);
  assert.equal(runtime.leaseHeld, false);
});

for (const [name, options, error, outcome] of [
  ["no eligible account", { accountError: true }, /No unlocked Claude account/, "failed_before_prompt"],
  ["missing executable", { spawnError: true }, /ENOENT/, "failed_before_prompt"],
  ["missing completion", { events: ({ init, replay }) => [init, replay] }, /without a completed turn/, "needs_attention"],
  ["failed result", { events: ({ init, replay, result }) => [init, replay, { ...result, subtype: "error_during_execution", is_error: true, errors: ["rate limited"] }] }, /rate limited/, "needs_attention"],
  ["unclean exit", { exitCode: 1 }, /exited 1/, "needs_attention"],
  ["malformed event", { events: () => ["{broken-json"] }, /JSON/, "failed_before_prompt"],
  ["wrong session", { events: ({ init, result }) => [init, { ...result, session_id: "wrong" }] }, /unexpected session ID/, "needs_attention"],
  ["wrong acknowledgement", { events: ({ init, replay }) => [init, { ...replay, message: { content: "wrong" } }] }, /different or repeated routine prompt/, "needs_attention"],
  ["missing acknowledgement", { events: ({ init, result }) => [init, result] }, /without acknowledging/, "needs_attention"],
  ["timeout", { hang: true, ignoreTerm: true, events: ({ init, replay }) => [init, replay] }, /exceeded/, "needs_attention"],
]) {
  test(`Claude routine handles ${name} without resubmission or retained locks`, async () => {
    const home = mkTempHome();
    const { receipt } = await prepareQueuedWorker(home, claudeDefinition(home));
    const runtime = makeClaudeRuntime(home, options);
    const context = claudeWorkerContext(home, receipt, runtime);
    context.routineTimeouts.killGraceMs = 5;
    await assert.rejects(executeRoutineWorker(context), error);
    assert.equal(JSON.parse(fs.readFileSync(receipt.receiptPath)).outcome, outcome);
    assert.equal(context.getExitCode(), 1);
    assert.equal(runtime.calls.some((call) => call.type === "resume"), false);
    assert.equal(runtime.leaseHeld, false);
    assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-locks", "demo")), false);
    assert.equal(fs.existsSync(path.join(home, ".aimgr", "routine-bootstrap.lock")), false);
    if (options.ignoreTerm) assert.deepEqual(runtime.kills, ["SIGTERM", "SIGKILL"]);
  });
}

test("Claude account lease loss stops the running task before releasing account ownership", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, claudeDefinition(home));
  const runtime = makeClaudeRuntime(home, { hang: true, events: ({ init, replay }) => [init, replay] });
  const context = claudeWorkerContext(home, receipt, runtime);
  const worker = executeRoutineWorker(context);
  const rejected = assert.rejects(worker, /account lease lost/);
  await waitUntil(() => JSON.parse(fs.readFileSync(receipt.receiptPath)).outcome === "prompt_admitted", "prompt was not admitted");
  runtime.abort.abort();
  await rejected;
  assert.deepEqual(runtime.kills, ["SIGTERM"]);
  assert.equal(runtime.leaseHeld, false);
});

test("Claude resume failure keeps the completed task and cleans up the account", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, claudeDefinition(home));
  const runtime = makeClaudeRuntime(home, { resumeError: true });
  const context = claudeWorkerContext(home, receipt, runtime);
  const result = await executeRoutineWorker(context);
  assert.equal(result.outcome, "completed");
  assert.equal(result.needsAttention, true);
  assert.match(result.interactiveTui.error, /resume unavailable/);
  assert.equal(context.getExitCode(), 1);
  assert.equal(runtime.leaseHeld, false);
});

test("Claude prompt drift fails before account selection", async () => {
  const home = mkTempHome();
  const { receipt } = await prepareQueuedWorker(home, claudeDefinition(home));
  fs.appendFileSync(receipt.configured.promptFile, "Changed after claim");
  const runtime = makeClaudeRuntime(home);
  await assert.rejects(executeRoutineWorker(claudeWorkerContext(home, receipt, runtime)), /prompt changed/);
  assert.equal(runtime.calls.length, 0);
});

test("scheduled Claude occurrences deduplicate and prevent overlap", async () => {
  const home = mkTempHome();
  configure(home, claudeDefinition(home));
  const calls = [];
  const deps = { env: { HOME: home }, routineNow: new Date(2026, 7, 15, 7, 5, 0),
    spawnSyncImpl: fakeParentSpawn(calls, home), routineWorkspaceMoveImpl: fakeWorkspaceMove };
  const argv = ["routine", "run", "demo", "--json", "--home", home];
  const first = JSON.parse(await runCli(argv, deps));
  assert.equal(first.outcome, "queued");
  assert.equal(first.configured.agent, "claude");
  assert.equal(JSON.parse(await runCli(argv, deps)).outcome, "duplicate");
  assert.equal(JSON.parse(await runCli([...argv, "--manual"], deps)).outcome, "overlap");
  assert.equal(calls.filter((call) => call.args.includes("create")).length, 1);
});
