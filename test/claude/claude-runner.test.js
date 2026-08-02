import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  prepareClaudeCliLaunch,
  resolveInstalledClaudeSecurityAdapter,
  runClaudeCli,
  runClaudeCliNoninteractive,
  verifyInstalledClaudeExecutable,
} from "../../src/targets/claude-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const RUNNER_SOURCE_PATH = fileURLToPath(new URL(
  "../../src/targets/claude-runner.js",
  import.meta.url,
));
const SUPERVISOR_SOURCE_PATH = fileURLToPath(new URL(
  "../../src/targets/claude-supervisor.js",
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

test("executable preflight resolves the exact PATH selection once and requires only file plus X_OK", async () => {
  const selected = "/synthetic/bin/claude";
  const resolved = "/synthetic/share/claude/current";
  const calls = [];
  const result = await verifyInstalledClaudeExecutable({
    command: selected,
    fsImpl: {
      realpathSync(filePath) {
        calls.push(["realpath", filePath]);
        return resolved;
      },
      statSync(filePath) {
        calls.push(["stat", filePath]);
        return { isFile: () => true };
      },
      accessSync(filePath, mode) {
        calls.push(["access", filePath, mode]);
      },
    },
  });
  assert.equal(result, resolved);
  assert.deepEqual(calls, [
    ["realpath", selected],
    ["stat", resolved],
    ["access", resolved, fs.constants.X_OK],
  ]);
});

test("installed adapter resolution uses one stable installer-owned executable", () => {
  const home = mkTempHome();
  const expected = installSyntheticAdapter(home);
  assert.deepEqual(resolveInstalledClaudeSecurityAdapter({ userHomeDir: home }), expected);

  fs.unlinkSync(expected.shimPath);
  assert.throws(
    () => resolveInstalledClaudeSecurityAdapter({ userHomeDir: home }),
    /run the local installer/,
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
    statusLine,
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

test("one optional customization failure warns and leaves the other categories usable", async () => {
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  const claudeDir = path.join(home, ".claude");
  fs.mkdirSync(path.join(claudeDir, "skills"), { recursive: true });
  fs.mkdirSync(path.join(configDir, "skills"), { recursive: true });
  writeJson(path.join(claudeDir, "settings.json"), {
    hooks: { Stop: [{ hooks: [{ type: "command", command: "/usr/bin/true" }] }] },
  });
  writeJson(path.join(home, ".claude.json"), {
    mcpServers: { synthetic: { command: "/usr/bin/true" } },
  });
  const warnings = [];
  const prepared = await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    platform: "linux",
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, ["Managed Claude skipped optional personal skills."]);
  assert.ok(prepared.userHooksPath);
  assert.ok(prepared.userMcpConfigPath);
});

test("login staging does not traverse or materialize optional customizations", async () => {
  const home = mkTempHome();
  const stagingHome = path.join(home, ".aimgr", "claude-homes", "alpha", ".login-staging");
  const configDir = path.join(stagingHome, ".claude");
  fs.mkdirSync(path.join(home, ".claude", "skills"), { recursive: true });
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "malformed");
  fs.writeFileSync(path.join(home, ".claude", ".generic-preference"), "");

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
  assert.deepEqual(calls[0].args.slice(1), [
    process.execPath,
    "--settings",
    prepared.userHooksPath,
    "--mcp-config",
    prepared.userMcpConfigPath,
    "--plugin-dir",
    prepared.userPluginDirs[0],
    "--synthetic",
  ]);
  assert.deepEqual(calls[0].options.stdio, ["inherit", "inherit", "inherit", "ipc"]);
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

test("direct noninteractive runner uses contained roots and adapter without customization or IPC", async () => {
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
    spawnSyncImpl(file, args, options) {
      calls.push({ file, args, options });
      return { status: 0, signal: null };
    },
  });
  assert.deepEqual(result, { status: 0, signal: null, timedOut: false });
  assert.deepEqual(calls, [{
    file: fs.realpathSync(process.execPath),
    args: ["--version"],
    options: {
      stdio: "inherit",
      env: {
        PATH: `${adapter.adapterDir}:/developer/bin:/usr/bin:/bin`,
        ANTHROPIC_CUSTOM_HEADERS: "preserve",
        HOME: home,
        CLAUDE_CONFIG_DIR: configDir,
        CLAUDE_SECURESTORAGE_CONFIG_DIR: configDir,
      },
      cwd: projectDir,
      timeout: 12_345,
      killSignal: "SIGTERM",
      shell: false,
    },
  }]);
  assert.deepEqual(fs.readdirSync(configDir), []);
});

test("direct noninteractive runner reports its bounded timeout without inventing a mode", async () => {
  const home = mkTempHome();
  const { homeDir, configDir } = launchPaths(home);
  const error = Object.assign(new Error("timed out"), { code: "ETIMEDOUT" });
  const result = await runClaudeCliNoninteractive({
    command: process.execPath,
    userHomeDir: home,
    homeDir,
    configDir,
    cwd: home,
    platform: "linux",
    timeoutMs: 1,
    spawnSyncImpl: () => ({ status: null, signal: "SIGTERM", error }),
  });
  assert.deepEqual(result, { status: null, signal: "SIGTERM", timedOut: true });
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
    /bounded timeout/,
  );
});

test("pause-resume IPC and build qualification policy are absent from the runtime", () => {
  const source = `${fs.readFileSync(RUNNER_SOURCE_PATH, "utf8")}\n${fs.readFileSync(SUPERVISOR_SOURCE_PATH, "utf8")}`;
  assert.doesNotMatch(source, /aimgr:claude-process-control|registerProcessControl|SIGSTOP|SIGCONT/);
  assert.doesNotMatch(source, /SUPPORTED_CLAUDE_BUILDS|codesign|sha256|sourceSha256|DISABLE_AUTOUPDATER/);
});
