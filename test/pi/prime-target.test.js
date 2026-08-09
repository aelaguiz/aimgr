import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../../src/cli/args.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

function fixtureState() {
  const access = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_codex" } });
  return {
    schemaVersion: "0.2",
    accounts: {
      pro3: { provider: "openai-codex", reauth: {}, pool: { enabled: true } },
      claude: {
        provider: "anthropic",
        expect: { email: "boss@example.com" },
        reauth: { mode: "native-claude" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        pro3: {
          access,
          refresh: "CODEX_REFRESH",
          idToken: access,
          expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
          accountId: "acct_codex",
        },
      },
      anthropic: {
        claude: buildAnthropicClaudeCredential({ expiresAtMs: Date.now() + 60 * 60_000 }),
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, piCli: {}, primeAgent: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };
}

function writePrimeSession(agentDir, { id, provider, model, binding }) {
  const entries = [
    { type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: "/tmp/prime-project" },
    {
      type: "model_change",
      id: "model-entry",
      parentId: null,
      timestamp: new Date().toISOString(),
      provider,
      modelId: model,
    },
    {
      type: "credential_binding",
      id: "binding-entry",
      parentId: "model-entry",
      timestamp: new Date().toISOString(),
      provider,
      source: "aimgr",
      binding,
      identityFingerprint: `fingerprint:${binding}`,
    },
    {
      type: "message",
      id: "assistant-entry",
      parentId: "model-entry",
      timestamp: new Date().toISOString(),
      message: {
        role: "assistant",
        content: [],
        provider,
        model,
        stopReason: "stop",
        timestamp: Date.now(),
      },
    },
  ];
  const sessionPath = path.join(agentDir, "sessions", `${id}.jsonl`);
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  fs.writeFileSync(sessionPath, `${entries.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  return sessionPath;
}

test("Pi explicit Codex and Claude selections install only non-secret external descriptors", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "pi-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const output = JSON.parse(await runCli([
    "pi", "use", "--codex", "pro3", "--claude", "claude", "--home", home,
  ], {
    env: { PI_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  }));
  assert.equal(output.ok, true);
  assert.equal(output.receipt.providers.length, 2);
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
  assert.equal(auth["openai-codex"].binding, "pro3");
  assert.equal(auth.anthropic.binding, "claude");
  assert.equal(auth["openai-codex"].type, "external");
  assert.equal(auth.anthropic.type, "external");
  assert.doesNotMatch(JSON.stringify(auth), /CODEX_REFRESH|REFRESH_BOSS|ACCESS_BOSS/);
  assert.match(
    fs.readFileSync(path.join(agentDir, "extensions", "session-title-footer.ts"), "utf8"),
    /^\/\/ Managed by aimgr\./,
  );
});

test("harness use projects session identity even when every requested provider is off", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "pi-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const projected = [];

  const result = JSON.parse(await runCli([
    "pi", "use", "--codex", "off", "--claude", "off", "--home", home,
  ], {
    env: { PI_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    ensureHarnessSessionIdentityExtensionImpl: ({ agentDir: selectedAgentDir }) => {
      projected.push(selectedAgentDir);
    },
  }));

  assert.equal(result.ok, true);
  assert.deepEqual(projected, [agentDir]);
});

test("Prime use/status/uninstall uses its agent dir; status degrades and uninstall never opens Redis", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const authPath = path.join(agentDir, "auth.json");
  const native = { type: "api_key", key: "NATIVE_CODEX" };
  writeJson(statePath, fixtureState());
  writeJson(authPath, { "openai-codex": native, unrelated: { type: "api_key", key: "KEEP" } });
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };

  const use = JSON.parse(await runCli([
    "prime", "use", "--codex", "pro3", "--home", home,
  ], { env, connectRedisStoreImpl: redis.connectRedisStoreImpl }));
  assert.equal(use.ok, true);
  assert.equal(JSON.parse(fs.readFileSync(authPath))["openai-codex"].type, "external");

  let redisAttempts = 0;
  const offline = async () => {
    redisAttempts += 1;
    throw new Error("offline secret internals");
  };
  const status = JSON.parse(await runCli(["prime", "status", "--home", home], {
    env,
    connectRedisStoreImpl: offline,
  }));
  assert.equal(status.ok, true);
  assert.equal(status.status.coordination, "unavailable");
  assert.equal(status.status.providers["openai-codex"].installed, true);
  assert.equal(redisAttempts, 1);

  redisAttempts = 0;
  const uninstall = JSON.parse(await runCli([
    "prime", "uninstall", "--provider", "codex", "--home", home,
  ], { env, connectRedisStoreImpl: offline }));
  assert.equal(uninstall.ok, true);
  assert.equal(redisAttempts, 0, "local-only uninstall must dispatch before Redis initialization");
  const restored = JSON.parse(fs.readFileSync(authPath));
  assert.deepEqual(restored["openai-codex"], native);
  assert.deepEqual(restored.unrelated, { type: "api_key", key: "KEEP" });
});


test("Pi use automatically migrates an exact recognized AIM legacy projection without a rollback secret", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "pi-agent");
  const state = fixtureState();
  const credential = state.credentials["openai-codex"].pro3;
  state.targets.piCli = {
    activeLabel: "pro3",
    expectedAccountId: credential.accountId,
    lastAppliedAt: new Date().toISOString(),
  };
  writeJson(statePath, state);
  writeJson(path.join(agentDir, "auth.json"), {
    "openai-codex": {
      type: "oauth",
      access: credential.access,
      refresh: credential.refresh,
      expires: Date.parse(credential.expiresAt),
      accountId: credential.accountId,
    },
  });
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const output = JSON.parse(await runCli([
    "pi", "use", "--codex", "pro3", "--home", home,
  ], {
    env: { PI_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  }));
  assert.equal(output.receipt.providers[0].migratedLegacy, true);
  assert.equal(output.receipt.providers[0].backupPath, null);
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
  assert.equal(auth["openai-codex"].type, "external");
  const local = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json")));
  assert.equal("activeLabel" in local.targets.piCli, false);
  assert.equal("expectedAccountId" in local.targets.piCli, false);
  assert.equal(local.targets.piCli.providers, undefined);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "backups", "harness-auth")), false);
});


test("Prime use codex and claude shorthands choose one provider and turn the other off", async () => {
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
    },
    anthropic: {
      claude: {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 10 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 10 },
        ],
      },
    },
  };

  for (const provider of ["codex", "claude"]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState());
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    const output = JSON.parse(await runCli([
      "prime", "use", provider, "--home", home,
    ], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
    }));
    assert.equal(output.ok, true);
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
    if (provider === "codex") {
      assert.equal(auth["openai-codex"].binding, "pro3");
      assert.equal(auth.anthropic, undefined);
    } else {
      assert.equal(auth.anthropic.binding, "claude");
      assert.equal(auth["openai-codex"], undefined);
    }
  }
});

test("Prime resume parses --rotate and plain resume delegates to Prime without Redis", async () => {
  const parsed = parseArgs(["prime", "resume", "thread-123", "--rotate"]);
  assert.deepEqual(parsed.positional, ["prime", "resume", "thread-123"]);
  assert.equal(parsed.opts.primeResumeRotate, true);
  assert.throws(() => parseArgs(["prime", "run", "codex", "--rotate"]), /Unknown option: --rotate/);
  assert.deepEqual(parseArgs(["claude", "run", "pro3", "--rotate"]).opts.afterDoubleDash, ["--rotate"]);

  const home = mkTempHome();
  let launched = null;
  let redisAttempts = 0;
  const output = await runCli(["prime", "resume", "thread-123", "--home", home], {
    cwd: "/tmp/prime-project",
    env: { PRIME_AGENT_CODING_AGENT_DIR: path.join(home, ".prime", "agent") },
    connectRedisStoreImpl: async () => {
      redisAttempts += 1;
      throw new Error("plain resume must not open Redis");
    },
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launched = options;
      return { status: 0 };
    },
  });

  assert.equal(output, "");
  assert.equal(redisAttempts, 0);
  assert.deepEqual(launched.args, ["--dist", "--resume", "thread-123"]);
  assert.equal(launched.cwd, "/tmp/prime-project");
  assert.match(
    fs.readFileSync(path.join(home, ".prime", "agent", "extensions", "session-title-footer.ts"), "utf8"),
    /^\/\/ Managed by aimgr\./,
  );

  launched = null;
  await runCli(["prime", "resume", "thread-123", "--home", home], {
    cwd: "/tmp/prime-project",
    env: { PRIME_AGENT_CODING_AGENT_DIR: path.join(home, ".prime", "agent") },
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    inspectPrimeDefaultLauncherLaneImpl: () => "source",
    launchPrimeAgentImpl: (options) => {
      launched = options;
      return { status: 0 };
    },
  });
  assert.deepEqual(launched.args, ["--resume", "thread-123"]);
});

test("Prime rotate resume preserves Codex and its exact model while selecting a different account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  state.accounts.beta = { provider: "openai-codex", reauth: {}, pool: { enabled: true } };
  state.credentials["openai-codex"].beta = {
    access: betaAccess,
    refresh: "BETA_REFRESH",
    idToken: betaAccess,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    accountId: "acct_beta",
  };
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
      beta: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 20 },
          { kind: "secondary", usedPercent: 20 },
        ],
      },
    },
  };
  await runCli(["prime", "use", "--codex", "pro3", "--claude", "claude", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const sessionPath = writePrimeSession(agentDir, {
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    binding: "beta",
  });

  let launched = null;
  const output = await runCli(["prime", "resume", sessionPath, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env: { PRIME_AGENT_CODING_AGENT_DIR: path.join(home, "drifted-prime-agent") },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launched = options;
      return { status: 0 };
    },
  });

  assert.match(output, /openai-codex · pro3 · rotating resume/);
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
  assert.equal(auth["openai-codex"].binding, "pro3");
  assert.equal(auth.anthropic.binding, "claude");
  assert.equal(launched.env.PRIME_AGENT_CODING_AGENT_DIR, agentDir);
  assert.deepEqual(launched.args, [
    "--dist",
    "--provider",
    "openai-codex",
    "--model",
    "gpt-5.6-sol",
    "--fork",
    sessionPath,
    "--reset-credential-binding",
    "openai-codex",
  ]);
});

test("repeated Codex rotating resumes cycle across selectable alternate accounts", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  for (const label of ["beta", "delta", "gamma"]) {
    const access = makeFakeJwt({
      "https://api.openai.com/auth": { chatgpt_account_id: `acct_${label}` },
    });
    state.accounts[label] = {
      provider: "openai-codex",
      reauth: {},
      pool: { enabled: true },
    };
    state.credentials["openai-codex"][label] = {
      access,
      refresh: `${label.toUpperCase()}_REFRESH`,
      idToken: access,
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      accountId: `acct_${label}`,
    };
  }
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  writePrimeSession(agentDir, {
    id: sessionId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    binding: "beta",
  });
  const usage = {
    "openai-codex": Object.fromEntries(["pro3", "beta", "delta", "gamma"].map((label) => [
      label,
      {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
    ])),
  };

  const selected = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
      env,
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
      resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
      inspectPrimeDefaultLauncherLaneImpl: () => "dist",
      launchPrimeAgentImpl: () => ({ status: 0 }),
    });
    selected.push(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")))["openai-codex"].binding);
  }

  assert.deepEqual(selected, ["delta", "gamma", "pro3"]);
  const local = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json")));
  assert.deepEqual(
    local.pool.openaiCodex.history
      .filter((entry) => entry.kind === "prime_rotation")
      .map((entry) => entry.label),
    selected,
  );
});

test("Prime rotate resume preserves Claude Fable and selects a different Claude account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  state.accounts.fable2 = {
    provider: "anthropic",
    expect: { email: "two@example.com" },
    reauth: { mode: "native-claude" },
    pool: { enabled: true },
  };
  state.credentials.anthropic.fable2 = buildAnthropicClaudeCredential({
    access: "ACCESS_TWO",
    refresh: "REFRESH_TWO",
    emailAddress: "two@example.com",
    organizationName: "Two Org",
    organizationUuid: "org_two",
  });
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };
  const usage = {
    anthropic: {
      claude: {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 10 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 10 },
        ],
      },
      fable2: {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 20 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 20 },
        ],
      },
    },
  };
  await runCli(["prime", "use", "--claude", "fable2", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  writePrimeSession(agentDir, {
    id: sessionId,
    provider: "anthropic",
    model: "claude-fable-5",
    binding: "claude",
  });

  let launched = null;
  const output = await runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launched = options;
      return { status: 0 };
    },
  });

  assert.match(output, /anthropic · fable2 · rotating resume/);
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
  assert.equal(auth.anthropic.binding, "fable2");
  assert.deepEqual(launched.args, [
    "--dist",
    "--provider",
    "anthropic",
    "--model",
    "claude-fable-5",
    "--fork",
    sessionId,
    "--reset-credential-binding",
    "anthropic",
  ]);
});

test("repeated Claude rotating resumes cycle across selectable alternate accounts", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  for (const [label, index] of [["pro2", 2], ["pro3", 3], ["pro4", 4]]) {
    state.accounts[label] = {
      provider: "anthropic",
      expect: { email: `${label}@example.com` },
      reauth: { mode: "native-claude" },
      pool: { enabled: true },
    };
    state.credentials.anthropic[label] = buildAnthropicClaudeCredential({
      access: `ACCESS_${index}`,
      refresh: `REFRESH_${index}`,
      emailAddress: `${label}@example.com`,
      organizationName: `Org ${index}`,
      organizationUuid: `org_${index}`,
    });
  }
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };
  await runCli(["prime", "use", "--claude", "pro2", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  writePrimeSession(agentDir, {
    id: sessionId,
    provider: "anthropic",
    model: "claude-fable-5",
    binding: "claude",
  });
  const usage = {
    anthropic: Object.fromEntries(["claude", "pro2", "pro3", "pro4"].map((label) => [
      label,
      {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 10 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 10 },
        ],
      },
    ])),
  };

  const selected = [];
  for (let attempt = 0; attempt < 3; attempt += 1) {
    await runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
      env,
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
      resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
      inspectPrimeDefaultLauncherLaneImpl: () => "dist",
      launchPrimeAgentImpl: () => ({ status: 0 }),
    });
    selected.push(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"))).anthropic.binding);
  }

  assert.deepEqual(selected, ["pro3", "pro4", "pro2"]);
  const local = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json")));
  assert.deepEqual(
    local.pool.anthropic.history
      .filter((entry) => entry.kind === "prime_rotation")
      .map((entry) => entry.label),
    selected,
  );
});

test("Prime rotate resume does not relaunch the same account when no alternate exists", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const env = { PRIME_AGENT_CODING_AGENT_DIR: agentDir };
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
    },
  };
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const sessionId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  writePrimeSession(agentDir, {
    id: sessionId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    binding: "pro3",
  });
  fs.rmSync(path.join(home, ".aimgr", "local-state.json"));

  let launches = 0;
  const result = await runCliWithExitCode(["prime", "resume", sessionId, "--rotate", "--home", home], {
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: () => {
      launches += 1;
      return { status: 0 };
    },
  });

  assert.match(result.stdout, /could not rotate accounts: no_alternate_account/);
  assert.equal(result.exitCode, 1);
  assert.equal(launches, 0);
});

test("Prime run selects an account and launches the integrated bundle in the current directory", async () => {
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
    },
    anthropic: {
      claude: {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 10 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 10 },
        ],
      },
    },
  };

  for (const run of [
    { flavor: "codex", provider: "openai-codex", model: "gpt-5.6-sol", binding: "pro3" },
    { flavor: "claude", provider: "anthropic", model: "claude-fable-5", binding: "claude" },
  ]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    const launcher = path.join(home, "workspace", "prime-agent", "prime-agent.sh");
    writeJson(statePath, fixtureState());
    writeJson(path.join(agentDir, "auth.json"), {
      [run.provider]: { type: "api_key", key: "NATIVE_BEFORE_EXPLICIT_RUN" },
    });
    fs.mkdirSync(path.dirname(launcher), { recursive: true });
    fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    let launched = null;
    const output = await runCli([
      "prime", "run", run.flavor, "--home", home,
    ], {
      cwd: "/tmp/prime-project",
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
      launchPrimeAgentImpl: (options) => {
        launched = options;
        return { status: 0 };
      },
    });

    assert.match(output, new RegExp(`AIM Prime: ${run.provider} · ${run.binding}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")))[run.provider].binding, run.binding);
    assert.equal(launched.command, fs.realpathSync(launcher));
    assert.deepEqual(launched.args, ["--dist", "--provider", run.provider, "--model", run.model]);
    assert.equal(launched.cwd, "/tmp/prime-project");
  }
});

test("Prime run ignores stale Anthropic receipt state and launches Codex", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const authPath = path.join(agentDir, "auth.json");
  const nativeAnthropic = { type: "oauth", access: "NATIVE_ANTHROPIC" };
  writeJson(statePath, fixtureState());
  writeJson(authPath, { anthropic: nativeAnthropic });
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli(["prime", "use", "--claude", "claude", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });

  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const stale = JSON.parse(fs.readFileSync(localStatePath));
  const liveDescriptor = JSON.parse(fs.readFileSync(authPath)).anthropic;
  stale.targets.primeAgent.providers = {
    anthropic: {
      binding: "pro8",
      lastInstalledDescriptor: { ...liveDescriptor, binding: "pro8" },
      pendingTransition: { schemaVersion: 1, operation: "uninstall", phase: "prepared" },
    },
  };
  writeJson(localStatePath, stale);

  let launched = false;
  const output = await runCli(["prime", "run", "codex", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        pro3: {
          ok: true,
          windows: [
            { kind: "primary", usedPercent: 10 },
            { kind: "secondary", usedPercent: 10 },
          ],
        },
      },
    }),
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: () => {
      launched = true;
      return { status: 0 };
    },
  });

  assert.match(output, /AIM Prime: openai-codex · pro3/);
  assert.equal(launched, true);
  const auth = JSON.parse(fs.readFileSync(authPath));
  assert.equal(auth["openai-codex"].binding, "pro3");
  assert.deepEqual(auth.anthropic, nativeAnthropic);
  const cleaned = JSON.parse(fs.readFileSync(localStatePath));
  assert.equal(cleaned.targets.primeAgent.providers, undefined);
});

test("Prime run codex rotates away from the current account when another is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const launcher = path.join(home, "workspace", "prime-agent", "prime-agent.sh");
  const state = fixtureState();
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  state.accounts.beta = { provider: "openai-codex", reauth: {}, pool: { enabled: true } };
  state.credentials["openai-codex"].beta = {
    access: betaAccess,
    refresh: "BETA_REFRESH",
    idToken: betaAccess,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    accountId: "acct_beta",
  };
  writeJson(statePath, state);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.writeFileSync(launcher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
      beta: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 10 },
          { kind: "secondary", usedPercent: 10 },
        ],
      },
    },
  };

  const selected = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await runCli(["prime", "run", "codex", "--home", home], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
      launchPrimeAgentImpl: () => ({ status: 0 }),
    });
    selected.push(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")))["openai-codex"].binding);
  }

  assert.equal(new Set(selected).size, 2);
  assert.deepEqual(new Set(selected), new Set(["pro3", "beta"]));
});

test("Prime auto selection never inherits Pi's current-label hysteresis", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  const betaAccess = makeFakeJwt({
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_beta" },
  });
  state.accounts.beta = { provider: "openai-codex", reauth: {}, pool: { enabled: true } };
  state.credentials["openai-codex"].beta = {
    access: betaAccess,
    refresh: "BETA_REFRESH",
    idToken: betaAccess,
    expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
    accountId: "acct_beta",
  };
  state.targets.piCli.providers = {
    "openai-codex": { binding: "pro3" },
  };
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 18 },
          { kind: "secondary", usedPercent: 12 },
        ],
      },
      beta: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 17 },
          { kind: "secondary", usedPercent: 11 },
        ],
      },
    },
  };
  const output = JSON.parse(await runCli([
    "prime", "use", "--codex", "auto", "--home", home,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
  }));
  assert.equal(output.receipt.providers[0].binding, "beta");
  const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
  assert.equal(auth["openai-codex"].binding, "beta");
});


for (const targetCase of [
  {
    targetId: "pi",
    envKey: "PI_CODING_AGENT_DIR",
    laterEnv: () => ({}),
    defaultDir: (home) => path.join(home, ".pi", "agent"),
  },
  {
    targetId: "prime",
    envKey: "PRIME_AGENT_CODING_AGENT_DIR",
    laterEnv: (home) => ({ PRIME_AGENT_CODING_AGENT_DIR: path.join(home, "changed-prime-agent-dir") }),
    defaultDir: (home) => path.join(home, "changed-prime-agent-dir"),
  },
]) {
  test(`${targetCase.targetId} status/uninstall remain bound to the persisted override auth path`, async () => {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const ownedAgentDir = path.join(home, `${targetCase.targetId}-owned-agent`);
    const ownedAuthPath = path.join(ownedAgentDir, "auth.json");
    writeJson(statePath, fixtureState());
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    const installEnv = { [targetCase.envKey]: ownedAgentDir };
    await runCli([
      targetCase.targetId, "use", "--codex", "pro3", "--home", home,
    ], {
      env: installEnv,
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });

    const statusOutput = JSON.parse(await runCli([
      targetCase.targetId, "status", "--home", home,
    ], {
      env: targetCase.laterEnv(home),
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    }));
    assert.equal(statusOutput.status.authPath, ownedAuthPath);
    assert.equal(statusOutput.status.pathConflict, true);
    assert.equal(statusOutput.status.providers["openai-codex"].installed, true);

    let redisAttempts = 0;
    const uninstallOutput = JSON.parse(await runCli([
      targetCase.targetId, "uninstall", "--provider", "codex", "--home", home,
    ], {
      env: targetCase.laterEnv(home),
      connectRedisStoreImpl: async () => {
        redisAttempts += 1;
        throw new Error("uninstall must stay local");
      },
    }));
    assert.equal(redisAttempts, 0);
    assert.equal(uninstallOutput.receipt.authPath, ownedAuthPath);
    assert.equal(uninstallOutput.receipt.pathConflict, true);
    assert.equal(JSON.parse(fs.readFileSync(ownedAuthPath))["openai-codex"], undefined);
    assert.equal(fs.existsSync(path.join(targetCase.defaultDir(home), "auth.json")), false);
  });
}


test("two-provider uninstall ignores stale receipt state and removes both AIM descriptors", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "pi-agent");
  const authPath = path.join(agentDir, "auth.json");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli([
    "pi", "use", "--codex", "pro3", "--claude", "claude", "--home", home,
  ], {
    env: { PI_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });

  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const stale = JSON.parse(fs.readFileSync(localStatePath));
  stale.targets.piCli.providers = {
    "openai-codex": {
      binding: "wrong",
      lastInstalledDescriptor: { type: "stale" },
      pendingTransition: { schemaVersion: 1, operation: "uninstall", phase: "prepared" },
    },
    anthropic: {
      binding: "wrong",
      lastInstalledDescriptor: { type: "stale" },
      pendingTransition: { schemaVersion: 1, operation: "uninstall", phase: "prepared" },
    },
  };
  writeJson(localStatePath, stale);

  const result = JSON.parse(await runCli(["pi", "uninstall", "--home", home], {
    env: { PI_CODING_AGENT_DIR: agentDir },
  }));
  assert.equal(result.ok, true);
  const auth = JSON.parse(fs.readFileSync(authPath));
  assert.equal(auth["openai-codex"], undefined);
  assert.equal(auth.anthropic, undefined);
  const cleaned = JSON.parse(fs.readFileSync(localStatePath));
  assert.equal(cleaned.targets.piCli.providers, undefined);
});
