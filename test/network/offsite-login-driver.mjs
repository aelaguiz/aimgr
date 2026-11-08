// Opt-in test-only handoff. Managed login owns native OAuth; only its one-use
// URL/callback crosses hosts. Original-profile validation belongs to the parent.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readAimgrConfig } from "../../src/config/aimgr-config.js";

assert.equal(process.env.AIMGR_TEST_REAL_LOCAL_AUTH, "1", "Explicit isolated-host opt-in is required");
const label = process.argv[2];
assert.equal(label, "proxy6", "Only the established non-retired Claude test account is permitted");
if (process.platform === "darwin") {
  assert.equal(os.homedir(), "/Users/ec2-user");
  const marker = "/etc/aimgr-macos-test-rental.json";
  const stat = fs.statSync(marker);
  assert.equal(stat.uid, 0);
  assert.equal(stat.mode & 0o022, 0);
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
const directory = process.env.AIMGR_OFFSITE_LOGIN_DIR;
assert.ok(directory && path.isAbsolute(directory), "A fresh private handoff directory is required");
const stat = fs.lstatSync(directory);
assert.ok(stat.isDirectory() && !stat.isSymbolicLink());
assert.equal(stat.uid, process.getuid());
assert.equal(stat.mode & 0o077, 0);
const urlPath = path.join(directory, "auth-url.private.json");
const callbackPath = path.join(directory, "callback.private.json");
const stderrPath = path.join(directory, "native-stderr.private.log");
const receiptPath = path.join(directory, "receipt.json");
for (const name of [urlPath, callbackPath, stderrPath, receiptPath]) assert.equal(fs.existsSync(name), false);
const stderrFd = fs.openSync(stderrPath, "wx", 0o600);
const cli = fileURLToPath(new URL("../../bin/aimgr.js", import.meta.url));
const child = spawn(process.execPath, [cli, "claude", "login", label, "--manual-callback-stdio"], {
  cwd: directory, env: process.env, stdio: ["pipe", "pipe", stderrFd],
});
fs.closeSync(stderrFd);
let pending = "", authUrlSeen = false, callbackSubmitted = false, resultOk = false, failure = false;
const stop = () => {
  failure = true;
  child.kill("SIGTERM");
  const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
  timer.unref();
};
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
child.stdout.setEncoding("utf8");
child.stdin.on("error", stop);
child.stdout.on("data", chunk => {
  try {
    pending += chunk;
    assert.ok(pending.length <= 256 * 1024);
    let index;
    while ((index = pending.indexOf("\n")) >= 0) {
      const line = pending.slice(0, index); pending = pending.slice(index + 1);
      if (!line.trim()) continue;
      const event = JSON.parse(line);
      if (event.type === "auth_url") {
        assert.equal(authUrlSeen, false);
        assert.equal(event.provider, "anthropic");
        assert.equal(event.label, label);
        assert.equal(new URL(event.url).protocol, "https:");
        fs.writeFileSync(urlPath, JSON.stringify({ url: event.url }) + "\n", { mode: 0o600, flag: "wx" });
        authUrlSeen = true;
        console.log(JSON.stringify({ type: "handoff_ready", urlPath, callbackPath }));
      } else if (event.type === "result") {
        resultOk = event.ok === true && event.authority === "environment-local" && event.label === label
          && event.provider === "anthropic";
      } else if (event.type === "error") failure = true;
      else throw new Error("Unexpected login protocol event");
    }
  } catch { stop(); }
});
const poll = setInterval(() => {
  if (failure || !authUrlSeen || callbackSubmitted || !fs.existsSync(callbackPath)) return;
  try {
    const callbackStat = fs.lstatSync(callbackPath);
    assert.ok(callbackStat.isFile() && !callbackStat.isSymbolicLink());
    assert.equal(callbackStat.uid, process.getuid());
    assert.equal(callbackStat.mode & 0o077, 0);
    assert.ok(callbackStat.size > 0 && callbackStat.size <= 64 * 1024);
    const callback = JSON.parse(fs.readFileSync(callbackPath, "utf8"));
    assert.ok((typeof callback.url === "string") !== (typeof callback.code === "string"));
    assert.deepEqual(Object.keys(callback), [typeof callback.url === "string" ? "url" : "code"]);
    child.stdin.end(JSON.stringify(callback) + "\n");
    callbackSubmitted = true;
    fs.unlinkSync(callbackPath);
  } catch { stop(); }
}, 100);
const deadline = setTimeout(stop, 300_000);
const status = await new Promise(resolve => {
  child.once("error", () => { failure = true; resolve({ code: null, signal: "spawn-error" }); });
  child.once("close", (code, signal) => resolve({ code, signal }));
});
clearInterval(poll); clearTimeout(deadline);
for (const name of [urlPath, callbackPath]) fs.rmSync(name, { force: true });
const receipt = { checkedAt: new Date().toISOString(), platform: process.platform, label,
  authority: "environment-local", authUrlSeen, callbackSubmitted,
  ok: status.code === 0 && resultOk && !failure && authUrlSeen && callbackSubmitted, ...status };
fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2) + "\n", { mode: 0o600, flag: "wx" });
console.log(JSON.stringify({ type: "handoff_result", receiptPath, ...receipt }));
process.exitCode = receipt.ok ? 0 : 1;
