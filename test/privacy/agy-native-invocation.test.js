import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter, once } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { supportsAgyPlatform } from "../../src/privacy/agy-artifacts.js";
import { runAgyNative } from "../../src/privacy/agy-native-invocation.js";

function fixture(t, { exitCode = 0 } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "agy-test-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const accountHome = fs.realpathSync(fs.mkdirSync(path.join(root, "account"), { recursive: true }));
  const cwd = fs.realpathSync(fs.mkdirSync(path.join(root, "project"), { recursive: true }));
  const calls = [];
  const deps = {
    platform: "linux",
    arch: "x64",
    isInteractive: true,
    resolveWorkingDirectories: () => [cwd],
    admitArtifact: () => ({ launcher: "/approved/launcher" }),
    spawnImpl(command, args, options) {
      const environment = Buffer.alloc(fs.fstatSync(options.stdio[3]).size);
      fs.readSync(options.stdio[3], environment, 0, environment.length, 0);
      calls.push({ command, args, options, environment: environment.toString("utf8").split("\0") });
      const child = new EventEmitter();
      setImmediate(() => child.emit("close", exitCode));
      return child;
    },
  };
  const request = {
    operation: "run", label: "test-account", accountHome, cwd, args: ["--print", "fixture"],
    stderr: { write() {} },
    env: {
      TERM: "xterm", HOME: "/outside-home", HTTPS_PROXY: "http://ambient-proxy.invalid",
      GOOGLE_APPLICATION_CREDENTIALS: "/ambient-credentials", GEMINI_API_KEY: "fixture-secret",
      DBUS_SESSION_BUS_ADDRESS: "ambient-keyring", AGY_ADC_AUTH: "true",
      PATH: "/untrusted-path", SSH_CONNECTION: "192.0.2.1 12345 192.0.2.2 22",
    },
  };
  return { calls, deps, request };
}

test("runs only through the admitted launcher with the selected private home", async t => {
  const { calls, deps, request } = fixture(t);
  request.args = ["--model", "gemini-3.8-flash", "--print=--conversation looks like a flag", "--output-format", "json"];
  assert.deepEqual(await runAgyNative(request, deps), { exitCode: 0 });
  const [call] = calls;
  const scratch = call.args[4];
  assert.equal(fs.existsSync(scratch), false);
  assert.equal(call.command, "/approved/launcher");
  assert.equal(call.options.cwd, request.cwd);
  assert.deepEqual(call.options.env, { PATH: "/usr/bin:/bin" });
  assert.equal(call.options.detached, false);
  assert.deepEqual(call.options.stdio.slice(0, 3), ["inherit", "inherit", "inherit"]);
  assert.deepEqual(call.args, [
    "v1", "run", request.accountHome, request.cwd, scratch, "3", "1", request.cwd, "--", "--model=gemini-3.8-flash",
    "--print=--conversation looks like a flag", "--output-format=json",
  ]);
  assert.deepEqual(call.environment.filter(Boolean).sort(), [
    "AGY_CLI_DISABLE_AUTO_UPDATE=true", "BROWSER=/usr/bin/true", `HOME=${request.accountHome}`,
    "PATH=/usr/bin:/bin", "SSH_CONNECTION=127.0.0.1 49152 127.0.0.1 22", "TERM=xterm",
  ]);
});

test("refuses native conversation and remote flags before launching", async t => {
  const { calls, deps, request } = fixture(t);
  for (const args of [["--conversation", "existing"], ["--continue"], ["--remote-agent"], ["acp"],
    ["--model", "--conversation=existing"], ["--print=first", "--print=second"]]) {
    await assert.rejects(runAgyNative({ ...request, args }, deps), /Antigravity/);
  }
  assert.equal(calls.length, 0);
});

test("runs bare commands through the approved ACP entry with a separate terminal client", async t => {
  const { calls, deps, request } = fixture(t);
  const chat = { ...request, args: [] };
  await assert.rejects(runAgyNative(chat, { ...deps, isInteractive: false }), /chat requires an interactive terminal/);
  assert.equal(calls.length, 0);
  for (const [platform, arch] of [["linux", "x64"], ["darwin", "arm64"]]) {
    const runAcp = async (_child, options) => {
      assert.equal(options.operation, "interactive");
      assert.equal(options.label, chat.label);
      assert.equal(options.cwd, chat.cwd);
      assert.deepEqual(options.args, []);
      return { exitCode: 0 };
    };
    assert.deepEqual(await runAgyNative(chat, { ...deps, platform, arch, runAcp }), { exitCode: 0 });
    const call = calls.at(-1);
    assert.equal(call.command, "/approved/launcher");
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.args, ["v1", "resume", chat.accountHome, chat.cwd, call.args[4], "3", "1", request.cwd, "--"]);
    assert.deepEqual(call.options.stdio.slice(0, 3), ["pipe", "pipe", "pipe"]);
  }
});

test("reuses a durable private workspace for bare runs and exact resume launched from home", async t => {
  const { calls, deps, request } = fixture(t);
  const homeDir = path.dirname(request.cwd);
  const expected = path.join(homeDir, "workspace", "antigravity", request.label);
  const resumeId = "af42bcee-b692-49ea-923e-3b8c864fc044";
  let run = 0;
  deps.runAcp = async (_child, options) => {
    assert.equal(options.cwd, expected);
    assert.equal(fs.statSync(expected).mode & 0o777, 0o700);
    if (run++) {
      assert.equal(options.sessionId, resumeId);
      assert.equal(fs.readFileSync(path.join(expected, "work"), "utf8"), "keep this");
    } else {
      fs.writeFileSync(path.join(expected, "work"), "keep this");
    }
    return { exitCode: 0 };
  };
  const atHome = { ...request, homeDir, cwd: homeDir };
  await runAgyNative({ ...atHome, args: [] }, deps);
  await runAgyNative({ ...atHome, operation: "resume", sessionId: resumeId }, deps);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].options.cwd, expected);
  assert.equal(calls[1].options.cwd, expected);
  const other = path.join(path.dirname(expected), "another");
  fs.symlinkSync(expected, other);
  await assert.rejects(runAgyNative({ ...atHome, label: "another", args: [] }, deps), /private workspace/);
  assert.equal(calls.length, 2);
});

test("status collection uses an empty workspace and captures only bounded native stdout", async t => {
  const { calls, deps, request } = fixture(t);
  const spawn = deps.spawnImpl;
  deps.spawnImpl = (command, args, options) => {
    const child = spawn(command, args, options);
    child.stdout = new PassThrough();
    child.stdout.end("native-report");
    return child;
  };
  for (const operation of ["usage", "credits"]) {
    const status = { ...request, operation, cwd: "/not-a-working-directory" };
    await assert.rejects(runAgyNative(status, deps), /take no native launch arguments/);
    assert.deepEqual(await runAgyNative({ ...status, args: [] }, deps), { exitCode: 0, statusReport: "native-report" });
    const call = calls.at(-1);
    const scratch = call.args[4];
    assert.equal(call.options.cwd, scratch);
    assert.equal(call.options.detached, true);
    assert.deepEqual(call.options.stdio.slice(0, 3), ["ignore", "pipe", "ignore"]);
    assert.deepEqual(call.args, ["v1", operation, request.accountHome, scratch, scratch, "3", "0", "--"]);
    assert.equal(fs.existsSync(scratch), false);
  }
  deps.spawnImpl = (command, args, options) => {
    const child = spawn(command, args, options);
    child.stdout = new PassThrough();
    child.stdout.end(Buffer.alloc(65 * 1024));
    child.kill = (signal) => assert.equal(signal, "SIGKILL");
    return child;
  };
  assert.deepEqual(await runAgyNative({ ...request, operation: "usage", args: [] }, deps), { exitCode: 1 });
});

test("forced shutdown ends the managed group when the wrapper exits and a child still owns its pipes", async t => {
  const { deps, request } = fixture(t);
  const worker = `
    require("node:fs").writeSync(4, "ready");
    if (process.argv[1] === "usage") process.stdout.write("x".repeat(70 * 1024));
    setTimeout(() => process.exit(), 4000);
  `;
  const wrapper = `
    const { spawn } = require("node:child_process");
    const { createInterface } = require("node:readline");
    const operation = process.argv[1];
    spawn(process.execPath, ["-e", ${JSON.stringify(worker)}, operation],
      { stdio: ["ignore", "inherit", "ignore", "ignore", 4] }).unref();
    if (operation === "usage") process.exit(0);
    createInterface({ input: process.stdin }).on("line", line => {
      const { id, method } = JSON.parse(line);
      const result = method === "initialize" ? { protocolVersion: 1, agentCapabilities: { auth: { logout: {} } } } : {};
      process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
    });
  `;
  for (const operation of ["usage", "logout"]) {
    let workerClosed;
    const result = await runAgyNative({ ...request, operation, args: [] }, {
      ...deps,
      spawnImpl(_command, _args, options) {
        const child = spawn(process.execPath, ["-e", wrapper, operation], { ...options, stdio: [...options.stdio, "pipe"] });
        const receipt = child.stdio[4];
        let text = "";
        receipt.setEncoding("utf8");
        receipt.on("data", chunk => { text += chunk; });
        workerClosed = once(receipt, "end", { signal: AbortSignal.timeout(2500) }).then(() => text, () => undefined);
        return child;
      },
    });
    assert.equal(result.exitCode, operation === "usage" ? 1 : 0);
    assert.equal(await workerClosed, "ready");
  }
});

test("launches resume and logout through the native ACP operation without provider arguments", async t => {
  const { calls, deps, request } = fixture(t);
  const sessionId = "af42bcee-b692-49ea-923e-3b8c864fc044";
  for (const operation of ["resume", "logout"]) {
    const args = operation === "resume" ? ["--print", "hello"] : [];
    const suppliedSession = operation === "resume" ? sessionId : undefined;
    const runAcp = async (_child, options) => {
      assert.equal(options.operation, operation);
      assert.equal(options.sessionId, suppliedSession);
      assert.equal(options.cwd, operation === "resume" ? request.cwd : calls.at(-1).args[4]);
      assert.deepEqual(options.args, operation === "resume" ? ["--print=hello"] : []);
      return { exitCode: 0 };
    };
    assert.deepEqual(await runAgyNative({ ...request, operation, args, sessionId: suppliedSession }, { ...deps, runAcp }), { exitCode: 0 });
    const call = calls.at(-1);
    assert.equal(call.args[1], operation);
    assert.equal(call.args.at(-1), "--");
    assert.deepEqual(call.options.stdio.slice(0, 3), ["pipe", "pipe", "pipe"]);
    if (operation === "logout") {
      assert.equal(call.args[3], call.args[4]);
      assert.equal(call.args[6], "0");
    }
  }
});

test("hands only the assigned native proxy to a routed launch", async t => {
  const { calls, deps, request } = fixture(t);
  const proxyUrl = "socks5h://127.0.0.1:37781";
  const routeRequest = { ...request, profileRef: "test-route" };
  const prepareRoute = ({ profileRef, args }) => {
    assert.equal(profileRef, "test-route");
    return { command: "/approved/route", args, proxyUrl };
  };
  await runAgyNative(routeRequest, { ...deps, prepareRoute });
  const [call] = calls;
  assert.equal(call.command, "/approved/route");
  assert.deepEqual(call.environment.filter(entry => /PROXY=/.test(entry)).sort(), [
    `ALL_PROXY=${proxyUrl}`, `HTTPS_PROXY=${proxyUrl}`, `HTTP_PROXY=${proxyUrl}`, "NO_PROXY=",
  ]);
  await assert.rejects(runAgyNative(routeRequest, { ...deps, prepareRoute: () => { throw new Error("route failed"); } }), /route failed/);
  assert.equal(calls.length, 1);
});

test("requires terminal confirmation of the same Google address after native login", async t => {
  const { calls, deps, request } = fixture(t);
  const homeDir = path.dirname(request.cwd);
  const login = { ...request, operation: "login", homeDir, cwd: homeDir };
  for (const observed of ["other@example.test", "expected@example.test"]) {
    const answers = ["expected@example.test", observed];
    const result = await runAgyNative(login, { ...deps, askAddress: () => answers.shift() });
    assert.deepEqual(result, observed === "expected@example.test" ? { exitCode: 0, account: observed } : { exitCode: 0 });
    assert.equal(answers.length, 0);
  }
  await assert.rejects(runAgyNative(login, { ...deps, isInteractive: false }), /interactive terminal/);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.equal(call.options.cwd, call.args[4]);
    assert.equal(call.options.detached, false);
    assert.equal(call.args[3], call.args[4]);
    assert.equal(call.args[6], "0");
    assert.equal(fs.existsSync(call.args[4]), false);
  }
});

test("keeps a provider failure exit status and never launches on an unsupported platform", async t => {
  const { calls, deps, request } = fixture(t, { exitCode: 41 });
  assert.deepEqual(await runAgyNative(request, deps), { exitCode: 41 });
  for (const [platform, arch] of [["darwin", "x64"], ["linux", "arm64"], ["win32", "x64"]]) {
    assert.equal(supportsAgyPlatform(platform, arch), false);
    await assert.rejects(runAgyNative(request, { ...deps, platform, arch, admitArtifact: undefined }), /requires Linux x64 or macOS arm64/);
  }
  assert.equal(calls.length, 1);
});

test("uses the same native launch ABI on macOS arm64 and removes its temporary files", async t => {
  const { calls, deps, request } = fixture(t);
  assert.equal(supportsAgyPlatform("linux", "x64"), true);
  assert.equal(supportsAgyPlatform("darwin", "arm64"), true);
  assert.deepEqual(await runAgyNative(request, {
    ...deps, platform: "darwin", arch: "arm64",
    admitArtifact(target) {
      assert.deepEqual(target, { platform: "darwin", arch: "arm64" });
      return deps.admitArtifact();
    },
    spawnImpl(command, args, options) {
      fs.writeFileSync(path.join(args[4], "native-temp"), "fixture");
      return deps.spawnImpl(command, args, options);
    },
  }), { exitCode: 0 });
  assert.equal(calls[0].command, "/approved/launcher");
  assert.equal(calls[0].args[0], "v1");
  assert.equal(fs.existsSync(calls[0].args[4]), false);
});

test("passes the launch environment on descriptor three to a real child process", async t => {
  const { request } = fixture(t);
  const launcher = path.join(request.cwd, "launcher-fixture.cjs");
  fs.writeFileSync(launcher, `#!${process.execPath}
const fs = require("node:fs");
const bytes = Buffer.alloc(fs.fstatSync(3).size);
fs.readSync(3, bytes, 0, bytes.length, 0);
const variables = Object.fromEntries(bytes.toString("utf8").split("\\0").filter(Boolean).map(entry => {
  const equals = entry.indexOf("=");
  return [entry.slice(0, equals), entry.slice(equals + 1)];
}));
fs.writeFileSync("received.json", JSON.stringify({
  cwd: process.cwd(), home: variables.HOME, outside: variables.GEMINI_API_KEY,
  helperHome: process.env.HOME, args: process.argv.slice(8),
}));
process.exitCode = 39;
`, { mode: 0o700 });
  const result = await runAgyNative({ ...request, args: ["--print", "hello"] }, {
    platform: "linux", arch: "x64", admitArtifact: () => ({ launcher }), resolveWorkingDirectories: () => [],
  });
  assert.deepEqual(result, { exitCode: 39 });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(request.cwd, "received.json"), "utf8")), {
    cwd: request.cwd, home: request.accountHome, args: ["0", "--", "--print=hello"],
  });
});
