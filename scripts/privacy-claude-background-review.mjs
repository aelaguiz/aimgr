/**
 * Research-only, exact native client experiment. Invoke through the default-
 * services probe on the marked offsite Linux VM inside a fresh network AND PID
 * namespace. All credentials, conversations and TLS responses are synthetic.
 *
 * A pathname copy of the same reviewed vendor bytes stands in for an older
 * daemon owner. It proves which executable actually runs a later job without
 * introducing or approving an unknown Claude version. The experiment records
 * the distinction; it does not treat this copy as a new approved AIM bundle.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { runClaudeCliNoninteractive } from "../src/targets/claude-runner.js";

const input = JSON.parse(process.argv[2]);
const { check, captureFile, ...launch } = input;
assert.equal(process.platform, "linux");
assert.notEqual(process.getuid(), 0);
assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
assert.ok(launch.userHomeDir.startsWith("/opt/aimgr-state-audit/claude-implementation/"));
// /sys can still describe the host mount; getifaddrs reads this net namespace.
assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = launch.userHomeDir;
const observations = [];
const write = () => fs.writeFileSync(path.join(root, "background-review.json"), JSON.stringify({ observations }, null, 2));
const capture = () => fs.readFileSync(captureFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
const modelCount = marker => capture().filter(row => row.path.includes("/messages") && JSON.stringify(row.body).includes(marker)).length;
const owners = (config = launch.configDir) => fs.readdirSync("/proc").filter(p => /^\d+$/.test(p)).flatMap(p => {
  try {
    const env = fs.readFileSync(`/proc/${p}/environ`, "utf8").split("\0");
    if (!env.includes(`CLAUDE_CONFIG_DIR=${config}`)) return [];
    const exe = fs.readlinkSync(`/proc/${p}/exe`);
    if (!path.basename(exe).startsWith("claude")) return [];
    const args = fs.readFileSync(`/proc/${p}/cmdline`, "utf8").split("\0").filter(Boolean);
    return [{ pid: Number(p), executable: exe, daemon: args.includes("daemon") && args.includes("run"), args }];
  } catch { return []; }
});
const until = async (predicate, label, timeout = 20000) => {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (predicate()) return; await delay(100); }
  throw new Error(`Timed out: ${label}`);
};
const enabledEnv = { ...process.env }; delete enabledEnv.CLAUDE_CODE_DISABLE_AGENT_VIEW;
const disabledEnv = { ...enabledEnv, CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" };
const saveOutput = (label, stdout, stderr) => fs.appendFileSync(path.join(root, "background-output.private.txt"), `\n${label}\n${stdout}\n${stderr}\n`);
const direct = async (command, args, env, label) => {
  const child = spawn(command, args, { cwd: launch.cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "", stderr = "", timedOut = false;
  child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; });
  const timer = setTimeout(() => { timedOut = true; child.kill("SIGKILL"); }, 20000);
  const result = await new Promise((resolve, reject) => { child.on("error", reject); child.on("close", (status, signal) => resolve({ status, signal })); });
  clearTimeout(timer); saveOutput(label, stdout, stderr);
  return { ...result, stdout, stderr, timedOut };
};
const admitted = async (args, env, label) => {
  let stdout = "", stderr = "";
  const result = await runClaudeCliNoninteractive({ ...launch, args, env, timeoutMs: 30000,
    spawnImpl(command, argv, options) {
      const child = spawn(command, argv, options);
      child.stdout.on("data", c => { stdout += c; }); child.stderr.on("data", c => { stderr += c; }); return child;
    } });
  saveOutput(label, stdout, stderr); return { ...result, stdout, stderr };
};
const bgArgs = marker => ["--bg", "--name", marker, `Reply SYNTHETIC_OK. ${marker}.`, "--dangerously-skip-permissions", "--model", "sonnet"];
const note = (name, details) => { observations.push({ name, ...details }); write(); };
try {
  const first = await admitted(["-p", "Reply SYNTHETIC_OK. FOREGROUND_ONLY.", "--model", "sonnet"], enabledEnv, "foreground");
  assert.equal(first.status, 0); assert.ok(first.stdout.includes("SYNTHETIC_OK"));
  assert.equal(owners().length, 0);
  note("foreground-does-not-require-daemon", { passed: true });

  const old = path.join(root, "claude-previous-path");
  fs.copyFileSync(launch.command, old); fs.chmodSync(old, 0o700);
  const userSettings = path.join(launch.configDir, "settings.json");
  const settings = JSON.parse(fs.readFileSync(userSettings, "utf8"));
  fs.writeFileSync(userSettings, JSON.stringify({ ...settings, skipDangerousModePermissionPrompt: true }));
  const previous = await direct(old, bgArgs("OLD_OWNER"), enabledEnv, "old-owner");
  assert.equal(previous.status, 0, "native background positive control failed");
  await until(() => owners().some(o => o.daemon) && modelCount("OLD_OWNER") > 0, "old daemon and worker request");
  const daemon = owners().find(o => o.daemon);
  await delay(1000);
  assert.ok(owners().some(o => o.pid === daemon.pid));
  note("background-outlives-dispatch", { passed: true, daemonExecutable: daemon.executable, daemonPid: daemon.pid });

  const handoff = await admitted(bgArgs("NEW_DISPATCH"), enabledEnv, "new-admitted-dispatch");
  assert.equal(handoff.status, 0, "approved dispatcher handoff refused");
  await until(() => modelCount("NEW_DISPATCH") > 0, "later worker request");
  const after = owners();
  assert.equal(after.find(o => o.daemon)?.pid, daemon.pid);
  assert.ok(after.filter(o => !o.daemon).length >= 2);
  assert.ok(after.every(o => o.executable === old));
  note("new-admitted-dispatch-reuses-previous-executable", { passed: true, sameDaemon: true,
    descendantProcesses: after.filter(o => !o.daemon).map(({ pid, executable }) => ({ pid, executable })),
    limitation: "The previous pathname contains the same reviewed vendor bytes, not another version." });

  const before = owners().map(o => o.pid).sort();
  for (const [name, args] of [["bg", bgArgs("DISABLED_DISPATCH")], ["daemon-run", ["daemon", "run"]]]) {
    const messagesBefore = capture().filter(row => row.path.includes("/messages")).length;
    const result = await admitted(args, disabledEnv, `disabled-${name}`);
    const message = result.stdout + result.stderr;
    const policyRefusal = /disabled|disableAgentView|DISABLE_AGENT_VIEW/i.test(message);
    const sent = capture().filter(row => row.path.includes("/messages")).length - messagesBefore;
    note(name === "bg" ? "disabled-bg-with-existing-daemon" : "aim-daemon-argv-falls-through-to-prompt", {
      status: result.status, policyRefusal, modelRequests: sent,
      ...(name === "daemon-run" ? { nativeDaemonCommandReached: false, explanation:
        "AIM prepends settings arguments, so the native first-argument daemon command is not reached. The synthetic service answered an ordinary prompt." } : {}) });
    if (name === "bg") assert.ok(policyRefusal, `${name} did not report native policy refusal`);
    // This observation is a command-dispatch UX problem, not daemon policy
    // evidence. Test the actual native daemon command separately below.
    else { assert.equal(result.status, 0); assert.ok(result.stdout.includes("SYNTHETIC_OK")); assert.ok(sent > 0); }
    assert.equal(modelCount("DISABLED_DISPATCH"), 0);
  }
  // `agents` checks TTY availability before its policy. Pipes test the wrong
  // refusal; give the native UI a real disposable PTY for this independent gate.
  const ptyScript = `import os,pty,subprocess,sys,select,time
master,slave=pty.openpty()
p=subprocess.Popen(sys.argv[1:],stdin=slave,stdout=slave,stderr=slave)
os.close(slave); output=b''; end=time.monotonic()+15
while time.monotonic()<end:
 if select.select([master],[],[],.1)[0]:
  try: output+=os.read(master,65536)
  except OSError: break
 if p.poll() is not None: break
if p.poll() is None: p.kill()
code=p.wait(); os.close(master);sys.stdout.buffer.write(output);sys.exit(code if code>=0 else 128-code)
`;
  const agents = await direct("/usr/bin/python3", ["-c", ptyScript, launch.command, "agents"], disabledEnv, "disabled-agents-real-pty");
  const agentsPolicyRefusal = /disabled|disableAgentView|DISABLE_AGENT_VIEW/i.test(agents.stdout + agents.stderr);
  note("disabled-agents-with-real-pty", { status: agents.status, policyRefusal: agentsPolicyRefusal });
  assert.ok(agentsPolicyRefusal);
  assert.deepEqual(owners().map(o => o.pid).sort(), before);
  note("narrow-switch-does-not-stop-existing-work", { passed: true });
  const freshConfig = path.join(root, "fresh-config");
  fs.mkdirSync(freshConfig);
  for (const file of [".claude.json", ".credentials.json", "settings.json"]) {
    fs.copyFileSync(path.join(launch.configDir, file), path.join(freshConfig, file));
  }
  const freshEnv = { ...disabledEnv, CLAUDE_CONFIG_DIR: freshConfig, CLAUDE_SECURESTORAGE_CONFIG_DIR: freshConfig };
  const requestsBefore = capture().filter(row => row.path.includes("/messages")).length;
  const freshDaemon = await direct(launch.command, ["daemon", "run"], freshEnv, "disabled-fresh-daemon-run");
  assert.equal(freshDaemon.status, 0); assert.equal(freshDaemon.timedOut, false);
  assert.equal(owners(freshConfig).length, 0);
  assert.equal(fs.existsSync(path.join(freshConfig, "daemon/roster.json")), false);
  assert.equal(capture().filter(row => row.path.includes("/messages")).length, requestsBefore);
  note("narrow-switch-prevents-fresh-supervisor", { passed: true, status: freshDaemon.status,
    policyRefusal: /disabled|disableAgentView|DISABLE_AGENT_VIEW/i.test(freshDaemon.stdout + freshDaemon.stderr),
    modelRequests: 0, nativeOwners: 0, rosterCreated: false });
  const foreground = await admitted(["-p", "Reply SYNTHETIC_OK. DISABLED_FOREGROUND.", "--model", "sonnet"], disabledEnv, "disabled-foreground");
  assert.equal(foreground.status, 0); assert.ok(foreground.stdout.includes("SYNTHETIC_OK"));
  note("narrow-switch-retains-foreground", { passed: true });
  console.log("SYNTHETIC_OK");
} catch (error) {
  note("failure", { message: error.message }); throw error;
} finally {
  // Only processes whose exact synthetic config belongs to this fresh fixture.
  // The surrounding PID namespace also prevents leaked test daemons on failure.
  for (const owner of owners()) { try { process.kill(owner.pid, "SIGKILL"); } catch {} }
}
