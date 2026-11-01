import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { listen } from "./socks-fixture.js";
import { prepareClaudeNativeRoute, assertLocalClaudeProfileStopped } from "../../src/network/claude-native-route.js";
import { acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";
import { createNativeRoutineFixture, verifyStartupDenied } from "./native-routine-fixture.js";

import { verifyNativeClaudeFeatures } from "./native-features-fixture.js";
import { verifyOsScheduledRoutine } from "./native-scheduled-fixture.js";
import { verifyInteractiveRoutine, verifyScheduledInterruption, verifyNativeTerminalCleanup } from "./native-pty-fixture.js";
import { verifyNativeProcessControl } from "./native-control-fixture.js";
import { verifyRoutineConcurrency, verifyScheduledStartupFailure, assertScheduledModelRoutes } from "./native-scheduled-failure-fixture.js";
import { scheduledResponse } from "./native-scheduled-response.js";

const exec = promisify(execFile);
const repo = fileURLToPath(new URL("../../", import.meta.url));

test("rented Mac native routes preserve concurrent callers and close on adapter/monitor failure", {
  skip: process.env.AIMGR_TEST_NATIVE_MAC !== "1", timeout: 600000,
}, async t => {
  assert.equal(process.platform, "darwin");
  assert.equal(os.homedir(), "/Users/ec2-user");
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-mac-native-")));
  const defaults = async () => ({ route: (await exec("/sbin/route", ["-n", "get", "default"])).stdout.split("\n").filter(line => /gateway:|interface:/.test(line)),
    dns: (await exec("/usr/sbin/scutil", ["--dns"])).stdout });
  const beforeDefaults = await defaults();
  const children = [], receipts = [], routes = {}, tunnels = {}, modelRequests = [], modelRoutes = [];
  let holdExit = false, heldExitSeen = false;
  const handler = async (req, res) => {
    receipts.push({ path: req.url, route: req.socket.remoteAddress, ordinaryLane: Boolean(req.ordinaryLane) });
    if (req.url === "/exit" && holdExit && req.socket.remoteAddress === "127.0.0.2") { heldExitSeen = true; return; }
    if (req.url.startsWith("/v1/messages")) {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw);
      modelRequests.push(body);
      modelRoutes.push(req.socket.remoteAddress);
      if (JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")) return;
      const routine = JSON.stringify(body.messages).includes("ROUTINE_SUCCESS_CANARY");
      const wantsMcp = JSON.stringify(body.messages).includes("MCP_STDIO_CANARY");
      const wantsSubagent = body.messages.some(message => message.role === "user" && (typeof message.content === "string"
        ? message.content.includes("NATIVE_SUBAGENT_PARENT")
        : message.content.some(block => block.type === "text" && block.text.includes("NATIVE_SUBAGENT_PARENT"))));
      const isChild = JSON.stringify(body.messages).includes("NATIVE_CHILD_TASK") && !wantsSubagent;
      const mcpTool = body.tools.find(tool => tool.name.includes("stdio") && tool.name.endsWith("echo"));
      const toolName = wantsSubagent ? "Agent" : wantsMcp ? mcpTool?.name ?? "ToolSearch" : "Bash";
      const alreadyRan = body.messages.some(message => Array.isArray(message.content) && message.content.some(block => block.type === "tool_use" && (wantsSubagent ? block.name === "Agent" : wantsMcp ? block.name.includes("stdio") && block.name.endsWith("echo") : block.name === "Bash")));
      // Current Claude defers MCP tool definitions until ToolSearch discovers
      // them. Exercise that normal discovery before asking for the real tool.
      const input = wantsSubagent ? { description: "Synthetic child task", prompt: "Run the synthetic Bash task. NATIVE_CHILD_TASK.", subagent_type: "general-purpose" }
        : wantsMcp ? (mcpTool ? { text: "MCP_TOOL_RESULT_CANARY" } : { query: "+stdio echo", max_results: 5 })
          : { command: isChild ? "printf subagent-ok > child-proof.txt" : "printf native-tool-ok > tool-proof.txt", description: "Write synthetic test proof" };
      // The CLI deduplicates tool calls by id. Discovery and invocation must
      // have separate ids, just as separate real model responses do.
      const content = scheduledResponse(body, modelRequests.length) ?? (alreadyRan ? { type: "text", text: routine ? "NATIVE_MOCK_DONE\nAIM-JOB: done" : "NATIVE_MOCK_DONE" } : { type: "tool_use", id: `tool_fixture_${modelRequests.length}`, name: toolName, input });
      if (content.hold) return;
      const message = { id: `msg_native_${modelRequests.length}`, type: "message", role: "assistant", model: body.model, content: [content], stop_reason: content.type === "text" ? "end_turn" : "tool_use", stop_sequence: null, usage: { input_tokens: 10, output_tokens: 10 } };
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const events = [
          { type: "message_start", message: { ...message, content: [], stop_reason: null } },
          { type: "content_block_start", index: 0, content_block: content.type === "text" ? { type: "text", text: "" } : { ...content, input: {} } },
          { type: "content_block_delta", index: 0, delta: content.type === "text" ? { type: "text_delta", text: content.text } : { type: "input_json_delta", partial_json: JSON.stringify(content.input) } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: message.stop_reason, stop_sequence: null }, usage: { output_tokens: 10 } },
          { type: "message_stop" },
        ];
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else { res.setHeader("content-type", "application/json"); res.end(JSON.stringify(message)); }
      return;
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ip: req.socket.remoteAddress }));
  };
  const origin = http.createServer(handler);
  const ordinaryOrigin = http.createServer((req, res) => { req.ordinaryLane = true; return handler(req, res); });
  const port = await listen(origin, "0.0.0.0"), destination = `http://198.18.0.11:${port}`;
  const ordinaryDestination = `http://198.18.0.11:${await listen(ordinaryOrigin, "0.0.0.0")}`;
  t.after(async () => {
    for (const name of ["mac_a", "mac_b"]) await exec("sudo", ["launchctl", "bootout", `system/com.aimgr.claude-proxy.${name}`]).catch(() => {});
    for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    origin.closeAllConnections(); origin.close();
    ordinaryOrigin.closeAllConnections(); ordinaryOrigin.close();
    for (const ip of ["127.0.0.2", "127.0.0.3", "198.18.0.11"]) await exec("sudo", ["ifconfig", "lo0", "-alias", ip]).catch(() => {});
    await exec("sudo", ["ifconfig", "lo0", "inet6", "fd18::11", "-alias"]).catch(() => {});
    if (process.env.AIMGR_TEST_MAC_EVIDENCE) await fs.cp(root, process.env.AIMGR_TEST_MAC_EVIDENCE, { recursive: true });
    await fs.rm(root, { recursive: true, force: true });
  });
  for (const ip of ["127.0.0.2", "127.0.0.3", "198.18.0.11"]) await exec("sudo", ["ifconfig", "lo0", "alias", ip, "up"]);
  await exec("sudo", ["ifconfig", "lo0", "inet6", "fd18::11", "alias"]);
  for (const [name, source, index] of [["a", "127.0.0.2", 84], ["b", "127.0.0.3", 85]]) {
    const code = `import {startSocks} from ${JSON.stringify(new URL("./socks-fixture.js", import.meta.url).href)}; const s=await startSocks({sourceAddress:${JSON.stringify(source)},destinations:{"198.18.0.11":${port},ipv6:${port}}}); console.log(s.port);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", code], { stdio: ["ignore", "pipe", "inherit"] });
    children.push(child);
    tunnels[name] = child;
    routes[name] = { socksHost: "127.0.0.1", socksPort: Number((await once(child.stdout, "data"))[0].toString().trim()),
      expectedExits: [source], exitCheckUrl: `${destination}/exit`, gid: 64000 + index, interface: `utun${index}`, subnetIndex: index };
  }
  const manifest = path.join(root, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ user: os.userInfo().username, profiles: { mac_a: routes.a, mac_b: routes.b } }));
  const savedHistory = path.join(root, "pre-change-history.jsonl");
  const historyText = '{"type":"user","message":"PRE_CHANGE_HISTORY_CANARY"}\n';
  await fs.writeFile(savedHistory, historyText);
  const oldWrites = path.join(root, "old-writer-count");
  const oldWriter = spawn(process.execPath, ["-e", `const fs=require('fs');setInterval(()=>fs.appendFileSync(${JSON.stringify(oldWrites)},'x'),30)`]);
  children.push(oldWriter);
  for (let n = 0; n < 100; n++) { try { await fs.stat(oldWrites); break; } catch { await delay(25); } }
  const oldExit = once(oldWriter, "exit"); oldWriter.kill("SIGTERM"); await oldExit;
  const writesAtStop = await fs.readFile(oldWrites, "utf8");
  const install = file => exec("sudo", ["bash", "-c", 'umask 077; exec "$@"', "--", "bash", path.join(repo, "scripts/install-claude-proxy-macos.sh"), file], { timeout: 45000 });
  const installedManifest = "/opt/aimgr-claude-proxy/manifest.json";
  const beforeInstall = await fs.readFile(installedManifest).catch(error => { if (error.code !== "ENOENT") throw error; return null; });
  const invalid = path.join(root, "invalid-install.json");
  await fs.writeFile(invalid, JSON.stringify({ user: os.userInfo().username, profiles: { mac_a: { ...routes.a, socksPort: 0 }, mac_b: routes.b } }));
  await assert.rejects(install(invalid), error => error.code === 125);
  assert.deepEqual(await fs.readFile(installedManifest).catch(error => { if (error.code !== "ENOENT") throw error; return null; }), beforeInstall);
  const wrongExit = path.join(root, "failed-verification.json");
  await fs.writeFile(wrongExit, JSON.stringify({ user: os.userInfo().username, profiles: { mac_a: { ...routes.a, expectedExits: ["192.0.2.77"] }, mac_b: routes.b } }));
  await assert.rejects(install(wrongExit), error => error.code === 125 && /did not become ready/.test(error.stderr));
  for (const name of ["mac_a", "mac_b"]) {
    await fs.access(`/opt/aimgr-claude-proxy/${name}-state/failed`);
    await assertLocalClaudeProfileStopped(name);
  }
  const forbiddenProof = path.join(root, "failed-install-child");
  const deniedArgs = ["-e", `require('fs').writeFileSync(${JSON.stringify(forbiddenProof)},'unexpected')`];
  await assert.rejects(prepareClaudeNativeRoute({ profile: { ...routes.a, profileRef: "mac_a", label: "a" }, command: process.execPath,
    args: deniedArgs }), { code: "native_proxy_mismatch" });
  await assert.rejects(exec("/opt/aimgr-claude-proxy/darwin_launch", ["mac_a", JSON.stringify({ ...routes.a, expectedExits: ["192.0.2.77"] }),
    "--", process.execPath, ...deniedArgs]), error => error.code === 125);
  await assert.rejects(fs.access(forbiddenProof), { code: "ENOENT" });
  assert.equal(await fs.readFile(savedHistory, "utf8"), historyText);
  assert.equal(await fs.readFile(oldWrites, "utf8"), writesAtStop);
  await install(manifest);
  assert.equal(await fs.readFile(savedHistory, "utf8"), historyText);
  assert.equal(await fs.readFile(oldWrites, "utf8"), writesAtStop);
  console.log(JSON.stringify({ nativeMacTransition: { failedInstallPreservedState: true, failedVerificationClosed: true, deniedChildDidNotStart: true,
    historyPreserved: true, oldWriterStayedStopped: true, explicitRepairRequired: true } }));
  await exec("sudo", ["/usr/bin/python3", "-I", "/opt/aimgr-claude-proxy/darwin_proxy.py", "verify", "mac_a"]);
  assert.deepEqual(await defaults(), beforeDefaults, "installation preserves the machine's default route and DNS resolvers");
  for (const [url, expected] of [[`http://[fd18::11]:${port}/ipv6`, "127.0.0.2"], [`http://localhost:${port}/loopback`, "127.0.0.1"]]) {
    const invocation = await prepareClaudeNativeRoute({ profile: { ...routes.a, profileRef: "mac_a", label: "a" }, command: "/usr/bin/curl", args: ["--noproxy", "*", "-fsS", "--max-time", "5", url] });
    assert.equal(JSON.parse((await exec(invocation.command, invocation.args)).stdout).ip, expected);
  }
  console.log(JSON.stringify({ nativeNetwork: { ipv6AssignedRoute: true, hostnameAndLoopbackPreserved: true, defaultRouteAndResolversUnchanged: true } }));
  const started = [];
  const launch = async (name, id) => {
    const code = `const url=${JSON.stringify(destination + "/")}; const id=${JSON.stringify(id)}; async function turn(){const r=await fetch(url+id);console.log(JSON.stringify({id,exit:(await r.json()).ip,uid:process.getuid(),gid:process.getgid(),cwd:process.cwd(),custom:process.env.AIMGR_ENV_CANARY,timezone:process.env.TZ,locale:process.env.LC_ALL}));} await turn();setInterval(()=>turn().catch(()=>{}),300);`;
    const invocation = await prepareClaudeNativeRoute({ profile: { ...routes[name], profileRef: `mac_${name}`, label: name }, command: process.execPath, args: ["--input-type=module", "-e", code] });
    const child = spawn(invocation.command, invocation.args, { cwd: root, env: { ...process.env, AIMGR_ENV_CANARY: "preserved", TZ: "America/Chicago", LC_ALL: "en_US.UTF-8", NO_PROXY: "*", HTTPS_PROXY: "http://127.0.0.1:1" }, stdio: ["ignore", "pipe", "pipe"] });
    children.push(child);
    const done = once(child, "exit");
    let output = "", error = "";
    child.stdout.on("data", b => { output += b; });
    child.stderr.on("data", b => { error += b; });
    for (let n = 0; n < 100 && !output.includes("\n") && child.exitCode === null; n++) await delay(50);
    assert.ok(output.includes("\n"), JSON.stringify({ id, output, error, status: child.exitCode }));
    const receipt = JSON.parse(output.split("\n")[0]);
    assert.equal(receipt.exit, routes[name].expectedExits[0]);
    assert.equal(receipt.uid, process.getuid());
    assert.equal(receipt.gid, routes[name].gid);
    assert.equal(receipt.cwd, root);
    assert.equal(receipt.custom, "preserved");
    assert.equal(receipt.timezone, "America/Chicago");
    assert.equal(receipt.locale, "en_US.UTF-8");
    started.push(receipt);
    return { child, done, error: () => error };
  };
  const [a1, a2, b] = await Promise.all([launch("a", "A1"), launch("a", "A2"), launch("b", "B1")]);
  await assert.rejects(install(manifest), error => error.code === 125);
  assert.equal(a1.child.exitCode, null);
  assert.equal(a2.child.exitCode, null);
  assert.equal(b.child.exitCode, null);
  const nestedProfile = { ...routes.b, profileRef: "mac_b", label: "b" };
  const nestedCode = `import {prepareClaudeNativeRoute} from ${JSON.stringify(new URL("../../src/network/claude-native-route.js", import.meta.url).href)}; import {execFile} from 'node:child_process'; import {promisify} from 'node:util'; const next=await prepareClaudeNativeRoute({profile:${JSON.stringify(nestedProfile)},command:process.execPath,args:['--input-type=module','-e',${JSON.stringify(`console.log(await (await fetch(${JSON.stringify(destination + "/nested-B")})).text())`)}]}); const result=await promisify(execFile)(next.command,next.args); process.stdout.write(result.stdout);`;
  const nestedBaseline = await exec(process.execPath, ["--input-type=module", "-e", nestedCode]);
  assert.equal(JSON.parse(nestedBaseline.stdout).ip, "127.0.0.3");
  const nested = await prepareClaudeNativeRoute({ profile: { ...routes.a, profileRef: "mac_a", label: "a" }, command: process.execPath,
    args: ["--input-type=module", "-e", nestedCode] });
  const nestedProtected = await exec(nested.command, nested.args);
  assert.equal(JSON.parse(nestedProtected.stdout).ip, "127.0.0.3", "trusted account B launch from A must retain the baseline handoff");
  const groupBinary = path.join(root, "check-groups");
  await exec("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", path.join(repo, "test/network/native-macos-groups-fixture.c"), "-o", groupBinary]);
  const originalGroups = (await exec("/usr/bin/id", ["-G"])).stdout.trim().split(/\s+/);
  const groupProof = await exec("sudo", [groupBinary, `/tmp/aimgr-groups-${process.pid}`,
    JSON.stringify({ socksHost: "127.0.0.1", socksPort: routes.a.socksPort, expectedExits: routes.a.expectedExits }), ...originalGroups]);
  const groupReceipt = JSON.parse(groupProof.stdout.trim().split("\n").at(-1));
  assert.equal(groupReceipt.inheritedGroupCount, 16);
  const guiBinary = path.join(root, "check-gui");
  await exec("/usr/bin/clang", ["-O2", "-Wall", "-Wextra", "-Werror", "-framework", "Cocoa", path.join(repo, "test/network/native-macos-gui-fixture.m"), "-o", guiBinary]);
  const guiInvocation = await prepareClaudeNativeRoute({ profile: { ...routes.a, profileRef: "mac_a", label: "a" }, command: guiBinary, args: [] });
  const desktop = args => exec("sudo", ["launchctl", "asuser", String(process.getuid()), "sudo", "-u", os.userInfo().username, ...args]);
  assert.equal(JSON.parse((await desktop([guiBinary])).stdout).windowVisible, true);
  const guiReceipt = JSON.parse((await desktop([guiInvocation.command, ...guiInvocation.args])).stdout);
  assert.equal(guiReceipt.windowVisible, true);
  assert.equal((await desktop(["/usr/bin/pbpaste"])).stdout, "AIM_CLIPBOARD_SYNTHETIC");
  console.log(JSON.stringify({ nativeGui: { ...guiReceipt, ordinaryUserReadClipboard: true } }));
  const environmentCanary = await prepareClaudeNativeRoute({ profile: { ...routes.a, profileRef: "mac_a", label: "a" }, command: process.execPath,
    args: ["-e", "const fs=require('fs');fs.writeSync(3,'inherited-fd-ok');console.log(JSON.stringify({dyld:process.env.DYLD_LIBRARY_PATH,uid:process.getuid(),gid:process.getgid()}))"] });
  const descriptorProof = await fs.open(path.join(root, "fd-proof"), "w+");
  const environmentChild = spawn(environmentCanary.command, environmentCanary.args, { env: { ...process.env, DYLD_LIBRARY_PATH: "/tmp/aimgr-synthetic-library-path" }, stdio: ["ignore", "pipe", "inherit", descriptorProof.fd] });
  let environmentOutput = "";
  environmentChild.stdout.on("data", chunk => { environmentOutput += chunk; });
  assert.equal((await once(environmentChild, "exit"))[0], 0);
  await descriptorProof.close();
  assert.equal(JSON.parse(environmentOutput).dyld, "/tmp/aimgr-synthetic-library-path");
  assert.equal(await fs.readFile(path.join(root, "fd-proof"), "utf8"), "inherited-fd-ok");
  let routines, features, failedOccurrence;
  let scheduled;
  let interactive;
  const profile = { ...routes.a, profileRef: "mac_a", label: "a" };
  await verifyNativeTerminalCleanup(profile);
  const processControl = await verifyNativeProcessControl({ root, profile });
  if (process.env.AIMGR_TEST_CLAUDE_BIN) {
    features = await verifyNativeClaudeFeatures({ root, profile, destination, modelRequests });
    routines = await createNativeRoutineFixture({ root, profile: { ...routes.a, profileRef: "mac_a", label: "a" }, destination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN });
    const success = await routines.start(0, "Run the synthetic Bash task. ROUTINE_SUCCESS_CANARY.");
    assert.equal((await success.finished).outcome, "completed");
    assert.equal(await fs.readFile(path.join(routines.cwd, "tool-proof.txt"), "utf8"), "native-tool-ok");
    assert.ok(modelRequests.length >= 2);
    assert.ok(modelRoutes.every(route => route === "127.0.0.2"));
    scheduled = await verifyOsScheduledRoutine({ root, profile, destination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN });
    interactive = await verifyInteractiveRoutine({ root, profile, destination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN });
    assert.ok(modelRequests.some(body => JSON.stringify(body.messages).includes("NATIVE_FOLLOWUP_CANARY")));
  }
  await assert.rejects(assertLocalClaudeProfileStopped("mac_a"), /still has local native work/);
  const ordinary = await exec(process.execPath, ["--input-type=module", "-e", `console.log(await (await fetch(${JSON.stringify(destination + "/ordinary")})).text())`]);
  assert.equal(JSON.parse(ordinary.stdout).ip, "198.18.0.11");
  const shared1 = await acquireClaudeAssignmentLock(root, "a"), shared2 = await acquireClaudeAssignmentLock(root, "a");
  await assert.rejects(acquireClaudeAssignmentLock(root, "a", { exclusive: true }));
  await shared1.release(); await shared2.release();
  const exclusive = await acquireClaudeAssignmentLock(root, "a", { exclusive: true }); await exclusive.release();
  if (routines) {
    failedOccurrence = await routines.start(1, "Hold the interrupted synthetic task. ROUTINE_FAIL_CANARY.");
    for (let n = 0; n < 200 && !modelRequests.some(body => JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")); n++) await delay(50);
    assert.ok(modelRequests.some(body => JSON.stringify(body.messages).includes("ROUTINE_FAIL_CANARY")));
    await verifyRoutineConcurrency({ root, profileB: nestedProfile, destination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN, runningA: failedOccurrence, routineA: routines, modelRequests });
  }
  const ready = JSON.parse(await fs.readFile("/opt/aimgr-claude-proxy/mac_a-state/ready.json", "utf8"));
  const monitor = ready.owners.find(owner => owner.role === "monitor").pid;
  const beforeB = receipts.filter(row => row.path === "/B1").length;
  await exec("sudo", ["kill", "-KILL", String(monitor)]);
  assert.equal((await a1.done)[0], 125, a1.error());
  assert.equal((await a2.done)[0], 125, a2.error());
  assert.match(a1.error(), /proxy mac_a unavailable/);
  await delay(500);
  assert.ok(receipts.filter(row => row.path === "/B1").length > beforeB);
  assert.equal(b.child.exitCode, null);
  const beforeA = receipts.filter(row => /^\/A/.test(row.path)).length;
  await delay(300);
  assert.equal(receipts.filter(row => /^\/A/.test(row.path)).length, beforeA);
  await assertLocalClaudeProfileStopped("mac_a");
  assert.ok(receipts.filter(row => /^\/A/.test(row.path)).every(row => row.route === "127.0.0.2"));
  assert.ok(receipts.filter(row => row.path === "/B1").every(row => row.route === "127.0.0.3"));
  if (failedOccurrence) {
    const failedReceipt = await failedOccurrence.finished;
    assert.equal(failedReceipt.needsAttention, true);
    assert.match(failedReceipt.error, /Claude a.*mac_a.*repair.*retry or resume/);
    assert.match(failedReceipt.interactiveTui.error, /Claude a.*mac_a.*repair.*retry or resume/);
    assert.equal((await failedOccurrence.duplicate()).outcome, "duplicate");
  }
  await verifyStartupDenied({ root, profile, destination, phase: "monitor-down", received: receipts });
  const failedStartup = routines ? await verifyScheduledStartupFailure({ root, profile, profileB: nestedProfile, destination,
    ordinaryDestination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN, modelRequests }) : null;
  const repair = async () => {
    const owners = JSON.parse(await fs.readFile("/opt/aimgr-claude-proxy/mac_a-state/ready.json", "utf8")).owners;
    for (let n = 0; n < 200; n++) {
      const live = JSON.parse((await exec("/usr/bin/python3", ["-I", "-c", "import sys,json; sys.path.insert(0,'/opt/aimgr-claude-proxy'); import darwin_proxy as p; print(json.dumps(p.processes()))"])).stdout);
      if (!owners.some(owner => owner.role !== "tunnel" && live[owner.pid]?.started === owner.started)) break;
      if (n === 199) assert.fail("old profile owners did not finish stopping");
      await delay(50);
    }
    await exec("sudo", ["launchctl", "kickstart", "system/com.aimgr.claude-proxy.mac_a"]);
    for (let n = 0; n < 200; n++) {
      const flags = await fs.readdir("/opt/aimgr-claude-proxy/mac_a-state");
      if (!flags.includes("failed") && !flags.includes("starting")) return;
      await delay(50);
    }
    assert.fail("explicit profile repair did not become ready");
  };
  await repair();
  if (routines) await routines.maintain();
  if (failedStartup) assert.equal((await failedStartup.duplicate()).outcome, "duplicate");
  const scheduledNoReplay = [];
  if (routines) for (const phase of ["before", "during"]) scheduledNoReplay.push(await verifyScheduledInterruption({ root, profile, destination,
    claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN, modelRequests, phase,
    stopRoute: async () => {
      const current = JSON.parse(await fs.readFile("/opt/aimgr-claude-proxy/mac_a-state/ready.json", "utf8"));
      await exec("sudo", ["kill", "-KILL", String(current.owners.find(owner => owner.role === "adapter").pid)]);
    },
    repairRoute: repair }));
  if (routines) {
    const resumed = await features.nativeTurn("Explicitly resume saved conversation after proxy repair.", ["--resume", features.savedNativeSessionId]);
    assert.equal(resumed.status, 0, JSON.stringify(resumed));
    assert.equal(JSON.parse(resumed.stdout).session_id, features.savedNativeSessionId);
    assert.equal((await (await routines.start(2, "Run the next independent task. ROUTINE_SUCCESS_CANARY.")).finished).needsAttention, false);
    assert.equal((await failedOccurrence.duplicate()).outcome, "duplicate");
  }
  const suspended = await launch("a", "A3");
  const current = JSON.parse(await fs.readFile("/opt/aimgr-claude-proxy/mac_a-state/ready.json", "utf8"));
  const adapter = current.owners.find(owner => owner.role === "adapter").pid;
  await exec("sudo", ["kill", "-STOP", String(adapter)]);
  await verifyStartupDenied({ root, profile, destination, phase: "adapter-hung", received: receipts });
  assert.equal((await suspended.done)[0], 125, suspended.error());
  assert.equal(b.child.exitCode, null);
  await repair();
  const repaired = await launch("a", "A4");
  assert.equal(repaired.child.exitCode, null);
  // Hold a second launch in native admission while existing A is active.
  // Tunnel restart must not reopen the old sessions during that pending probe.
  const admittedProof = path.join(root, "cancelled-admission.txt");
  const pending = await prepareClaudeNativeRoute({ profile, command: process.execPath,
    args: ["-e", `require('fs').writeFileSync(${JSON.stringify(admittedProof)},'started')`] });
  holdExit = true;
  const waiting = spawn(pending.command, pending.args, { stdio: ["ignore", "ignore", "pipe"] });
  children.push(waiting);
  const waitingExit = once(waiting, "exit");
  waiting.stderr.resume();
  for (let n = 0; n < 100 && !heldExitSeen; n++) await delay(20);
  assert.ok(heldExitSeen);
  const tunnelExit = once(tunnels.a, "exit"), lossAt = Date.now();
  tunnels.a.kill("SIGTERM");
  await tunnelExit;
  const replacementCode = `import {startSocks} from ${JSON.stringify(new URL("./socks-fixture.js", import.meta.url).href)}; const s=await startSocks({port:${routes.a.socksPort},sourceAddress:'127.0.0.2',destinations:{'198.18.0.11':${port}}}); console.log(s.port);`;
  const replacement = spawn(process.execPath, ["--input-type=module", "-e", replacementCode], { stdio: ["ignore", "pipe", "inherit"] });
  children.push(replacement);
  await once(replacement.stdout, "data");
  assert.equal((await repaired.done)[0], 125, repaired.error());
  assert.ok(Date.now() - lossAt < 3000, "pending admission cannot delay outage shutdown until its probe times out");
  assert.equal((await waitingExit)[0], 125);
  await assert.rejects(fs.access(admittedProof), { code: "ENOENT" });
  holdExit = false;
  const oldCount = receipts.filter(row => row.path === "/A4").length;
  await delay(300);
  assert.equal(receipts.filter(row => row.path === "/A4").length, oldCount);
  assert.equal(b.child.exitCode, null);
  const replacementExit = once(replacement, "exit"); replacement.kill(); await replacementExit;
  if (routines) await verifyScheduledStartupFailure({ root, profile, profileB: nestedProfile, destination,
    ordinaryDestination, claudeBin: process.env.AIMGR_TEST_CLAUDE_BIN, modelRequests, phase: "tunnel-down" });
  for (const assertNoReplay of scheduledNoReplay) assertNoReplay();
  assertScheduledModelRoutes(modelRequests, modelRoutes, "198.18.0.11");
  const protectedReceipts = receipts.filter(row => !row.ordinaryLane && !["/ordinary", "/loopback", "/startup-ordinary"].includes(row.path));
  const wrongRouteRequests = protectedReceipts.filter(row => !["127.0.0.2", "127.0.0.3"].includes(row.route));
  assert.deepEqual(wrongRouteRequests, [], "all protected native requests, including non-model endpoints, use a protected route");
  console.log(JSON.stringify({ nativeMac: { concurrentRoutes: started, ordinaryPreserved: true, assignmentLocksPassed: true,
    monitorLossStoppedAOnly: true, directOrWrongRouteRequests: wrongRouteRequests.length, actualNativeRoutine: routines?.receipts ?? null, nativeFeatures: features?.receipt ?? null, immediateAdapterHangDenied: true, tunnelLossDuringAdmissionStoppedImmediately: true,
    inheritedGroups: groupReceipt, environmentAndDescriptorsPreserved: true, osScheduled: scheduled ?? null, nestedAccountHandoff: true,
    interactiveRoutine: interactive ?? null, processControl } }));
});
