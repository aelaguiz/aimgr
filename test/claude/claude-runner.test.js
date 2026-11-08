import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
  buildManagedClaudeStatusLine,
  prepareClaudeCliLaunch as realPrepareClaudeCliLaunch,
  resolveInstalledClaudeSecurityAdapter,
  runClaudeCli as realRunClaudeCli,
  runClaudeCliNoninteractive as realRunClaudeCliNoninteractive,
  verifyInstalledClaudeExecutable,
} from "../../src/targets/claude-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";
import { acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";

import { verifySyntheticExecutable, prepareSyntheticNativeInvocation, spawnSyntheticSupervisor, resolveSyntheticSecurityAdapter } from "../helpers/claude-native-invocation.js";
const prepareClaudeCliLaunch = options => realPrepareClaudeCliLaunch({ verifyInstalledClaudeExecutableImpl: verifySyntheticExecutable,
  resolveInstalledClaudeSecurityAdapterImpl: resolveSyntheticSecurityAdapter, ...options });
const runClaudeCli = options => realRunClaudeCli({ prepareClaudeCliLaunchImpl: prepareClaudeCliLaunch,
  prepareClaudeNativeInvocationImpl: prepareSyntheticNativeInvocation, spawnImpl: spawnSyntheticSupervisor, ...options });
const runClaudeCliNoninteractive = options => realRunClaudeCliNoninteractive({ verifyInstalledClaudeExecutableImpl: verifySyntheticExecutable,
  resolveInstalledClaudeSecurityAdapterImpl: resolveSyntheticSecurityAdapter,
  prepareClaudeNativeInvocationImpl: prepareSyntheticNativeInvocation, spawnImpl: spawnSyntheticSupervisor, ...options });

const RUNNER_SOURCE_PATH = fileURLToPath(new URL(
  "../../src/targets/claude-runner.js",
  import.meta.url,
));
const SUPERVISOR_SOURCE_PATH = fileURLToPath(new URL(
  "../../src/targets/claude-supervisor.js",
  import.meta.url,
));
const STATUSLINE_TAP_PATH = fileURLToPath(new URL(
  "../../src/targets/claude-statusline-tap.sh",
  import.meta.url,
));

function launchPaths(home, label = "alpha") {
  const homeDir = path.join(home, ".aimgr", "claude-homes", label);
  return { homeDir, configDir: path.join(homeDir, ".claude") };
}

function writeExecutable(filePath, contents = "#!/bin/sh\nexit 0\n") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents, { mode: 0o700 });
}

function installSyntheticAdapter(home) {
  const adapterDir = path.join(home, ".aimgr", "runtime", "claude-file-store");
  const shimPath = path.join(adapterDir, "security");
  writeExecutable(shimPath);
  const resolvedShimPath = fs.realpathSync(shimPath);
  return { adapterDir: path.dirname(resolvedShimPath), shimPath: resolvedShimPath };
}

function preparedLaunch(home, options = {}) {
  const paths = launchPaths(home);
  return {
    command: process.execPath,
    userHomeDir: home,
    ...paths,
    aimgrRoot: path.join(home, ".aimgr"),
    claudeHomesRoot: path.join(home, ".aimgr", "claude-homes"),
    selectedLabelHome: paths.homeDir,
    userPluginDirs: [],
    userHooksPath: null,
    userMcpConfigPath: null,
    ...options,
  };
}

test("missing native launcher names the protected account and repair action while ordinary spawn errors stay unchanged", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prepared = preparedLaunch(home);
  const profile = { label: "protected", profileRef: "office" };
  const missing = Object.assign(new Error("spawn fixture ENOENT"), { code: "ENOENT" });
  for (const runner of [runClaudeCli, runClaudeCliNoninteractive]) {
    for (const egressProfile of [undefined, profile]) {
      for (const mode of ["throw", "event"]) {
        await assert.rejects(runner({ ...prepared, preparedLaunch: prepared, cwd: home, egressProfile,
          platform: "linux", prepareClaudeNativeRouteImpl: async () => ({ command: "/missing/native-helper", args: [] }),
          spawnImpl: () => {
            if (mode === "throw") throw missing;
            const child = new EventEmitter();
            process.nextTick(() => child.emit("error", missing));
            return child;
          },
        }), error => {
          if (!egressProfile) assert.equal(error, missing);
          else {
            assert.equal(error.code, "native_proxy_unavailable");
            assert.equal(error.cause, missing);
            assert.match(error.message, /protected.*unavailable.*Repair.*retry.*office/);
          }
          return true;
        });
      }
    }
  }
});

test("protected exit 125 retains job diagnostics without changing other process results", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prepared = preparedLaunch(home);
  for (const runner of [runClaudeCli, runClaudeCliNoninteractive]) {
    for (const egressProfile of [undefined, { label: "protected", profileRef: "office" }]) {
      for (const [status, signal] of [[125, null], [1, null], [0, null], [null, "SIGTERM"]]) {
        for (const mode of ["sync", "async"]) {
          const result = await runner({ ...prepared, preparedLaunch: prepared, cwd: home, egressProfile,
            platform: "linux", prepareClaudeNativeRouteImpl: async () => ({ command: "/fixture/helper", args: [] }),
            spawnImpl: () => {
              if (mode === "sync") return { status, signal };
              const child = new EventEmitter();
              process.nextTick(() => child.emit("close", status, signal));
              return child;
            },
          });
          assert.equal(result.status, status);
          assert.equal(result.signal, signal);
          if (egressProfile && status === 125) assert.match(result.error.message, /protected.*125.*office.*repair.*retry or resume/);
          else assert.equal(result.error, undefined);
        }
      }
    }
  }
});

test("direct and assigned-route runners request identical privacy without changing native permission flags", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prepared = preparedLaunch(home);
  const args = ["-p", "synthetic task", "--permission-mode", "default"];
  for (const runner of [runClaudeCli, runClaudeCliNoninteractive]) {
    for (const egressProfile of [undefined, { label: "assigned", profileRef: "office" }]) {
      const stop = new Error("synthetic preparation reached");
      await assert.rejects(runner({ ...prepared, preparedLaunch: prepared, cwd: home, platform: "linux", egressProfile, args,
        prepareClaudeNativeInvocationImpl(input) {
          assert.equal(input.protectedAccount, true);
          assert.deepEqual(input.args, args);
          assert.equal(input.args.includes("--dangerously-skip-permissions"), false);
          throw stop;
        } }), error => error === stop);
    }
  }
});

test("Mac privacy routing keeps the fixed exec chain below the IPC supervisor", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  installSyntheticAdapter(home);
  const prepared = preparedLaunch(home);
  const launcher = `/opt/aimgr-claude-runtime/artifacts/${"a".repeat(64)}/launcher`;
  const vendor = launcher.replace(/launcher$/, "claude");
  let routeCalled = false;
  await runClaudeCliNoninteractive({ ...prepared, cwd: home, platform: "darwin",
    egressProfile: { label: "protected", profileRef: "office" },
    prepareClaudeNativeInvocationImpl: async options => ({ ...await prepareSyntheticNativeInvocation(options),
      command: launcher, vendorCommand: vendor, args: ["v1", "protected", "fixture"] }),
    prepareClaudeNativeRouteImpl: async options => {
      routeCalled = true;
      assert.equal(options.command, launcher);
      assert.equal(options.nativeCommand, vendor);
      assert.equal(options.approvedPrivacyEntry, true);
      return { command: launcher, args: ["route-v1", "office", "binding", "--", ...options.args] };
    },
    spawnImpl(command, args, options) {
      assert.equal(routeCalled, true);
      assert.equal(command, process.execPath);
      assert.deepEqual(args.slice(1), ["--privacy-entry-v1", launcher, "route-v1", "office", "binding", "--", "v1", "protected", "fixture"]);
      assert.equal(options.stdio[3], "ipc");
      assert.equal(fs.fstatSync(options.stdio[5]).nlink, 0);
      return { status: 0, signal: null };
    },
  });
});

test("executable preflight refuses an unapproved executable without running it", async () => {
  await assert.rejects(verifyInstalledClaudeExecutable({ command: process.execPath }), { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED" });
});

test("adapter resolution uses the admitted executable's exact sibling and never a legacy fallback", () => {
  const home = mkTempHome();
  const expected = installSyntheticAdapter(home);
  const command = path.join(expected.adapterDir, "claude");
  assert.deepEqual(resolveInstalledClaudeSecurityAdapter({ command }), expected);

  fs.unlinkSync(expected.shimPath);
  assert.throws(
    () => resolveInstalledClaudeSecurityAdapter({ command }),
    /approved runtime bundle/,
  );
});

test("preflight shares generic customizations but excludes credentials, trust, cache, and logs", async () => {
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  const claudeDir = path.join(home, ".claude");
  const projectDir = path.join(home, "project");
  const pluginAlpha = path.join(claudeDir, "plugins", "cache", "market", "alpha", "1");
  const pluginZeta = path.join(claudeDir, "plugins", "cache", "market", "zeta", "2");
  const hooks = { SessionStart: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }] };
  const statusLine = { type: "command", command: "/usr/bin/true" };
  const mcpServers = { synthetic: { command: "/usr/bin/true", args: ["--mcp"] } };
  fs.mkdirSync(path.join(claudeDir, "skills", "global-skill"), { recursive: true });
  fs.mkdirSync(path.join(projectDir, ".claude", "skills", "project-skill"), { recursive: true });
  fs.mkdirSync(pluginAlpha, { recursive: true });
  fs.mkdirSync(pluginZeta, { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  writeJson(path.join(claudeDir, "settings.json"), {
    hooks,
    statusLine,
    skipDangerousModePermissionPrompt: true,
    enabledPlugins: { "zeta@market": true, "disabled@market": false, "alpha@market": true },
    theme: "must-not-copy",
  });
  writeJson(path.join(home, ".claude.json"), {
    mcpServers,
    oauthAccount: { accessToken: "SYNTHETIC_MUST_NOT_COPY" },
    projects: { [projectDir]: { hasTrustDialogAccepted: true } },
  });
  writeJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    plugins: {
      "alpha@market": [{ scope: "user", installPath: pluginAlpha }],
      "zeta@market": [{ scope: "user", installPath: pluginZeta }],
    },
  });

  const safeMarkers = [".generic-preference", ".i-have-adhd-always"];
  for (const marker of safeMarkers) fs.writeFileSync(path.join(claudeDir, marker), "");
  for (const forbidden of [
    ".credentials.json",
    ".account-state",
    ".auth-state",
    ".cache-state",
    ".project-trust",
    ".session-state",
    ".token-state",
  ]) fs.writeFileSync(path.join(claudeDir, forbidden), "");
  fs.writeFileSync(path.join(claudeDir, ".nonempty-preference"), "not-a-marker");

  const prepared = await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    platform: "linux",
  });
  assert.equal(fs.readlinkSync(path.join(configDir, "skills")), path.join(claudeDir, "skills"));
  assert.deepEqual(prepared.userPluginDirs, [
    fs.realpathSync(pluginAlpha),
    fs.realpathSync(pluginZeta),
  ]);
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.userHooksPath, "utf8")), {
    hooks,
    statusLine: buildManagedClaudeStatusLine(statusLine),
    skipDangerousModePermissionPrompt: true,
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.userMcpConfigPath, "utf8")), { mcpServers });
  assert.equal(fs.statSync(prepared.userHooksPath).mode & 0o777, 0o600);
  assert.equal(fs.statSync(prepared.userMcpConfigPath).mode & 0o777, 0o600);
  for (const marker of safeMarkers) {
    assert.equal(fs.readlinkSync(path.join(configDir, marker)), path.join(claudeDir, marker));
  }
  for (const excluded of [
    ".credentials.json",
    ".account-state",
    ".auth-state",
    ".cache-state",
    ".project-trust",
    ".session-state",
    ".token-state",
    ".nonempty-preference",
  ]) assert.equal(fs.existsSync(path.join(configDir, excluded)), false, excluded);
  const overlays = `${fs.readFileSync(prepared.userHooksPath)}${fs.readFileSync(prepared.userMcpConfigPath)}`;
  assert.doesNotMatch(overlays, /SYNTHETIC_MUST_NOT_COPY|projects|theme|enabledPlugins/);
  assert.equal(fs.existsSync(path.join(projectDir, ".claude", "skills", "project-skill")), true);
});

test("bypass acknowledgement reaches a managed account even without hooks", async () => {
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  writeJson(path.join(home, ".claude", "settings.json"), {
    skipDangerousModePermissionPrompt: true,
    theme: "must-not-copy",
  });
  const prepared = await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    platform: "linux",
  });
  assert.deepEqual(JSON.parse(fs.readFileSync(prepared.userHooksPath, "utf8")), {
    statusLine: buildManagedClaudeStatusLine(null),
    skipDangerousModePermissionPrompt: true,
  });
});

test("managed status lines run the usage tap and keep the user's command and options", () => {
  const tap = `/bin/sh '${STATUSLINE_TAP_PATH}'`;
  assert.deepEqual(buildManagedClaudeStatusLine(null), { type: "command", command: tap });
  assert.deepEqual(
    buildManagedClaudeStatusLine({ type: "command", command: "bash ~/it's.sh", padding: 1 }),
    { type: "command", command: `${tap} 'bash ~/it'"'"'s.sh'`, padding: 1 },
  );
  const other = { type: "static", text: "left alone" };
  assert.equal(buildManagedClaudeStatusLine(other), other);
});

test("the usage tap saves readings privately and still renders the user's status line", () => {
  const home = mkTempHome();
  const configDir = path.join(home, "config");
  fs.mkdirSync(configDir);
  const usagePath = path.join(configDir, ".aimgr-session-usage.json");
  const run = (input, args = []) => spawnSync("/bin/sh", [STATUSLINE_TAP_PATH, ...args], {
    input,
    encoding: "utf8",
    env: { PATH: process.env.PATH, CLAUDE_CONFIG_DIR: configDir },
  });

  const withUsage = JSON.stringify({
    model: { display_name: "Fable" },
    rate_limits: { five_hour: { used_percentage: 42, resets_at: 1_790_000_000 } },
  });
  const rendered = run(withUsage, [`cat > '${path.join(home, "seen.json")}'; printf 'line'`]);
  assert.equal(rendered.status, 0);
  assert.equal(rendered.stdout, "line");
  assert.equal(fs.readFileSync(path.join(home, "seen.json"), "utf8"), withUsage);
  assert.equal(fs.readFileSync(usagePath, "utf8"), withUsage);
  assert.equal(fs.statSync(usagePath).mode & 0o777, 0o600);

  // Input without usage leaves the last reading in place; no command prints nothing.
  const bare = run(JSON.stringify({ model: { display_name: "Fable" } }));
  assert.equal(bare.status, 0);
  assert.equal(bare.stdout, "");
  assert.equal(fs.readFileSync(usagePath, "utf8"), withUsage);
  assert.deepEqual(fs.readdirSync(configDir), [".aimgr-session-usage.json"]);
});

test("required skills, MCP and package preparation refuse instead of silently reducing a session", async t => {
  for (const category of ["skills", "mcp", "packages"]) {
    const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const { homeDir, configDir } = launchPaths(home);
    const claudeDir = path.join(home, ".claude");
    fs.mkdirSync(path.join(claudeDir, "skills"), { recursive: true });
    if (category === "skills") fs.mkdirSync(path.join(configDir, "skills"), { recursive: true });
    writeJson(path.join(claudeDir, "settings.json"), category === "packages"
      ? { enabledPlugins: { "missing@synthetic": true } } : {});
    writeJson(path.join(home, ".claude.json"), { mcpServers: category === "mcp" ? [] : { synthetic: { command: "/usr/bin/true" } } });
    const warnings = [];
    await assert.rejects(prepareClaudeCliLaunch({ command: process.execPath,
      userHomeDir: home, homeDir, configDir, platform: "linux", warn: message => warnings.push(message),
    }), category === "skills" ? /conflicting managed Claude skills/ : category === "mcp" ? /MCP servers are malformed/ : /plugin/);
    assert.equal(warnings.some(message => /optional personal skills|optional user MCP|optional user plugins/.test(message)), false);
  }
});

test("unique and legacy login staging do not traverse or materialize optional customizations", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "malformed");
  fs.writeFileSync(path.join(home, ".claude", ".generic-preference"), "");
  for (const directory of [".login-staging", ".login-staging-12345678-1234-4123-8123-123456789abc"]) {
  const stagingHome = path.join(home, ".aimgr", "claude-homes", "alpha", directory);
  const configDir = path.join(stagingHome, ".claude");
  fs.mkdirSync(configDir, { recursive: true });
  const prepared = await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir: stagingHome,
    configDir,
    platform: "linux",
  });
  assert.deepEqual(prepared.userPluginDirs, []);
  assert.equal(prepared.userHooksPath, null);
  assert.equal(prepared.userMcpConfigPath, null);
  assert.deepEqual(fs.readdirSync(configDir), []);
  }
  for (const directory of [".login-staging-12345678-1234-1123-8123-123456789abc", ".login-staging-not-a-uuid"]) {
    const homeDir = path.join(home, ".aimgr/claude-homes/alpha", directory);
    await assert.rejects(prepareClaudeCliLaunch({ command: process.execPath, userHomeDir: home,
      homeDir, configDir: path.join(homeDir, ".claude"), platform: "linux" }), /exact label or login-staging home/);
  }
});

test("interactive runner preserves cwd, stdio, PATH, and developer env while clearing only selectors", async () => {
  const home = mkTempHome();
  const projectDir = path.join(home, "project");
  fs.mkdirSync(path.join(projectDir, ".claude", "skills", "project-skill"), { recursive: true });
  const adapter = installSyntheticAdapter(home);
  const prepared = preparedLaunch(home, {
    ...adapter,
    userHooksPath: path.join(home, "hooks.json"),
    userMcpConfigPath: path.join(home, "mcp.json"),
    userPluginDirs: [path.join(home, "plugin")],
  });
  const calls = [];
  const result = await runClaudeCli({
    command: prepared.command,
    userHomeDir: home,
    homeDir: prepared.homeDir,
    configDir: prepared.configDir,
    cwd: projectDir,
    args: ["--synthetic"],
    env: {
      HOME: "/wrong",
      PATH: "/developer/bin:/usr/bin:/bin",
      CLAUDE_CONFIG_DIR: "/wrong",
      CLAUDE_SECURESTORAGE_CONFIG_DIR: "/wrong",
      ANTHROPIC_API_KEY: "clear",
      ANTHROPIC_AUTH_TOKEN: "clear",
      ANTHROPIC_BASE_URL: "clear",
      CLAUDE_CODE_OAUTH_TOKEN: "clear",
      CLAUDE_CODE_USE_BEDROCK: "clear",
      CLAUDE_CODE_ORGANIZATION_UUID: "other-org",
      CLAUDE_CODE_ACCOUNT_UUID: "other-account",
      CLAUDE_CODE_USER_EMAIL: "other@example.invalid",
      ANTHROPIC_CUSTOM_HEADERS: "preserve",
      CODEX_HOME: "/developer/codex",
      DEBUG: "developer-debug",
      DYLD_INSERT_LIBRARIES: "/developer/dyld.dylib",
      LD_PRELOAD: "/developer/loader.so",
      PROJECT_ENV: "preserve",
    },
    preparedLaunch: prepared,
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      return { status: 7, signal: null };
    },
  });
  assert.deepEqual(result, { status: 7, signal: null });
  assert.equal(calls[0].file, process.execPath);
  assert.match(calls[0].args[0], /claude-supervisor\.js$/);
  assert.deepEqual(calls[0].args.slice(2), [
    process.execPath,
    "--settings",
    prepared.userHooksPath,
    "--mcp-config",
    prepared.userMcpConfigPath,
    "--plugin-dir",
    prepared.userPluginDirs[0],
    "--synthetic",
  ]);
  assert.equal(calls[0].args[1], "--privacy-entry-v1");
  assert.deepEqual(calls[0].options.stdio.slice(0, 5), ["inherit", "inherit", "inherit", "ipc", "ignore"]);
  assert.equal(typeof calls[0].options.stdio[5], "number");
  assert.equal(calls[0].options.cwd, projectDir);
  assert.equal(calls[0].options.env.HOME, home);
  assert.equal(calls[0].options.env.CLAUDE_CONFIG_DIR, prepared.configDir);
  assert.equal(calls[0].options.env.CLAUDE_SECURESTORAGE_CONFIG_DIR, prepared.configDir);
  assert.equal(calls[0].options.env.PATH, `${adapter.adapterDir}:/developer/bin:/usr/bin:/bin`);
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CODE_USE_BEDROCK",
    "CLAUDE_CODE_ORGANIZATION_UUID",
    "CLAUDE_CODE_ACCOUNT_UUID",
    "CLAUDE_CODE_USER_EMAIL",
  ]) assert.equal(calls[0].options.env[key], undefined, key);
  for (const key of [
    "ANTHROPIC_CUSTOM_HEADERS",
    "CODEX_HOME",
    "DEBUG",
    "DYLD_INSERT_LIBRARIES",
    "LD_PRELOAD",
    "PROJECT_ENV",
  ]) assert.equal(calls[0].options.env[key], {
    ANTHROPIC_CUSTOM_HEADERS: "preserve",
    CODEX_HOME: "/developer/codex",
    DEBUG: "developer-debug",
    DYLD_INSERT_LIBRARIES: "/developer/dyld.dylib",
    LD_PRELOAD: "/developer/loader.so",
    PROJECT_ENV: "preserve",
  }[key], key);
});

test("noninteractive runner uses the admitted supervisor handoff without optional customization", async () => {
  const home = mkTempHome();
  const projectDir = path.join(home, "project");
  const { homeDir, configDir } = launchPaths(home);
  const adapter = installSyntheticAdapter(home);
  fs.mkdirSync(projectDir, { recursive: true });
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "malformed");
  const calls = [];
  const result = await runClaudeCliNoninteractive({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    cwd: projectDir,
    args: ["--version"],
    env: {
      PATH: "/developer/bin:/usr/bin:/bin",
      ANTHROPIC_API_KEY: "clear",
      ANTHROPIC_CUSTOM_HEADERS: "preserve",
    },
    timeoutMs: 12_345,
    platform: "darwin",
    spawnImpl(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null };
    },
  });
  assert.deepEqual(result, { status: 0, signal: null, timedOut: false });
  assert.deepEqual(calls, [{
    file: fs.realpathSync(process.execPath),
    args: [SUPERVISOR_SOURCE_PATH, "--privacy-entry-v1", fs.realpathSync(process.execPath), "--version"],
    options: {
      stdio: ["ignore", "pipe", "pipe", "ipc", "ignore", calls[0].options.stdio[5]],
      env: {
        PATH: `${adapter.adapterDir}:/developer/bin:/usr/bin:/bin`,
        ANTHROPIC_CUSTOM_HEADERS: "preserve",
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
        CLAUDE_CODE_REMOTE_MEMORY_DIR: path.join(home, ".claude"),
      },
      cwd: projectDir,
      detached: true,
      shell: false,
    },
  }]);
  assert.deepEqual(fs.readdirSync(configDir), []);
});

test("direct noninteractive runner reports its bounded timeout without inventing a mode", async () => {
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  const controller = new AbortController();
  controller.abort();
  const result = await runClaudeCliNoninteractive({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    cwd: home,
    platform: "linux",
    timeoutMs: 1,
    signal: controller.signal,
  });
  assert.deepEqual(result, { status: null, signal: null, timedOut: true });
  await assert.rejects(
    runClaudeCliNoninteractive({
      command: process.execPath,
      userHomeDir: home,
      homeDir,
      configDir,
      cwd: home,
      platform: "linux",
      timeoutMs: 300_001,
    }),
    /bounded process limits/,
  );
});

test("coordinated maintenance uses the real supervisor and keeps its lock out of vendor descriptors", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const paths = launchPaths(home);
  const lock = await acquireClaudeAssignmentLock(home, "alpha");
  const identity = fs.fstatSync(lock.fd);
  try {
    const result = await runClaudeCliNoninteractive({ command: process.execPath, userHomeDir: home,
      ...paths, cwd: home, env: { PATH: "/usr/bin:/bin" }, assignmentLock: lock, platform: "linux",
      args: ["-e", `const fs=require('fs'); for(let fd=3;fd<64;fd++) { try {
        const s=fs.fstatSync(fd); if(s.dev===${identity.dev} && s.ino===${identity.ino}) process.exit(99);
      } catch {} } process.exit(13);`] });
    assert.deepEqual(result, { status: 13, signal: null, timedOut: false });
    lock.assertOwned();
  } finally { await lock.release(); }
});

test("pause-resume IPC is present without build qualification policy", () => {
  const source = `${fs.readFileSync(RUNNER_SOURCE_PATH, "utf8")}\n${fs.readFileSync(SUPERVISOR_SOURCE_PATH, "utf8")}`;
  assert.match(source, /aimgr:claude-process-control/);
  assert.match(source, /registerProcessControl/);
  assert.match(source, /SIGSTOP/);
  assert.match(source, /SIGCONT/);
  assert.doesNotMatch(source, /SUPPORTED_CLAUDE_BUILDS|codesign|sha256|sourceSha256|DISABLE_AUTOUPDATER/);
});

test("managed Claude runner waits for supervisor pause and resume acknowledgements", async () => {
  const home = mkTempHome();
  const prepared = preparedLaunch(home);
  const child = new EventEmitter();
  child.connected = true;
  const sent = [];
  child.send = (message, callback) => {
    sent.push(message);
    queueMicrotask(() => {
      callback();
      child.emit("message", {
        type: "aimgr:claude-process-control-ack-v1",
        requestId: message.requestId,
        action: message.action,
        ok: true,
      });
    });
  };
  let control = null;
  const running = runClaudeCli({
    command: process.execPath,
    userHomeDir: home,
    homeDir: prepared.homeDir,
    configDir: prepared.configDir,
    cwd: home,
    preparedLaunch: prepared,
    spawnImpl: () => child,
    registerProcessControl(value) {
      control = value;
    },
  });
  await new Promise(setImmediate);
  assert.ok(control);
  assert.equal(await control.pause(), true);
  assert.equal(await control.resume(), true);
  assert.deepEqual(sent.map((entry) => entry.action), ["pause", "resume"]);
  child.emit("close", 0, null);
  assert.deepEqual(await running, { status: 0, signal: null });
  assert.equal(control, null);
});


test("noninteractive timeout kills the detached Claude process group including a stubborn descendant", async () => {
  if (process.platform === "win32") return;
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  const scriptPath = path.join(home, "stubborn-tree.mjs");
  const pidPath = path.join(home, "tree-pids.json");
  fs.writeFileSync(scriptPath, `
    import fs from "node:fs";
    import { spawn } from "node:child_process";
    const child = spawn(process.execPath, ["-e", "process.on('SIGTERM',()=>{});setInterval(()=>{},1000)"], { stdio: "ignore" });
    fs.writeFileSync(process.argv[2], JSON.stringify({ parent: process.pid, child: child.pid }));
    process.on("SIGTERM", () => {});
    setInterval(() => {}, 1000);
  `);

  const result = await runClaudeCliNoninteractive({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    cwd: home,
    args: [scriptPath, pidPath],
    platform: "linux",
    // Leave startup headroom on the two-core isolated VM; this checks
    // descendant cleanup, not Node process startup latency.
    timeoutMs: 1500,
    terminationGraceMs: 100,
  });
  assert.equal(result.timedOut, true);
  const pids = JSON.parse(fs.readFileSync(pidPath, "utf8"));
  const alive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return error?.code !== "ESRCH";
    }
  };
  for (let attempt = 0; attempt < 20 && (alive(pids.parent) || alive(pids.child)); attempt += 1) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.equal(alive(pids.parent), false);
  assert.equal(alive(pids.child), false);
});


test("a missing selected executable cannot silently choose the active approved build", async () => {
  await assert.rejects(verifyInstalledClaudeExecutable({}), /absolute PATH-selected/);
});

test("a standalone noninteractive caller waits for descendant cleanup after its direct child closes", t => {
  if (process.platform === "win32") return;
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  installSyntheticAdapter(home);
  const tree = path.join(home, "term-exiting-tree.mjs");
  const pidsFile = path.join(home, "pids.json");
  const signalsFile = path.join(home, "signals.jsonl");
  fs.writeFileSync(tree, `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    if (process.argv[2] === 'descendant') {
      process.on('SIGTERM', () => {});
      console.log('ready');
      setInterval(() => {}, 1000);
    } else {
      const child = spawn(process.execPath, [${JSON.stringify(tree)}, 'descendant'], {stdio:['ignore','pipe','ignore']});
      child.stdout.once('data', () => {
        fs.writeFileSync(${JSON.stringify(pidsFile)}, JSON.stringify({parent:process.pid, child:child.pid}));
        child.stdout.destroy();
      });
      process.on('SIGTERM', () => process.exit(0));
      setInterval(() => {}, 1000);
    }
  `);
  t.after(() => {
    // On the before-fix run the standalone caller can exit before its KILL.
    // Reap only the process group created by this fixture, then remove its data.
    if (fs.existsSync(pidsFile)) {
      const { parent } = JSON.parse(fs.readFileSync(pidsFile));
      try { process.kill(-parent, "SIGKILL"); } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    fs.rmSync(home, { recursive: true, force: true });
  });
  const runner = new URL("../../src/targets/claude-runner.js", import.meta.url).href;
  const helpers = new URL("../helpers/claude-native-invocation.js", import.meta.url).href;
  const program = `
    import fs from 'node:fs';
    import { spawn } from 'node:child_process';
    import { runClaudeCliNoninteractive } from ${JSON.stringify(runner)};
    import { verifySyntheticExecutable, resolveSyntheticSecurityAdapter, prepareSyntheticNativeInvocation } from ${JSON.stringify(helpers)};
    const result = await runClaudeCliNoninteractive({
      command:process.execPath, userHomeDir:${JSON.stringify(home)}, homeDir:${JSON.stringify(homeDir)},
      configDir:${JSON.stringify(configDir)}, cwd:${JSON.stringify(home)}, timeoutMs:2000, terminationGraceMs:150,
      verifyInstalledClaudeExecutableImpl:verifySyntheticExecutable,
      resolveInstalledClaudeSecurityAdapterImpl:resolveSyntheticSecurityAdapter,
      prepareClaudeNativeInvocationImpl:prepareSyntheticNativeInvocation,
      spawnImpl(_command,_args,options) { return spawn(process.execPath,[${JSON.stringify(tree)}],options); },
      killProcessGroupImpl(pid,signal) {
        fs.appendFileSync(${JSON.stringify(signalsFile)}, JSON.stringify({pid,signal})+'\\n');
        return process.kill(pid,signal);
      }
    });
    console.log(JSON.stringify(result));
  `;
  // A separate Node program is essential: the test runner's own referenced
  // handles otherwise hide premature exit with an unresolved top-level await.
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", program],
    { encoding: "utf8", timeout: 15000, maxBuffer: 64 * 1024 });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).timedOut, true);
  const signals = fs.readFileSync(signalsFile, "utf8").trim().split("\n").map(JSON.parse);
  const { parent } = JSON.parse(fs.readFileSync(pidsFile));
  assert.deepEqual(signals, [{ pid: -parent, signal: "SIGTERM" }, { pid: -parent, signal: "SIGKILL" }]);
});

test("lease cancellation during privacy preparation refuses before any supervisor starts", async t => {
  const home = mkTempHome(); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prepared = preparedLaunch(home), controller = new AbortController();
  const reason = new Error("synthetic lease lost"); let spawned = false;
  await assert.rejects(runClaudeCli({ ...prepared, preparedLaunch: prepared, cwd: home,
    signal: controller.signal, prepareClaudeNativeInvocationImpl: async options => {
      const native = await prepareSyntheticNativeInvocation(options); controller.abort(reason); return native;
    }, spawnImpl() { spawned = true; throw new Error("unexpected spawn"); } }), error => error === reason);
  assert.equal(spawned, false);
});


test("original detached intent refuses before interactive hook-prefix augmentation", async t => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const prepared = preparedLaunch(home, { userHooksPath: path.join(home, "hooks.json") });
  for (const args of [["daemon", "run"], ["attach", "synthetic-name"], ["logs"], ["--bg", "task"], ["-cn", "--bg"]]) {
    await assert.rejects(realRunClaudeCli({ cwd: home, preparedLaunch: prepared, args,
      prepareClaudeNativeInvocationImpl: () => assert.fail("native preparation must not start") }),
    /daemon commands|detached Claude sessions/);
    await assert.rejects(realRunClaudeCliNoninteractive({ cwd: home, args,
      verifyInstalledClaudeExecutableImpl: () => assert.fail("artifact preparation must not start") }),
    /daemon commands|detached Claude sessions/);
  }
  for (const args of [["-p", "attach"], ["-p", "daemon"], ["--name", "attach", "-p", "task"]]) {
    await assert.rejects(realRunClaudeCli({ cwd: home, preparedLaunch: prepared, args,
      prepareClaudeNativeInvocationImpl: input => {
        assert.deepEqual(input.args.slice(0, 2), ["--settings", prepared.userHooksPath]);
        assert.deepEqual(input.args.slice(2), args);
        throw new Error("literal reached native preparation");
      } }), /literal reached native preparation/);
  }
});
