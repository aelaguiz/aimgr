import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { Readable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { refreshOrLoginCodex } from "../../src/credentials/codex-login.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { installFakeOpenclaw, readFakeOpenclawRestarts, readFakeOpenclawSessionPatches } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson, writeOpenclawAuthStore, writeOpenclawSessionsStore } from "../helpers/files.js";

test("refreshOrLoginCodex manual-callback prompts for callback URL and skips browser launch", async () => {
  const state = {
    schemaVersion: "0.2",
    accounts: {
      manual_label: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: { pins: {}, browserProfiles: {} },
      codexCli: {},
      interactiveOAuth: { bindings: { manual_label: { mode: "manual-callback" } } },
    },
  };

  const prompts = [];
  const pastedValues = [];
  let openUrlCalls = 0;

  const cred = await refreshOrLoginCodex({
    state,
    label: "manual_label",
    homeDir: mkTempHome(),
    interactiveBinding: { mode: "manual-callback" },
    loginImpl: async ({ onAuth, onManualCodeInput, onPrompt, originator }) => {
      assert.equal(originator, "aimgr");
      onAuth({ url: "https://auth.openai.example/authorize" });
      pastedValues.push(await onManualCodeInput());
      pastedValues.push(await onPrompt());
      return {
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: Date.now() + 3600_000,
        accountId: "acct_manual",
      };
    },
    promptImpl: async (question) => {
      prompts.push(question);
      return "http://localhost:1455/auth/callback?code=CODE123&state=STATE456";
    },
    openUrlImpl: () => {
      openUrlCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(openUrlCalls, 0);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((question) => question.includes("Paste the full callback URL")));
  assert.deepEqual(pastedValues, [
    "http://localhost:1455/auth/callback?code=CODE123&state=STATE456",
    "http://localhost:1455/auth/callback?code=CODE123&state=STATE456",
  ]);
  assert.equal(cred.accountId, "acct_manual");
  assert.equal(cred.idToken, "ACCESS_TOKEN");
});

test("login --manual-callback-stdio emits auth_url JSONL and reads callback JSON from stdin", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  let openUrlCalls = 0;
  const callbackUrl = "http://localhost:1455/auth/callback?code=CODE123&state=STATE456";
  const out = await runCli(["login", "pro1", "--manual-callback-stdio", "--home", home], {
    stdin: Readable.from([`${JSON.stringify({ type: "callback_url", url: callbackUrl })}\n`]),
    openUrlImpl: () => {
      openUrlCalls += 1;
      return { ok: true };
    },
    loginOpenAICodexImpl: async ({ onAuth, onManualCodeInput, originator }) => {
      assert.equal(originator, "aimgr");
      onAuth({ url: "https://auth.openai.example/authorize" });
      assert.equal(await onManualCodeInput(), callbackUrl);
      return {
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: Date.now() + 3600_000,
        accountId: "acct_pro1",
      };
    },
  });

  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(openUrlCalls, 0);
  assert.deepEqual(lines[0], {
    type: "auth_url",
    label: "pro1",
    provider: "openai-codex",
    url: "https://auth.openai.example/authorize",
  });
  assert.equal(lines[1].type, "result");
  assert.equal(lines[1].ok, true);
  assert.equal(lines[1].label, "pro1");
  assert.equal(lines[1].provider, "openai-codex");

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.credentials["openai-codex"].pro1.accountId, "acct_pro1");
  assert.equal(persisted.credentials["openai-codex"].pro1.refresh, "REFRESH_TOKEN");
});

test("login --manual-callback-stdio accepts a raw callback URL on stdin", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const callbackUrl = "http://localhost:1455/auth/callback?code=RAWCODE&state=RAWSTATE";
  const out = await runCli(["login", "pro1", "--manual-callback-stdio", "--home", home], {
    stdin: Readable.from([`${callbackUrl}\n`]),
    loginOpenAICodexImpl: async ({ onAuth, onManualCodeInput }) => {
      onAuth({ url: "https://auth.openai.example/authorize" });
      assert.equal(await onManualCodeInput(), callbackUrl);
      return {
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: Date.now() + 3600_000,
        accountId: "acct_pro1",
      };
    },
  });

  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines[0].type, "auth_url");
  assert.equal(lines[1].type, "result");
  assert.equal(lines[1].ok, true);
});

test("login --manual-callback-stdio refresh success emits only result JSONL", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        pro1: {
          access: "OLD_ACCESS",
          refresh: "OLD_REFRESH",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          accountId: "acct_pro1",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const out = await runCli(["login", "pro1", "--manual-callback-stdio", "--home", home], {
    stdin: Readable.from([""]),
    loginOpenAICodexImpl: async () => {
      throw new Error("OAuth login should not run after refresh succeeds");
    },
    refreshOpenAICodexImpl: async () => ({
      access: "NEW_ACCESS",
      refresh: "NEW_REFRESH",
      expires: Date.now() + 3600_000,
      accountId: "acct_pro1",
    }),
  });

  const lines = out.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "result");
  assert.equal(lines[0].ok, true);
  assert.equal(lines[0].label, "pro1");
});

test("login --manual-callback-stdio emits JSONL error and nonzero exit when stdin callback is missing", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const result = await runCliWithExitCode(["login", "pro1", "--manual-callback-stdio", "--home", home], {
    stdin: Readable.from([""]),
    loginOpenAICodexImpl: async ({ onAuth, onManualCodeInput }) => {
      onAuth({ url: "https://auth.openai.example/authorize" });
      await onManualCodeInput();
      throw new Error("unreachable");
    },
  });

  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(result.exitCode, 1);
  assert.equal(lines[0].type, "auth_url");
  assert.equal(lines[1].type, "error");
  assert.equal(lines[1].ok, false);
  assert.equal(lines[1].label, "pro1");
  assert.match(lines[1].error, /Missing callback URL on stdin/);
});

test("login --manual-callback-stdio rejects Claude labels as JSONL errors", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      claudalyst: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const result = await runCliWithExitCode(["login", "claudalyst", "--manual-callback-stdio", "--home", home], {
    stdin: Readable.from([""]),
  });
  const lines = result.stdout.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(result.exitCode, 1);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].type, "error");
  assert.equal(lines[0].ok, false);
  assert.equal(lines[0].label, "claudalyst");
  assert.match(lines[0].error, /only supports openai-codex labels/);
});

test("apply materializes only assigned managed profiles and clears stale per-agent overrides", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true }, browser: {} },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true }, browser: {} },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
        qa: {
          access: "ACCESS_TOKEN_QA",
          refresh: "REFRESH_TOKEN_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_456",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawAuthStore(home, "main", {
    version: 1,
    profiles: {
      "openai-codex:boss": { provider: "openai-codex", type: "oauth" },
      "openai-codex:qa": { provider: "openai-codex", type: "oauth" },
    },
    order: {
      "openai-codex": ["openai-codex:boss", "openai-codex:qa"],
    },
  });
  writeOpenclawAuthStore(home, "agent_stale", {
    version: 1,
    profiles: {},
    order: {
      "openai-codex": ["openai-codex:qa"],
    },
    lastGood: {
      "openai-codex": "openai-codex:qa",
    },
  });

  await runCli(["apply", "--home", home]);

  const mainStorePath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const mainStore = JSON.parse(fs.readFileSync(mainStorePath, "utf8"));
  assert.ok(mainStore.profiles["openai-codex:boss"]);
  assert.equal(mainStore.profiles["openai-codex:qa"], undefined);
  assert.equal(mainStore.profiles["openai-codex:boss"].provider, "openai-codex");
  assert.equal(mainStore.order?.["openai-codex"], undefined);
  assert.equal(mainStore.lastGood?.["openai-codex"], undefined);

  const agentStorePath = path.join(home, ".openclaw", "agents", "agent_boss", "agent", "auth-profiles.json");
  const agentStore = JSON.parse(fs.readFileSync(agentStorePath, "utf8"));
  assert.deepEqual(agentStore.order["openai-codex"], ["openai-codex:boss"]);
  assert.equal(agentStore.lastGood["openai-codex"], "openai-codex:boss");

  const staleStorePath = path.join(home, ".openclaw", "agents", "agent_stale", "agent", "auth-profiles.json");
  const staleStore = JSON.parse(fs.readFileSync(staleStorePath, "utf8"));
  assert.equal(staleStore.order?.["openai-codex"], undefined);
  assert.equal(staleStore.lastGood?.["openai-codex"], undefined);
});

test("rebalance openclaw runs the real sync path and then settles to noop on repeat", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: {
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai-codex:qa",
      updatedAt: 1,
    },
  });
  const fetchImpl = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 10 : 88;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    await withEnv(
      {
        HOME: home,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
      async () => {
        const firstOut = await runCli(["rebalance", "openclaw"], { fetchImpl });
        const first = JSON.parse(firstOut);
        assert.equal(first.ok, true);
        assert.equal(first.rebalanced.status, "applied");
        assert.equal(readFakeOpenclawRestarts(home).length, 1);
        assert.equal(readFakeOpenclawSessionPatches(home).length, 0);

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.cleanupMode, "disk");

        const mainStore = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"), "utf8"),
        );
        assert.equal(mainStore.order?.["openai-codex"], undefined);
        assert.equal(mainStore.lastGood?.["openai-codex"], undefined);

        const sessions = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_boss", "sessions", "sessions.json"), "utf8"),
        );
        assert.equal(sessions.s1.modelProvider, undefined);
        assert.equal(sessions.s1.model, undefined);
        assert.equal(sessions.s1.providerOverride, undefined);
        assert.equal(sessions.s1.modelOverride, undefined);
        assert.equal(sessions.s1.authProfileOverride, undefined);

        const secondOut = await runCli(["rebalance", "openclaw"], { fetchImpl });
        const second = JSON.parse(secondOut);
        assert.equal(second.ok, true);
        assert.equal(second.rebalanced.status, "noop");
        assert.equal(readFakeOpenclawRestarts(home).length, 1);
      },
    );
});

test("rebalance openclaw reports blocked at the real CLI boundary when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "aimgr.js"), "rebalance", "openclaw"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  assert.equal(readFakeOpenclawRestarts(home).length, 0);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rebalanced.status, "blocked");
  assert.deepEqual(parsed.rebalanced.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "blocked");
  assert.deepEqual(updatedState.targets.openclaw.lastApplyReceipt.blockers, [{ reason: "no_eligible_pool_account" }]);
});
