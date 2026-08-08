import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { PassThrough, Readable } from "node:stream";
import { withHarnessAuthTransaction } from "../../src/targets/harness-auth.js";
import {
  resolveHarnessTargetMutationLockPath,
  withHarnessTargetMutationLock,
} from "../../src/targets/harness-target-lock.js";
import {
  inspectPrimeCreateCapability,
  launchPrimeCreate,
  lookupPrimeCreate,
  PrimeCreateDispatchError,
} from "../../src/targets/prime-create.js";
import {
  readPrimeCreateJournal,
  resolvePrimeCreateJournalOperationDir,
  writePrimeCreateJournal,
} from "../../src/targets/prime-create-journal.js";
import { runCli, runCliWithExitCode } from "../helpers/cli-runner.js";
import { attachRedisFixtureFromLegacyState } from "../helpers/redis-fixture.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

function fixtureState({ includeBeta = false } = {}) {
  const access = makeFakeJwt({ "https://api.openai.com/auth": { chatgpt_account_id: "acct_codex" } });
  const state = {
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
  if (includeBeta) {
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
  }
  return state;
}

function requestFor({ home, agentDir, operationId = "op-1", label = "pro3" }) {
  return {
    schemaVersion: 1,
    operationId,
    targetAgentDir: agentDir,
    provider: "openai-codex",
    label,
    preserveOtherProvider: true,
    prime: {
      daemonSocket: path.join(home, "runtime", "prime.sock"),
      cwd: path.join(home, "project with spaces"),
      name: "Fixture root",
      model: "gpt-5.6-sol",
    },
  };
}

function primeCapability({ buildId = "fixture-build", launcherLane = "source" } = {}) {
  return {
    schemaVersion: 1,
    capability: "prime-resident-root-create",
    capabilityVersion: 2,
    createRequestSchemaVersion: 1,
    createReceiptSchemaVersion: 1,
    createStatusRequestSchemaVersion: 1,
    createStatusReceiptSchemaVersion: 1,
    coldCreate: {
      expectedBuildId: buildId,
      expectedLauncherLane: launcherLane,
      expectedDaemonGeneration: null,
      targetBefore: null,
    },
  };
}

function primeReceipt(request, binding = request.label, {
  buildId = "fixture-build",
  launcherLane = "source",
} = {}) {
  return {
    schemaVersion: 1,
    operationId: request.operationId,
    disposition: "created",
    universe: {
      socket: request.prime.daemonSocket,
      buildId,
      launcherLane,
      daemonGeneration: "fixture-generation",
    },
    targetBefore: null,
    sourceTarget: null,
    targetAfter: {
      activeSessionId: "active-fixture-001",
      sessionId: "019fde8e-aaaa-7aaa-8aaa-aaaaaaaaaaaa",
      sessionFile: path.join(request.targetAgentDir, "sessions", "019fde8e-aaaa.jsonl"),
      configuredCredentialBindings: [
        { provider: "openai-codex", source: "aimgr", binding },
      ],
    },
  };
}

function committedLookup(receipt) {
  return { status: "committed", receipt };
}

function createDeps({
  home,
  agentDir,
  redis,
  launch,
  lookup = () => ({ status: "absent" }),
  capability,
} = {}) {
  return {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    resolvePrimeLauncherImpl: () => "/fixture/prime-agent.sh",
    inspectPrimeCreateCapabilityImpl: capability ?? (() => primeCapability()),
    launchPrimeCreateImpl: launch,
    lookupPrimeCreateImpl: lookup,
  };
}

async function runCreate(request, deps) {
  const result = await runCliWithExitCode([
    "prime", "create", "--request-json", "-", "--home", deps.home,
  ], {
    ...deps,
    stdin: Readable.from([JSON.stringify(request)]),
  });
  return JSON.parse(result.stdout);
}

async function runCreateStatus(operationId, deps) {
  const result = await runCliWithExitCode([
    "prime", "create", "status", "--request-json", "-", "--home", deps.home,
  ], {
    ...deps,
    stdin: Readable.from([JSON.stringify({ schemaVersion: 1, operationId })]),
  });
  return JSON.parse(result.stdout);
}

function createJsonSpawnFixture(responder) {
  return (command, args, options) => {
    const child = new EventEmitter();
    child.pid = 42_424;
    child.stdin = new PassThrough();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    let input = "";
    let closed = false;
    child.stdin.on("data", (chunk) => {
      input += chunk.toString("utf8");
    });
    child.kill = () => {
      if (closed) return false;
      closed = true;
      queueMicrotask(() => child.emit("close", null));
      return true;
    };
    child.stdin.once("finish", () => {
      queueMicrotask(() => {
        if (closed) return;
        const result = responder({ command, args, options, input }) ?? {};
        if (result.error) child.emit("error", result.error);
        if (result.stdout !== undefined) child.stdout.write(String(result.stdout));
        if (result.stderr !== undefined) child.stderr.write(String(result.stderr));
        closed = true;
        child.emit("close", result.status ?? (result.error ? null : 0));
      });
    });
    queueMicrotask(() => child.emit("spawn"));
    return child;
  };
}

test("Prime brief status is content-free and separates current descriptor from persisted selection", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const authPath = path.join(agentDir, "auth.json");
  writeJson(statePath, fixtureState({ includeBeta: true }));
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  auth["openai-codex"] = {
    ...auth["openai-codex"],
    binding: "beta",
    futureCanary: "SECRET PROMPT TRANSCRIPT",
  };
  auth.freeFormCanary = { token: "TOKEN_CANARY" };
  writeJson(authPath, auth);
  const localPath = path.join(home, ".aimgr", "local-state.json");
  const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
  local.targets.primeAgent.futureCanary = "LOCAL_STATE_SECRET";
  local.targets.primeAgent.providers.anthropic = { binding: "SECRET PROMPT TRANSCRIPT" };
  writeJson(localPath, local);

  const output = await runCli(["prime", "status", "--brief-json", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const parsed = JSON.parse(output);
  assert.deepEqual(Object.keys(parsed).sort(), ["ok", "status"]);
  assert.deepEqual(Object.keys(parsed.status).sort(), [
    "conflict", "coordination", "installed", "managed", "owned", "pathConflict",
    "providers", "schemaVersion", "target",
  ]);
  assert.deepEqual(Object.keys(parsed.status.providers).sort(), ["claude", "codex"]);
  assert.deepEqual(Object.keys(parsed.status.providers.codex).sort(), [
    "configuredBinding", "conflict", "installed", "lastSelectedBinding", "managed", "owned",
  ]);
  assert.equal(parsed.status.providers.codex.configuredBinding, "beta");
  assert.equal(parsed.status.providers.codex.lastSelectedBinding, "pro3");
  assert.equal(parsed.status.providers.claude.lastSelectedBinding, null);
  assert.equal(parsed.status.providers.codex.conflict, true);
  assert.doesNotMatch(output, /SECRET|TOKEN|LOCAL_STATE|authPath|backup|Fingerprint|providerIds/i);
});

test("Prime brief status truthfully reports a recovered descriptor without a local ownership receipt", async () => {
  const installedHome = mkTempHome();
  const installedStatePath = path.join(installedHome, ".aimgr", "secrets.json");
  const installedDir = path.join(installedHome, "prime-agent");
  writeJson(installedStatePath, fixtureState());
  const installedRedis = await attachRedisFixtureFromLegacyState({
    homeDir: installedHome,
    statePath: installedStatePath,
  });
  await runCli(["prime", "use", "--codex", "pro3", "--home", installedHome], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: installedDir },
    connectRedisStoreImpl: installedRedis.connectRedisStoreImpl,
  });
  fs.rmSync(path.join(installedHome, ".aimgr", "local-state.json"));

  const parsed = JSON.parse(await runCli([
    "prime", "status", "--brief-json", "--home", installedHome,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: installedDir },
    connectRedisStoreImpl: installedRedis.connectRedisStoreImpl,
  }));
  assert.equal(parsed.status.providers.codex.managed, true);
  assert.equal(parsed.status.providers.codex.installed, true);
  assert.equal(parsed.status.providers.codex.owned, true);
  assert.equal(parsed.status.providers.codex.conflict, false);
  assert.equal(parsed.status.providers.codex.configuredBinding, "pro3");
  assert.equal(parsed.status.providers.codex.lastSelectedBinding, null);
});

test("Prime identity extension changes only through the explicit identity install operation", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const extensionPath = path.join(agentDir, "extensions", "session-title-footer.ts");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  assert.equal(fs.existsSync(extensionPath), false);
  const before = JSON.parse(await runCli(["prime", "identity", "status", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
  }));
  assert.equal(before.receipt.status, "missing");
  const installed = JSON.parse(await runCli(["prime", "identity", "install", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
  }));
  assert.equal(installed.receipt.action, "prime_identity_install");
  assert.equal(installed.receipt.status, "installed");
  assert.match(fs.readFileSync(extensionPath, "utf8"), /^\/\/ Managed by aimgr\./);
});

test("Prime path conflict blocks use, run, uninstall, identity install, and create before effects", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const ownedDir = path.join(home, "owned-prime");
  const driftedDir = path.join(home, "drifted-prime");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: ownedDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const authBefore = fs.readFileSync(path.join(ownedDir, "auth.json"), "utf8");
  const localStatePath = path.join(home, ".aimgr", "local-state.json");
  const localBefore = fs.readFileSync(localStatePath, "utf8");
  let launches = 0;
  const common = {
    env: { PRIME_AGENT_CODING_AGENT_DIR: driftedDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    launchPrimeAgentImpl: () => {
      launches += 1;
      return { status: 0 };
    },
  };
  for (const argv of [
    ["prime", "use", "--codex", "pro3", "--home", home],
    ["prime", "run", "codex", "--codex", "pro3", "--home", home],
    ["prime", "uninstall", "--provider", "codex", "--home", home],
    ["prime", "identity", "install", "--home", home],
  ]) {
    const result = await runCliWithExitCode(argv, common);
    assert.equal(JSON.parse(result.stdout).receipt.reason, "path_conflict");
    assert.equal(result.exitCode, 1);
  }
  const request = requestFor({ home, agentDir: driftedDir, operationId: "conflict-create" });
  const created = await runCliWithExitCode([
    "prime", "create", "--request-json", "-", "--home", home,
  ], {
    ...common,
    stdin: Readable.from([JSON.stringify(request)]),
    launchPrimeCreateImpl: () => {
      launches += 1;
      return primeReceipt(request);
    },
  });
  assert.equal(JSON.parse(created.stdout).reason, "path_conflict");
  assert.equal(fs.readFileSync(path.join(ownedDir, "auth.json"), "utf8"), authBefore);
  assert.equal(fs.existsSync(path.join(driftedDir, "auth.json")), false);
  assert.equal(fs.existsSync(resolveHarnessTargetMutationLockPath({
    homeDir: home,
    targetPath: path.join(driftedDir, "auth.json"),
  })), false);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "prime-create-journal")), false);
  assert.equal(fs.existsSync(path.join(ownedDir, "extensions", "session-title-footer.ts")), false);
  assert.equal(fs.readFileSync(localStatePath, "utf8"), localBefore);
  assert.equal(launches, 0);
});

test("journaled Prime create preserves the other provider, releases the auth lock, and is idempotent", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  const authPath = path.join(agentDir, "auth.json");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli([
    "prime", "use", "--codex", "pro3", "--claude", "claude", "--home", home,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const request = requestFor({ home, agentDir, operationId: "create-$() ' unicode-✓" });
  let launches = 0;
  let dispatched = null;
  const deps = createDeps({
    home,
    agentDir,
    redis,
    launch: async (options) => {
      launches += 1;
      dispatched = options;
      await withHarnessAuthTransaction(authPath, async (auth) => ({
        result: auth["openai-codex"].binding,
      }));
      return primeReceipt(request, "pro3", {
        buildId: "fixture-build-from-capability",
        launcherLane: "installed",
      });
    },
    capability: () => primeCapability({
      buildId: "fixture-build-from-capability",
      launcherLane: "installed",
    }),
  });
  deps.home = home;
  const first = await runCreate(request, deps);
  assert.equal(first.transactionStatus, "committed");
  assert.equal(first.ok, true);
  assert.equal(first.projection.configuredBinding, "pro3");
  assert.equal(first.projection.preserveOtherProvider, true);
  assert.equal(first.root.targetAfter.configuredCredentialBindings[0].binding, "pro3");
  assert.equal(first.root.targetAfter.credentialBindings, undefined);
  assert.deepEqual(first.root.universe, {
    socket: request.prime.daemonSocket,
    buildId: "fixture-build-from-capability",
    launcherLane: "installed",
    daemonGeneration: "fixture-generation",
  });
  assert.deepEqual(Object.keys(dispatched.request).sort(), [
    "cwd",
    "daemonSocket",
    "expectedAgentDir",
    "expectedBuildId",
    "expectedCredentialDescriptor",
    "expectedDaemonGeneration",
    "expectedLauncherLane",
    "model",
    "name",
    "operationId",
    "provider",
    "schemaVersion",
    "targetBefore",
  ]);
  assert.equal(dispatched.request.expectedAgentDir, agentDir);
  assert.equal(dispatched.request.expectedBuildId, "fixture-build-from-capability");
  assert.equal(dispatched.request.expectedLauncherLane, "installed");
  assert.equal(dispatched.request.expectedDaemonGeneration, null);
  assert.equal(dispatched.request.targetBefore, null);
  assert.equal(dispatched.request.expectedCredentialDescriptor.binding, "pro3");
  assert.equal(dispatched.request.expectedCredentialDescriptor.source, "aimgr");
  assert.match(dispatched.request.expectedCredentialDescriptor.expectedIdentityFingerprint, /^aimgr-id-v1:/);
  assert.equal(Object.hasOwn(first, "expectedCredentialDescriptor"), false);
  assert.doesNotMatch(JSON.stringify(first), /aimgr-id-v1|fingerprint/i);
  assert.equal(JSON.parse(fs.readFileSync(authPath, "utf8")).anthropic.binding, "claude");
  assert.equal(fs.existsSync(path.join(agentDir, "extensions", "session-title-footer.ts")), false);

  const second = await runCreate(request, deps);
  assert.deepEqual(second, first);
  const conflicting = await runCreate({
    ...request,
    prime: { ...request.prime, name: "Different request under reused operation ID" },
  }, deps);
  assert.equal(conflicting.transactionStatus, "conflict_uncertain");
  assert.equal(conflicting.reason, "operation_id_conflict");
  assert.equal(launches, 1);
  const stored = readPrimeCreateJournal({ homeDir: home, operationId: request.operationId });
  assert.equal(stored.status, "ok");
  stored.journal.receipt.futureSecretCanary = "PROMPT TOKEN SECRET";
  stored.journal.root.targetAfter.futureTranscript = "TRANSCRIPT SECRET";
  writePrimeCreateJournal({ homeDir: home, journal: stored.journal });
  const status = JSON.parse(await runCli([
    "prime", "create", "status", "--request-json", "-", "--home", home,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    stdin: Readable.from([JSON.stringify({ schemaVersion: 1, operationId: request.operationId })]),
  }));
  assert.deepEqual(status, first);
  assert.doesNotMatch(JSON.stringify(status), /PROMPT|TOKEN|TRANSCRIPT|futureSecret/i);
});

test("Prime create preserves an uncertain projection on found:false and commits a lost response when found", async () => {
  for (const admitted of [false, true]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });
    const request = requestFor({
      home,
      agentDir,
      operationId: admitted ? "lost-after-admit" : "no-root",
      label: "beta",
    });
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        throw new Error("fixture connection lost");
      },
      lookup: () => admitted
        ? committedLookup(primeReceipt(request, "beta"))
        : { status: "absent" },
    });
    deps.home = home;
    const receipt = await runCreate(request, deps);
    const current = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"));
    if (admitted) {
      assert.equal(receipt.transactionStatus, "committed");
      assert.equal(current["openai-codex"].binding, "beta");
    } else {
      assert.equal(receipt.transactionStatus, "partial_effect");
      assert.equal(receipt.reason, "root_admission_uncertain");
      assert.equal(receipt.rollback, null);
      assert.equal(current["openai-codex"].binding, "beta");
    }
  }
});

test("Prime pending remains recoverable through status and same-operation replay", async () => {
  for (const recovery of ["status", "replay"]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    const request = requestFor({
      home,
      agentDir,
      operationId: `prime-pending-${recovery}`,
      label: "beta",
    });
    let primeStatus = "pending";
    let launches = 0;
    let lookups = 0;
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        launches += 1;
        throw new Error("fixture response lost");
      },
      lookup: () => {
        lookups += 1;
        return primeStatus === "pending"
          ? { status: "pending" }
          : committedLookup(primeReceipt(request, "beta"));
      },
    });
    deps.home = home;

    const pending = await runCreate(request, deps);
    assert.equal(pending.transactionStatus, "pending");
    assert.equal(pending.reason, "recovery_required");
    assert.equal(pending.root, null);
    const pendingJournal = readPrimeCreateJournal({
      homeDir: home,
      operationId: request.operationId,
    });
    assert.equal(pendingJournal.journal.phase, "dispatch_pending");
    assert.equal(pendingJournal.journal.transactionStatus, "pending");
    assert.equal(Object.hasOwn(pendingJournal.journal, "receipt"), false);

    primeStatus = "committed";
    const recovered = recovery === "status"
      ? await runCreateStatus(request.operationId, deps)
      : await runCreate(request, deps);
    assert.equal(recovered.transactionStatus, "committed");
    assert.equal(recovered.root.operationId, request.operationId);
    assert.equal(launches, 1);
    assert.equal(lookups, 2);
    const recoveredJournal = readPrimeCreateJournal({
      homeDir: home,
      operationId: request.operationId,
    });
    if (recovery === "replay") {
      assert.equal(recoveredJournal.journal.phase, "final");
      assert.equal(recoveredJournal.journal.receipt.transactionStatus, "committed");
    } else {
      assert.equal(recoveredJournal.journal.phase, "dispatch_pending");
      assert.equal(Object.hasOwn(recoveredJournal.journal, "receipt"), false);
    }
  }
});

test("Prime create reports partial effect when root state and rollback cannot be proven", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState({ includeBeta: true }));
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const request = requestFor({ home, agentDir, operationId: "uncertain", label: "beta" });
  const deps = createDeps({
    home,
    agentDir,
    redis,
    launch: () => {
      throw new Error("response lost");
    },
    lookup: () => {
      throw new Error("status unavailable");
    },
  });
  deps.home = home;
  const receipt = await runCreate(request, deps);
  assert.equal(receipt.transactionStatus, "partial_effect");
  assert.equal(receipt.retry.automaticAllowed, false);
  assert.equal(receipt.retry.statusLookupOnly, true);
  assert.equal(JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["openai-codex"].binding, "beta");
});

test("Prime create rejects unknown structured fields and a descriptor-capture mismatch", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const request = requestFor({ home, agentDir, operationId: "strict" });
  await assert.rejects(
    runCli(["prime", "create", "--request-json", "-", "--home", home], {
      ...createDeps({ home, agentDir, redis, launch: () => primeReceipt(request) }),
      stdin: Readable.from([JSON.stringify({ ...request, prompt: "must not be accepted" })]),
    }),
    /Invalid AIM Prime structured request/,
  );
  assert.equal(fs.existsSync(path.join(agentDir, "auth.json")), false);

  const mismatch = requestFor({ home, agentDir, operationId: "capture-mismatch" });
  const deps = createDeps({
    home,
    agentDir,
    redis,
    launch: () => primeReceipt(mismatch, "wrong-label"),
    lookup: () => committedLookup(primeReceipt(mismatch, "wrong-label")),
  });
  deps.home = home;
  const receipt = await runCreate(mismatch, deps);
  assert.equal(receipt.transactionStatus, "conflict_uncertain");
  assert.equal(receipt.reason, "root_receipt_conflict");
  assert.equal(receipt.root, null);
});

test("isolated exact-label Prime run skips usage and strictly validates passthrough before mutation", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, ".prime", "agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  let usageCalls = 0;
  let launched = null;
  const daemonSocket = path.join(home, "runtime", "isolated.sock");
  const sessionDir = path.join(home, "sessions");
  await runCli([
    "prime", "run", "codex", "--codex", "pro3", "--home", home, "--",
    "--no-env", "--offline", "--daemon-socket", daemonSocket, "--session-dir", sessionDir,
  ], {
    env: {},
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
    probeUsageSnapshotsByProviderImpl: async () => {
      usageCalls += 1;
      throw new Error("exact label must not probe usage");
    },
    resolvePrimeLauncherImpl: () => "/fixture/prime-agent.sh",
    launchPrimeAgentImpl: (options) => {
      launched = options;
      return { status: 0 };
    },
  });
  assert.equal(usageCalls, 0);
  assert.equal(launched.env.PRIME_AGENT_CODING_AGENT_DIR, agentDir);
  assert.deepEqual(launched.args, [
    "--dist", "--provider", "openai-codex", "--model", "gpt-5.6-sol",
    "--no-env", "--offline", "--daemon-socket", daemonSocket, "--session-dir", sessionDir,
  ]);
  assert.equal(fs.existsSync(path.join(agentDir, "extensions", "session-title-footer.ts")), false);

  const authBefore = fs.readFileSync(path.join(agentDir, "auth.json"), "utf8");
  await assert.rejects(
    runCli([
      "prime", "run", "codex", "--codex", "pro3", "--home", home, "--",
      "--no-env", "--offline", "--provider", "evil", "--session-dir", sessionDir,
    ], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      launchPrimeAgentImpl: () => {
        throw new Error("must not launch");
      },
    }),
    /passthrough accepts only/,
  );
  assert.equal(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"), authBefore);
});

test("the outer target mutex blocks concurrent AIM selection while Prime reads auth", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState({ includeBeta: true }));
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const request = requestFor({ home, agentDir, operationId: "mutex-create", label: "pro3" });
  let releaseLaunch;
  let enteredLaunch;
  const entered = new Promise((resolve) => {
    enteredLaunch = resolve;
  });
  const held = new Promise((resolve) => {
    releaseLaunch = resolve;
  });
  const deps = createDeps({
    home,
    agentDir,
    redis,
    launch: async () => {
      enteredLaunch();
      await held;
      return primeReceipt(request);
    },
  });
  deps.home = home;
  const creating = runCreate(request, deps);
  await entered;

  let selectionFinished = false;
  const selecting = runCli([
    "prime", "use", "--codex", "beta", "--home", home,
  ], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  }).then((value) => {
    selectionFinished = true;
    return value;
  });
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(selectionFinished, false);
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["openai-codex"].binding,
    "pro3",
  );

  releaseLaunch();
  const [created] = await Promise.all([creating, selecting]);
  assert.equal(created.transactionStatus, "committed");
  assert.equal(
    JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["openai-codex"].binding,
    "beta",
  );
});

test("Prime run does not wait on a target lock held by another interactive session", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState());
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  const launched = [];

  await withHarnessTargetMutationLock({
    homeDir: home,
    targetPath: path.join(agentDir, "auth.json"),
    lockOptions: { retries: 0 },
  }, async () => {
    await runCli([
      "prime", "run", "codex", "--codex", "pro3", "--home", home,
    ], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
      resolvePrimeLauncherImpl: () => "/fixture/prime-agent.sh",
      launchPrimeAgentImpl: (options) => {
        launched.push(options);
        return { status: 0 };
      },
      harnessTargetMutationLockOptions: { retries: 0 },
    });
  });

  assert.equal(launched.length, 1);
  assert.deepEqual(launched[0].args.slice(0, 5), [
    "--dist", "--provider", "openai-codex", "--model", "gpt-5.6-sol",
  ]);
});


test("Prime create pending journals survive every crash hook and restart to a truthful terminal receipt", async () => {
  async function setup(operationId) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });
    const request = requestFor({ home, agentDir, operationId, label: "beta" });
    let launches = 0;
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        launches += 1;
        return primeReceipt(request, "beta");
      },
      lookup: () => ({ status: "absent" }),
    });
    deps.home = home;
    return { home, agentDir, request, deps, launches: () => launches };
  }

  {
    const fixture = await setup("crash-prepared");
    await assert.rejects(runCreate(fixture.request, {
      ...fixture.deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "prepared") throw new Error("fixture crash: prepared");
      },
    }), /fixture crash: prepared/);
    const pending = await runCreateStatus(fixture.request.operationId, fixture.deps);
    assert.equal(pending.transactionStatus, "pending");
    assert.equal(pending.reason, "recovery_required");

    const localPath = path.join(fixture.home, ".aimgr", "local-state.json");
    const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
    local.targets.primeAgent.providers["openai-codex"].pendingTransition = {
      schemaVersion: 1,
      operation: "install",
      descriptor: { fixture: "interrupted-before-auth-write" },
    };
    writeJson(localPath, local);

    const recovered = await runCreate(fixture.request, fixture.deps);
    assert.equal(recovered.transactionStatus, "aborted_no_effect");
    const persisted = JSON.parse(fs.readFileSync(localPath, "utf8"));
    assert.equal(
      persisted.targets.primeAgent.providers["openai-codex"].pendingTransition,
      undefined,
    );
    assert.equal(fixture.launches(), 0);
  }

  {
    const fixture = await setup("crash-descriptor-written");
    await assert.rejects(runCreate(fixture.request, {
      ...fixture.deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "descriptor_written") throw new Error("fixture crash: descriptor_written");
      },
    }), /fixture crash: descriptor_written/);
    const pending = await runCreateStatus(fixture.request.operationId, fixture.deps);
    assert.equal(pending.transactionStatus, "pending");
    assert.equal(pending.reason, "recovery_required");
    const recovered = await runCreate(fixture.request, fixture.deps);
    assert.equal(recovered.transactionStatus, "rolled_back_no_root");
    assert.equal(fixture.launches(), 0);
  }

  {
    const fixture = await setup("crash-rollback-pending");
    await assert.rejects(runCreate(fixture.request, {
      ...fixture.deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "descriptor_written") throw new Error("fixture crash: descriptor_written");
      },
    }), /fixture crash: descriptor_written/);
    await assert.rejects(runCreate(fixture.request, {
      ...fixture.deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "rollback_pending") throw new Error("fixture crash: rollback_pending");
      },
    }), /fixture crash: rollback_pending/);
    const recovered = await runCreate(fixture.request, fixture.deps);
    assert.equal(recovered.transactionStatus, "rolled_back_no_root");
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(fixture.agentDir, "auth.json"), "utf8"))["openai-codex"].binding,
      "pro3",
    );
    assert.equal(fixture.launches(), 0);
  }

  {
    const fixture = await setup("crash-root-admitted");
    await assert.rejects(runCreate(fixture.request, {
      ...fixture.deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "root_admitted") throw new Error("fixture crash: root_admitted");
      },
    }), /fixture crash: root_admitted/);
    const pending = await runCreateStatus(fixture.request.operationId, fixture.deps);
    assert.equal(pending.transactionStatus, "pending");
    assert.equal(pending.reason, "recovery_required");
    const recovered = await runCreate(fixture.request, {
      ...fixture.deps,
      lookupPrimeCreateImpl: () => {
        throw new Error("root-admitted recovery must use its durable journal receipt");
      },
    });
    assert.equal(recovered.transactionStatus, "committed");
    assert.equal(fixture.launches(), 1);
  }
});

test("Prime create classifies uncertain found:false and descriptor drift without rollback", async () => {
  for (const mode of ["uncertain_found_false", "descriptor_drift"]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    const authPath = path.join(agentDir, "auth.json");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    const request = requestFor({ home, agentDir, operationId: mode, label: "beta" });
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        if (mode === "descriptor_drift") {
          const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
          auth["openai-codex"] = { ...auth["openai-codex"], binding: "tampered" };
          writeJson(authPath, auth);
        }
        throw new Error("fixture response lost");
      },
      lookup: () => ({ status: "absent" }),
    });
    deps.home = home;
    deps.restoreHarnessProviderProjectionImpl = async () => {
      throw new Error("uncertain dispatch must not roll back from found:false");
    };
    const receipt = await runCreate(request, deps);
    assert.equal(
      receipt.transactionStatus,
      mode === "uncertain_found_false" ? "partial_effect" : "conflict_uncertain",
    );
    assert.equal(receipt.retry.automaticAllowed, false);
    assert.equal(receipt.retry.statusLookupOnly, true);
  }
});

test("Prime create converts every post-effect journal write failure into a truthful receipt", async () => {
  const scenarios = [
    { name: "descriptor_phase", failAt: 2 },
    { name: "dispatch_phase", failAt: 3 },
    { name: "root_phase", failAt: 4 },
    { name: "commit_final", failAt: 5 },
  ];
  for (const scenario of scenarios) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });
    const request = requestFor({
      home,
      agentDir,
      operationId: `journal-failure-${scenario.name}`,
      label: "beta",
    });
    let writes = 0;
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => primeReceipt(request, "beta"),
      lookup: () => ({ status: "absent" }),
    });
    deps.home = home;
    deps.writePrimeCreateJournalImpl = (options) => {
      writes += 1;
      if (writes === scenario.failAt) throw new Error("fixture journal persistence failure");
      return writePrimeCreateJournal(options);
    };

    const receipt = await runCreate(request, deps);
    assert.equal(receipt.transactionStatus, "partial_effect", scenario.name);
    assert.equal(receipt.reason, "journal_write_failed", scenario.name);
    assert.equal(receipt.retry.automaticAllowed, false, scenario.name);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["openai-codex"].binding,
      "beta",
      scenario.name,
    );
  }

  for (const rollbackScenario of [
    { name: "rollback_phase", failAt: 1, expected: "partial_effect", binding: "beta" },
    { name: "rollback_final", failAt: 2, expected: "conflict_uncertain", binding: "pro3" },
  ]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    writeJson(statePath, fixtureState({ includeBeta: true }));
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
      env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
      connectRedisStoreImpl: redis.connectRedisStoreImpl,
    });
    const request = requestFor({
      home,
      agentDir,
      operationId: `journal-failure-${rollbackScenario.name}`,
      label: "beta",
    });
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        throw new Error("predispatch crash must not launch");
      },
      lookup: () => ({ status: "absent" }),
    });
    deps.home = home;
    await assert.rejects(runCreate(request, {
      ...deps,
      onPrimeCreateCrashWindowImpl: (phase) => {
        if (phase === "descriptor_written") throw new Error("fixture crash: descriptor_written");
      },
    }), /fixture crash: descriptor_written/);
    let writes = 0;
    const receipt = await runCreate(request, {
      ...deps,
      writePrimeCreateJournalImpl: (options) => {
        writes += 1;
        if (writes === rollbackScenario.failAt) throw new Error("fixture journal persistence failure");
        return writePrimeCreateJournal(options);
      },
    });
    assert.equal(receipt.transactionStatus, rollbackScenario.expected, rollbackScenario.name);
    assert.equal(receipt.reason, "journal_write_failed", rollbackScenario.name);
    assert.equal(
      JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf8"))["openai-codex"].binding,
      rollbackScenario.binding,
      rollbackScenario.name,
    );
  }

  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const agentDir = path.join(home, "prime-agent");
  writeJson(statePath, fixtureState({ includeBeta: true }));
  const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
  await runCli(["prime", "use", "--codex", "pro3", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: agentDir },
    connectRedisStoreImpl: redis.connectRedisStoreImpl,
  });
  const request = requestFor({ home, agentDir, operationId: "journal-failure-abort-final", label: "beta" });
  const deps = createDeps({ home, agentDir, redis, launch: () => primeReceipt(request, "beta") });
  deps.home = home;
  await assert.rejects(runCreate(request, {
    ...deps,
    onPrimeCreateCrashWindowImpl: (phase) => {
      if (phase === "prepared") throw new Error("fixture crash: prepared");
    },
  }), /fixture crash: prepared/);
  const receipt = await runCreate(request, {
    ...deps,
    writePrimeCreateJournalImpl: () => {
      throw new Error("fixture journal persistence failure");
    },
  });
  assert.equal(receipt.transactionStatus, "conflict_uncertain");
  assert.equal(receipt.reason, "journal_write_failed");
  const local = JSON.parse(fs.readFileSync(path.join(home, ".aimgr", "local-state.json"), "utf8"));
  assert.equal(local.targets.primeAgent.providers["openai-codex"].pendingTransition, undefined);
});

test("Prime create validates capability and ownership before journal or auth mutation", async () => {
  for (const scenario of ["capability", "ownership"]) {
    const home = mkTempHome();
    const statePath = path.join(home, ".aimgr", "secrets.json");
    const agentDir = path.join(home, "prime-agent");
    const authPath = path.join(agentDir, "auth.json");
    writeJson(statePath, fixtureState());
    if (scenario === "ownership") {
      writeJson(authPath, { "openai-codex": { type: "api_key", key: "NATIVE" } });
    }
    const redis = await attachRedisFixtureFromLegacyState({ homeDir: home, statePath });
    const request = requestFor({ home, agentDir, operationId: `preflight-${scenario}` });
    let launches = 0;
    const deps = createDeps({
      home,
      agentDir,
      redis,
      launch: () => {
        launches += 1;
        return primeReceipt(request);
      },
      capability: scenario === "capability"
        ? () => {
            throw new Error("fixture incompatible source/dist");
          }
        : () => primeCapability(),
    });
    deps.home = home;
    const before = fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : null;
    const receipt = await runCreate(request, deps);
    assert.equal(receipt.transactionStatus, "aborted_no_effect");
    assert.equal(receipt.reason, scenario === "ownership"
      ? "ownership_conflict"
      : "capability_or_account_unavailable");
    assert.equal(launches, 0);
    assert.equal(fs.existsSync(authPath) ? fs.readFileSync(authPath, "utf8") : null, before);
    const localPath = path.join(home, ".aimgr", "local-state.json");
    if (fs.existsSync(localPath)) {
      const local = JSON.parse(fs.readFileSync(localPath, "utf8"));
      assert.equal(local.targets.primeAgent.createOperations, undefined);
    }
  }
});

test("Prime create launcher keeps every dynamic value in bounded JSON stdin and fixed argv", async () => {
  const hostile = {
    schemaVersion: 1,
    operationId: "-op '$() ; ` unicode-✓",
    expectedAgentDir: "/tmp/agent $() ; ` ✓",
    daemonSocket: "/tmp/socket '$() ; ` ✓",
    expectedBuildId: "build '$() ; ` ✓",
    expectedLauncherLane: "source",
    expectedDaemonGeneration: null,
    targetBefore: null,
    cwd: "/tmp/project '$() ; ` ✓",
    name: "root '$() ; ` ✓",
    provider: "openai-codex",
    model: "gpt-5.6-sol",
    expectedCredentialDescriptor: {
      provider: "openai-codex",
      source: "aimgr",
      binding: "pro3",
      expectedIdentityFingerprint: `aimgr-id-v1:${"a".repeat(43)}`,
    },
  };
  let captured = null;
  const response = await launchPrimeCreate({
    command: "/fixed/prime-agent.sh",
    request: hostile,
    cwd: hostile.cwd,
    env: { PRIME_AGENT_CODING_AGENT_DIR: hostile.expectedAgentDir },
    spawnImpl: createJsonSpawnFixture((request) => {
      captured = request;
      return { status: 0, stdout: JSON.stringify({ schemaVersion: 1, ok: true }) };
    }),
  });
  assert.deepEqual(response, { schemaVersion: 1, ok: true });
  assert.equal(captured.command, "/fixed/prime-agent.sh");
  assert.deepEqual(captured.args, ["--dist", "create", "--request-json", "-"]);
  assert.equal(captured.options.shell, false);
  assert.deepEqual(JSON.parse(captured.input), hostile);
  for (const dynamic of [
    hostile.operationId,
    hostile.expectedAgentDir,
    hostile.daemonSocket,
    hostile.expectedBuildId,
    hostile.cwd,
    hostile.name,
    hostile.provider,
    hostile.model,
    hostile.expectedCredentialDescriptor.binding,
  ]) {
    assert.equal(captured.args.includes(dynamic), false);
  }

  let statusCapture = null;
  const missing = await lookupPrimeCreate({
    command: "/fixed/prime-agent.sh",
    operationId: hostile.operationId,
    daemonSocket: hostile.daemonSocket,
    cwd: hostile.cwd,
    env: {},
    spawnImpl: createJsonSpawnFixture((request) => {
      statusCapture = request;
      return {
        status: 0,
        stdout: JSON.stringify({
          schemaVersion: 1,
          operationId: hostile.operationId,
          found: false,
        }),
      };
    }),
  });
  assert.deepEqual(missing, { status: "absent" });
  assert.deepEqual(statusCapture.args, ["--dist", "create", "status", "--request-json", "-"]);
  assert.deepEqual(JSON.parse(statusCapture.input), {
    schemaVersion: 1,
    operationId: hostile.operationId,
    daemonSocket: hostile.daemonSocket,
  });
  const pending = await lookupPrimeCreate({
    command: "/fixed/prime-agent.sh",
    operationId: hostile.operationId,
    daemonSocket: hostile.daemonSocket,
    cwd: hostile.cwd,
    env: {},
    spawnImpl: createJsonSpawnFixture(() => ({
      status: 0,
      stdout: JSON.stringify({
        schemaVersion: 1,
        operationId: hostile.operationId,
        found: true,
        status: "pending",
      }),
    })),
  });
  assert.deepEqual(pending, { status: "pending" });

  const committedReceipt = {
    schemaVersion: 1,
    operationId: hostile.operationId,
    disposition: "created",
  };
  const committed = await lookupPrimeCreate({
    command: "/fixed/prime-agent.sh",
    operationId: hostile.operationId,
    daemonSocket: hostile.daemonSocket,
    cwd: hostile.cwd,
    env: {},
    spawnImpl: createJsonSpawnFixture(() => ({
      status: 0,
      stdout: JSON.stringify(committedReceipt),
    })),
  });
  assert.deepEqual(committed, { status: "committed", receipt: committedReceipt });
});

test("bounded AIM harness target mutations route through the outer target mutex", async () => {
  const home = mkTempHome();
  const primeDir = path.join(home, "prime-agent");
  const piDir = path.join(home, "pi-agent");
  const cases = [
    { argv: ["prime", "use", "--codex", "off", "--home", home], target: path.join(primeDir, "auth.json") },
    {
      argv: ["prime", "create", "--request-json", "-", "--home", home],
      target: path.join(primeDir, "auth.json"),
      stdin: JSON.stringify(requestFor({ home, agentDir: primeDir, operationId: "lock-route" })),
    },
    { argv: ["prime", "identity", "install", "--home", home], target: path.join(primeDir, "auth.json") },
    { argv: ["prime", "uninstall", "--home", home], target: path.join(primeDir, "auth.json") },
    { argv: ["pi", "use", "--codex", "off", "--home", home], target: path.join(piDir, "auth.json") },
    { argv: ["pi", "uninstall", "--home", home], target: path.join(piDir, "auth.json") },
  ];
  for (const entry of cases) {
    const calls = [];
    await runCli(entry.argv, {
      env: {
        PRIME_AGENT_CODING_AGENT_DIR: primeDir,
        PI_CODING_AGENT_DIR: piDir,
      },
      stdin: Readable.from([entry.stdin ?? "{}"]),
      withHarnessTargetMutationLockImpl: async (options) => {
        calls.push(options);
      },
    });
    assert.deepEqual(calls, [{ homeDir: home, targetPath: entry.target }]);
  }

  let plainResumeLockCalls = 0;
  await runCli(["prime", "resume", "session", "--home", home], {
    env: { PRIME_AGENT_CODING_AGENT_DIR: primeDir },
    resolvePrimeLauncherImpl: () => "/fixture/prime-agent.sh",
    launchPrimeAgentImpl: () => ({ status: 0 }),
    withHarnessTargetMutationLockImpl: async () => {
      plainResumeLockCalls += 1;
    },
  });
  assert.equal(plainResumeLockCalls, 0, "plain Prime resume is not an AIM target mutation");
});


test("Prime create journal recovers the newest durable generation after interrupted or corrupt writes", () => {
  const home = mkTempHome();
  const operationId = "crash-recovery-generation";
  const base = {
    schemaVersion: 1,
    operationId,
    requestDigest: "request-digest",
    phase: "prepared",
    transactionStatus: "pending",
  };
  writePrimeCreateJournal({ homeDir: home, journal: { ...base, revisionCanary: "first" } });
  writePrimeCreateJournal({ homeDir: home, journal: { ...base, phase: "descriptor_written", revisionCanary: "second" } });

  const operationDir = resolvePrimeCreateJournalOperationDir({ homeDir: home, operationId });
  assert.equal(fs.statSync(operationDir).mode & 0o777, 0o700);
  const generations = fs.readdirSync(operationDir).filter((name) => name.endsWith(".json")).sort();
  assert.equal(generations.length, 2);
  for (const name of generations) {
    assert.equal(fs.statSync(path.join(operationDir, name)).mode & 0o777, 0o600);
  }

  fs.writeFileSync(path.join(operationDir, generations.at(-1)), "{interrupted", { mode: 0o600 });
  let recovered = readPrimeCreateJournal({ homeDir: home, operationId });
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.journal.revisionCanary, "first");

  fs.writeFileSync(path.join(operationDir, ".write-dead-process"), "partial", { mode: 0o600 });
  recovered = readPrimeCreateJournal({ homeDir: home, operationId });
  assert.equal(recovered.status, "recovered");
  assert.equal(recovered.journal.revisionCanary, "first");
});


test("Prime create capability requires the exact versioned receipt and dispatch transport failures stay uncertain", async () => {
  const exact = primeCapability({
    buildId: "build-from-source-capability",
    launcherLane: "source",
  });
  assert.deepEqual(await inspectPrimeCreateCapability({
    command: "/fixed/prime-agent.sh",
    cwd: "/tmp",
    env: {},
    spawnImpl: createJsonSpawnFixture(({ args, input }) => {
      assert.deepEqual(args, ["--dist", "create", "capabilities", "--request-json", "-"]);
      assert.deepEqual(JSON.parse(input), { schemaVersion: 1 });
      return { status: 0, stdout: JSON.stringify(exact) };
    }),
  }), exact);
  for (const invalid of [
    { ...exact, extra: true },
    { ...exact, coldCreate: { ...exact.coldCreate, extra: true } },
    { ...exact, coldCreate: { ...exact.coldCreate, expectedDaemonGeneration: "not-cold" } },
    { ...exact, capabilityVersion: 1 },
  ]) {
    await assert.rejects(inspectPrimeCreateCapability({
      command: "/fixed/prime-agent.sh",
      cwd: "/tmp",
      env: {},
      spawnImpl: createJsonSpawnFixture(() => ({ status: 0, stdout: JSON.stringify(invalid) })),
    }), /capability is unavailable/);
  }
  await assert.rejects(inspectPrimeCreateCapability({
    command: "/fixed/prime-agent.sh",
    cwd: "/tmp",
    env: {},
    spawnImpl: createJsonSpawnFixture(() => ({ status: 0, stdout: "create --request-json -" })),
  }), /capability is unavailable/);
  await assert.rejects(launchPrimeCreate({
    command: "/fixed/prime-agent.sh",
    request: { schemaVersion: 1 },
    cwd: "/tmp",
    env: {},
    spawnImpl: createJsonSpawnFixture(() => ({ error: new Error("ENOBUFS with SECRET stderr") })),
  }), (error) => {
    assert.equal(error instanceof PrimeCreateDispatchError, true);
    assert.equal(error.uncertain, true);
    assert.doesNotMatch(error.message, /SECRET|ENOBUFS/);
    return true;
  });
});
