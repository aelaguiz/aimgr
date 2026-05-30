import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { activateCodexPoolSelection, preserveLiveCodexAuthForActiveLabel } from "../../src/targets/codex-cli.js";
import { runCodexTender } from "../../src/targets/codex-tender.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

const SESSION_ID = "019e5487-026d-7f52-8fbd-1d123045f1c6";
const OTHER_SESSION_ID = "019e5487-026d-7f52-8fbd-1d123045f1c7";
const TEST_REMOTE = "ws://aimgr-test";

function writeMinimalState(home) {
  writeJson(path.join(home, ".aimgr", "secrets.json"), {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });
}

function createFakeTmux() {
  const tmux = {
    alive: false,
    phase: "initial",
    completeAfterNextGoalRead: false,
    newSessions: [],
    sentExit: 0,
    sentEnter: 0,
    attached: 0,
    newSession({ sessionName, cwd, command }) {
      this.alive = true;
      this.phase = command.includes(" resume ") ? "resume" : "initial";
      this.newSessions.push({ sessionName, cwd, command });
    },
    hasSession() {
      if (this.completeAfterNextGoalRead && this.sentEnter > 0) {
        this.alive = false;
      }
      return this.alive;
    },
    capturePane() {
      if (this.phase === "resume") {
        return [
          "Resume paused goal?",
          "1. Resume goal   Mark it active and continue when idle",
          "2. Leave paused  Keep it paused; use /goal resume later",
        ].join("\n");
      }
      return "";
    },
    sendExit() {
      this.sentExit += 1;
      this.alive = false;
    },
    sendEnter() {
      this.sentEnter += 1;
    },
    attach() {
      this.attached += 1;
      return { exitCode: 0 };
    },
  };
  return tmux;
}

function createFakePrivateCodexAppServers({ loadedThreadIds = [["thread-1"]], getThreadGoal = async () => null } = {}) {
  const servers = [];
  return {
    servers,
    async startCodexAppServerImpl() {
      const index = servers.length;
      const server = {
        remoteUrl: `ws://aimgr-test-${index + 1}`,
        stopped: false,
        client: {
          listLoadedThreads: async () => loadedThreadIds[Math.min(index, loadedThreadIds.length - 1)] ?? [],
          getThreadGoal: async ({ threadId }) => getThreadGoal({ threadId, serverIndex: index }),
        },
        stop() {
          server.stopped = true;
        },
      };
      servers.push(server);
      return server;
    },
  };
}

test("codex run --tend wires tmux supervision options and Codex args", async () => {
  let captured = null;
  const out = await runCli(
    [
      "codex",
      "run",
      "--tend",
      "--no-attach",
      "--tmux-session",
      "overnight-codex",
      "--codex-bin",
      "/tmp/codex-bin",
      "--max-restarts",
      "2",
      "--poll-seconds",
      "0.25",
      "-p",
      "yolo",
      "--",
      "--model",
      "gpt-5.5",
      "--search",
    ],
    {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          sessionName: params.sessionName,
          threadId: "thread-1",
          restarts: 0,
          events: [],
        };
      },
    },
  );

  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.tended.status, "ended");
  assert.equal(captured.sessionName, "overnight-codex");
  assert.equal(captured.codexBin, "/tmp/codex-bin");
  assert.equal(captured.attach, false);
  assert.equal(captured.maxRestarts, "2");
  assert.equal(captured.pollSeconds, "0.25");
  assert.equal(captured.codexProfile, "yolo");
  assert.deepEqual(captured.codexArgs, ["--model", "gpt-5.5", "--search"]);
});

for (const flag of ["--profile", "--codex-profile"]) {
  test(`codex run --tend accepts ${flag} for Codex profile selection`, async () => {
    let captured = null;
    await runCli(["codex", "run", "--tend", "--no-attach", flag, "yolo"], {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          sessionName: params.sessionName,
          threadId: "thread-1",
          restarts: 0,
          events: [],
        };
      },
    });

    assert.equal(captured.codexProfile, "yolo");
  });
}

for (const flag of ["--resume", "--session-id"]) {
  test(`codex run --tend accepts ${flag} for existing Codex session tending`, async () => {
    let captured = null;
    await runCli(["codex", "run", "--tend", "--no-attach", "-p", "yolo", flag, SESSION_ID], {
      runCodexTenderImpl: async (params) => {
        captured = params;
        return {
          status: "ended",
          sessionName: params.sessionName,
          threadId: SESSION_ID,
          restarts: 0,
          events: [],
        };
      },
    });

    assert.equal(captured.codexProfile, "yolo");
    assert.equal(captured.resumeSessionId, SESSION_ID);
  });
}

test("codex run --tend reports blocked tender with exit code 1", async () => {
  const result = await runCliWithExitCode(["codex", "run", "--tend", "--no-attach"], {
    runCodexTenderImpl: async () => ({
      status: "blocked",
      reason: "rotation_blocked",
      events: [],
    }),
  });

  assert.equal(result.exitCode, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.tended.status, "blocked");
  assert.equal(parsed.tended.reason, "rotation_blocked");
});

test("runCodexTender tends an explicit resumed Codex session without thread discovery", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let rotations = 0;
  let goalReads = 0;
  const appServerClient = {
    listThreads: async () => {
      throw new Error("explicit resume should not discover recent threads");
    },
    getThreadGoal: async ({ threadId }) => {
      assert.equal(threadId, SESSION_ID);
      goalReads += 1;
      if (goalReads === 1) {
        return { threadId: SESSION_ID, status: "usageLimited" };
      }
      tmux.completeAfterNextGoalRead = true;
      return { threadId: SESSION_ID, status: "complete" };
    },
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      codexProfile: "yolo",
      resumeSessionId: SESSION_ID,
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
    },
    {
      tmux,
      appServerClient,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, SESSION_ID);
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.equal(tmux.sentEnter, 2);
  assert.deepEqual(
    tmux.newSessions.map((session) => session.command),
    [
      `/tmp/codex --no-alt-screen --remote ${TEST_REMOTE} -p yolo resume ${SESSION_ID}`,
      `/tmp/codex --no-alt-screen --remote ${TEST_REMOTE} -p yolo resume ${SESSION_ID}`,
    ],
  );
  assert.ok(result.events.some((event) => event.type === "thread_provided" && event.threadId === SESSION_ID));
});

test("runCodexTender accepts exact Codex resume passthrough for existing sessions", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  tmux.completeAfterNextGoalRead = true;

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      codexArgs: ["resume", SESSION_ID],
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => {
          throw new Error("resume passthrough should not discover recent threads");
        },
        getThreadGoal: async ({ threadId }) => {
          assert.equal(threadId, SESSION_ID);
          return { threadId: SESSION_ID, status: "complete" };
        },
      },
      sleepImpl: async () => {},
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, SESSION_ID);
  assert.equal(tmux.sentEnter, 1);
  assert.equal(tmux.newSessions[0].command, `/tmp/codex --no-alt-screen --remote ${TEST_REMOTE} resume ${SESSION_ID}`);
});

test("runCodexTender rejects unsafe resumed-session inputs before starting tmux", async () => {
  const home = mkTempHome();
  writeMinimalState(home);

  const cases = [
    {
      input: { resumeSessionId: "--last" },
      expected: /Codex session id from AIMGR options must be a UUID/,
    },
    {
      input: { codexArgs: ["resume", "--last"] },
      expected: /Codex session id from Codex resume passthrough must be a UUID/,
    },
    {
      input: { codexArgs: ["resume", "my-thread"] },
      expected: /Codex session id from Codex resume passthrough must be a UUID/,
    },
    {
      input: { resumeSessionId: SESSION_ID, codexArgs: ["resume", OTHER_SESSION_ID] },
      expected: /Conflicting Codex session ids/,
    },
    {
      input: { codexArgs: ["resume", SESSION_ID, "continue"] },
      expected: /only supports `resume <SESSION_ID>`/,
    },
    {
      input: { resumeSessionId: SESSION_ID, codexArgs: ["--model", "gpt-5.5"] },
      expected: /pass-through args are not supported with tended resume sessions/,
    },
    {
      input: { codexArgs: ["--remote", "ws://127.0.0.1:12345"] },
      expected: /TEND owns the Codex --remote endpoint/,
    },
    {
      input: { codexArgs: ["--remote=ws://127.0.0.1:12345"] },
      expected: /TEND owns the Codex --remote endpoint/,
    },
    {
      input: { codexArgs: ["--remote-auth-token-env", "TOKEN"] },
      expected: /TEND owns the Codex remote auth wiring/,
    },
  ];

  for (const { input, expected } of cases) {
    const tmux = createFakeTmux();
    await assert.rejects(
      runCodexTender(
        {
          statePath: path.join(home, ".aimgr", "secrets.json"),
          homeDir: home,
          sessionName: "aimgr-test",
          attach: false,
          preflight: false,
          ...input,
        },
        {
          tmux,
        },
      ),
      expected,
    );
    assert.equal(tmux.newSessions.length, 0);
  }
});

test("runCodexTender rotates usage-limited goals and confirms the built-in resume prompt", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let rotations = 0;
  let goalReads = 0;
  const appServerClient = {
    listThreads: async () => [
      {
        id: "thread-1",
        cwd: "/tmp/project",
        createdAt: 1779500000,
        updatedAt: 1779500001,
      },
    ],
    getThreadGoal: async () => {
      goalReads += 1;
      if (goalReads === 1) {
        return { threadId: "thread-1", status: "usageLimited" };
      }
      tmux.completeAfterNextGoalRead = true;
      return { threadId: "thread-1", status: "complete" };
    },
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      codexProfile: "yolo",
      codexArgs: ["--model", "gpt-5.5"],
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.equal(tmux.sentExit, 1);
  assert.equal(tmux.sentEnter, 1);
  assert.equal(tmux.newSessions.length, 2);
  assert.match(tmux.newSessions[0].command, /\/tmp\/codex --no-alt-screen --remote ws:\/\/aimgr-test -p yolo --model gpt-5\.5/);
  assert.match(tmux.newSessions[1].command, /\/tmp\/codex --no-alt-screen --remote ws:\/\/aimgr-test -p yolo resume thread-1/);
  assert.doesNotMatch(tmux.newSessions[1].command, /\/goal resume/);
  assert.ok(result.events.some((event) => event.type === "resume_prompt_confirmed"));
});

test("runCodexTender binds to its private loaded thread instead of a same-cwd sibling", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let rotations = 0;
  let goalReads = 0;
  const privateAppServers = createFakePrivateCodexAppServers({
    loadedThreadIds: [["thread-intended"], ["thread-intended"]],
    getThreadGoal: async ({ threadId }) => {
      assert.equal(threadId, "thread-intended");
      goalReads += 1;
      if (goalReads === 1) {
        return { threadId, status: "usageLimited" };
      }
      tmux.completeAfterNextGoalRead = true;
      return { threadId, status: "complete" };
    },
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
    },
    {
      tmux,
      startCodexAppServerImpl: privateAppServers.startCodexAppServerImpl,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, "thread-intended");
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.equal(privateAppServers.servers.length, 2);
  assert.equal(privateAppServers.servers[0].stopped, true);
  assert.equal(privateAppServers.servers[1].stopped, true);
  assert.deepEqual(
    tmux.newSessions.map((session) => session.command),
    [
      "/tmp/codex --no-alt-screen --remote ws://aimgr-test-1",
      "/tmp/codex --no-alt-screen --remote ws://aimgr-test-2 resume thread-intended",
    ],
  );
  assert.ok(tmux.newSessions.every((session) => !session.command.includes("thread-sibling")));
});

test("runCodexTender blocks instead of guessing when private loaded threads are ambiguous", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let rotations = 0;
  const privateAppServers = createFakePrivateCodexAppServers({
    loadedThreadIds: [["thread-intended", "thread-sibling"]],
  });

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
    },
    {
      tmux,
      startCodexAppServerImpl: privateAppServers.startCodexAppServerImpl,
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return { status: "activated" };
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "ambiguous_loaded_threads");
  assert.equal(result.threadId, null);
  assert.equal(result.restarts, 0);
  assert.equal(rotations, 0);
  assert.equal(privateAppServers.servers.length, 1);
  assert.equal(privateAppServers.servers[0].stopped, false);
  assert.deepEqual(
    tmux.newSessions.map((session) => session.command),
    ["/tmp/codex --no-alt-screen --remote ws://aimgr-test-1"],
  );
  assert.ok(result.events.some((event) => event.type === "thread_binding_ambiguous"));
  assert.ok(result.events.some((event) => event.type === "app_server_left_running_for_live_session"));
});

test("runCodexTender promotes pass-through profile args to the resume command", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let goalReads = 0;

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      codexArgs: ["--model", "gpt-5.5", "--profile", "yolo", "--search"],
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => {
          goalReads += 1;
          if (goalReads === 1) {
            return { threadId: "thread-1", status: "usageLimited" };
          }
          tmux.completeAfterNextGoalRead = true;
          return { threadId: "thread-1", status: "complete" };
        },
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => ({
        status: "activated",
        receipt: { label: "pro2", blockers: [], warnings: [] },
        wrote: true,
      }),
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(tmux.newSessions.length, 2);
  assert.match(tmux.newSessions[0].command, /\/tmp\/codex --no-alt-screen --remote ws:\/\/aimgr-test -p yolo --model gpt-5\.5 --search/);
  assert.match(tmux.newSessions[1].command, /\/tmp\/codex --no-alt-screen --remote ws:\/\/aimgr-test -p yolo resume thread-1/);
  assert.doesNotMatch(tmux.newSessions[0].command, /--profile yolo/);
});

test("runCodexTender rejects conflicting Codex profile inputs before starting tmux", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();

  await assert.rejects(
    runCodexTender(
      {
        statePath: path.join(home, ".aimgr", "secrets.json"),
        homeDir: home,
        codexProfile: "yolo",
        codexArgs: ["--profile", "other"],
        sessionName: "aimgr-test",
        attach: false,
        preflight: false,
      },
      {
        tmux,
      },
    ),
    /Conflicting Codex profiles: yolo from AIMGR options and other from --profile/,
  );
  assert.equal(tmux.newSessions.length, 0);
});

test("runCodexTender blocks instead of rotating again when the resume prompt cannot be confirmed", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  tmux.capturePane = () => "";
  let rotations = 0;

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      promptTimeoutSeconds: 0,
      maxRestarts: 3,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => ({ threadId: "thread-1", status: "usageLimited" }),
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "resume_prompt_unconfirmed");
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.equal(tmux.newSessions.length, 2);
  assert.ok(result.events.some((event) => event.type === "resume_prompt_timeout"));
});

test("runCodexTender exits without rotation when no stopped goal exists", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  tmux.hasSession = () => false;
  let rotations = 0;

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return { status: "activated" };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.restarts, 0);
  assert.equal(rotations, 0);
  assert.equal(tmux.sentExit, 0);
  assert.equal(tmux.sentEnter, 0);
  assert.equal(tmux.newSessions.length, 1);
});

test("runCodexTender rotates and resumes non-goal sessions when the pane shows a rate limit", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let initialPaneCaptures = 0;
  let rotationArgs = null;
  tmux.capturePane = () => {
    if (tmux.phase === "resume") return "";
    initialPaneCaptures += 1;
    return initialPaneCaptures === 1 ? "" : "Rate limit reached for gpt-5. Please try again later.";
  };
  tmux.hasSession = function hasSession() {
    if (this.phase === "resume" && this.newSessions.length >= 2) return false;
    return this.alive;
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async (args) => {
        rotationArgs = args;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.restarts, 1);
  assert.equal(rotationArgs.avoidCurrentLabel, true);
  assert.equal(tmux.sentExit, 1);
  assert.equal(tmux.sentEnter, 0);
  assert.deepEqual(
    tmux.newSessions.map((session) => session.command),
    [
      `/tmp/codex --no-alt-screen --remote ${TEST_REMOTE}`,
      `/tmp/codex --no-alt-screen --remote ${TEST_REMOTE} resume thread-1`,
    ],
  );
  assert.ok(result.events.some((event) => event.type === "recovery_triggered" && event.source === "pane"));
});

test("runCodexTender reattaches after recovery when the old tmux attach exits late", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  const attachHandles = [];
  let initialPaneCaptures = 0;
  tmux.capturePane = () => {
    if (tmux.phase === "resume") return "";
    initialPaneCaptures += 1;
    return initialPaneCaptures === 1 ? "" : "Too many requests. Please try again later.";
  };
  tmux.hasSession = function hasSession() {
    if (this.phase === "resume" && this.newSessions.length >= 2) return false;
    return this.alive;
  };
  tmux.attach = (sessionName) => {
    const handle = { exitCode: null, signalCode: null, sessionName };
    attachHandles.push(handle);
    return handle;
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: true,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {
        if (attachHandles[0] && attachHandles[0].exitCode === null) {
          attachHandles[0].exitCode = 0;
        }
      },
      activateCodexPoolSelectionImpl: async () => ({
        status: "activated",
        receipt: { label: "pro2", blockers: [], warnings: [] },
        wrote: true,
      }),
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.restarts, 1);
  assert.equal(attachHandles.length, 2);
  assert.equal(attachHandles[0].sessionName, "aimgr-test");
  assert.equal(attachHandles[1].sessionName, "aimgr-test");
  assert.equal(result.events.filter((event) => event.type === "session_attached").length, 2);
});

test("runCodexTender rotates non-goal sessions when the active usage snapshot is hard limited", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeMinimalState(home);
  const state = JSON.parse(fs.readFileSync(statePath, "utf8"));
  state.targets.codexCli.activeLabel = "boss";
  writeJson(statePath, state);
  const tmux = createFakeTmux();
  tmux.capturePane = () => "";
  tmux.hasSession = function hasSession() {
    if (this.phase === "resume" && this.newSessions.length >= 2) return false;
    return this.alive;
  };
  let rotations = 0;

  const result = await runCodexTender(
    {
      statePath,
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      probeUsageSnapshotsByProviderImpl: async () => ({
        "openai-codex": {
          boss: {
            ok: true,
            allowed: false,
            limitReached: true,
            rateLimitReachedType: "primary",
            windows: [{ kind: "primary", usedPercent: 100 }, { kind: "secondary", usedPercent: 40 }],
          },
        },
      }),
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.ok(result.events.some((event) => event.type === "recovery_triggered" && event.source === "usage"));
});

test("runCodexTender resumes an explicit non-goal Codex session without waiting for a goal prompt", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let hasSessionCalls = 0;
  tmux.capturePane = () => "";
  tmux.hasSession = () => {
    hasSessionCalls += 1;
    return hasSessionCalls === 1;
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      codexBin: "/tmp/codex",
      resumeSessionId: SESSION_ID,
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => {
          throw new Error("explicit resume should not discover recent threads");
        },
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, SESSION_ID);
  assert.equal(result.restarts, 0);
  assert.equal(tmux.sentEnter, 0);
  assert.equal(tmux.newSessions.length, 1);
  assert.ok(result.events.some((event) => event.type === "resume_prompt_not_present"));
});

test("runCodexTender does not rotate on rate-limit text that was already present at session start", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let hasSessionCalls = 0;
  let rotations = 0;
  tmux.capturePane = () => "Rate limit reached for gpt-5. Please try again later.";
  tmux.hasSession = () => {
    hasSessionCalls += 1;
    return hasSessionCalls === 1;
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return { status: "activated" };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.restarts, 0);
  assert.equal(rotations, 0);
  assert.equal(tmux.sentExit, 0);
});

test("runCodexTender waits for a thread id before recovering from a non-goal rate limit", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let initialPaneCaptures = 0;
  let listReads = 0;
  let rotations = 0;
  tmux.capturePane = () => {
    if (tmux.phase === "resume") return "";
    initialPaneCaptures += 1;
    return initialPaneCaptures === 1 ? "" : "Too many requests. Please try again later.";
  };
  tmux.hasSession = function hasSession() {
    if (this.phase === "resume" && this.newSessions.length >= 2) return false;
    return this.alive;
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      codexBin: "/tmp/codex",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      maxPollIterations: 4,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => {
          listReads += 1;
          if (listReads === 1) return [];
          return [
            {
              id: "thread-1",
              cwd: "/tmp/project",
              createdAt: 1779500000,
              updatedAt: 1779500001,
            },
          ];
        },
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => {
        rotations += 1;
        return {
          status: "activated",
          receipt: { label: "pro2", blockers: [], warnings: [] },
          wrote: true,
        };
      },
    },
  );

  assert.equal(result.status, "ended");
  assert.equal(result.threadId, "thread-1");
  assert.equal(result.restarts, 1);
  assert.equal(rotations, 1);
  assert.ok(result.events.some((event) => event.type === "rate_limit_recovery_waiting_for_thread"));
});

test("runCodexTender leaves the current non-goal session alive when no alternate account exists", async () => {
  const home = mkTempHome();
  writeMinimalState(home);
  const tmux = createFakeTmux();
  let initialPaneCaptures = 0;
  tmux.capturePane = () => {
    initialPaneCaptures += 1;
    return initialPaneCaptures === 1 ? "" : "exceeded retry limit, last status: 429";
  };

  const result = await runCodexTender(
    {
      statePath: path.join(home, ".aimgr", "secrets.json"),
      homeDir: home,
      cwd: "/tmp/project",
      sessionName: "aimgr-test",
      attach: false,
      preflight: false,
      pollSeconds: 0,
      maxRestarts: 1,
      startedAtMs: 1_779_500_000_000,
    },
    {
      tmux,
      appServerClient: {
        listThreads: async () => [
          {
            id: "thread-1",
            cwd: "/tmp/project",
            createdAt: 1779500000,
            updatedAt: 1779500001,
          },
        ],
        getThreadGoal: async () => null,
      },
      sleepImpl: async () => {},
      activateCodexPoolSelectionImpl: async () => ({
        status: "blocked",
        receipt: {
          blockers: [{ reason: "no_alternate_pool_account" }],
          warnings: [],
        },
        wrote: false,
      }),
    },
  );

  assert.equal(result.status, "blocked");
  assert.equal(result.reason, "no_alternate_pool_account");
  assert.equal(result.restarts, 0);
  assert.equal(tmux.sentExit, 0);
  assert.equal(tmux.alive, true);
  assert.equal(tmux.newSessions.length, 1);
});

test("activateCodexPoolSelection can require an alternate without clearing the current auth", async () => {
  const home = mkTempHome();
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "REFRESH_BOSS",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
      },
    },
    pool: { openaiCodex: { history: [] } },
  };

  const result = await activateCodexPoolSelection({
    state,
    homeDir: home,
    observedAt: "2026-05-23T00:00:00.000Z",
    usageByProvider: {
      "openai-codex": {
        boss: {
          ok: true,
          windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
        },
      },
    },
    selectionMode: "weighted_usage",
    avoidCurrentLabel: true,
  });

  assert.equal(result.status, "blocked");
  assert.equal(result.receipt.blockers[0].reason, "no_alternate_pool_account");
  assert.equal(state.targets.codexCli.activeLabel, "boss");
  const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
});

test("preserveLiveCodexAuthForActiveLabel stores refreshed live auth before rotation", () => {
  const home = mkTempHome();
  const oldJwt = makeFakeJwt({
    email: "boss@example.com",
    exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const newJwt = makeFakeJwt({
    email: "boss@example.com",
    exp: Math.floor(Date.now() / 1000) + 7200,
    refreshed: true,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const oldCredential = {
    access: oldJwt,
    refresh: "OLD_REFRESH",
    idToken: oldJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_boss",
  };
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: oldCredential },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_boss",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(oldCredential),
              dirtyLocal: false,
            },
          },
        },
        anthropic: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
      },
    },
    pool: { openaiCodex: { history: [] } },
  };
  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: newJwt,
      access_token: newJwt,
      refresh_token: "NEW_REFRESH",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });

  const preserved = preserveLiveCodexAuthForActiveLabel({ state, homeDir: home, observedAt: "2026-05-23T00:00:00.000Z" });

  assert.equal(preserved.status, "updated");
  assert.equal(preserved.label, "boss");
  assert.equal(state.credentials["openai-codex"].boss.access, newJwt);
  assert.equal(state.credentials["openai-codex"].boss.refresh, "NEW_REFRESH");
  assert.equal(state.credentials["openai-codex"].boss.idToken, newJwt);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyObservedAt, "2026-05-23T00:00:00.000Z");
  assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), true);
});
