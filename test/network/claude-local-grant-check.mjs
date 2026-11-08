// Explicit per-host acceptance steps; the parent alternates hosts. No remote
// executor, browser control, grant transfer, or direct OAuth exchange lives here.
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAimgrConfig } from "../../src/config/aimgr-config.js";
import { withClaudeNativeStateLocks } from "../../src/credentials/claude-native-state-lock.js";
import { readClaudeActiveAppState } from "../../src/privacy/claude-state-source.js";
import { readClaudeEnvironment, claudeOwnerBinding } from "../../src/privacy/claude-environment.js";

assert.equal(process.env.AIMGR_TEST_REAL_LOCAL_AUTH, "1", "Explicit isolated-host opt-in is required");
if (process.platform === "darwin") {
  assert.equal(os.homedir(), "/Users/ec2-user");
  const marker = "/etc/aimgr-macos-test-rental.json";
  const stat = fs.statSync(marker);
  assert.equal(stat.uid, 0); assert.equal(stat.mode & 0o022, 0);
  const rental = JSON.parse(fs.readFileSync(marker, "utf8"));
  assert.equal(rental.purpose, "aimgr-macos-testing");
  assert.equal(rental.provider, "aws-ec2");
  assert.equal(rental.hostname, os.hostname());
} else {
  assert.equal(process.platform, "linux");
  assert.equal(os.hostname(), "aimgr-privacy-dev");
  assert.equal(os.homedir(), "/home/aimdev");
}
const { config } = readAimgrConfig({ homeDir: os.homedir() });
assert.equal(new URL(config.redis.url).hostname, "127.0.0.1");
assert.equal(config.redis.keyPrefix, "aimgr-privacy-dev:");
const [operation, directory] = process.argv.slice(2);
assert.ok(["snapshot", "request", "refresh", "logout"].includes(operation));
assert.ok(directory && path.isAbsolute(directory));
const rootStat = fs.lstatSync(directory);
assert.ok(rootStat.isDirectory() && !rootStat.isSymbolicLink());
assert.equal(rootStat.uid, process.getuid()); assert.equal(rootStat.mode & 0o077, 0);
const receiptPath = path.join(directory, "receipt.json");
assert.equal(fs.existsSync(receiptPath), false, "Use a fresh directory for each step");
const label = "proxy6";
const configDir = path.join(os.homedir(), ".aimgr/claude-homes", label, ".claude");
const appStatePath = path.join(configDir, ".claude.json");
const credentialsPath = path.join(configDir, ".credentials.json");
const environment = readClaudeEnvironment();
const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
const digest = value => crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
function localJson(file, optional = false) {
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
    const stat = fs.fstatSync(fd);
    assert.ok(stat.isFile() && stat.nlink === 1 && stat.uid === process.getuid() && stat.size <= 1024 * 1024);
    assert.equal(stat.mode & 0o077, 0);
    return JSON.parse(fs.readFileSync(fd, "utf8"));
  } catch (error) { if (optional && error.code === "ENOENT") return {}; throw error; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}
function snapshot() {
  const credentials = localJson(credentialsPath, true);
  const owner = localJson(path.join(configDir, ".aim-privacy-identity.json"), true);
  const account = readClaudeActiveAppState({ configDir }).state.oauthAccount;
  const primary = credentials.claudeAiOauth;
  const thirdParty = { ...credentials }; delete thirdParty.claudeAiOauth;
  const present = Boolean(primary?.accessToken && primary?.refreshToken);
  if (present) {
    assert.ok(account?.accountUuid && account?.organizationUuid);
    assert.equal(owner.accountUuid, account.accountUuid);
    assert.equal(owner.organizationUuid, account.organizationUuid);
    assert.equal(owner.environmentBinding, claudeOwnerBinding(environment, account));
    assert.ok(owner.grant?.id && owner.grant.source === "native-local-login" && owner.grant.status === "ready",
      "The test must begin with a successful managed local login");
  }
  return { credentials, primary, safe: { primaryPresent: present,
    accountOrganizationHash: account ? digest([account.accountUuid, account.organizationUuid]) : null,
    environmentOwnerHash: owner.environmentBinding ?? null,
    ownerGenerationHash: owner.grant?.id ? digest(owner.grant.id) : null,
    thirdPartyHash: digest(canonical(thirdParty)) } };
}
const locked = operation => withClaudeNativeStateLocks({ configDir, appStatePath }, operation);
async function native(args, name) {
  const outputPath = path.join(directory, name + ".private.log");
  const fd = fs.openSync(outputPath, "wx", 0o600);
  const child = spawn(process.execPath, [cli, ...args], { cwd: directory, env: process.env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "", exceeded = false, timedOut = false;
  const collect = chunk => {
    fs.writeSync(fd, chunk);
    if (output.length + chunk.length <= 1024 * 1024) output += chunk;
    else { exceeded = true; child.kill("SIGTERM"); }
    if (/verify you are human|human verification challenge/i.test(output)) child.kill("SIGTERM");
  };
  child.stdout.on("data", collect); child.stderr.on("data", collect);
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGTERM"); }, 90_000);
  const killTimer = setTimeout(() => child.kill("SIGKILL"), 95_000);
  let status;
  try {
    status = await new Promise(resolve => {
      child.once("error", () => resolve({ code: null, signal: "spawn-error" }));
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
  } finally { clearTimeout(timer); clearTimeout(killTimer); fs.closeSync(fd); }
  assert.equal(exceeded || timedOut, false, "Native output/deadline bound failed; inspect only the private log");
  assert.doesNotMatch(output, /verify you are human|human verification challenge/i, "Stop all provider work");
  return { ...status, output };
}
const usageArgs = ["claude", "run", label, "--", "--safe-mode", "--strict-mcp-config",
  "--no-session-persistence", "--print", "--output-format", "json", "/usage"];
function authenticated(result) {
  const records = result.output.split("\n").map(line => { try { return JSON.parse(line); } catch { return null; } });
  return result.code === 0 && records.some(row => row?.type === "result" && row.is_error === false);
}
const receipt = { checkedAt: new Date().toISOString(), platform: process.platform, operation, label };
let phase = "local-snapshot";
try {
  const before = await locked(snapshot);
  receipt.before = before.safe;
  assert.equal(before.safe.primaryPresent, true);
  if (operation === "refresh") {
    phase = "force-local-expiry-due";
    await locked(() => {
      const latest = snapshot();
      assert.ok(latest.primary.refreshToken === before.primary.refreshToken, "Unexpected concurrent rotation; do not overwrite it");
      latest.credentials.claudeAiOauth.expiresAt = Date.now() - 60_000;
      const temporary = path.join(configDir, ".fixture-expiry-" + crypto.randomUUID());
      try {
        fs.writeFileSync(temporary, JSON.stringify(latest.credentials) + "\n", { mode: 0o600, flag: "wx" });
        fs.renameSync(temporary, credentialsPath);
      } finally { fs.rmSync(temporary, { force: true }); }
    });
    receipt.forcedDueLocally = true;
  }
  if (operation === "request" || operation === "refresh") {
    phase = "native-authenticated-request";
    const result = await native(usageArgs, "native-usage");
    receipt.authenticatedRequest = authenticated(result);
    assert.equal(receipt.authenticatedRequest, true, "Native authenticated usage failed; inspect the private log");
  }
  if (operation === "logout") {
    phase = "local-logout";
    const result = await native(["claude", "logout", label], "native-logout");
    receipt.logoutSucceeded = result.code === 0;
    assert.equal(receipt.logoutSucceeded, true);
    for (let index = 0; index < 2; index++) {
      phase = "launch-after-local-logout";
      const denied = await native(usageArgs, "after-logout-" + index);
      assert.ok(denied.code !== 0 && /aim claude login/.test(denied.output), "Local logout must require explicit local login");
      assert.equal((await locked(snapshot)).safe.primaryPresent, false, "Managed request resurrected a primary grant");
    }
    receipt.repeatedLaunchesDenied = true;
    receipt.noPrimaryResurrection = true;
  }
  phase = "verify-local-state";
  const after = await locked(snapshot);
  receipt.after = after.safe;
  assert.equal(after.safe.thirdPartyHash, before.safe.thirdPartyHash, "Third-party credentials changed");
  receipt.thirdPartyPreserved = true;
  if (operation !== "logout") {
    assert.equal(after.safe.accountOrganizationHash, before.safe.accountOrganizationHash);
    assert.equal(after.safe.environmentOwnerHash, before.safe.environmentOwnerHash);
    assert.equal(after.safe.ownerGenerationHash, before.safe.ownerGenerationHash);
    receipt.ownerPreserved = true;
  }
  if (operation === "refresh") {
    receipt.accessTokenChanged = after.primary.accessToken !== before.primary.accessToken;
    receipt.refreshTokenChanged = after.primary.refreshToken !== before.primary.refreshToken;
    receipt.expiryRenewed = after.primary.expiresAt > Date.now();
    assert.equal(receipt.accessTokenChanged, true);
    assert.equal(receipt.refreshTokenChanged, true);
    assert.equal(receipt.expiryRenewed, true);
  }
  receipt.ok = true;
} catch {
  receipt.ok = false;
  receipt.failedPhase = phase;
  receipt.error = "Acceptance step failed; inspect this host's private log and source before retrying.";
} finally {
  fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
  console.log(JSON.stringify({ receiptPath, ...receipt }));
}
process.exitCode = receipt.ok ? 0 : 1;
