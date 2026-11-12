import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { prepareCodexNativeInvocation as prepareInvocation } from "../../src/privacy/codex-native-invocation.js";
import { resolveCodexLaunchInputs } from "../../src/privacy/codex-launch-inputs.js";
import { prepareCodexAccountState } from "../../src/privacy/codex-account-state.js";

const prepareCodexNativeInvocation = options => prepareInvocation({
  resolveInputs: inputs => resolveCodexLaunchInputs({ ...inputs, workingDirectories: [] }), ...options,
});

test("relative --cd is projected once while native retains its original process cwd and arguments", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-invocation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"), cwd = path.join(root, "project"), selected = path.join(cwd, "child");
  fs.mkdirSync(homeDir); fs.mkdirSync(selected, { recursive: true });
  const defaultTarget = path.join(homeDir, "shared default");
  fs.mkdirSync(defaultTarget); fs.symlinkSync(defaultTarget, path.join(homeDir, ".codex"));
  const environment = { binding: "a".repeat(64) };
  const prepared = { ...prepareCodexAccountState({ homeDir, accountId: "api-provider:deepseek", label: "fixture", environment }), keyBacked: true };
  const policy = path.join(root, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ schema: 1, version: "test", platform: process.platform, arch: process.arch,
    settingsManifest: 1, sourceCommit: "b".repeat(40) }));
  const artifact = { command: "/synthetic/codex", launcher: "/synthetic/launcher", artifactSet: "c".repeat(64),
    version: "test", policy, readPaths: [], stateIO: fileURLToPath(new URL("../../native/codex/state_io.py", import.meta.url)) };
  const callerTemp = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "codex-caller-"));
  t.after(() => fs.rmSync(callerTemp, { recursive: true, force: true }));
  for (const args of [["-C", "child"], ["-C", "child", "--add-dir", "extra"]]) {
    const invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, args, environment,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin", TMPDIR: callerTemp }, admitArtifact: () => artifact,
      inspectManagedPolicy: () => ({ files: [] }),
      nativeInputs: async ({ parsedArgs }) => {
        assert.equal(parsedArgs.config[0], 'mcp_oauth_credentials_store="file"');
        assert.equal(parsedArgs.cwd, selected);
        assert.equal(parsedArgs.processCwd, cwd);
        if (parsedArgs.worktree) assert.deepEqual(parsedArgs.directories, [path.join(cwd, "extra")]);
        return { cwd: selected, reads: [], writes: [], database_roots: [prepared.sharedHome], mcp_store: "file" };
      },
    });
    const scratch = invocation.args[3];
    try {
      assert.equal(invocation.environment.TMPDIR, callerTemp);
      assert.notEqual(scratch, callerTemp);
      const socketDirectory = fs.mkdtempSync(path.join(callerTemp, "com.google.Chrome."));
      const socket = net.createServer();
      try {
        await new Promise((resolve, reject) => socket.once("error", reject).listen(path.join(socketDirectory, "SingletonSocket"), resolve));
      } finally {
        if (socket.listening) await new Promise(resolve => socket.close(resolve));
        fs.rmdirSync(socketDirectory);
      }
      assert.equal(fs.statSync(scratch).mode & 0o777, 0o700);
      assert.deepEqual(fs.readdirSync(scratch), [], "environment transfer is unlinked inside private staging");
      assert.equal(invocation.prepared.sharedHome, path.join(homeDir, ".codex"), "unset CODEX_HOME retains native lexical default origin");
      assert.equal(invocation.cwd, cwd);
      assert.equal(invocation.inputs.cwd, selected);
      assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--") + 1), ["--no-daemon", "-c", 'mcp_oauth_credentials_store="file"', ...args]);
      assert.equal(fs.existsSync(path.join(prepared.sharedHome, "config.toml")), false, "default file mode does not author shared settings");
      if (process.platform === "darwin") assert.ok(invocation.args.includes(path.join(homeDir,
        "Library/Application Support/com.openai.codex/production-appcast-bootstrap.json")));
    } finally { await invocation.close(); }
    assert.equal(fs.existsSync(scratch), false, "private environment staging is removed on close");
    const later = fs.mkdtempSync(path.join(callerTemp, "after-parent-"));
    fs.rmdirSync(later);
  }
  const config = path.join(prepared.sharedHome, "config.toml");
  fs.writeFileSync(config, 'mcp_oauth_credentials_store="auto"\n');
  for (const command of [[], ["exec"], ["app-server"]]) {
    for (const mode of ["keyring", "auto"]) {
      await assert.rejects(prepareCodexNativeInvocation({ prepared, homeDir, cwd, environment,
        args: [...command, "-c", `mcp_oauth_credentials_store="${mode}"`], ownedAppServer: command[0] === "app-server",
        env: { HOME: homeDir, PATH: "/usr/bin:/bin" }, admitArtifact: () => artifact,
        inspectManagedPolicy: () => ({ files: [] }), nativeInputs: async ({ parsedArgs }) => {
          assert.deepEqual(parsedArgs.config, ['mcp_oauth_credentials_store="file"', `mcp_oauth_credentials_store="${mode}"`]);
          return { cwd, reads: [], writes: [], database_roots: [], mcp_store: mode };
        },
      }), /conflicting command-line or administrator setting/);
    }
  }
  // Existing MCP sign-ins never block a launch or get converted: the shared
  // File store stays byte-identical and the account home shares its inode.
  const file = path.join(prepared.sharedHome, ".credentials.json");
  for (const bytes of ['{}', '{"figma|0123456789abcdef":{"server_name":"figma"}}']) {
    fs.writeFileSync(file, bytes, { mode: 0o600 });
    const invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, environment,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin" }, admitArtifact: () => artifact,
      inspectManagedPolicy: () => ({ files: [] }),
      nativeInputs: async () => ({ cwd, reads: [], writes: [], database_roots: [], mcp_store: "file" }),
    });
    try {
      assert.equal(Object.hasOwn(invocation.environment, "TMPDIR"), false, "unset caller TMPDIR keeps the native OS fallback");
      assert.equal(fs.statSync(path.join(invocation.prepared.codexHome, ".credentials.json")).ino, fs.statSync(file).ino,
        "the account home hard-links the shared MCP File store");
    } finally { await invocation.close(); }
    assert.equal(fs.readFileSync(file, "utf8"), bytes);
  }
  assert.equal(fs.readFileSync(config, "utf8"), 'mcp_oauth_credentials_store="auto"\n');
  fs.writeFileSync(config, 'model = [\n');
  for (const args of [["--version"], ["-V"], ["--help"], ["-h"], ["exec", "--help"], ["sandbox", "-h"]]) {
    let admitted = false;
    const invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, environment, args,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin" },
      admitArtifact: () => { admitted = true; return artifact; }, inspectManagedPolicy: () => ({ files: [] }),
      nativeInputs: () => assert.fail("Native help/version must not initialize databases"),
      resolveInputs: () => assert.fail("Native help/version must not inventory project/config inputs"),
    });
    try {
      assert.ok(admitted);
      assert.equal(invocation.command, artifact.launcher, "Inspection still enters the approved privacy boundary");
      assert.deepEqual(invocation.entries, []);
      assert.deepEqual(invocation.inputs, { cwd, writes: [], reads: [], databases: [] });
      await invocation.flushSettings();
    } finally { await invocation.close(); }
  }
  fs.unlinkSync(file); fs.writeFileSync(config, '');
  for (const args of [["sandbox", "linux", "echo", "--help"], ["mcp", "add", "fixture", "echo", "--help"],
    ["execpolicy", "check", "echo", "--help"], ["exec", "--", "--help"], ["Please explain --help"]]) {
    await assert.rejects(prepareCodexNativeInvocation({ prepared, homeDir, cwd, environment, args,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin" }, admitArtifact: () => artifact,
      inspectManagedPolicy: () => ({ files: [] }),
      nativeInputs: () => { throw new Error("ordinary preparation retained"); },
    }), /ordinary preparation retained/);
  }
});
