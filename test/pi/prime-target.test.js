import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "../../src/cli/args.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { buildHarnessIdentityFingerprint } from "../../src/credentials/harness-access.js";
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

function fixtureIdentityFingerprint(state, provider, label) {
  return buildHarnessIdentityFingerprint({
    provider,
    identity: buildStableIdentityForCredential(provider, state.credentials[provider][label]),
  });
}

function claudeUsageStatusStub(usageByLabel) {
  return async ({ records }) => ({
    ok: true,
    accounts: records.map((record) => ({
      label: record.label,
      authState: usageByLabel?.[record.label]?.ok === true ? "usage_readable" : "unavailable",
      credentialReady: true,
      locked: false,
      usage: usageByLabel?.[record.label],
    })),
  });
}

function writePrimeSession(agentDir, {
  id,
  provider,
  model,
  binding,
  identityFingerprint = `fingerprint:${binding}`,
}) {
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
    ...(binding ? [
      {
        type: "custom",
        customType: "aimgr_credential_binding_v1",
        id: "binding-entry",
        parentId: "model-entry",
        timestamp: new Date().toISOString(),
        data: {
          provider,
          source: "aimgr",
          binding,
          identityFingerprint,
        },
      },
      {
        type: "custom",
        customType: "aimgr_credential_binding_v1",
        id: "abandoned-binding-entry",
        parentId: "model-entry",
        timestamp: new Date().toISOString(),
        data: {
          provider,
          source: "aimgr",
          binding: "abandoned-sibling",
          identityFingerprint: "fingerprint:abandoned-sibling",
        },
      },
    ] : []),
    {
      type: "message",
      id: "assistant-entry",
      parentId: binding ? "binding-entry" : "model-entry",
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


test("Prime use codex and claude shorthands preserve the other provider", async () => {
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
    await runCli([
      "prime", "use", "--codex", "pro3", "--claude", "claude", "--home", home,
    ], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });
    const output = JSON.parse(await runCli([
      "prime", "use", provider, "--home", home,
    ], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      probeUsageSnapshotsByProviderImpl: async () => usage,
      collectClaudeRedisAccountUsageStatusImpl: claudeUsageStatusStub(usage.anthropic),
    }));
    assert.equal(output.ok, true);
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")));
    assert.equal(auth["openai-codex"].binding, "pro3");
    assert.equal(auth.anthropic.binding, "claude");
  }
});

test("Prime resume parses --rotate and delegates launcher lane selection without Redis", async () => {
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
  assert.deepEqual(launched.args, ["--resume", "thread-123"]);
  assert.equal(launched.cwd, "/tmp/prime-project");
  assert.match(
    fs.readFileSync(path.join(home, ".prime", "agent", "extensions", "session-title-footer.ts"), "utf8"),
    /^\/\/ Managed by aimgr\./,
  );

});

test("Prime rotate resume hands off Codex in place without mutating AIM target state", async () => {
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
    identityFingerprint: fixtureIdentityFingerprint(state, "openai-codex", "beta"),
  });
  const authPath = path.join(agentDir, "auth.json");
  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const authBefore = fs.readFileSync(authPath, "utf8");
  const localStateBefore = fs.readFileSync(localStatePath, "utf8");

  const launches = [];
  const output = await runCli(["prime", "resume", sessionPath, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env,
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launches.push(options);
      return { status: 0 };
    },
  });

  assert.match(output, /openai-codex · pro3 · live handoff complete/);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].args, [
    "__aim-handoff-credential",
    "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    "openai-codex",
    "gpt-5.6-sol",
    "beta",
    fixtureIdentityFingerprint(state, "openai-codex", "beta"),
    "pro3",
    fixtureIdentityFingerprint(state, "openai-codex", "pro3"),
    "--json",
  ]);
  assert.deepEqual(launches[1].args, ["--resume", sessionPath]);
  assert.equal(launches[0].cwd, "/tmp/prime-project");
  assert.equal(launches[1].cwd, "/tmp/prime-project");
  assert.equal(fs.readFileSync(authPath, "utf8"), authBefore);
  assert.equal(fs.readFileSync(localStatePath, "utf8"), localStateBefore);
  assert.doesNotMatch(JSON.stringify(launches), /CODEX_REFRESH|BETA_REFRESH/);
});

test("Prime rotate resume hands off Claude in place without mutating AIM target state", async () => {
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
    identityFingerprint: fixtureIdentityFingerprint(state, "anthropic", "claude"),
  });
  const authPath = path.join(agentDir, "auth.json");
  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const authBefore = fs.readFileSync(authPath, "utf8");
  const localStateBefore = fs.readFileSync(localStatePath, "utf8");

  const launches = [];
  const connectionPolicies = [];
  const output = await runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env,
    connectRedisStoreImpl: (options) => {
      connectionPolicies.push(options.connectionPolicy);
      return redis.connectRedisStoreImpl();
    },
    probeUsageSnapshotsByProviderImpl: async () => {
      throw new Error("Claude rotation must not use the all-provider burst probe");
    },
    collectClaudeRedisAccountUsageStatusImpl: claudeUsageStatusStub(usage.anthropic),
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launches.push(options);
      return { status: 0 };
    },
  });

  assert.match(output, /anthropic · fable2 · live handoff complete/);
  assert.deepEqual(connectionPolicies, ["leased"]);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].args, [
    "__aim-handoff-credential",
    sessionId,
    "anthropic",
    "claude-fable-5",
    "claude",
    fixtureIdentityFingerprint(state, "anthropic", "claude"),
    "fable2",
    fixtureIdentityFingerprint(state, "anthropic", "fable2"),
    "--json",
  ]);
  assert.deepEqual(launches[1].args, ["--resume", sessionId]);
  assert.equal(fs.readFileSync(authPath, "utf8"), authBefore);
  assert.equal(fs.readFileSync(localStatePath, "utf8"), localStateBefore);
  assert.doesNotMatch(JSON.stringify(launches), /ACCESS_TWO|REFRESH_TWO/);
});

test("Prime rotate resume manually hands off xAI in place without automatic advance", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const state = fixtureState();
  state.accounts.grok0 = {
    provider: "xai",
    expect: { email: "grok0@example.com" },
    reauth: {},
    pool: { enabled: false },
  };
  state.accounts.grok1 = {
    provider: "xai",
    expect: { email: "grok1@example.com" },
    reauth: {},
    pool: { enabled: true },
  };
  state.accounts.grok2 = {
    provider: "xai",
    expect: { email: "grok2@example.com" },
    reauth: {},
    pool: { enabled: true },
  };
  state.credentials.xai = {
    grok0: {
      access: "GROK_ACCESS_DISABLED",
      refresh: "GROK_REFRESH_DISABLED",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      emailAddress: "grok0@example.com",
    },
    grok1: {
      access: "GROK_ACCESS_ONE",
      refresh: "GROK_REFRESH_ONE",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      emailAddress: "grok1@example.com",
    },
    grok2: {
      access: "GROK_ACCESS_TWO",
      refresh: "GROK_REFRESH_TWO",
      expiresAt: new Date(Date.now() + 60 * 60_000).toISOString(),
      emailAddress: "grok2@example.com",
    },
  };
  writeJson(statePath, state);
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const sessionId = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const sessionPath = writePrimeSession(agentDir, {
    id: sessionId,
    provider: "xai",
    model: "grok-4.6",
    binding: "grok1",
    identityFingerprint: fixtureIdentityFingerprint(state, "xai", "grok1"),
  });
  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const localStateBefore = fs.readFileSync(localStatePath, "utf8");
  const sessionBefore = fs.readFileSync(sessionPath, "utf8");
  const launches = [];

  const output = await runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      throw new Error("xAI manual handoff must not enter automatic Codex selection");
    },
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launches.push(options);
      return { status: 0 };
    },
  });

  assert.match(output, /xai · grok2 · live handoff complete/);
  assert.equal(launches.length, 2);
  assert.deepEqual(launches[0].args, [
    "__aim-handoff-credential",
    sessionId,
    "xai",
    "grok-4.6",
    "grok1",
    fixtureIdentityFingerprint(state, "xai", "grok1"),
    "grok2",
    fixtureIdentityFingerprint(state, "xai", "grok2"),
    "--json",
  ]);
  assert.deepEqual(launches[1].args, ["--resume", sessionId]);
  assert.equal(fs.readFileSync(localStatePath, "utf8"), localStateBefore);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), sessionBefore);
  assert.doesNotMatch(JSON.stringify(launches), /GROK_ACCESS|GROK_REFRESH/);
});

test("Prime rotate resume refuses a historical unbound Claude session without mutation", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const sessionId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  writePrimeSession(agentDir, {
    id: sessionId,
    provider: "anthropic",
    model: "claude-fable-5",
    binding: null,
  });
  const authPath = path.join(agentDir, "auth.json");
  const authBefore = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : null;
  const launches = [];

  await assert.rejects(() => runCli(["prime", "resume", sessionId, "--rotate", "--home", home], {
    cwd: "/tmp/prime-project",
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => ({
      anthropic: {
        claude: {
          ok: true,
          windows: [
            { label: "5h", kind: "session", usedPercent: 10 },
            { label: "Fable", kind: "weekly_scoped", usedPercent: 10 },
          ],
        },
      },
    }),
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launches.push(options);
      return { status: 0 };
    },
  }), /Prime session has no AIM binding for provider=anthropic/);

  assert.deepEqual(launches, []);
  assert.equal(fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : null, authBefore);
});

test("Prime rotate resume does not attach or mutate files when the live handoff fails", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const authPath = path.join(agentDir, "auth.json");
  const localStatePath = path.join(home, ".aimgr", "local-state.json");
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
  writeJson(authPath, { sentinel: { type: "api_key", key: "UNCHANGED" } });
  const sessionId = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  const sessionPath = writePrimeSession(agentDir, {
    id: sessionId,
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    binding: "pro3",
    identityFingerprint: fixtureIdentityFingerprint(state, "openai-codex", "pro3"),
  });
  const usage = {
    "openai-codex": {
      pro3: {
        ok: true,
        windows: [
          { kind: "primary", usedPercent: 20 },
          { kind: "secondary", usedPercent: 20 },
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
  const authBefore = fs.readFileSync(authPath, "utf8");
  const localStateBefore = fs.readFileSync(localStatePath, "utf8");
  const sessionBefore = fs.readFileSync(sessionPath, "utf8");
  const launches = [];

  const result = await runCliWithExitCode([
    "prime", "resume", sessionId, "--rotate", "--home", home,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => usage,
    resolvePrimeLauncherImpl: () => "/tmp/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launches.push(options);
      return { status: 17 };
    },
  });

  assert.equal(result.exitCode, 17);
  assert.equal(result.stdout, "");
  assert.equal(launches.length, 1);
  assert.deepEqual(launches[0].args, [
    "__aim-handoff-credential",
    sessionId,
    "openai-codex",
    "gpt-5.6-sol",
    "pro3",
    fixtureIdentityFingerprint(state, "openai-codex", "pro3"),
    "beta",
    fixtureIdentityFingerprint(state, "openai-codex", "beta"),
    "--json",
  ]);
  assert.equal(fs.readFileSync(authPath, "utf8"), authBefore);
  assert.equal(fs.readFileSync(localStatePath, "utf8"), localStateBefore);
  assert.equal(fs.readFileSync(sessionPath, "utf8"), sessionBefore);
  assert.doesNotMatch(JSON.stringify(launches), /CODEX_REFRESH|BETA_REFRESH/);
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

test("Prime run selects an account and starts a new session directly", async () => {
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
    const connectionPolicies = [];
    const output = await runCli([
      "prime", "run", run.flavor, "--home", home,
    ], {
      cwd: "/tmp/prime-project",
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: (options) => {
        connectionPolicies.push(options.connectionPolicy);
        return redis.connectRedisStoreImpl();
      },
      probeUsageSnapshotsByProviderImpl: async () => usage,
      collectClaudeRedisAccountUsageStatusImpl: claudeUsageStatusStub(usage.anthropic),
      resolvePrimeLauncherImpl: () => fs.realpathSync(launcher),
      launchPrimeAgentImpl: (options) => {
        launched = options;
        return { status: 0 };
      },
    });

    assert.match(output, new RegExp(`AIM Prime: ${run.provider} · ${run.binding}`));
    assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json")))[run.provider].binding, run.binding);
    assert.equal(launched.command, fs.realpathSync(launcher));
    assert.deepEqual(launched.args, ["--provider", run.provider, "--model", run.model]);
    assert.equal(launched.cwd, "/tmp/prime-project");
    assert.deepEqual(connectionPolicies, ["leased"]);
  }
});

test("Prime run preserves the live Anthropic descriptor despite stale receipt state", async () => {
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
  assert.deepEqual(auth.anthropic, liveDescriptor);
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
      resolvePrimeLauncherImpl: () => fs.realpathSync(launcher),
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
