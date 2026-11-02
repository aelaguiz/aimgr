import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import fsSync from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { loadRedisRuntime, closeRedisRuntime } from "../../src/coordination/runtime.js";
import { publishCredential } from "../../src/coordination/redis-store.js";
import { readAimgrConfig } from "../../src/config/aimgr-config.js";
import { setTimeout as delay } from "node:timers/promises";
import { assertLocalClaudeProfileStopped } from "../../src/network/claude-native-route.js";

function assertTestEnvironment() {
  if (process.platform === "darwin") {
    assert.equal(os.homedir(), "/Users/ec2-user");
    const marker = "/etc/aimgr-macos-test-rental.json";
    const stat = fsSync.statSync(marker);
    assert.equal(stat.uid, 0);
    assert.equal(stat.mode & 0o022, 0);
    const rental = JSON.parse(fsSync.readFileSync(marker));
    assert.equal(rental.purpose, "aimgr-macos-testing");
    assert.equal(rental.provider, "aws-ec2");
    assert.equal(rental.hostname, os.hostname());
  } else {
    assert.equal(process.platform, "linux");
    assert.equal(os.hostname(), "aimgr-privacy-dev");
    assert.equal(os.homedir(), "/home/aimdev");
  }
  const { config } = readAimgrConfig({ homeDir: os.homedir() });
  const redis = new URL(config.redis.url);
  assert.equal(redis.hostname, "127.0.0.1");
  assert.equal(config.redis.keyPrefix, "aimgr-privacy-dev:");
}

const verification = path.join(os.homedir(), "verification");
const nativeEnv = () => ({ ...process.env, PATH: `${os.homedir()}/.local/bin:${process.env.PATH}` });
const challengeFile = path.join(verification, "HUMAN_VERIFICATION_CHALLENGE");
const realChildren = new Set();
function inspectChallenge(value) {
  if (/hcaptcha|recaptcha|verify you are human|human verification challenge/i.test(value)) {
    fsSync.writeFileSync(challengeFile, "Stop all provider work and discuss with user.\n", { mode: 0o600 });
    for (const child of realChildren) child.kill("SIGTERM");
  }
  assert.ok(!fsSync.existsSync(challengeFile), "HUMAN_VERIFICATION_CHALLENGE: stop all provider work");
}

test("real protected account fails clearly before startup when its VM tunnel is down", {
  skip: process.env.AIMGR_TEST_REAL_PROXY_STARTUP !== "1", timeout: 90000,
}, async () => {
  assertTestEnvironment();
  inspectChallenge("");
  const exec = promisify(execFile);
  const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
  const mac = process.platform === "darwin";
  const events = "/sys/fs/cgroup/aimgr-claude/proxy5/cgroup.events";
  const assertStopped = () => mac ? assertLocalClaudeProfileStopped("proxy5") : fs.readFile(events, "utf8").then(value => assert.match(value, /populated 0/));
  await assertStopped();
  const runtime = await loadRedisRuntime({ homeDir: os.homedir(), provider: "anthropic" });
  assert.deepEqual(runtime.snapshot.credentials.map(record => record.label).sort(), ["proxy5", "proxy6"]);
  assert.equal(runtime.snapshot.credentials.find(record => record.label === "proxy5").policy.egress.profileRef, "proxy5");
  await closeRedisRuntime(runtime);
  const listener = async () => {
    try { return (await exec("lsof", ["-tiTCP:1085", "-sTCP:LISTEN"])).stdout.trim(); }
    catch (error) { if (error.code === 1) return ""; throw error; }
  };
  const originalPid = await listener();
  assert.match(originalPid, /^\d+$/);
  const argv = mac
    ? JSON.parse(await fs.readFile(path.join(verification, "proxy-ssh/tunnel-command-proxy5.private.json"), "utf8"))
    : (await fs.readFile(`/proc/${originalPid}/cmdline`, "utf8")).split("\0").filter(Boolean);
  if (mac) assert.equal((await exec("/bin/ps", ["-ww", "-p", originalPid, "-o", "command="])).stdout.trim(), argv.join(" "));
  assert.equal(path.basename(argv[0]), "ssh");
  const { config } = readAimgrConfig({ homeDir: os.homedir() });
  const assigned = config.claudeProxyProfiles.proxy5;
  assert.equal(assigned.socksPort, 1085);
  assert.ok(argv.includes("127.0.0.1:1085"));
  assert.ok(assigned.expectedExits.some(ip => argv.includes(`tunnel@${ip}`)), "listener must belong to the private assigned proxy");
  const startedAt = Date.now();
  let receipt;
  try {
    process.kill(Number(originalPid), "SIGTERM");
    for (let n = 0; n < 100 && await listener(); n++) await delay(50);
    assert.equal(await listener(), "");
    let failure;
    try {
      await exec(process.execPath, [cli, "claude", "run", "proxy5", "--", "-p", "Synthetic startup test; this prompt must not be submitted."], {
        cwd: verification, env: nativeEnv(), timeout: 20000,
      });
    } catch (error) { failure = error; }
    assert.equal(failure?.code, 1);
    assert.match(failure.stderr, /aim: Claude proxy5: assigned proxy is unavailable/);
    assert.match(failure.stderr, /Repair the proxy\/tunnel.*retry or resume.*\(proxy5\)/);
    await assertStopped();
    receipt = { checkedAt: new Date().toISOString(), label: "proxy5", proxy: "proxy5", exitCode: failure.code,
      error: failure.stderr.trim(), durationMs: Date.now() - startedAt, nativeOwnersAbsent: true, platform: process.platform, localChromeTunnelChanged: false };
  } finally {
    // Restore precisely the VM's original SSH invocation. No account switching
    // or session replay: only a later explicit command can use this route.
    if (!await listener()) {
      const tunnel = spawn(argv[0], argv.slice(1), { detached: true, stdio: "ignore" });
      tunnel.unref();
      for (let n = 0; n < 100 && !await listener(); n++) await delay(100);
    }
    assert.match(await listener(), /^\d+$/);
    if (mac) {
      const owners = JSON.parse(await fs.readFile("/opt/aimgr-claude-proxy/proxy5-state/ready.json", "utf8")).owners;
      for (let n = 0; n < 200; n++) {
        const live = JSON.parse((await exec("/usr/bin/python3", ["-I", "-c",
          "import sys,json;sys.path.insert(0,'/opt/aimgr-claude-proxy');import darwin_proxy as p;print(json.dumps(p.processes()))"])).stdout);
        const state = (await exec("sudo", ["launchctl", "print", "system/com.aimgr.claude-proxy.proxy5"])).stdout;
        if (!/^\s*pid = /m.test(state) && !owners.some(owner => owner.role !== "tunnel" && live[owner.pid]?.started === owner.started)) break;
        if (n === 199) assert.fail("old native Mac service owners have not exited");
        await delay(50);
      }
      await exec("sudo", ["launchctl", "kickstart", "system/com.aimgr.claude-proxy.proxy5"]);
      for (let n = 0; n < 200; n++) {
        const flags = await fs.readdir("/opt/aimgr-claude-proxy/proxy5-state");
        if (!flags.includes("failed") && !flags.includes("starting")) break;
        if (n === 199) assert.fail("explicit native Mac repair failed");
        await delay(50);
      }
      await exec("sudo", ["/usr/bin/python3", "-I", "/opt/aimgr-claude-proxy/darwin_proxy.py", "verify", "proxy5"]);
    } else await exec("sudo", ["systemctl", "restart", "aimgr-claude-proxy-proxy5.service"]);
  }
  await fs.writeFile(path.join(verification, "optional-real-startup.json"), JSON.stringify(receipt, null, 2) + "\n");
  console.log(JSON.stringify({ realProxyStartup: receipt }));
});

// Explicit offsite acceptance test. Never runs in the ordinary unit suite.
// It uses only the two sacrificial accounts, already enrolled through their
// existing local browsers. All test prompts and files are synthetic.
test("real native Claude keeps A1/A2/B concurrent and resumes each account through its assigned exit", {
  skip: process.env.AIMGR_TEST_REAL_ACCOUNTS !== "1", timeout: 360000,
}, async () => {
  assertTestEnvironment();
  inspectChallenge("");
  const root = await fs.mkdtemp(path.join(verification, "real-native-"));
  const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
  const receipts = [];
  const run = async (label, name, { previous = null } = {}) => {
    assert.ok(["proxy5", "proxy6"].includes(label));
    const cwd = previous?.cwd ?? path.join(root, name);
    if (!previous) await fs.mkdir(cwd);
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "This is a synthetic test workspace. Preserve its normal directory and tool behavior.\n");
    const { config } = readAimgrConfig({ homeDir: os.homedir() });
    const expectedExits = config.claudeProxyProfiles[label].expectedExits;
    assert.ok(Array.isArray(expectedExits) && expectedExits.length > 0);
    const marker = `NATIVE_REAL_${name.toUpperCase()}`;
    const prompt = `${previous ? "Your final answer must contain two labeled lines: PREVIOUS MARKER (the exact marker printed by the previous turn's Bash command, recalled from this conversation), and NEW OUTPUT (the output of the command below). " : ""}Run this exact Bash command once and report its output: sleep 6; printf '${marker} '; curl -fsS 'https://api.ipify.org?format=json'. Do not do any other work.`;
    const startedAt = Date.now();
    const child = spawn(process.execPath, [cli, "claude", "run", label, "--", "-p", prompt,
      "--model", "claude-sonnet-4-6", "--output-format", "json", "--dangerously-skip-permissions", "--max-turns", "5",
      ...(previous ? ["--resume", previous.sessionId] : [])],
    { cwd, env: nativeEnv(), stdio: ["ignore", "pipe", "pipe"] });
    realChildren.add(child);
    let stdout = "", stderr = "";
    const inspect = () => { try { inspectChallenge(stdout + stderr); } catch {} };
    child.stdout.on("data", chunk => { stdout += chunk; inspect(); });
    child.stderr.on("data", chunk => { stderr += chunk; inspect(); });
    const status = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => { child.kill("SIGTERM"); reject(new Error(`Native ${name} timed out`)); }, 180000);
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("exit", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
    });
    realChildren.delete(child);
    await fs.writeFile(path.join(cwd, `${name}.output.private.log`), stdout + "\n" + stderr, { mode: 0o600 });
    inspectChallenge(stdout + stderr);
    const result = stdout.split("\n").filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return null; } }).find(value => value?.type === "result");
    const receipt = { label, name, cwd, startedAt, finishedAt: Date.now(), ...status,
      sessionId: result?.session_id, stopReason: result?.stop_reason, isError: result?.is_error,
      markerPresent: result?.result?.includes(marker) ?? false,
      assignedExitPresent: expectedExits.some(ip => result?.result?.includes(ip)),
      ...(previous ? { previousMarkerRecalled: result?.result?.includes(`NATIVE_REAL_${previous.name.toUpperCase()}`) ?? false } : {}) };
    receipts.push(receipt);
    assert.equal(status.code, 0, `Native ${name} failed; inspect its private VM log`);
    assert.equal(result?.is_error, false, `Native ${name} did not complete a model turn`);
    assert.equal(receipt.markerPresent, true);
    assert.equal(receipt.assignedExitPresent, true);
    if (previous) {
      assert.equal(receipt.sessionId, previous.sessionId);
      assert.equal(receipt.previousMarkerRecalled, true);
    }
    return receipt;
  };
  try {
    const results = await Promise.allSettled([run("proxy5", "a1"), run("proxy5", "a2"), run("proxy6", "b1")]);
    const failures = results.filter(result => result.status === "rejected");
    assert.equal(failures.length, 0, failures.map(result => result.reason.message).join("; "));
    assert.equal(new Set(receipts.map(receipt => receipt.sessionId)).size, 3);
    assert.ok(Math.max(...receipts.map(receipt => receipt.startedAt)) < Math.min(...receipts.map(receipt => receipt.finishedAt)), "all three session lifetimes overlap");
    // Continue only under the same underlying account. Recall proof excludes
    // the old marker from the new prompt, so a fresh conversation cannot pass.
    const [a1, , b1] = results.map(result => result.value);
    await run("proxy5", "resume-a1", { previous: a1 });
    await run("proxy6", "resume-b1", { previous: b1 });
  } finally {
    await fs.writeFile(path.join(root, "receipt.json"), JSON.stringify({ checkedAt: new Date().toISOString(), receipts }, null, 2) + "\n");
    console.log(JSON.stringify({ realNativeEvidence: path.join(root, "receipt.json"), receipts }));
  }
});


test("real native refresh preserves the assignment and fresh usage works", {
  skip: process.env.AIMGR_TEST_REAL_ACCOUNTS !== "1", timeout: 120000,
}, async () => {
  assertTestEnvironment();
  inspectChallenge("");
  const runtime = await loadRedisRuntime({ homeDir: os.homedir(), provider: "anthropic" });
  const exec = promisify(execFile);
  const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
  const directory = await fs.mkdtemp(path.join(verification, "real-refresh-"));
  try {
    assert.deepEqual(runtime.snapshot.credentials.map(record => record.label).sort(), ["proxy5", "proxy6"]);
    const before = runtime.snapshot.credentials.find(record => record.label === "proxy5");
    assert.equal(before.policy.egress.profileRef, "proxy5");
    const due = structuredClone(before);
    // Change only the local expiration hint in this disposable test record.
    // Native Claude must exchange its real refresh token through the route.
    due.credential.nativeClaudeBundle.claudeAiOauth.expiresAt = Date.now() - 60000;
    const published = await publishCredential(runtime.store, { expectedVersion: before.version, credentialRecord: due, updatedBy: "offsite-refresh-acceptance" });
    assert.equal(published.ok, true);
    // Existing preflight reconciliation correctly prefers a newer managed
    // file. Make the same synthetic expiry hint due there, without changing
    // the real tokens, so this exercises exchange rather than reconciliation.
    const nativePath = path.join(os.homedir(), ".aimgr/claude-homes/proxy5/.claude/.credentials.json");
    const native = JSON.parse(await fs.readFile(nativePath, "utf8"));
    assert.ok(native.claudeAiOauth.accessToken === due.credential.nativeClaudeBundle.claudeAiOauth.accessToken,
      "Reconcile the disposable native token rotation before forcing another refresh; never print token values");
    native.claudeAiOauth.expiresAt = due.credential.nativeClaudeBundle.claudeAiOauth.expiresAt;
    await fs.writeFile(nativePath, JSON.stringify(native) + "\n", { mode: 0o600 });
    const env = nativeEnv();
    const maintained = await exec(process.execPath, [cli, "auth", "maintain"], { env, timeout: 60000, maxBuffer: 256 * 1024 });
    await fs.writeFile(path.join(directory, "maintenance.private.log"), maintained.stdout + maintained.stderr, { mode: 0o600 });
    inspectChallenge(maintained.stdout + maintained.stderr);
    // The normal one-shot Redis connection closes while native maintenance
    // runs. Read the completed publication through a fresh one-shot view.
    const refreshed = await loadRedisRuntime({ homeDir: os.homedir(), provider: "anthropic" });
    const after = refreshed.snapshot.credentials.find(record => record.label === "proxy5");
    await closeRedisRuntime(refreshed);
    const oldAuth = before.credential.nativeClaudeBundle.claudeAiOauth;
    const newAuth = after.credential.nativeClaudeBundle.claudeAiOauth;
    const receipt = {
      checkedAt: new Date().toISOString(), label: "proxy5",
      accessTokenChanged: oldAuth.accessToken !== newAuth.accessToken,
      refreshTokenChanged: oldAuth.refreshToken !== newAuth.refreshToken,
      expiryRenewed: newAuth.expiresAt > Date.now(),
      assignmentPreserved: after.policy.egress.profileRef === "proxy5",
      identityPreserved: after.identity.accountUuid === before.identity.accountUuid,
      versionBefore: before.version, versionAfter: after.version,
    };
    await fs.writeFile(path.join(directory, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
    console.log(JSON.stringify({ realRefreshEvidence: directory, ...receipt }));
    assert.equal(receipt.accessTokenChanged, true);
    assert.equal(receipt.expiryRenewed, true);
    assert.equal(receipt.assignmentPreserved, true);
    assert.equal(receipt.identityPreserved, true);
    const status = await exec(process.execPath, [cli, "claude", "status", "proxy5", "proxy6", "--fresh", "--json"], { env, timeout: 30000, maxBuffer: 256 * 1024 });
    await fs.writeFile(path.join(directory, "usage.private.json"), status.stdout, { mode: 0o600 });
    const usage = JSON.parse(status.stdout);
    assert.deepEqual(usage.accounts.map(account => account.label).sort(), ["proxy5", "proxy6"]);
    assert.ok(usage.accounts.every(account => account.source === "live" && account.usage?.ok === true && !account.errorKind));
  } finally { await closeRedisRuntime(runtime); }
});
