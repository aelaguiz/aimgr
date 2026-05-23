import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { preserveLiveCodexAuthForActiveLabel } from "../../src/targets/codex-cli.js";
import { runCodexTender } from "../../src/targets/codex-tender.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

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
  assert.match(tmux.newSessions[0].command, /\/tmp\/codex --no-alt-screen -p yolo --model gpt-5\.5/);
  assert.match(tmux.newSessions[1].command, /\/tmp\/codex --no-alt-screen -p yolo resume thread-1/);
  assert.doesNotMatch(tmux.newSessions[1].command, /\/goal resume/);
  assert.ok(result.events.some((event) => event.type === "resume_prompt_confirmed"));
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
  assert.match(tmux.newSessions[0].command, /\/tmp\/codex --no-alt-screen -p yolo --model gpt-5\.5 --search/);
  assert.match(tmux.newSessions[1].command, /\/tmp\/codex --no-alt-screen -p yolo resume thread-1/);
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
