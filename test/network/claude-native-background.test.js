import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { runClaudeCli, runClaudeCliNoninteractive } from "../../src/targets/claude-runner.js";
import { assertLocalClaudeProfileStopped } from "../../src/network/claude-native-route.js";
import { listen } from "./socks-fixture.js";
import { installFixtureSecurityAdapter } from "./native-routine-fixture.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));

test("actual Claude background sessions retain independent A1/A2/B routing after dispatch exits", {
  skip: process.env.AIMGR_TEST_NATIVE_BACKGROUND !== "1", timeout: 150000,
}, async (t) => {
  assert.ok(["linux", "darwin"].includes(process.platform));
  const mac = process.platform === "darwin";
  if (mac) assert.equal(os.homedir(), "/Users/ec2-user");
  const profileName = name => `${mac ? "mac" : "bg"}_${name}`;
  assert.ok(process.env.AIMGR_TEST_CLAUDE_BIN);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-native-background-")));
  installFixtureSecurityAdapter(root);
  const previousCommand = path.join(root, "previous-client", "claude");
  await fs.mkdir(path.dirname(previousCommand));
  await fs.copyFile(process.env.AIMGR_TEST_CLAUDE_BIN, previousCommand);
  await fs.chmod(previousCommand, 0o755);
  const cwd = path.join(root, "project");
  await fs.mkdir(cwd);
  const children = [];
  const paths = [], requests = [], receipts = {}, held = new Map(), daemons = {};
  const services = ["aimgr-claude-proxy-bg_a.service", "aimgr-claude-proxy-bg_b.service"];
  const helper = path.join(repo, "native/claude/linux_proxy.py");
  const macInventory = async () => JSON.parse((await exec("/usr/bin/python3", ["-I", "-c", `import sys,json; sys.path.insert(0, '/opt/aimgr-claude-proxy'); import darwin_proxy as p; print(json.dumps(p.processes()))`])).stdout);
  const profileMembers = async name => mac
    ? Object.entries(await macInventory()).filter(([, info]) => info.uid === process.getuid() && info.gid === (name === "a" ? 64084 : 64085)).map(([pid]) => Number(pid))
    : (await fs.readFile(`/sys/fs/cgroup/aimgr-claude/bg_${name}/cgroup.procs`, "utf8")).trim().split("\n").filter(Boolean).map(Number);
  const stopA = async () => mac ? exec("sudo", ["launchctl", "bootout", "system/com.aimgr.claude-proxy.mac_a"]) : exec("sudo", ["systemctl", "stop", services[0]]);
  const startA = async () => {
    if (!mac) return exec("sudo", ["systemctl", "start", services[0]]);
    await exec("sudo", ["launchctl", "bootstrap", "system", "/Library/LaunchDaemons/com.aimgr.claude-proxy.mac_a.plist"]);
    for (let n = 0; n < 160; n++) {
      const flags = await fs.readdir("/opt/aimgr-claude-proxy/mac_a-state");
      if (!flags.includes("failed") && !flags.includes("starting")) return;
      await delay(50);
    }
    assert.fail("Mac background route did not repair");
  };
  const nativeOwners = async () => {
    if (mac) return JSON.parse((await exec("/usr/bin/python3", ["-I", "-c", `import sys,json,pathlib; sys.path.insert(0,'/opt/aimgr-claude-proxy'); import darwin_proxy as p
owners=[]
for pid,info in p.processes().items():
 if info['uid'] != ${process.getuid()} or not pathlib.Path(info['command']).name.startswith('claude'): continue
 try: values=p.environment(pid)
 except RuntimeError: continue
 if values and any(value.startswith(${JSON.stringify('CLAUDE_CONFIG_DIR='+root+'/')}.encode()) for value in values): owners.append(pid)
print(json.dumps(owners))`])).stdout);

    const executable = await fs.realpath(process.env.AIMGR_TEST_CLAUDE_BIN), owners = [];
    for (const pid of await fs.readdir("/proc")) {
      if (!/^\d+$/.test(pid)) continue;
      try {
        if (![executable, previousCommand].includes(await fs.realpath(`/proc/${pid}/exe`))) continue;
        const env = (await fs.readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
        if (env.some(entry => entry.startsWith(`CLAUDE_CONFIG_DIR=${root}/`))) owners.push(Number(pid));
      } catch (error) { if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error; }
    }
    return owners;
  };
  t.after(async () => {
    if (process.env.AIMGR_TEST_BACKGROUND_EVIDENCE) await fs.cp(root, process.env.AIMGR_TEST_BACKGROUND_EVIDENCE, { recursive: true });
    if (mac) {
      for (const name of ["mac_a", "mac_b"]) await exec("sudo", ["launchctl", "bootout", `system/com.aimgr.claude-proxy.${name}`]).catch(() => {});
    } else {
      for (const name of ["bg_a", "bg_b"]) await exec("python3", [helper, "stop", name]).catch(() => {});
      await exec("sudo", ["systemctl", "stop", ...services]).catch(() => {});
    }
    for (const pid of await nativeOwners()) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    if (mac) for (const ip of ["127.0.0.2", "127.0.0.3", "198.18.0.11"]) await exec("sudo", ["ifconfig", "lo0", "-alias", ip]).catch(() => {});
    else await exec("sudo", ["ip", "address", "del", "198.18.0.11/32", "dev", "lo"]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  const ownerScript = path.join(root, "owner.mjs");
  await fs.writeFile(ownerScript, `import fs from 'node:fs'; import {execFileSync} from 'node:child_process';
const owners=[]; let pid=process.pid;
for(let n=0;n<12&&pid>1;n++) { if (process.platform==='darwin') { const row=execFileSync('/bin/ps',['-p',String(pid),'-o','ppid=,uid=,gid=,comm='],{encoding:'utf8'}).trim().split(/\\s+/); owners.push({pid,ppid:Number(row[0]),uid:Number(row[1]),gid:Number(row[2]),command:row.slice(3).join(' ')}); pid=Number(row[0]); continue; } const stat=fs.readFileSync('/proc/'+pid+'/stat','utf8'); const tail=stat.slice(stat.lastIndexOf(')')+2).split(' '); owners.push({pid,ppid:Number(tail[1]),cgroup:fs.readFileSync('/proc/'+pid+'/cgroup','utf8'),status:fs.readFileSync('/proc/'+pid+'/status','utf8').split('\\n').filter(x=>/^(Name|Uid|Gid):/.test(x)),command:fs.readFileSync('/proc/'+pid+'/cmdline','utf8').split('\\0').filter(Boolean)}); pid=Number(tail[1]); }
fs.writeFileSync(${JSON.stringify(root)}+'/'+process.argv[2]+'.json', JSON.stringify({owners,configDir:process.env.CLAUDE_CONFIG_DIR,uid:process.getuid(),gid:process.getgid()}));
`);
  const origin = http.createServer(async (req, res) => {
    paths.push(req.url);
    if (req.url === "/exit") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: req.socket.remoteAddress })); return; }
    if (req.url.startsWith("/v1/messages/count_tokens")) { res.end('{"input_tokens":10}'); return; }
    if (!req.url.startsWith("/v1/messages")) { res.writeHead(404); res.end('{}'); return; }
    let raw = ""; for await (const chunk of req) raw += chunk;
    const body = JSON.parse(raw), messages = body.messages ?? [];
    const id = JSON.stringify(messages).match(/BG_(A[1-5]|B1)_CANARY/)?.[1];
    const hasResult = messages.some(m => Array.isArray(m.content) && m.content.some(b => b.type === "tool_result"));
    const toolResults = messages.flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === "tool_result") : []);
    requests.push({ id, key: req.headers["x-api-key"], route: req.socket.remoteAddress, hasResult, toolResults });
    // A barrier keeps the real background workers alive after dispatch exits.
    // B receives a fresh tool response after A fails, proving continued work.
    let nextContent;
    if (id && hasResult) nextContent = await new Promise(resolve => held.set(id, resolve));
    const canBash = body.tools?.some(tool => tool.name === "Bash");
    const content = nextContent ?? (id && canBash ? { type: "tool_use", id: `owner_${id}_${requests.length}`, name: "Bash", input: {
      command: `${process.execPath} ${ownerScript} ${id}`, description: "Record synthetic background process ownership",
    } } : { type: "text", text: "Synthetic background task" });
    const message = { id: `msg_bg_${requests.length}`, type: "message", role: "assistant", model: body.model, content: [content], stop_reason: content.type === "tool_use" ? "tool_use" : "end_turn", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
    if (!body.stream) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); return; }
    res.writeHead(200, { "content-type": "text/event-stream" });
    for (const event of [
      { type: "message_start", message: { ...message, content: [], stop_reason: null } },
      { type: "content_block_start", index: 0, content_block: content.type === "text" ? { type: "text", text: "" } : { ...content, input: {} } },
      { type: "content_block_delta", index: 0, delta: content.type === "text" ? { type: "text_delta", text: content.text } : { type: "input_json_delta", partial_json: JSON.stringify(content.input) } },
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
      { type: "message_stop" },
    ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
    res.end();
  });
  const port = await listen(origin, "0.0.0.0");
  t.after(() => { origin.closeAllConnections(); origin.close(); });
  if (mac) for (const ip of ["127.0.0.2", "127.0.0.3", "198.18.0.11"]) await exec("sudo", ["ifconfig", "lo0", "alias", ip, "up"]);
  else await exec("sudo", ["ip", "address", "add", "198.18.0.11/32", "dev", "lo"]);
  const destination = `http://198.18.0.11:${port}`;
  const fixture = new URL("./socks-fixture.js", import.meta.url).href;
  const proxies = {};
  for (const [name, sourceAddress] of [["a", "127.0.0.2"], ["b", "127.0.0.3"]]) {
    const child = spawn(process.execPath, ["--input-type=module", "-e", `import {startSocks} from ${JSON.stringify(fixture)}; const s=await startSocks({sourceAddress:${JSON.stringify(sourceAddress)},destinations:{"198.18.0.11":${port}}}); console.log(s.port);`], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    proxies[name] = { child, socksPort: Number((await once(child.stdout, "data"))[0].toString().trim()), expectedExits: [sourceAddress] };
  }
  const profiles = Object.fromEntries(Object.entries(proxies).map(([name, p]) => [profileName(name), { ...(mac ? { gid: name === "a" ? 64084 : 64085, interface: name === "a" ? "utun84" : "utun85", subnetIndex: name === "a" ? 84 : 85 } : {}), socksPort: p.socksPort, expectedExits: p.expectedExits, redirectPort: name === "a" ? 15185 : 15186, exitCheckUrl: `${destination}/exit` }]));
  const manifest = path.join(root, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ user: process.env.USER, profiles }));
  await exec("sudo", ["bash", path.join(repo, `scripts/install-claude-proxy-${mac ? "macos" : "linux"}.sh`), manifest]);
  for (const name of ["a", "b"]) {
    const config = path.join(root, ".aimgr", "claude-homes", name, ".claude");
    await fs.mkdir(config, { recursive: true });
    await fs.writeFile(path.join(config, "settings.json"), JSON.stringify({ skipDangerousModePermissionPrompt: true,
      env: { ANTHROPIC_BASE_URL: destination, ANTHROPIC_API_KEY: `synthetic-bg-${name}`, API_TIMEOUT_MS: "120000" } }));
    await fs.writeFile(path.join(config, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true,
      primaryApiKey: `synthetic-bg-${name}`, customApiKeyResponses: { approved: [`synthetic-bg-${name}`], rejected: [] },
      projects: { [cwd]: { hasTrustDialogAccepted: true } } }));
  }
  const launch = async (id, { protectedRoute = true, denied = false, interactiveRunner = false, configAlias = false, command = process.env.AIMGR_TEST_CLAUDE_BIN } = {}) => {
    const name = id[0].toLowerCase(), configDir = path.join(root, ".aimgr", "claude-homes", configAlias ? `${name}-alias` : name, ".claude");
    let output = "";
    const result = await (interactiveRunner ? runClaudeCli : runClaudeCliNoninteractive)({ command, userHomeDir: root, homeDir: path.dirname(configDir), configDir, cwd,
      args: ["--bg", "--name", `aimgr-${id}`, `Run the synthetic owner tool. BG_${id}_CANARY.`, "--dangerously-skip-permissions", "--model", "claude-sonnet-4-6"],
      env: { ...process.env }, timeoutMs: 30000,
      egressProfile: protectedRoute ? { ...profiles[profileName(name)], profileRef: profileName(name), label: name, socksHost: "127.0.0.1" } : undefined,
      spawnImpl: (command, args, options) => { const child = spawn(command, args, { ...options, stdio: interactiveRunner ? ["ignore", "pipe", "pipe", "ipc"] : options.stdio }); child.stdout.on("data", c => { output += c; }); child.stderr.on("data", c => { output += c; }); return child; },
    });
    if (denied) {
      assert.equal(result.status, 125, JSON.stringify({ result, output }));
      assert.match(output, /account a, proxy (bg|mac)_a unavailable/);
      assert.match(output, /outside its assigned proxy/);
      assert.ok(!requests.some(r => r.id === id));
      return;
    }
    assert.equal(result.status, 0, JSON.stringify({ id, result, output }));
    for (let n = 0; n < 300 && !requests.some(r => r.id === id && r.hasResult); n++) await delay(50);
    if (!requests.some(r => r.id === id && r.hasResult)) {
      for (const entry of ["daemon.log"]) {
        const diagnostics = await fs.readFile(path.join(configDir, entry), "utf8").catch(() => "missing");
        console.log(JSON.stringify({ backgroundDiagnostic: entry, content: diagnostics.slice(-16000) }));
      }
      console.log(JSON.stringify({ scopedProcesses: (await exec("ps", ["-eo", "pid,ppid,args"])).stdout.split("\n").filter(line => line.includes(root)) }));
      if (process.env.AIMGR_TEST_BACKGROUND_EVIDENCE) await fs.cp(root, process.env.AIMGR_TEST_BACKGROUND_EVIDENCE, { recursive: true });
    }
    assert.ok(requests.some(r => r.id === id && r.hasResult), JSON.stringify({ id, output, requests, paths }));
    const rawReceipt = await fs.readFile(path.join(root, `${id}.json`), "utf8").catch(error => {
      throw new Error(JSON.stringify({ id, error: error.message, requests }));
    });
    const receipt = JSON.parse(rawReceipt);
    assert.equal(receipt.configDir, configDir);
    assert.equal(receipt.uid, process.getuid());
    assert.ok(receipt.owners.length >= 3);
    assert.equal(receipt.owners.every(owner => mac ? owner.gid === (name === "a" ? 64084 : 64085) : owner.cgroup.includes(`/aimgr-claude/bg_${name}`)), protectedRoute, JSON.stringify(receipt));
    assert.ok(requests.filter(r => r.id === id).every(r => r.key === `synthetic-bg-${name}` && r.route === (protectedRoute ? proxies[name].expectedExits[0] : "198.18.0.11")));
    const roster = JSON.parse(await fs.readFile(path.join(configDir, "daemon/roster.json"), "utf8"));
    daemons[id] = roster.supervisorPid;
    assert.equal(mac ? (await macInventory())[roster.supervisorPid]?.gid === (name === "a" ? 64084 : 64085)
      : (await fs.readFile(`/proc/${roster.supervisorPid}/cgroup`, "utf8")).includes(`/aimgr-claude/bg_${name}`), protectedRoute);
    const members = await profileMembers(name);
    receipt.nativeProcesses = (await Promise.all(members.map(async pid => {
      if (mac) return { pid, ...(await macInventory())[pid] };
      try { return { pid, status: (await fs.readFile(`/proc/${pid}/status`, "utf8")).split("\n").filter(line => /^(Name|PPid|Uid|Gid):/.test(line)) }; }
      catch (error) { if (error.code === "ENOENT" || error.code === "ESRCH") return null; throw error; }
    }))).filter(Boolean);
    receipts[id] = receipt;
  };
  await launch("A1");
  await Promise.all([launch("A2"), launch("B1")]);
  assert.equal(daemons.A1, daemons.A2);
  assert.notEqual(daemons.A1, daemons.B1);
  await assert.rejects(assertLocalClaudeProfileStopped(profileName("a")), /still has local native work/);
  const aBefore = requests.filter(r => r.id?.startsWith("A")).length;
  const interruptedBefore = requests.filter(r => ["A1", "A2"].includes(r.id)).length;
  await stopA();
  for (let n = 0; n < 100; n++) {
    if ((await profileMembers("a")).length === 0) break;
    await delay(50);
  }
  assert.equal((await profileMembers("a")).length, 0);
  assert.ok((await profileMembers("b")).length > 0);
  held.get("B1")({ type: "tool_use", id: "b_after_a_failure", name: "Bash", input: {
    command: `${process.execPath} ${ownerScript} B1_after`, description: "Prove healthy B continues after A stops",
  } });
  for (let n = 0; n < 200 && requests.filter(r => r.id === "B1" && r.hasResult).length < 2; n++) await delay(50);
  assert.ok(requests.filter(r => r.id === "B1" && r.hasResult).length >= 2);
  assert.equal(JSON.parse(await fs.readFile(path.join(root, "B1_after.json"), "utf8")).uid, process.getuid());
  await startA();
  await delay(500);
  assert.equal(requests.filter(r => r.id?.startsWith("A")).length, aBefore);
  assert.equal((await profileMembers("a")).length, 0);
  // Enrollment must not silently hand a protected dispatch to a daemon that
  // started before privacy was enabled. Surviving workers matter too.
  await fs.symlink(path.join(root, ".aimgr/claude-homes/a"), path.join(root, ".aimgr/claude-homes/a-alias"));
  await launch("A3", { protectedRoute: false, command: previousCommand, configAlias: true });
  await launch("A4", { denied: true });
  await launch("A4", { denied: true, interactiveRunner: true });
  process.kill(daemons.A3, "SIGKILL");
  await delay(100);
  const remaining = await nativeOwners();
  const outside = [];
  for (const pid of remaining) {
    if (mac ? ![64084, 64085].includes((await macInventory())[pid]?.gid)
      : !(await fs.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "")).includes("/aimgr-claude/")) outside.push(pid);
  }
  assert.ok(outside.length, "the pinned daemon leaves workers after its supervisor exits");
  await launch("A4", { denied: true });
  await launch("A4", { denied: true, interactiveRunner: true });
  for (const pid of outside) { try { process.kill(pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") throw error; } }
  await delay(150);
  await launch("A5");
  assert.equal(requests.filter(r => ["A1", "A2"].includes(r.id)).length, interruptedBefore,
    "a later cold daemon must not replay interrupted A1/A2 work");
  console.log(JSON.stringify({ nativeBackground: { receipts, requests, dispatchReturned: true, stoppedAOnly: true,
    ordinaryDaemonDenied: true, aliasedAccountDirectoryDenied: true, orphanedWorkersDenied: true, explicitStoppedTransitionPassed: true } }));
});
