import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("./claude-supervisor.js", import.meta.url));
const USER_HOOKS_OVERLAY_FILE = ".aimgr-user-hooks.json";
const USER_MCP_OVERLAY_FILE = ".aimgr-user-mcp.json";
const SECURITY_ADAPTER_RELATIVE_PATH = path.join(
  ".aimgr",
  "runtime",
  "claude-file-store",
  "security",
);

// These values can select credentials or a provider backend instead of the
// projected Claude account. Every other developer/operator variable survives.
const COMPETING_CLAUDE_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_API_KEY_FILE_DESCRIPTOR",
  "CLAUDE_CODE_HOST_CREDS_FILE",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
]);

const SAFE_MARKER_NAME = /^\.[A-Za-z0-9][A-Za-z0-9._-]*$/;
const FORBIDDEN_MARKER_NAME = /(?:^\.claude\.json$|account|auth|cache|credential|history|log|oauth|project|session|token|trust)/i;

function normalizedAbsolute(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw && path.isAbsolute(raw) ? path.resolve(raw).normalize("NFC") : null;
}

function ensureDirectory(filePath, { fsImpl = fs } = {}) {
  fsImpl.mkdirSync(filePath, { recursive: true, mode: 0o700 });
  const stat = fsImpl.statSync(filePath);
  if (!stat.isDirectory()) {
    throw new Error("Managed Claude requires a directory for its selected config root.");
  }
}

function readOptionalJson(filePath, { fsImpl = fs, description } = {}) {
  let raw;
  try {
    raw = fsImpl.readFileSync(filePath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error(`Could not read the normal Claude ${description}.`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw new Error(`The normal Claude ${description} is malformed.`);
  }
}

function requireOptionalObjectField(source, field, description) {
  if (source === null || source[field] === undefined) return null;
  const value = source[field];
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`The normal Claude ${description} are malformed.`);
  }
  return Object.keys(value).length > 0 ? value : null;
}

function syncPrivateJsonOverlay(filePath, payload, {
  fsImpl = fs,
  description,
} = {}) {
  let exists = false;
  try {
    const stat = fsImpl.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing an unsafe ${description}.`);
    }
    exists = true;
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (payload === null) {
    if (exists) fsImpl.unlinkSync(filePath);
    return null;
  }

  const next = `${JSON.stringify(payload, null, 2)}\n`;
  if (exists && fsImpl.readFileSync(filePath, "utf8") === next) {
    fsImpl.chmodSync(filePath, 0o600);
    return filePath;
  }

  const tempPath = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`,
  );
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, next, { encoding: "utf8", flag: "wx", mode: 0o600 });
    fsImpl.renameSync(tempPath, filePath);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        fsImpl.unlinkSync(tempPath);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
  }
  fsImpl.chmodSync(filePath, 0o600);
  return filePath;
}

export async function verifyInstalledClaudeExecutable({
  command,
  fsImpl = fs,
} = {}) {
  const selectedCommand = normalizedAbsolute(command);
  if (!selectedCommand) {
    throw new Error("Managed Claude requires the absolute PATH-selected executable.");
  }

  let resolvedCommand;
  let stat;
  try {
    resolvedCommand = fsImpl.realpathSync(selectedCommand);
    stat = fsImpl.statSync(resolvedCommand);
    fsImpl.accessSync(resolvedCommand, fs.constants.X_OK);
  } catch {
    throw new Error("The PATH-selected Claude executable is unavailable or not executable.");
  }
  if (!stat.isFile()) {
    throw new Error("The PATH-selected Claude executable is not a file.");
  }
  return resolvedCommand;
}

export function resolveInstalledClaudeSecurityAdapter({
  userHomeDir,
  fsImpl = fs,
} = {}) {
  const resolvedHome = normalizedAbsolute(userHomeDir);
  if (!resolvedHome) {
    throw new Error("Managed Claude security adapter lookup requires an absolute user home.");
  }
  const installedPath = path.join(resolvedHome, SECURITY_ADAPTER_RELATIVE_PATH);
  let shimPath;
  let stat;
  try {
    shimPath = fsImpl.realpathSync(installedPath);
    stat = fsImpl.statSync(shimPath);
    fsImpl.accessSync(shimPath, fs.constants.X_OK);
  } catch {
    throw new Error("Managed Claude requires the installed security adapter; run the local installer.");
  }
  if (!stat.isFile() || path.basename(shimPath) !== "security") {
    throw new Error("Managed Claude found an invalid installed security adapter.");
  }
  return Object.freeze({ shimPath, adapterDir: path.dirname(shimPath) });
}

export function ensureManagedClaudePersonalSkillsLink({
  userHomeDir,
  configDir,
  fsImpl = fs,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedConfigDir) {
    throw new Error("Managed Claude skills setup requires absolute user and config directories.");
  }
  const source = path.join(resolvedUserHome, ".claude", "skills");
  const destination = path.join(resolvedConfigDir, "skills");
  let sourceStat;
  try {
    sourceStat = fsImpl.statSync(source);
  } catch (error) {
    if (error?.code === "ENOENT") return { linked: false, reason: "source_missing" };
    throw error;
  }
  if (!sourceStat.isDirectory()) {
    throw new Error("The normal Claude skills path is not a directory.");
  }

  let destinationStat = null;
  try {
    destinationStat = fsImpl.lstatSync(destination);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  if (destinationStat) {
    const target = destinationStat.isSymbolicLink()
      ? path.resolve(path.dirname(destination), fsImpl.readlinkSync(destination)).normalize("NFC")
      : null;
    if (target !== source) {
      throw new Error("Refusing a conflicting managed Claude skills path.");
    }
    return { linked: true, path: destination };
  }

  fsImpl.symlinkSync(source, destination, "dir");
  return { linked: true, path: destination };
}

export function syncManagedClaudeUserSettings({
  userHomeDir,
  configDir,
  fsImpl = fs,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedConfigDir) {
    throw new Error("Managed Claude user settings require absolute user and config directories.");
  }
  const settings = readOptionalJson(path.join(resolvedUserHome, ".claude", "settings.json"), {
    fsImpl,
    description: "user settings",
  });
  if (settings !== null && (typeof settings !== "object" || Array.isArray(settings))) {
    throw new Error("The normal Claude user settings are malformed.");
  }
  const hooks = requireOptionalObjectField(settings, "hooks", "user hooks");
  const statusLine = requireOptionalObjectField(settings, "statusLine", "user status-line settings");
  const payload = {
    ...(hooks === null ? {} : { hooks }),
    ...(statusLine === null ? {} : { statusLine }),
  };
  return syncPrivateJsonOverlay(
    path.join(resolvedConfigDir, USER_HOOKS_OVERLAY_FILE),
    Object.keys(payload).length === 0 ? null : payload,
    { fsImpl, description: "managed Claude user-settings overlay" },
  );
}

export function syncManagedClaudeUserMcp({
  userHomeDir,
  configDir,
  fsImpl = fs,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedConfigDir) {
    throw new Error("Managed Claude user MCP setup requires absolute user and config directories.");
  }
  const appState = readOptionalJson(path.join(resolvedUserHome, ".claude.json"), {
    fsImpl,
    description: "user app state",
  });
  if (appState !== null && (typeof appState !== "object" || Array.isArray(appState))) {
    throw new Error("The normal Claude user app state is malformed.");
  }
  const mcpServers = requireOptionalObjectField(appState, "mcpServers", "user MCP servers");
  return syncPrivateJsonOverlay(
    path.join(resolvedConfigDir, USER_MCP_OVERLAY_FILE),
    mcpServers === null ? null : { mcpServers },
    { fsImpl, description: "managed Claude user-MCP overlay" },
  );
}

export function resolveEnabledClaudeUserPlugins({
  userHomeDir,
  fsImpl = fs,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  if (!resolvedUserHome) {
    throw new Error("Managed Claude plugin discovery requires an absolute user home.");
  }
  const claudeDir = path.join(resolvedUserHome, ".claude");
  const settings = readOptionalJson(path.join(claudeDir, "settings.json"), {
    fsImpl,
    description: "plugin settings",
  });
  if (settings === null || settings.enabledPlugins === undefined) return [];
  if (
    typeof settings !== "object"
    || Array.isArray(settings)
    || settings.enabledPlugins === null
    || typeof settings.enabledPlugins !== "object"
    || Array.isArray(settings.enabledPlugins)
  ) {
    throw new Error("The normal Claude enabled plugin settings are malformed.");
  }
  const enabledIds = Object.entries(settings.enabledPlugins)
    .filter(([, enabled]) => enabled === true)
    .map(([id]) => id)
    .sort();
  if (enabledIds.length === 0) return [];

  const registry = readOptionalJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    fsImpl,
    description: "installed plugin registry",
  });
  if (!registry || typeof registry.plugins !== "object" || Array.isArray(registry.plugins)) {
    throw new Error("The normal Claude installed plugin registry is unavailable or malformed.");
  }

  return enabledIds.map((id) => {
    const records = Array.isArray(registry.plugins[id]) ? registry.plugins[id] : [];
    const record = records.find((candidate) => (
      candidate?.scope === "user" && normalizedAbsolute(candidate.installPath)
    ));
    if (!record) {
      throw new Error("An enabled normal Claude plugin has no usable user installation.");
    }
    const installPath = fsImpl.realpathSync(record.installPath);
    if (!fsImpl.statSync(installPath).isDirectory()) {
      throw new Error("An enabled normal Claude plugin path is not a directory.");
    }
    return Object.freeze({ id, installPath });
  });
}

function safeMarkerSource(sourcePath, markerName, { fsImpl = fs } = {}) {
  if (!SAFE_MARKER_NAME.test(markerName) || FORBIDDEN_MARKER_NAME.test(markerName)) return false;
  try {
    const stat = fsImpl.lstatSync(sourcePath);
    return stat.isFile() && !stat.isSymbolicLink() && stat.size === 0;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

export function syncManagedClaudeConfigMarkers({
  userHomeDir,
  configDir,
  fsImpl = fs,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedConfigDir) {
    throw new Error("Managed Claude marker setup requires absolute user and config directories.");
  }
  const sourceDir = path.join(resolvedUserHome, ".claude");
  let sourceEntries;
  try {
    sourceEntries = fsImpl.readdirSync(sourceDir, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return Object.freeze({ linked: Object.freeze([]) });
    throw error;
  }

  const markerNames = sourceEntries
    .map(({ name }) => name)
    .filter((name) => safeMarkerSource(path.join(sourceDir, name), name, { fsImpl }))
    .sort();

  for (const entry of fsImpl.readdirSync(resolvedConfigDir, { withFileTypes: true })) {
    if (!entry.isSymbolicLink() || !SAFE_MARKER_NAME.test(entry.name)) continue;
    const destination = path.join(resolvedConfigDir, entry.name);
    const target = path.resolve(resolvedConfigDir, fsImpl.readlinkSync(destination)).normalize("NFC");
    if (target !== path.join(sourceDir, entry.name) || markerNames.includes(entry.name)) continue;
    fsImpl.unlinkSync(destination);
  }

  for (const markerName of markerNames) {
    const source = path.join(sourceDir, markerName);
    const destination = path.join(resolvedConfigDir, markerName);
    let destinationStat = null;
    try {
      destinationStat = fsImpl.lstatSync(destination);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    if (destinationStat) {
      const exactLink = destinationStat.isSymbolicLink()
        && path.resolve(resolvedConfigDir, fsImpl.readlinkSync(destination)).normalize("NFC") === source;
      if (exactLink) continue;
      if (destinationStat.isFile() && destinationStat.size === 0) {
        fsImpl.unlinkSync(destination);
      } else {
        throw new Error("Refusing a conflicting managed Claude config marker.");
      }
    }
    fsImpl.symlinkSync(source, destination);
  }
  return Object.freeze({ linked: Object.freeze(markerNames) });
}

function assertContainedLaunchTopology({ userHomeDir, launchHome, configDir }) {
  const aimgrRoot = path.join(userHomeDir, ".aimgr");
  const claudeHomesRoot = path.join(aimgrRoot, "claude-homes");
  const relative = path.relative(claudeHomesRoot, configDir);
  const segments = relative.split(path.sep);
  const directLabelConfig = (
    segments.length === 2
    && /^[A-Za-z0-9_.-]+$/.test(segments[0])
    && segments[1] === ".claude"
  );
  const freshLoginConfig = (
    segments.length === 3
    && /^[A-Za-z0-9_.-]+$/.test(segments[0])
    && segments[1] === ".login-staging"
    && segments[2] === ".claude"
  );
  if (
    relative.startsWith("..")
    || path.isAbsolute(relative)
    || (!directLabelConfig && !freshLoginConfig)
    || launchHome !== path.dirname(configDir)
  ) {
    throw new Error("Managed Claude launch paths do not identify one exact label or login-staging home.");
  }
  return {
    aimgrRoot,
    claudeHomesRoot,
    selectedLabelHome: launchHome,
    loginStaging: freshLoginConfig,
  };
}

function optionalCustomization(description, operation, fallback, warn) {
  try {
    return operation();
  } catch {
    warn?.(`Managed Claude skipped optional ${description}.`);
    return fallback;
  }
}

async function prepareContainedClaudeCliLaunch({
  command,
  userHomeDir,
  homeDir,
  configDir,
  fsImpl = fs,
  platform = process.platform,
  warn = (message) => console.warn(message),
  verifyInstalledClaudeExecutableImpl = verifyInstalledClaudeExecutable,
  resolveInstalledClaudeSecurityAdapterImpl = resolveInstalledClaudeSecurityAdapter,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedLaunchHome = normalizedAbsolute(homeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedLaunchHome || !resolvedConfigDir) {
    throw new Error("Managed Claude preflight requires absolute user, label, and config directories.");
  }
  const { loginStaging, ...topology } = assertContainedLaunchTopology({
    userHomeDir: resolvedUserHome,
    launchHome: resolvedLaunchHome,
    configDir: resolvedConfigDir,
  });
  const resolvedCommand = await verifyInstalledClaudeExecutableImpl({ command, fsImpl });
  ensureDirectory(resolvedConfigDir, { fsImpl });

  const adapter = platform === "darwin"
    ? resolveInstalledClaudeSecurityAdapterImpl({ userHomeDir: resolvedUserHome, fsImpl })
    : {};
  return Object.freeze({
    command: resolvedCommand,
    userHomeDir: resolvedUserHome,
    homeDir: resolvedLaunchHome,
    configDir: resolvedConfigDir,
    loginStaging,
    ...topology,
    ...adapter,
  });
}

export async function prepareClaudeCliLaunch({
  command,
  userHomeDir,
  homeDir,
  configDir,
  fsImpl = fs,
  platform = process.platform,
  warn = (message) => console.warn(message),
  verifyInstalledClaudeExecutableImpl = verifyInstalledClaudeExecutable,
  resolveInstalledClaudeSecurityAdapterImpl = resolveInstalledClaudeSecurityAdapter,
} = {}) {
  const contained = await prepareContainedClaudeCliLaunch({
    command,
    userHomeDir,
    homeDir,
    configDir,
    fsImpl,
    platform,
    verifyInstalledClaudeExecutableImpl,
    resolveInstalledClaudeSecurityAdapterImpl,
  });
  const {
    loginStaging,
    userHomeDir: resolvedUserHome,
    configDir: resolvedConfigDir,
  } = contained;

  let userPlugins = [];
  let userHooksPath = null;
  let userMcpConfigPath = null;
  if (!loginStaging) {
    optionalCustomization("personal skills", () => ensureManagedClaudePersonalSkillsLink({
      userHomeDir: resolvedUserHome,
      configDir: resolvedConfigDir,
      fsImpl,
    }), null, warn);
    userHooksPath = optionalCustomization("user hooks and status line", () => (
      syncManagedClaudeUserSettings({
        userHomeDir: resolvedUserHome,
        configDir: resolvedConfigDir,
        fsImpl,
      })
    ), null, warn);
    userMcpConfigPath = optionalCustomization("user MCP servers", () => (
      syncManagedClaudeUserMcp({
        userHomeDir: resolvedUserHome,
        configDir: resolvedConfigDir,
        fsImpl,
      })
    ), null, warn);
    userPlugins = optionalCustomization("user plugins", () => (
      resolveEnabledClaudeUserPlugins({ userHomeDir: resolvedUserHome, fsImpl })
    ), [], warn);
    optionalCustomization("config-root markers", () => syncManagedClaudeConfigMarkers({
      userHomeDir: resolvedUserHome,
      configDir: resolvedConfigDir,
      fsImpl,
    }), null, warn);
  }

  return Object.freeze({
    ...contained,
    userPluginDirs: Object.freeze(userPlugins.map(({ installPath }) => installPath)),
    userHooksPath,
    userMcpConfigPath,
  });
}

function buildContainedLaunchEnvironment({ preparedLaunch, env }) {
  const launchEnv = { ...(env ?? {}) };
  for (const key of COMPETING_CLAUDE_ENV_KEYS) delete launchEnv[key];
  launchEnv.HOME = preparedLaunch.userHomeDir;
  launchEnv.CLAUDE_CONFIG_DIR = preparedLaunch.configDir;
  launchEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = preparedLaunch.configDir;
  if (preparedLaunch.adapterDir) {
    const inheritedPath = typeof launchEnv.PATH === "string" ? launchEnv.PATH : "";
    launchEnv.PATH = inheritedPath
      ? `${preparedLaunch.adapterDir}${path.delimiter}${inheritedPath}`
      : preparedLaunch.adapterDir;
  }
  return launchEnv;
}

function buildClaudeArgs(preparedLaunch, args) {
  return [
    ...(preparedLaunch.userHooksPath
      ? ["--settings", preparedLaunch.userHooksPath]
      : []),
    ...(preparedLaunch.userMcpConfigPath
      ? ["--mcp-config", preparedLaunch.userMcpConfigPath]
      : []),
    ...(preparedLaunch.userPluginDirs ?? [])
      .flatMap((pluginDir) => ["--plugin-dir", pluginDir]),
    ...(Array.isArray(args) ? args : []),
  ];
}

function buildSupervisorArgs(preparedLaunch, args) {
  return [SUPERVISOR_PATH, preparedLaunch.command, ...buildClaudeArgs(preparedLaunch, args)];
}

export async function runClaudeCliNoninteractive({
  command,
  userHomeDir,
  homeDir,
  configDir,
  cwd = process.cwd(),
  args = [],
  env = process.env,
  timeoutMs = 30_000,
  fsImpl = fs,
  platform = process.platform,
  verifyInstalledClaudeExecutableImpl = verifyInstalledClaudeExecutable,
  resolveInstalledClaudeSecurityAdapterImpl = resolveInstalledClaudeSecurityAdapter,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolvedCwd = normalizedAbsolute(cwd);
  if (!resolvedCwd) {
    throw new Error("Claude noninteractive launch requires an absolute working directory.");
  }
  if (
    !Array.isArray(args)
    || !args.every((arg) => typeof arg === "string")
    || !Number.isInteger(timeoutMs)
    || timeoutMs < 1
    || timeoutMs > 300_000
  ) {
    throw new Error("Claude noninteractive launch requires string arguments and a bounded timeout.");
  }

  const prepared = await prepareContainedClaudeCliLaunch({
    command,
    userHomeDir,
    homeDir,
    configDir,
    fsImpl,
    platform,
    verifyInstalledClaudeExecutableImpl,
    resolveInstalledClaudeSecurityAdapterImpl,
  });
  const result = spawnSyncImpl(prepared.command, args, {
    stdio: "inherit",
    env: buildContainedLaunchEnvironment({ preparedLaunch: prepared, env }),
    cwd: resolvedCwd,
    timeout: timeoutMs,
    killSignal: "SIGTERM",
    shell: false,
  });
  if (result?.error?.code === "ETIMEDOUT") {
    return Object.freeze({
      status: null,
      signal: typeof result.signal === "string" ? result.signal : null,
      timedOut: true,
    });
  }
  if (result?.error) throw result.error;
  const childSignal = typeof result?.signal === "string" ? result.signal : null;
  return Object.freeze({
    status: childSignal ? null : Number.isInteger(result?.status) ? result.status : 1,
    signal: childSignal,
    timedOut: false,
  });
}

export async function runClaudeCli({
  command,
  userHomeDir,
  homeDir,
  configDir,
  cwd = process.cwd(),
  args = [],
  env = process.env,
  signal = null,
  preparedLaunch = null,
  prepareClaudeCliLaunchImpl = prepareClaudeCliLaunch,
  spawnImpl = spawn,
} = {}) {
  const resolvedCwd = normalizedAbsolute(cwd);
  if (!resolvedCwd) {
    throw new Error("Claude launch requires an absolute working directory.");
  }
  const prepared = preparedLaunch ?? await prepareClaudeCliLaunchImpl({
    command,
    userHomeDir,
    homeDir,
    configDir,
  });
  if (
    !prepared
    || !normalizedAbsolute(prepared.command)
    || !normalizedAbsolute(prepared.userHomeDir)
    || !normalizedAbsolute(prepared.homeDir)
    || !normalizedAbsolute(prepared.configDir)
    || (prepared.adapterDir && !normalizedAbsolute(prepared.adapterDir))
    || (prepared.userHooksPath && !normalizedAbsolute(prepared.userHooksPath))
    || (prepared.userMcpConfigPath && !normalizedAbsolute(prepared.userMcpConfigPath))
    || !Array.isArray(prepared.userPluginDirs ?? [])
    || !(prepared.userPluginDirs ?? []).every((pluginDir) => normalizedAbsolute(pluginDir))
  ) {
    throw new Error("Claude launch requires a completed managed preflight.");
  }

  const child = spawnImpl(process.execPath, buildSupervisorArgs(prepared, args), {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: buildContainedLaunchEnvironment({ preparedLaunch: prepared, env }),
    cwd: resolvedCwd,
  });
  if (child?.error) throw child.error;
  if (Number.isInteger(child?.status) || typeof child?.signal === "string") {
    const childSignal = typeof child?.signal === "string" ? child.signal : null;
    return {
      status: childSignal ? null : Number.isInteger(child.status) ? child.status : 1,
      signal: childSignal,
    };
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("Claude launch did not return a process handle.");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let forcedKillTimer = null;
    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const onAbort = () => {
      try {
        child.kill("SIGTERM");
      } catch {
        // The close/error event remains the authoritative process result.
      }
      forcedKillTimer = setTimeout(() => {
        if (settled) return;
        try {
          child.kill("SIGKILL");
        } catch {
          // The close/error event remains the authoritative process result.
        }
      }, 5_000);
      forcedKillTimer.unref?.();
    };
    child.once("error", (error) => finish(reject, error));
    child.once("close", (code, childSignal) => {
      const normalizedSignal = typeof childSignal === "string" ? childSignal : null;
      finish(resolve, {
        status: normalizedSignal ? null : Number.isInteger(code) ? code : 1,
        signal: normalizedSignal,
      });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
