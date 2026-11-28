import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { ensureAgyAccountMetadata, readAgyAccountMetadata } from "../../src/coordination/agy-metadata.js";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { supportsAgyPlatform } from "../../src/privacy/agy-artifacts.js";
import { readLocalAgyStatus } from "../../src/status/agy-view.js";
import { runCli, runCliWithExitCode } from "../helpers/cli.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

const grantPath = (home) => path.join(home, ".gemini", "antigravity-cli", "antigravity-oauth-token");
const runtime = supportsAgyPlatform() ? "supported" : "unsupported";

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-agy-test-"));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  return {
    env: { HOME: home },
    root: path.join(fs.realpathSync(home), ".aimgr", "agy"),
    stderr: { write() {} },
    fetchImpl: () => assert.fail("Antigravity used wrapper networking"),
    runAgyNativeImpl: () => assert.fail("Antigravity launched unexpectedly"),
    readLocalAgyStatusImpl: (homeDir, options) => readLocalAgyStatus(homeDir, { ...options, runtimeRoot: path.join(home, "runtime") }),
  };
}

function writeFakeGrant(accountHome, token = "synthetic private native grant") {
  const grant = grantPath(accountHome);
  fs.mkdirSync(path.dirname(grant), { recursive: true, mode: 0o700 });
  fs.writeFileSync(grant, token, { mode: 0o600 });
}

const enroll = ({ accountHome, label }) => {
  writeFakeGrant(accountHome);
  return { exitCode: 0, account: `${label}@synthetic.invalid` };
};

function logout({ operation, accountHome }) {
  assert.equal(operation, "logout");
  fs.unlinkSync(grantPath(accountHome));
  return { exitCode: 0 };
}

test("refresh stores only the selected connection's native quota and exposes it in both local status views", async (t) => {
  const deps = fixture(t);
  const calls = [];
  const now = Date.parse("2026-11-20T17:00:00Z");
  const native = (name, data, numTurns = 0) => ({ exitCode: 0, statusReport: JSON.stringify({
    status: "SUCCESS", conversation_id: "", num_turns: numTurns,
    response: "private@synthetic.invalid /private/transcript", command: { name, data },
  }) });
  const quota = { groups: [{ name: "Gemini Models", description: "private@synthetic.invalid", buckets: [
    { id: "provider-specific", window: "weekly", remaining_fraction: 0.82, reset_time: "2026-11-23T17:00:00Z" },
    { window: "5h", remaining_amount: 0 },
  ] }, { name: "private@synthetic.invalid", buckets: [{ window: "weekly", remaining_fraction: 0.2 }] }] };
  let usageTurns = 0;
  const runAgyNativeImpl = (invocation) => {
    const { operation, accountHome, label, args } = invocation;
    calls.push(operation);
    if (operation === "login") return enroll(invocation);
    assert.equal(label, "first");
    assert.deepEqual(args, []);
    if (operation === "usage") return native(operation, quota, usageTurns);
    if (operation === "credits") return native(operation, { plan_name: "Google AI Pro", upgrade_uri: "https://private.invalid" });
    assert.equal(operation, "logout");
    fs.unlinkSync(grantPath(accountHome));
    return { exitCode: 0 };
  };
  const connected = { ...deps, runAgyNativeImpl, nowImpl: () => now };
  await runCli(["agy", "login", "first"], connected);
  await runCli(["agy", "login", "second"], connected);
  const output = await runCli(["agy", "refresh", "first"], connected);
  assert.match(output, /Pro.*82% left.*0 left/s);
  assert.doesNotMatch(output, /synthetic|transcript|private\.invalid/);
  const statusPath = path.join(deps.root, "first", "status.json");
  const snapshot = fs.readFileSync(statusPath, "utf8");
  assert.equal(fs.statSync(statusPath).mode & 0o7777, 0o600);
  const { lastAttemptAtMs, ...observation } = JSON.parse(snapshot);
  assert.equal(lastAttemptAtMs, now);
  assert.deepEqual(observation, { observedAtMs: now, plan: "Pro", buckets: [
    { id: "gemini-weekly", remainingFraction: 0.82, resetAtMs: Date.parse("2026-11-23T17:00:00Z") },
    { id: "gemini-5h", remainingAmount: 0 },
  ] });
  assert.equal(fs.existsSync(path.join(deps.root, "second", "status.json")), false);
  const detail = JSON.parse(await runCli(["agy", "status", "first", "--json"], connected));
  const general = JSON.parse(await runCli(["status", "--json"], connected));
  assert.deepEqual(detail.connections[0].observation, observation);
  assert.deepEqual(general.agy.connections[0].observation, observation);
  assert.ok(!general.agy.connections[1].observation);
  assert.deepEqual(calls, ["login", "login", "usage", "credits"]);
  usageTurns = 1;
  await assert.rejects(runCli(["agy", "refresh", "first"], connected), /did not return supported status fields/);
  assert.equal(fs.readFileSync(statusPath, "utf8"), snapshot);
  await assert.rejects(runCli(["agy", "refresh", "first", "--", "other"], connected), /native Antigravity arguments/);
  await runCli(["agy", "logout", "first"], connected);
  assert.equal(fs.existsSync(statusPath), false);
});

test("Antigravity launches each connection in its own private home with the original working directory and argv", async (t) => {
  const deps = fixture(t);
  const cwd = process.cwd();
  const calls = [];
  const env = deps.env;
  const nativeArgs = ["--model", "gemini-4-carbon", "--print=two words", "--", "-literal"];
  const runAgyNativeImpl = ({ operation, label, accountHome, cwd: nativeCwd, env: nativeEnv, args }) => {
    assert.equal(nativeCwd, cwd);
    assert.equal(nativeEnv, env);
    assert.equal(fs.statSync(accountHome).mode & 0o777, 0o700);
    calls.push({ operation, label, accountHome, args });
    if (operation === "login") return enroll({ accountHome, label });
    return { exitCode: label === "first" ? 17 : 0 };
  };
  for (const label of ["first", "second"]) {
    const output = await runCli(["agy", "login", label], { ...deps, runAgyNativeImpl });
    assert.match(output, new RegExp(`Enrolled Antigravity connection ${label}`));
    assert.doesNotMatch(output, /@synthetic|private native grant/);
    const marker = path.join(deps.root, label, "connection.json");
    assert.deepEqual(JSON.parse(fs.readFileSync(marker, "utf8")), { version: 1, label });
    assert.equal(fs.statSync(marker).mode & 0o777, 0o600);

    const result = await runCliWithExitCode(["agy", "run", label, "--", ...nativeArgs], { ...deps, runAgyNativeImpl });
    assert.equal(result.exitCode, label === "first" ? 17 : 0);
  }
  for (const { operation, label, accountHome, args } of calls) {
    assert.ok(accountHome.startsWith(`${deps.root}${path.sep}`));
    if (operation === "login") assert.deepEqual(args, []);
    else {
      assert.equal(accountHome, path.join(deps.root, label, "home"));
      assert.deepEqual(args, nativeArgs);
    }
  }
  assert.deepEqual(fs.readdirSync(deps.root).sort(), ["first", "second"]);
  const status = JSON.parse(await runCli(["agy", "status", "--json"], deps));
  assert.equal(status.runtime, runtime);
  assert.deepEqual(status.connections.map(({ label, status }) => ({ label, status })), [
    { label: "first", status: "ready" },
    { label: "second", status: "ready" },
  ]);
});

test("Antigravity enrollment requires a successful, verified native login and is idempotent without Redis", async (t) => {
  const deps = fixture(t);
  for (const result of [{ exitCode: 130, account: "canceled@synthetic.invalid" }, { exitCode: 0 }]) {
    await assert.rejects(runCli(["agy", "login", "first"], {
      ...deps,
      runAgyNativeImpl: ({ accountHome }) => {
        writeFakeGrant(accountHome);
        return result;
      },
    }), /did not verify a Google account/);
    assert.deepEqual(fs.readdirSync(deps.root), []);
    assert.match(await runCli(["agy", "status", "first"], deps), /not enrolled here/);
  }
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  assert.match(await runCli(["agy", "login", "first"], deps), /already enrolled locally/);
  assert.match(await runCli(["agy", "status", "first"], deps), /local grant present/);
  fs.unlinkSync(grantPath(path.join(deps.root, "first", "home")));
  assert.match(await runCli(["agy", "status", "first"], deps), /sign-in required/);
  await assert.rejects(runCli(["agy", "run", "first"], deps), /aim agy login first/);
});

test("Antigravity signs in again under the same label without exposing the previous home's conversations", async (t) => {
  const deps = fixture(t);
  const connection = path.join(deps.root, "first");
  const activeHome = path.join(connection, "home");
  const transcript = path.join(".gemini", "antigravity-cli", "conversation");
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  await runCli(["agy", "login", "second"], { ...deps, runAgyNativeImpl: enroll });
  fs.writeFileSync(path.join(activeHome, transcript), "previous conversation", { mode: 0o600 });
  const oldHomeInode = fs.statSync(activeHome).ino;
  const otherGrant = grantPath(path.join(deps.root, "second", "home"));
  const otherGrantInode = fs.statSync(otherGrant).ino;
  await runCli(["agy", "logout", "first"], { ...deps, runAgyNativeImpl: logout });

  await assert.rejects(runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl: (invocation) => ({ ...enroll(invocation), exitCode: 130 }),
  }), /did not verify a Google account/);
  assert.equal(fs.statSync(activeHome).ino, oldHomeInode);
  assert.deepEqual(fs.readdirSync(deps.root).sort(), ["first", "second"]);

  const renewed = await runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl({ accountHome, label }) {
      assert.notEqual(accountHome, activeHome);
      assert.deepEqual(fs.readdirSync(accountHome), []);
      assert.equal(fs.statSync(activeHome).ino, oldHomeInode);
      writeFakeGrant(accountHome, "fresh grant canary");
      return { exitCode: 0, account: `${label}@synthetic.invalid` };
    },
  });
  const archiveName = renewed.match(/\.aimgr\/agy\/(\.signed-out-first-[a-zA-Z0-9]{6})/)?.[1];
  assert.ok(archiveName);
  assert.match(renewed, /Signed in to Antigravity connection first/);
  assert.doesNotMatch(renewed, /@synthetic|grant canary|previous conversation/);
  const archive = path.join(deps.root, archiveName);
  assert.equal(fs.statSync(archive).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(archive, "home")).ino, oldHomeInode);
  assert.equal(fs.readFileSync(path.join(archive, "home", transcript), "utf8"), "previous conversation");
  assert.equal(fs.existsSync(grantPath(path.join(archive, "home"))), false);
  assert.equal(fs.statSync(otherGrant).ino, otherGrantInode);
  assert.equal(fs.readFileSync(grantPath(activeHome), "utf8"), "fresh grant canary");
  assert.equal(fs.existsSync(path.join(activeHome, transcript)), false);
  assert.match(await runCli(["agy", "login", "first"], deps), /already enrolled locally/);
  const status = JSON.parse(await runCli(["agy", "status", "--json"], deps));
  assert.deepEqual(status.connections.map(({ label, status }) => [label, status]), [["first", "ready"], ["second", "ready"]]);

  await runCli(["agy", "logout", "first"], { ...deps, runAgyNativeImpl: logout });
  const replacement = await runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl: (invocation) => ({ ...enroll(invocation), account: "different@synthetic.invalid" }),
  });
  assert.doesNotMatch(replacement, /@synthetic/);
  assert.equal(fs.readdirSync(deps.root).filter(name => name.startsWith(".signed-out-first-")).length, 2);
  assert.equal(fs.statSync(path.join(archive, "home")).ino, oldHomeInode);
  assert.equal(fs.existsSync(path.join(activeHome, transcript)), false);
});

test("Antigravity can retry an interrupted replacement before or after the fresh home was published", async (t) => {
  const deps = fixture(t);
  const connection = path.join(deps.root, "first");
  const pending = path.join(deps.root, ".reauth-first");
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  const oldConnection = fs.statSync(connection).ino;
  await runCli(["agy", "logout", "first"], { ...deps, runAgyNativeImpl: logout });

  const rename = fs.renameSync;
  const simulatedFailure = t.mock.method(fs, "renameSync", (from, to) => {
    if (to === connection && path.basename(from).startsWith(".login-")) throw new Error("fixture publication failure");
    return rename(from, to);
  });
  await assert.rejects(runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll }), /state is unsafe/);
  simulatedFailure.mock.restore();
  assert.equal(fs.statSync(connection).ino, oldConnection);
  assert.deepEqual(fs.readdirSync(deps.root), ["first"]);

  fs.renameSync(connection, pending);

  await assert.rejects(runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl() {
      assert.equal(fs.statSync(connection).ino, oldConnection);
      return { exitCode: 130 };
    },
  }), /did not verify a Google account/);
  assert.equal(fs.existsSync(pending), false);
  assert.match(await runCli(["agy", "status", "first"], deps), /sign-in required/);

  fs.renameSync(connection, pending);
  fs.mkdirSync(connection, { mode: 0o700 });
  fs.copyFileSync(path.join(pending, "connection.json"), path.join(connection, "connection.json"));
  writeFakeGrant(path.join(connection, "home"));
  const activeConnection = fs.statSync(connection).ino;
  const result = await runCli(["agy", "login", "first"], deps);
  assert.match(result, /already enrolled locally.*Previous local history was kept/);
  assert.equal(fs.existsSync(pending), false);
  assert.equal(fs.statSync(connection).ino, activeConnection);
  const archive = fs.readdirSync(deps.root).find(name => name.startsWith(".signed-out-first-"));
  assert.equal(fs.statSync(path.join(deps.root, archive)).ino, oldConnection);
});

test("Antigravity publishes only a verified, durable connection label and can retry after a Redis outage", async (t) => {
  const deps = fixture(t);
  const keyPrefix = "aimgr:test:agy:";
  writeAimgrConfig({ homeDir: deps.env.HOME, config: {
    redis: { url: "redis://fake.invalid:6379", keyPrefix },
    agyProxyAssignments: { first: "private-route" },
  } });
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix });
  let sharedAvailable = false;
  let redisAttempts = 0;
  let publishingLabel = "first";
  const grantModesAtPublish = [];
  deps.connectRedisStoreImpl = async (config) => {
    redisAttempts += 1;
    assert.equal(config.keyPrefix, keyPrefix);
    grantModesAtPublish.push(fs.statSync(grantPath(path.join(deps.root, publishingLabel, "home"))).mode & 0o777);
    if (!sharedAvailable) throw new Error("Redis failure with sensitive connection details");
    return store;
  };

  await assert.rejects(runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl: (invocation) => ({ ...enroll(invocation), exitCode: 130 }),
  }), /did not verify a Google account/);
  await assert.rejects(runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl: () => ({ exitCode: 0, account: "first@synthetic.invalid" }),
  }), /state is unsafe/);
  assert.equal(redisAttempts, 0);
  assert.deepEqual(await readAgyAccountMetadata(store), []);

  const output = await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  assert.match(output, /Enrolled Antigravity connection first locally\. The shared roster is unavailable/);
  assert.doesNotMatch(output, /sensitive|@synthetic|private-route/);
  assert.deepEqual(await readAgyAccountMetadata(store), []);
  assert.match(await runCli(["agy", "status", "first"], deps), /local grant present/);
  assert.equal(redisAttempts, 1);
  assert.match(await runCli(["agy", "login", "first"], deps), /already enrolled locally\. The shared roster is unavailable/);

  sharedAvailable = true;
  for (let count = 0; count < 2; count += 1) {
    assert.match(await runCli(["agy", "login", "first"], deps), /already enrolled locally\. The label is in the shared roster/);
  }
  publishingLabel = "second";
  assert.match(await runCli(["agy", "login", "second"], { ...deps, runAgyNativeImpl: enroll }), /Enrolled Antigravity connection second locally\. The label is in the shared roster/);
  assert.equal(redisAttempts, 5);
  assert.deepEqual(grantModesAtPublish, [0o600, 0o600, 0o600, 0o600, 0o600]);
  assert.deepEqual(await readAgyAccountMetadata(store), [{ label: "first" }, { label: "second" }]);
  assert.deepEqual([...client.sets], [[`${keyPrefix}agy:accountLabels`, new Set(["first", "second"])]]);
  assert.equal(client.values.size, 0);
});

test("Antigravity roster rejects malformed labels at the Redis boundary", async () => {
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "aimgr:test:agy:" });
  await assert.rejects(ensureAgyAccountMetadata(store, { label: "first@synthetic.invalid" }), /requires a valid label/);
  assert.equal(client.sets.size, 0);
  await client.sAdd(store.keys.agyAccountLabels(), "first@synthetic.invalid");
  await assert.rejects(readAgyAccountMetadata(store), { message: "Antigravity roster contains an invalid label." });
});

test("Antigravity requires exact labels and status stays read-only for an empty or unsafe local store", async (t) => {
  const deps = fixture(t);
  assert.deepEqual(JSON.parse(await runCli(["agy", "status", "--json"], deps)).connections, []);
  assert.match(await runCli(["agy", "status"], deps), new RegExp(`runtime platform ${runtime}.*quota unavailable`));
  assert.equal(fs.existsSync(path.dirname(deps.root)), false);
  await assert.rejects(runCli(["agy", "run"], deps), /aim agy run <label>/);
  await assert.rejects(runCli(["agy", "run", "first", "--json"], deps), /after `--`/);
  await assert.rejects(runCli(["agy", "login", "../personal"], deps), /Use an Antigravity label/);
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  await assert.rejects(runCli(["agy", "run"], deps), /aim agy run <label>/);
  await assert.rejects(runCli(["agy", "run", "other"], deps), /aim agy login other/);

  const first = path.join(deps.root, "first");
  fs.symlinkSync(first, path.join(deps.root, "other"));
  await assert.rejects(runCli(["agy", "login", "other"], deps), /state is unsafe/);
  const grant = grantPath(path.join(first, "home"));
  fs.linkSync(grant, `${grant}.linked`);
  assert.match(await runCli(["agy", "status", "first"], deps), /invalid local state/);
  fs.unlinkSync(`${grant}.linked`);
  fs.writeFileSync(path.join(first, "connection.json"), '{"version":1,"label":"first","account":"private@synthetic.invalid"}');
  const output = await runCli(["agy", "status", "--json"], deps);
  assert.deepEqual(JSON.parse(output).connections.map(({ label, status }) => ({ label, status })), [
    { label: "first", status: "invalid-state" },
    { label: "other", status: "invalid-state" },
  ]);
  await assert.rejects(runCli(["agy", "run", "first"], deps), /invalid local state/);
});

test("Antigravity enrollment serializes attempts for the same label", async (t) => {
  const deps = fixture(t);
  let onEntered;
  let onProceed;
  const entered = new Promise((resolve) => { onEntered = resolve; });
  const proceed = new Promise((resolve) => { onProceed = resolve; });
  const enrollment = runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl: async (invocation) => {
      onEntered();
      await proceed;
      return enroll(invocation);
    },
  });
  try {
    await Promise.race([entered, enrollment]);
    await assert.rejects(runCli(["agy", "login", "first"], deps), /operation is already in progress/);
    assert.match(await runCli(["agy", "status", "first"], deps), /not enrolled here/);
  } finally {
    onProceed();
    await enrollment;
  }
});

test("passes the native conversation UUID only with the selected connection", async t => {
  const deps = fixture(t);
  const sessionId = "af42bcee-b692-49ea-923e-3b8c864fc044";
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  await assert.rejects(runCli(["agy", "resume", "first", "invalid", "--", "--print=hi"], deps), /conversation UUID/);
  await runCli(["agy", "resume", "first", sessionId, "--", "--print=hi"], {
    ...deps,
    runAgyNativeImpl(invocation) {
      assert.equal(invocation.operation, "resume");
      assert.equal(invocation.accountHome, path.join(deps.root, "first", "home"));
      assert.equal(invocation.sessionId, sessionId);
      assert.deepEqual(invocation.args, ["--print=hi"]);
      return { exitCode: 0 };
    },
  });
});

test("dispatches a bare Antigravity run under the selected local connection", async t => {
  const deps = fixture(t);
  await runCli(["agy", "login", "first"], { ...deps, runAgyNativeImpl: enroll });
  await runCli(["agy", "run", "first"], {
    ...deps,
    runAgyNativeImpl(invocation) {
      assert.equal(invocation.operation, "run");
      assert.equal(invocation.accountHome, path.join(deps.root, "first", "home"));
      assert.deepEqual(invocation.args, []);
      return { exitCode: 0 };
    },
  });
});

test("logout waits for the label to be idle and confirms only its native grant was removed", async t => {
  const deps = fixture(t);
  for (const label of ["first", "second"]) {
    await runCli(["agy", "login", label], { ...deps, runAgyNativeImpl: enroll });
  }
  let onEntered;
  let onFinish;
  const entered = new Promise(resolve => { onEntered = resolve; });
  const finish = new Promise(resolve => { onFinish = resolve; });
  const run = runCli(["agy", "run", "first", "--", "--print=hi"], {
    ...deps,
    async runAgyNativeImpl() {
      onEntered();
      await finish;
      return { exitCode: 0 };
    },
  });
  await entered;
  try {
    await assert.rejects(runCli(["agy", "logout", "first"], deps), /operation is already in progress/);
    await runCli(["agy", "run", "second", "--", "--print=hi"], { ...deps, runAgyNativeImpl: () => ({ exitCode: 0 }) });
  } finally {
    onFinish();
    await run;
  }
  await assert.rejects(runCli(["agy", "logout", "first"], {
    ...deps, runAgyNativeImpl: () => ({ exitCode: 0 }),
  }), /did not clear the local grant/);
  assert.match(await runCli(["agy", "logout", "first"], {
    ...deps,
    runAgyNativeImpl({ operation, accountHome }) {
      assert.equal(operation, "logout");
      fs.unlinkSync(grantPath(accountHome));
      return { exitCode: 0 };
    },
  }), /first signed out/);
  assert.match(await runCli(["agy", "logout", "first"], deps), /signed out locally/);
  assert.match(await runCli(["agy", "status", "second"], deps), /local grant present/);
});

test("Antigravity keeps an enrolled route across config edits", async (t) => {
  const deps = fixture(t);
  const config = path.join(path.dirname(deps.root), "config.yaml");
  fs.mkdirSync(path.dirname(config), { mode: 0o700 });
  fs.writeFileSync(config, "agyProxyAssignments:\n  first: private-route\n", { mode: 0o600 });
  await runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl(invocation) {
      assert.equal(invocation.profileRef, "private-route");
      return enroll(invocation);
    },
  });
  fs.writeFileSync(config, "agyProxyAssignments: {}\n");
  await runCli(["agy", "run", "first"], {
    ...deps,
    runAgyNativeImpl({ profileRef }) {
      assert.equal(profileRef, "private-route");
      return { exitCode: 0 };
    },
  });
  fs.writeFileSync(config, "agyProxyAssignments:\n  first: different-route\n");
  await assert.rejects(runCli(["agy", "run", "first"], deps), /Restore its private-route assignment/);
  fs.writeFileSync(config, "agyProxyAssignments: {}\n");
  await runCli(["agy", "logout", "first"], { ...deps, runAgyNativeImpl: logout });
  fs.writeFileSync(config, "agyProxyAssignments:\n  first: different-route\n");
  await assert.rejects(runCli(["agy", "login", "first"], deps), /Restore its private-route assignment/);
  fs.writeFileSync(config, "agyProxyAssignments: {}\n");
  await runCli(["agy", "login", "first"], {
    ...deps,
    runAgyNativeImpl(invocation) {
      assert.equal(invocation.profileRef, "private-route");
      return enroll(invocation);
    },
  });
});
