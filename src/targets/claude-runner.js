import { prepareClaudeNativeRoute, nativeProxyEnvironment } from "../network/claude-native-route.js";
import fs from "node:fs";
import { ClaudeRouteError } from "../network/claude-egress-policy.js";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { admitClaudeArtifact } from "../privacy/claude-artifacts.js";
import { prepareClaudeNativeInvocation } from "../privacy/claude-native-invocation.js";
import { assertClaudeLocalInvocation } from "../privacy/claude-settings.js";
import { cleanClaudeRootEnvironment } from "../privacy/claude-provider-admission.js";
import {
  CLAUDE_PROCESS_CONTROL_ACK_TYPE,
  CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE,
} from "./claude-supervisor.js";
import {
  CLAUDE_SHARED_MEMORY_ENV_KEY,
  describeFoldedClaudeMemories,
  foldManagedClaudeMemories,
  resolveClaudeSharedMemoryBase,
} from "./claude-shared-memory.js";

const SUPERVISOR_PATH = fileURLToPath(new URL("./claude-supervisor.js", import.meta.url));
const STATUSLINE_TAP_PATH = fileURLToPath(new URL("./claude-statusline-tap.sh", import.meta.url));
const USER_HOOKS_OVERLAY_FILE = ".aimgr-user-hooks.json";
const USER_MCP_OVERLAY_FILE = ".aimgr-user-mcp.json";

async function prepareSupervisedNativeInvocation({ native, egressProfile, platform = process.platform,
  signal, deadlineMs, prepareRoute }) {
  if (egressProfile && platform === "darwin") {
    // Seatbelt blocks setuid helpers in nested tools. Only the hardened native
    // launcher can leave that inherited policy, run fixed route admission, and
    // enter the selected account policy. Its exec chain preserves the child
    // PID controlled by our supervisor, including pause and forced shutdown.
    const routed = await prepareRoute({ profile: egressProfile, command: native.command, args: native.args,
      nativeCommand: native.vendorCommand, approvedPrivacyEntry: true, platform, signal, deadlineMs });
    return { command: process.execPath, args: [SUPERVISOR_PATH, "--privacy-entry-v1", routed.command, ...routed.args] };
  }
  const args = [SUPERVISOR_PATH, "--privacy-entry-v1", native.command, ...native.args];
  return egressProfile
    ? prepareRoute({ profile: egressProfile, command: process.execPath, args,
      nativeCommand: native.vendorCommand, platform, signal, deadlineMs })
    : { command: process.execPath, args };
}

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

export async function verifyInstalledClaudeExecutable({ command, fsImpl = fs } = {}) {
  if (!normalizedAbsolute(command)) throw new Error("Managed Claude requires the absolute PATH-selected executable.");
  // Never execute --version to discover a candidate. Admission reads immutable
  // administrator records and bytes before credentials enter native state.
  return admitClaudeArtifact({ selectedCommand: command,
    pinnedArtifactSet: process.env.AIMGR_CLAUDE_ARTIFACT_SET, fsImpl }).command;
}

export function resolveInstalledClaudeSecurityAdapter({
  command,
  fsImpl = fs,
} = {}) {
  if (!normalizedAbsolute(command)) {
    throw new Error("Managed Claude security adapter lookup requires the admitted executable.");
  }
  // Called only AFTER complete artifact admission. Darwin manifests require
  // this exact sibling and hash it with the vendor; never fall back to an old
  // home-directory adapter that lacks the current device-key restrictions.
  const installedPath = path.join(path.dirname(command), "security");
  let shimPath;
  let stat;
  try {
    shimPath = fsImpl.realpathSync(installedPath);
    stat = fsImpl.statSync(shimPath);
    fsImpl.accessSync(shimPath, fs.constants.X_OK);
  } catch {
    throw new Error("Managed Claude requires the credential adapter in its approved runtime bundle.");
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

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'"'"'`)}'`;
}

// Every managed session's status line runs through the usage tap, which records
// the usage Claude Code already reads from each response so `aim status` need
// not ask the provider. A user command still renders after the tap; a status
// line of another type is left as it is.
export function buildManagedClaudeStatusLine(userStatusLine) {
  const tap = `/bin/sh ${shellQuote(STATUSLINE_TAP_PATH)}`;
  if (userStatusLine === null) return { type: "command", command: tap };
  if (userStatusLine.type !== "command") return userStatusLine;
  const command = typeof userStatusLine.command === "string" ? userStatusLine.command.trim() : "";
  return { ...userStatusLine, command: command ? `${tap} ${shellQuote(command)}` : tap };
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
  const attribution = requireOptionalObjectField(settings, "attribution", "user attribution settings");
  const payload = {
    ...(hooks === null ? {} : { hooks }),
    statusLine: buildManagedClaudeStatusLine(statusLine),
    ...(attribution === null ? {} : { attribution }),
    ...(typeof settings?.includeCoAuthoredBy === "boolean"
      ? { includeCoAuthoredBy: settings.includeCoAuthoredBy }
      : {}),
    ...(settings?.skipDangerousModePermissionPrompt === true
      ? { skipDangerousModePermissionPrompt: true }
      : {}),
  };
  return syncPrivateJsonOverlay(
    path.join(resolvedConfigDir, USER_HOOKS_OVERLAY_FILE),
    payload,
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
    && (segments[1] === ".login-staging" || /^\.login-staging-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(segments[1]))
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
    ? resolveInstalledClaudeSecurityAdapterImpl({ command: resolvedCommand, userHomeDir: resolvedUserHome, fsImpl })
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
    // T14/T22: skills and MCP are required workflows. A failed projection
    // must stop before vendor execution, rather than silently starting a
    // reduced session. Optional hooks/status presentation may still warn.
    ensureManagedClaudePersonalSkillsLink({
      userHomeDir: resolvedUserHome,
      configDir: resolvedConfigDir,
      fsImpl,
    });
    userHooksPath = optionalCustomization("user hooks and status line", () => (
      syncManagedClaudeUserSettings({
        userHomeDir: resolvedUserHome,
        configDir: resolvedConfigDir,
        fsImpl,
      })
    ), null, warn);
    userMcpConfigPath = syncManagedClaudeUserMcp({
      userHomeDir: resolvedUserHome,
      configDir: resolvedConfigDir,
      fsImpl,
    });
    // Enabled packages can supply required skills/MCP. An unreadable package
    // inventory is not evidence that every package is an optional integration.
    userPlugins = resolveEnabledClaudeUserPlugins({ userHomeDir: resolvedUserHome, fsImpl });
    optionalCustomization("config-root markers", () => syncManagedClaudeConfigMarkers({
      userHomeDir: resolvedUserHome,
      configDir: resolvedConfigDir,
      fsImpl,
    }), null, warn);
    optionalCustomization("shared memory", () => {
      const { folded } = foldManagedClaudeMemories({ userHomeDir: resolvedUserHome, fsImpl });
      const notice = describeFoldedClaudeMemories(folded);
      if (notice) warn?.(notice);
    }, null, warn);
  }

  return Object.freeze({
    ...contained,
    userPluginDirs: Object.freeze(userPlugins.map(({ installPath }) => installPath)),
    userHooksPath,
    userMcpConfigPath,
  });
}

export function buildContainedLaunchEnvironment({ preparedLaunch, env }) {
  // This is a new AIM root even for trusted A-to-B dispatch. Native self-
  // spawned agents/background children inherit their own admitted handoffs
  // directly and must not pass through this root credential cleanup.
  const launchEnv = cleanClaudeRootEnvironment(env ?? {});
  launchEnv.HOME = preparedLaunch.userHomeDir;
  launchEnv.CLAUDE_CONFIG_DIR = preparedLaunch.configDir;
  launchEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = preparedLaunch.configDir;
  launchEnv[CLAUDE_SHARED_MEMORY_ENV_KEY] = resolveClaudeSharedMemoryBase({
    userHomeDir: preparedLaunch.userHomeDir,
  });
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

export function buildSupervisorArgs(preparedLaunch, args) {
  return [SUPERVISOR_PATH, preparedLaunch.command, ...buildClaudeArgs(preparedLaunch, args)];
}

function signalNoninteractiveProcessGroup(child, signalName, {
  detached,
  killProcessGroupImpl = process.kill,
} = {}) {
  if (detached && Number.isInteger(child?.pid) && child.pid > 0 && process.platform !== "win32") {
    try {
      killProcessGroupImpl(-child.pid, signalName);
      return;
    } catch (error) {
      if (error?.code !== "ESRCH") {
        try {
          child.kill?.(signalName);
        } catch {
          // The close/error event remains authoritative.
        }
      }
      return;
    }
  }
  try {
    child?.kill?.(signalName);
  } catch {
    // The close/error event remains authoritative.
  }
}

function drainBoundedChildOutput(stream, { maxBytes, onOverflow }) {
  if (!stream || typeof stream.on !== "function") return;
  let bytes = 0;
  stream.on("data", (chunk) => {
    bytes += Buffer.byteLength(chunk);
    if (bytes > maxBytes) onOverflow();
  });
  stream.resume?.();
}

function nativeSpawnError(error, profile) {
  return profile ? new ClaudeRouteError("native_proxy_unavailable", { ...profile, cause: error }) : error;
}

function nativeExitContext(status, signal, profile) {
  if (!profile || signal || status !== 125) return {};
  // The native wrapper uses 125 for admission/outage failures, but also
  // forwards the child's status. Keep the diagnostic factual in both cases.
  return { error: new Error(`Claude ${profile.label} exited with status 125 while using proxy ${profile.profileRef}. Check the job log; if the proxy/tunnel is unavailable, repair it, then explicitly retry or resume.`) };
}

function spawnClaude(invocation, options, spawnImpl, profile) {
  try {
    const child = spawnImpl(invocation.command, invocation.args, options);
    if (child?.error) throw child.error;
    return child;
  } catch (error) {
    throw nativeSpawnError(error, profile);
  }
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
  deadlineMs = null,
  signal = null,
  terminationGraceMs = 1_000,
  maxOutputBytes = 64 * 1024,
  fsImpl = fs,
  platform = process.platform,
  verifyInstalledClaudeExecutableImpl = verifyInstalledClaudeExecutable,
  resolveInstalledClaudeSecurityAdapterImpl = resolveInstalledClaudeSecurityAdapter,
  spawnImpl = spawn,
  killProcessGroupImpl = process.kill,
  egressProfile,
  assignmentLock = null,
  prepareClaudeNativeRouteImpl = prepareClaudeNativeRoute,
  prepareClaudeNativeInvocationImpl = prepareClaudeNativeInvocation,
  expectedIdentity,
  requiredHooks = {},
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
    || !Number.isInteger(terminationGraceMs)
    || terminationGraceMs < 1
    || terminationGraceMs > 10_000
    || !Number.isInteger(maxOutputBytes)
    || maxOutputBytes < 1
    || maxOutputBytes > 1024 * 1024
  ) {
    throw new Error("Claude noninteractive launch requires string arguments and bounded process limits.");
  }

  assertClaudeLocalInvocation(args);
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
  const remaining = Number.isFinite(deadlineMs) ? Math.floor(deadlineMs - Date.now()) : timeoutMs;
  if (signal?.aborted || remaining <= 0) {
    return Object.freeze({ status: null, signal: null, timedOut: true });
  }
  const effectiveTimeoutMs = Math.max(1, Math.min(timeoutMs, remaining));
  // Maintenance and other noninteractive work share the same admission as
  // interactive Claude. Never spawn first and validate afterward. Ordinary
  // accounts retain their existing environment and need no proxy helper; the
  // approved entry and isolated settings validator are common to all accounts.
  // Regressions: test/network/claude-optional-privacy.test.js and native fixtures.
  const operationDeadline = Date.now() + effectiveTimeoutMs;
  const detached = platform !== "win32";
  const containedEnv = buildContainedLaunchEnvironment({ preparedLaunch: prepared, env });
  const native = await prepareClaudeNativeInvocationImpl({ preparedLaunch: prepared, args,
    env: egressProfile ? nativeProxyEnvironment(containedEnv) : containedEnv, cwd: resolvedCwd,
    protectedAccount: true, expectedIdentity, requiredHooks, stdoutIsTTY: false });
  let child;
  try {
    const invocation = await prepareSupervisedNativeInvocation({ native, egressProfile, platform, signal,
      deadlineMs: operationDeadline, prepareRoute: prepareClaudeNativeRouteImpl });
    if (signal?.aborted || Date.now() >= operationDeadline) {
      native.disposeBeforeStart(); return Object.freeze({ status: null, signal: null, timedOut: true });
    }
    assignmentLock?.assertOwned();
    child = spawnClaude(invocation, {
      // fd3 is IPC, fd4 is trusted account coordination, fd5 is the private
      // environment. The supervisor maps only fd5 to the native entry's fd3.
      // Neither coordination nor the environment handle reaches vendor code.
      stdio: ["ignore", "pipe", "pipe", "ipc", assignmentLock?.fd ?? "ignore", native.environmentFd],
      env: native.environment, cwd: resolvedCwd, detached, shell: false,
    }, spawnImpl, egressProfile);
    native.markStarted();
  } catch (error) { native.disposeBeforeStart(); throw error; }
  finally { native.closeEnvironment(); }
  if (Number.isInteger(child?.status) || typeof child?.signal === "string") {
    const childSignal = typeof child.signal === "string" ? child.signal : null;
    return Object.freeze({
      status: childSignal ? null : Number.isInteger(child.status) ? child.status : 1,
      signal: childSignal,
      timedOut: false,
      ...nativeExitContext(child.status, childSignal, egressProfile),
    });
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("Claude noninteractive launch did not return a process handle.");
  }

  return await new Promise((resolve, reject) => {
    let settled = false;
    let timedOut = false;
    let overflowed = false;
    let termSent = false;
    let timeoutTimer = null;
    let forcedKillTimer = null;
    let closeResult = null;
    let killEscalated = false;

    const cleanup = () => {
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (forcedKillTimer) clearTimeout(forcedKillTimer);
      signal?.removeEventListener?.("abort", onAbort);
    };
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    const terminate = () => {
      if (termSent || settled) return;
      termSent = true;
      signalNoninteractiveProcessGroup(child, "SIGTERM", { detached, killProcessGroupImpl });
      forcedKillTimer = setTimeout(() => {
        if (settled) return;
        killEscalated = true;
        signalNoninteractiveProcessGroup(child, "SIGKILL", { detached, killProcessGroupImpl });
        if (closeResult) {
          if (overflowed) finish(reject, new Error("Claude noninteractive output exceeded the safe size limit."));
          else finish(resolve, closeResult);
        }
      }, terminationGraceMs);
      // The direct child can close its final referenced handles during TERM
      // grace while descendants still survive. This timer then owns both the
      // remaining group cleanup and promise resolution below. Keep it referenced:
      // unref lets a standalone maintenance/scheduled caller exit before KILL
      // (Node reports an unsettled top-level await), abandoning that cleanup.
    };
    const onAbort = () => terminate();
    const onOverflow = () => {
      if (overflowed) return;
      overflowed = true;
      terminate();
    };

    drainBoundedChildOutput(child.stdout, { maxBytes: maxOutputBytes, onOverflow });
    drainBoundedChildOutput(child.stderr, { maxBytes: maxOutputBytes, onOverflow });
    child.once("error", (error) => finish(reject, nativeSpawnError(error, egressProfile)));
    child.once("close", (code, childSignal) => {
      const normalizedSignal = typeof childSignal === "string" ? childSignal : null;
      closeResult = Object.freeze({
        status: normalizedSignal ? null : Number.isInteger(code) ? code : 1,
        signal: normalizedSignal,
        timedOut,
        ...nativeExitContext(code, normalizedSignal, egressProfile),
      });
      // A direct child can exit on TERM while a descendant in its detached
      // process group ignores it. Keep the grace timer alive and KILL the
      // group before reporting completion.
      if (termSent && detached && forcedKillTimer && !killEscalated) return;
      if (overflowed) {
        finish(reject, new Error("Claude noninteractive output exceeded the safe size limit."));
        return;
      }
      finish(resolve, closeResult);
    });

    timeoutTimer = setTimeout(() => {
      timedOut = true;
      terminate();
    }, Math.max(1, operationDeadline - Date.now()));
    timeoutTimer.unref?.();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
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
  registerProcessControl = null,
  preparedLaunch = null,
  assignmentLock = null,
  egressProfile,
  prepareClaudeNativeRouteImpl = prepareClaudeNativeRoute,
  prepareClaudeNativeInvocationImpl = prepareClaudeNativeInvocation,
  expectedIdentity,
  requiredHooks = {},
  prepareClaudeCliLaunchImpl = prepareClaudeCliLaunch,
  spawnImpl = spawn,
} = {}) {
  // Inspect the original task before user-hooks settings are prepended. Native
  // eager daemon/job verbs depend on argv position; admission after that
  // augmentation can turn a management request into an ordinary model prompt.
  // Final composed admission remains necessary for the augmented invocation.
  assertClaudeLocalInvocation(args);
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

  // Establish the selected route before Claude can execute.
  // Still identify the real Claude binary to the existing-background-owner guard;
  // checking Node alone misses a native daemon that predates enrollment.
  // Preserve IPC/TTY descriptors: routing must not remove pause/resume or tools.
  // Regressions: claude-native-background.test.js and native-pty-fixture.js.
  const containedEnv = buildContainedLaunchEnvironment({ preparedLaunch: prepared, env });
  const native = await prepareClaudeNativeInvocationImpl({ preparedLaunch: prepared, args: buildClaudeArgs(prepared, args),
    env: egressProfile ? nativeProxyEnvironment(containedEnv) : containedEnv, cwd: resolvedCwd,
    protectedAccount: true, expectedIdentity, requiredHooks });
  let child;
  try {
    const invocation = await prepareSupervisedNativeInvocation({ native, egressProfile, signal,
      prepareRoute: prepareClaudeNativeRouteImpl });
    // Redis lease cancellation is independent of the local assignment guard.
    // Doctor/route setup may have yielded after cancellation; never start a
    // vendor just to terminate it immediately afterward.
    if (signal?.aborted) throw signal.reason ?? new Error("Claude launch was cancelled before start.");
    assignmentLock?.assertOwned();
    child = spawnClaude(invocation, {
      stdio: ["inherit", "inherit", "inherit", "ipc", assignmentLock?.fd ?? "ignore", native.environmentFd],
      env: native.environment, cwd: resolvedCwd, shell: false,
    }, spawnImpl, egressProfile);
    native.markStarted();
  } catch (error) { native.disposeBeforeStart(); throw error; }
  finally { native.closeEnvironment(); }
  if (Number.isInteger(child?.status) || typeof child?.signal === "string") {
    const childSignal = typeof child?.signal === "string" ? child.signal : null;
    return {
      status: childSignal ? null : Number.isInteger(child.status) ? child.status : 1,
      signal: childSignal,
      ...nativeExitContext(child.status, childSignal, egressProfile),
    };
  }
  if (!child || typeof child.once !== "function") {
    throw new Error("Claude launch did not return a process handle.");
  }

  let nextControlRequestId = 0;
  const sendProcessControl = (action) => new Promise((resolve) => {
    if (typeof child.send !== "function" || child.connected === false) {
      resolve(false);
      return;
    }
    const requestId = ++nextControlRequestId;
    let settled = false;
    let timer = null;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      child.removeListener?.("message", onMessage);
      child.removeListener?.("close", onClose);
      resolve(ok);
    };
    const onClose = () => finish(false);
    const onMessage = (message) => {
      if (
        message?.type === CLAUDE_PROCESS_CONTROL_ACK_TYPE
        && message.requestId === requestId
        && message.action === action
      ) finish(message.ok === true);
    };
    child.on?.("message", onMessage);
    child.once?.("close", onClose);
    timer = setTimeout(() => finish(false), 2_000);
    timer.unref?.();
    try {
      child.send({ type: CLAUDE_PROCESS_CONTROL_MESSAGE_TYPE, requestId, action }, (error) => {
        if (error) finish(false);
      });
    } catch {
      finish(false);
    }
  });
  registerProcessControl?.({
    pause: () => sendProcessControl("pause"),
    resume: () => sendProcessControl("resume"),
  });

  return await new Promise((resolve, reject) => {
    let settled = false;
    let forcedKillTimer = null;
    const cleanup = () => {
      signal?.removeEventListener?.("abort", onAbort);
      registerProcessControl?.(null);
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
    child.once("error", (error) => finish(reject, nativeSpawnError(error, egressProfile)));
    child.once("close", (code, childSignal) => {
      const normalizedSignal = typeof childSignal === "string" ? childSignal : null;
      finish(resolve, {
        status: normalizedSignal ? null : Number.isInteger(code) ? code : 1,
        signal: normalizedSignal,
        ...nativeExitContext(code, normalizedSignal, egressProfile),
      });
    });
    if (signal?.aborted) onAbort();
    else signal?.addEventListener?.("abort", onAbort, { once: true });
  });
}
