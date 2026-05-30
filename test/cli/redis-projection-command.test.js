import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importSnapshot, readSnapshot } from "../../src/coordination/redis-store.js";
import {
  resolveAimgrLocalStatePath,
  resolveAimgrMachineIdPath,
  resolveAimgrClaudeLabelHomeDir,
  resolveClaudeAuthFilePath,
  resolveCodexAuthFilePath,
  resolveManagedCodexHomeDir,
  resolveManagedPiAgentDir,
  resolvePiAuthFilePath,
} from "../../src/io/paths.js";
import { writeClaudeNativeBundleExportFile } from "../../src/credentials/claude-native.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";

const PREFIX = "aimgr:projection-test";

function writeMachineId(home, machineId) {
  const machineIdPath = resolveAimgrMachineIdPath({ homeDir: home });
  fs.mkdirSync(path.dirname(machineIdPath), { recursive: true });
  fs.writeFileSync(machineIdPath, `${machineId}\n`, "utf8");
}

function token(accountId, exp = Math.floor(Date.now() / 1000) + 3600) {
  return makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
      chatgpt_plan_type: "pro",
    },
  });
}

function codexCredential(accountId = "acct_boss", refresh = "REFRESH_BOSS") {
  return {
    access: token(accountId),
    refresh,
    idToken: token(accountId),
    accountId,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  };
}

async function seedOpenAiRedis({ home, client, machineId = "studio" }) {
  writeMachineId(home, machineId);
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importSnapshot(
    store,
    {
      machines: [{ machineId }],
      labels: [{ provider: "openai-codex", label: "boss", pool: { enabled: true } }],
      sessions: [
        {
          provider: "openai-codex",
          label: "boss",
          machineId,
          credential: codexCredential(),
          identity: { accountId: "acct_boss" },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );
  return store;
}

test("redis-configured codex use projects from Redis and writes only local adjunct state", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({ home, client });

  const out = await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.activated.receipt.label, "boss");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);

  const auth = JSON.parse(fs.readFileSync(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(auth.tokens.account_id, "acct_boss");
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.codexCli.activeLabel, "boss");
  assert.doesNotMatch(JSON.stringify(local), /REFRESH_BOSS/);
});

test("redis-configured codex watch publishes live auth rotation before exit", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const store = await seedOpenAiRedis({ home, client });

  await runCli(["codex", "use", "boss", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  const rotated = codexCredential("acct_boss", "REFRESH_ROTATED");
  writeJson(resolveCodexAuthFilePath(resolveManagedCodexHomeDir({ homeDir: home, env: {} })), {
    tokens: {
      access_token: rotated.access,
      refresh_token: rotated.refresh,
      id_token: rotated.idToken,
      account_id: rotated.accountId,
    },
    last_refresh: new Date().toISOString(),
  });

  const out = await runCli(["codex", "watch", "--once", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: { ok: true, windows: [{ usedPercent: 1 }] },
      },
    }),
  });
  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.preserved.status, "updated");
  const snapshot = await readSnapshot(store);
  assert.equal(snapshot.sessions.find((session) => session.label === "boss").credential.refresh, "REFRESH_ROTATED");
});

test("redis-configured pi use and hermes auth write read Redis sessions", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  await seedOpenAiRedis({ home, client });

  const piOut = await runCli(["pi", "use", "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {
        boss: { ok: true, windows: [{ usedPercent: 1 }] },
      },
    }),
  });
  assert.equal(JSON.parse(piOut).ok, true);
  const piAuth = JSON.parse(fs.readFileSync(resolvePiAuthFilePath(resolveManagedPiAgentDir({ homeDir: home, env: {} })), "utf8"));
  assert.equal(piAuth["openai-codex"].accountId, "acct_boss");

  const hermesPath = path.join(home, "hermes", "auth.json");
  fs.mkdirSync(path.dirname(hermesPath), { recursive: true });
  const hermesOut = await runCli(["auth", "write", "hermes", "boss", "--auth-file", hermesPath, "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  assert.equal(JSON.parse(hermesOut).ok, true);
  const hermesAuth = JSON.parse(fs.readFileSync(hermesPath, "utf8"));
  assert.equal(hermesAuth.providers["openai-codex"].tokens.refresh_token, "REFRESH_BOSS");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude import-native publishes the native bundle to Redis", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }],
      labels: [{ provider: "anthropic", label: "claude", pool: { enabled: true } }],
      sessions: [],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  const bundleFile = path.join(home, "bundle.json");
  writeClaudeNativeBundleExportFile({
    filePath: bundleFile,
    nativeClaudeBundle: buildAnthropicClaudeCredential({
      access: "CLAUDE_ACCESS",
      refresh: "CLAUDE_REFRESH",
    }).nativeClaudeBundle,
    labelHint: "claude",
    sourceHome: home,
  });

  const out = await runCli(["claude", "import-native", "claude", "--in", bundleFile, "--home", home], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
  });
  assert.equal(JSON.parse(out).ok, true);
  const snapshot = await readSnapshot(store);
  const session = snapshot.sessions.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  assert.equal(session.machineId, "studio");
  assert.equal(session.credential.refresh, "CLAUDE_REFRESH");
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude run projects into a per-label home and publishes post-run rotation", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  const credential = buildAnthropicClaudeCredential({
    access: "CLAUDE_ACCESS",
    refresh: "CLAUDE_REFRESH",
  });
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  const store = await connectRedisStore({ client, keyPrefix: PREFIX });
  await importSnapshot(
    store,
    {
      machines: [{ machineId: "studio" }],
      labels: [
        {
          provider: "anthropic",
          label: "claude",
          stableIdentity: {
            accountUuid: "acct_boss",
            emailAddress: "boss@example.com",
            organizationUuid: "org_boss",
          },
          pool: { enabled: true },
        },
      ],
      sessions: [
        {
          provider: "anthropic",
          label: "claude",
          machineId: "studio",
          credential,
          identity: {
            accountUuid: "acct_boss",
            emailAddress: "boss@example.com",
            organizationUuid: "org_boss",
          },
          health: { status: "ready", reason: null },
        },
      ],
    },
    { machineId: "test", observedAt: "2026-05-30T14:00:00.000Z" },
  );

  const claudeHome = resolveAimgrClaudeLabelHomeDir({ homeDir: home, label: "claude" });
  const out = await runCli(["claude", "run", "claude", "--home", home, "--", "--print", "hello"], {
    env: {},
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    runClaudeCliImpl: ({ homeDir: launchHome, args }) => {
      assert.equal(launchHome, claudeHome);
      assert.deepEqual(args, ["--print", "hello"]);
      assert.equal(fs.existsSync(resolveClaudeAuthFilePath(path.join(claudeHome, ".claude"))), true);
      writeClaudeNativeBundle(claudeHome, {
        accessToken: "CLAUDE_ACCESS_ROTATED",
        refreshToken: "CLAUDE_REFRESH_ROTATED",
      });
      return { status: 0, signal: null };
    },
  });

  const result = JSON.parse(out);
  assert.equal(result.ok, true);
  assert.equal(result.claudeRun.homeDir, claudeHome);
  const snapshot = await readSnapshot(store);
  const session = snapshot.sessions.find((entry) => entry.provider === "anthropic" && entry.label === "claude");
  assert.equal(session.credential.refresh, "CLAUDE_REFRESH_ROTATED");
  const local = JSON.parse(fs.readFileSync(resolveAimgrLocalStatePath({ homeDir: home }), "utf8"));
  assert.equal(local.targets.claudeCli.activeLabel, "claude");
  assert.match(local.targets.claudeCli.credentialsPath, /claude-homes\/claude\/\.claude\/\.credentials\.json$/);
  assert.doesNotMatch(JSON.stringify(local), /CLAUDE_REFRESH_ROTATED/);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "secrets.json")), false);
});

test("redis-configured claude use is retired in favor of claude run", async () => {
  const home = mkTempHome();
  const client = new FakeRedisClient();
  writeMachineId(home, "studio");
  writeAimgrConfig({
    homeDir: home,
    config: { redis: { url: "redis://fake:6379", keyPrefix: PREFIX } },
  });
  await assert.rejects(
    () => runCli(["claude", "use", "claude", "--home", home], {
      env: {},
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix: PREFIX }),
    }),
    /`aim claude use` was retired for Redis installs/,
  );
});
