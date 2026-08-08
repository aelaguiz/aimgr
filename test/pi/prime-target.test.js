import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeLocalState } from "../../src/state/local-state.js";
import { runCli } from "../helpers/cli-runner.js";
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
    "prime", "use", "--codex", "pro3", "--replace-native-auth", "--home", home,
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
  assert.equal(local.targets.piCli.providers["openai-codex"].binding, "pro3");
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


test("two-provider uninstall durably completes the first provider before advancing", async () => {
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

  let writes = 0;
  await assert.rejects(
    runCli(["pi", "uninstall", "--home", home], {
      env: { PI_CODING_AGENT_DIR: agentDir },
      writeLocalStateImpl: (options) => {
        writes += 1;
        if (writes === 4) throw new Error("crash before second provider transition");
        return writeLocalState(options);
      },
    }),
    /crash before second provider transition/,
  );
  const afterCrash = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json")));
  assert.equal(afterCrash.targets.piCli.providers["openai-codex"], undefined);
  assert.equal(afterCrash.targets.piCli.providers.anthropic.binding, "claude");
  const authAfterCrash = JSON.parse(fs.readFileSync(authPath));
  assert.equal(authAfterCrash["openai-codex"], undefined);
  assert.equal(authAfterCrash.anthropic.type, "external");

  const recovered = JSON.parse(await runCli(["pi", "uninstall", "--home", home], {
    env: { PI_CODING_AGENT_DIR: agentDir },
  }));
  assert.equal(recovered.ok, true);
  const authAfterRecovery = JSON.parse(fs.readFileSync(authPath));
  assert.equal(authAfterRecovery["openai-codex"], undefined);
  assert.equal(authAfterRecovery.anthropic, undefined);
});
