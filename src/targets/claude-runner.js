import { createHash } from "node:crypto";
import fs from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const SUPERVISOR_PATH = fileURLToPath(new URL("./claude-supervisor.js", import.meta.url));
const SECURITY_SHIM_SOURCE_PATH = fileURLToPath(
  new URL("../../native/claude/security_shim.c", import.meta.url),
);
const NO_KEYCHAIN_PROFILE_PATH = fileURLToPath(
  new URL("../../native/claude/no-keychain.sb", import.meta.url),
);
const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";
const CODESIGN_PATH = "/usr/bin/codesign";
const CLANG_PATH = "/usr/bin/clang";
const SUPPORTED_CLAUDE = Object.freeze({
  version: "2.1.218",
  sha256: "71abaff59312c9a9b6a1d818365048b42e4e95cc521a823660eded3e0880d9b7",
  identifier: "com.anthropic.claude-code",
  teamIdentifier: "Q6L2SF6YDW",
});
const AUTH_ENV_KEYS = Object.freeze([
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_CUSTOM_HEADERS",
  "CLAUDE_CODE_OAUTH_CLIENT_ID",
  "CLAUDE_CODE_OAUTH_REFRESH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN",
  "CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR",
  "CLAUDE_CODE_USE_BEDROCK",
  "CLAUDE_CODE_USE_FOUNDRY",
  "CLAUDE_CODE_USE_VERTEX",
  "CLAUDE_CONFIG_DIR",
  "CLAUDE_SECURESTORAGE_CONFIG_DIR",
  "DYLD_FRAMEWORK_PATH",
  "DYLD_INSERT_LIBRARIES",
  "DYLD_LIBRARY_PATH",
]);
const SHIM_SEMANTIC_CASES = Object.freeze([
  {
    args: ["find-generic-password", "-a", "aim-test-user", "-w", "-s", "aim-test-service"],
    status: 44,
  },
  { args: ["show-keychain-info"], status: 36 },
  { args: ["-i"], input: "aim-test-input\n", status: 1 },
  {
    args: ["add-generic-password", "-U", "-a", "aim-test-user", "-s", "aim-test-service", "-X", "00"],
    status: 1,
  },
  {
    args: ["delete-generic-password", "-a", "aim-test-user", "-s", "aim-test-service"],
    status: 44,
  },
  { args: ["verify-cert", "-c", "aim-test-certificate"], status: 65 },
  { args: ["unknown-operation"], status: 64 },
]);

function normalizedAbsolute(value) {
  const raw = typeof value === "string" ? value.trim() : "";
  return raw && path.isAbsolute(raw) ? path.resolve(raw).normalize("NFC") : null;
}

function assertOwnedDirectory(filePath, { fsImpl = fs, requirePrivate = false } = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch {
    throw new Error("Could not inspect the managed Claude runtime directory.");
  }
  if (
    !stat.isDirectory()
    || stat.isSymbolicLink()
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
    || (requirePrivate && Number.isInteger(stat.mode) && (stat.mode & 0o077) !== 0)
  ) {
    throw new Error("Refusing an unsafe managed Claude runtime directory.");
  }
}

function ensureOwnedDirectory(filePath, {
  fsImpl = fs,
  mode = 0o700,
  requirePrivate = true,
} = {}) {
  try {
    fsImpl.mkdirSync(filePath, { mode });
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw new Error("Could not create the managed Claude runtime directory.");
    }
  }
  assertOwnedDirectory(filePath, { fsImpl, requirePrivate: false });
  if (requirePrivate) {
    fsImpl.chmodSync(filePath, mode);
  }
  assertOwnedDirectory(filePath, { fsImpl, requirePrivate });
}

function assertOwnedExecutable(filePath, { fsImpl = fs } = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(filePath);
  } catch {
    throw new Error("Could not inspect the managed Claude compatibility executable.");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
    || (stat.mode & 0o777) !== 0o500
  ) {
    throw new Error("Refusing an unsafe managed Claude compatibility executable.");
  }
}

function hashBuffer(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(filePath, { fsImpl = fs } = {}) {
  return await new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = fsImpl.createReadStream(filePath);
    stream.once("error", reject);
    stream.on("data", (chunk) => hash.update(chunk));
    stream.once("end", () => resolve(hash.digest("hex")));
  });
}

function validateSecurityShimSemantics(shimPath, { spawnSyncImpl = spawnSync } = {}) {
  for (const testCase of SHIM_SEMANTIC_CASES) {
    const result = spawnSyncImpl(shimPath, testCase.args, {
      encoding: "utf8",
      input: testCase.input,
      shell: false,
      timeout: 5_000,
      maxBuffer: 4_096,
      env: {
        LANG: "C",
        LC_ALL: "C",
        PATH: "/usr/bin:/bin",
      },
    });
    if (
      result?.status !== testCase.status
      || result?.signal
      || String(result?.stdout ?? "") !== ""
      || String(result?.stderr ?? "") !== ""
    ) {
      throw new Error("Managed Claude compatibility executable failed its fixed semantic check.");
    }
  }
}

export function materializeClaudeSecurityShim({
  homeDir,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  const resolvedHome = normalizedAbsolute(homeDir);
  if (!resolvedHome) {
    throw new Error("Managed Claude compatibility setup requires an absolute home directory.");
  }
  assertOwnedDirectory(resolvedHome, { fsImpl });
  const source = fsImpl.readFileSync(SECURITY_SHIM_SOURCE_PATH);
  const sourceSha = hashBuffer(source);
  const aimgrRoot = path.join(resolvedHome, ".aimgr");
  const runtimeDir = path.join(aimgrRoot, "runtime");
  const runtimeRoot = path.join(runtimeDir, "claude-file-store");
  ensureOwnedDirectory(aimgrRoot, { fsImpl, requirePrivate: false });
  ensureOwnedDirectory(runtimeDir, { fsImpl });
  ensureOwnedDirectory(runtimeRoot, { fsImpl });
  const targetDir = path.join(runtimeRoot, sourceSha);
  const shimPath = path.join(targetDir, "security");

  if (!fsImpl.existsSync(targetDir)) {
    const buildDir = fsImpl.mkdtempSync(path.join(runtimeRoot, ".build-"));
    let installed = false;
    try {
      fsImpl.chmodSync(buildDir, 0o700);
      const buildPath = path.join(buildDir, "security");
      const compiled = spawnSyncImpl(CLANG_PATH, [
        "-std=c11",
        "-O2",
        "-Wall",
        "-Wextra",
        "-Werror",
        SECURITY_SHIM_SOURCE_PATH,
        "-o",
        buildPath,
      ], {
        encoding: "utf8",
        shell: false,
        timeout: 30_000,
        maxBuffer: 64 * 1024,
        env: {
          LANG: "C",
          LC_ALL: "C",
          PATH: "/usr/bin:/bin",
        },
      });
      if (compiled?.status !== 0 || compiled?.signal) {
        throw new Error("Could not compile the managed Claude compatibility executable.");
      }
      fsImpl.chmodSync(buildPath, 0o500);
      assertOwnedExecutable(buildPath, { fsImpl });
      validateSecurityShimSemantics(buildPath, { spawnSyncImpl });
      try {
        fsImpl.renameSync(buildDir, targetDir);
        installed = true;
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
      }
    } finally {
      if (!installed && fsImpl.existsSync(buildDir)) {
        fsImpl.rmSync(buildDir, { recursive: true, force: true });
      }
    }
  }

  assertOwnedDirectory(targetDir, { fsImpl, requirePrivate: true });
  assertOwnedExecutable(shimPath, { fsImpl });
  validateSecurityShimSemantics(shimPath, { spawnSyncImpl });
  return Object.freeze({
    sourceSha256: sourceSha,
    runtimeRoot,
    adapterDir: targetDir,
    shimPath,
  });
}

function verifyCodeSignature(command, { spawnSyncImpl = spawnSync } = {}) {
  const verified = spawnSyncImpl(CODESIGN_PATH, ["--verify", "--strict", command], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
  });
  if (verified?.status !== 0 || verified?.signal) {
    throw new Error("Installed Claude signature verification failed.");
  }
  const details = spawnSyncImpl(CODESIGN_PATH, ["-dv", "--verbose=4", command], {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
  });
  const output = `${details?.stdout ?? ""}\n${details?.stderr ?? ""}`;
  if (
    details?.status !== 0
    || details?.signal
    || !output.includes(`Identifier=${SUPPORTED_CLAUDE.identifier}`)
    || !output.includes(`TeamIdentifier=${SUPPORTED_CLAUDE.teamIdentifier}`)
    || !output.includes(`Anthropic PBC (${SUPPORTED_CLAUDE.teamIdentifier})`)
  ) {
    throw new Error("Installed Claude signing identity is not the qualified Anthropic identity.");
  }
}

export function verifySandboxExecutable({
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  let stat;
  try {
    stat = fsImpl.lstatSync(SANDBOX_EXEC_PATH);
    fsImpl.accessSync(SANDBOX_EXEC_PATH, fs.constants.X_OK);
  } catch {
    throw new Error("Could not inspect the local macOS sandbox boundary.");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.uid !== 0
    || stat.gid !== 0
    || (stat.mode & 0o022) !== 0
  ) {
    throw new Error("Refusing an unsafe local macOS sandbox boundary.");
  }
  const options = {
    encoding: "utf8",
    shell: false,
    timeout: 10_000,
    maxBuffer: 64 * 1024,
    env: {
      LANG: "C",
      LC_ALL: "C",
      PATH: "/usr/bin:/bin",
    },
  };
  const verified = spawnSyncImpl(
    CODESIGN_PATH,
    ["--verify", "--strict", "--verbose=2", SANDBOX_EXEC_PATH],
    options,
  );
  if (verified?.status !== 0 || verified?.signal) {
    throw new Error("The local macOS sandbox signature verification failed.");
  }
  const details = spawnSyncImpl(
    CODESIGN_PATH,
    ["-d", "-r-", SANDBOX_EXEC_PATH],
    options,
  );
  const output = `${details?.stdout ?? ""}\n${details?.stderr ?? ""}`;
  // Apple ships a distinct sandbox-exec binary with each macOS build. Its
  // signed designated requirement is the stable authority boundary; a release
  // hash would reject valid security updates while adding no stronger signer
  // guarantee.
  if (
    details?.status !== 0
    || details?.signal
    || !output.includes(`Executable=${SANDBOX_EXEC_PATH}`)
    || !output.includes('designated => identifier "com.apple.sandbox-exec" and anchor apple')
  ) {
    throw new Error("The local macOS sandbox boundary is not the qualified Apple system binary.");
  }
  return SANDBOX_EXEC_PATH;
}

export async function verifyInstalledClaudeExecutable({
  command,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("Managed Claude supports only the qualified native Darwin arm64 tuple.");
  }
  const rawCommand = normalizedAbsolute(command);
  if (!rawCommand) {
    throw new Error("Managed Claude requires an absolute installed Claude executable.");
  }
  let resolvedCommand;
  let stat;
  try {
    resolvedCommand = fsImpl.realpathSync(rawCommand);
    stat = fsImpl.lstatSync(resolvedCommand);
  } catch {
    throw new Error("Could not inspect the installed Claude executable.");
  }
  if (
    !stat.isFile()
    || stat.isSymbolicLink()
    || stat.nlink !== 1
    || (typeof process.getuid === "function" && Number.isInteger(stat.uid) && stat.uid !== process.getuid())
  ) {
    throw new Error("Refusing an unsafe installed Claude executable.");
  }
  fsImpl.accessSync(resolvedCommand, fs.constants.X_OK);
  if (path.basename(resolvedCommand) !== SUPPORTED_CLAUDE.version) {
    throw new Error(`Installed Claude version is not the qualified ${SUPPORTED_CLAUDE.version} build.`);
  }
  if (await hashFile(resolvedCommand, { fsImpl }) !== SUPPORTED_CLAUDE.sha256) {
    throw new Error("Installed Claude digest is not the qualified native build.");
  }
  verifyCodeSignature(resolvedCommand, { spawnSyncImpl });
  return resolvedCommand;
}

function dataVolumeAlias(filePath) {
  return filePath.startsWith("/Users/") ? `/System/Volumes/Data${filePath}` : filePath;
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
  };
}

export async function prepareClaudeCliLaunch({
  command,
  userHomeDir,
  homeDir,
  configDir,
  fsImpl = fs,
  spawnSyncImpl = spawnSync,
  verifyInstalledClaudeExecutableImpl = verifyInstalledClaudeExecutable,
  materializeClaudeSecurityShimImpl = materializeClaudeSecurityShim,
  verifySandboxExecutableImpl = verifySandboxExecutable,
} = {}) {
  const resolvedUserHome = normalizedAbsolute(userHomeDir);
  const resolvedLaunchHome = normalizedAbsolute(homeDir);
  const resolvedConfigDir = normalizedAbsolute(configDir);
  if (!resolvedUserHome || !resolvedLaunchHome || !resolvedConfigDir) {
    throw new Error("Managed Claude preflight requires absolute user, label, and config directories.");
  }
  const topology = assertContainedLaunchTopology({
    userHomeDir: resolvedUserHome,
    launchHome: resolvedLaunchHome,
    configDir: resolvedConfigDir,
  });
  const resolvedCommand = await verifyInstalledClaudeExecutableImpl({
    command,
    fsImpl,
    spawnSyncImpl,
  });
  const adapter = materializeClaudeSecurityShimImpl({
    homeDir: resolvedUserHome,
    fsImpl,
    spawnSyncImpl,
  });
  const sandboxExecPath = verifySandboxExecutableImpl({ fsImpl, spawnSyncImpl });
  fsImpl.accessSync(NO_KEYCHAIN_PROFILE_PATH, fs.constants.R_OK);
  return Object.freeze({
    command: resolvedCommand,
    userHomeDir: resolvedUserHome,
    homeDir: resolvedLaunchHome,
    configDir: resolvedConfigDir,
    profilePath: NO_KEYCHAIN_PROFILE_PATH,
    sandboxExecPath,
    ...topology,
    ...adapter,
  });
}

function buildContainedLaunchEnvironment({ preparedLaunch, env }) {
  const launchEnv = { ...(env ?? {}) };
  for (const key of AUTH_ENV_KEYS) delete launchEnv[key];
  launchEnv.HOME = preparedLaunch.homeDir;
  launchEnv.CLAUDE_CONFIG_DIR = preparedLaunch.configDir;
  launchEnv.CLAUDE_SECURESTORAGE_CONFIG_DIR = preparedLaunch.configDir;
  launchEnv.PATH = `${preparedLaunch.adapterDir}:${String(env?.PATH ?? "/usr/bin:/bin")}`;
  launchEnv.DISABLE_AUTOUPDATER = "1";
  launchEnv.DISABLE_UPDATES = "1";
  return launchEnv;
}

function buildSandboxArgs(preparedLaunch, args) {
  return [
    "-D", `USER_HOME=${preparedLaunch.userHomeDir}`,
    "-D", `USER_HOME_ALIAS=${dataVolumeAlias(preparedLaunch.userHomeDir)}`,
    "-D", `LAUNCH_HOME=${preparedLaunch.homeDir}`,
    "-D", `LAUNCH_HOME_ALIAS=${dataVolumeAlias(preparedLaunch.homeDir)}`,
    "-D", `AIMGR_ROOT=${preparedLaunch.aimgrRoot}`,
    "-D", `SELECTED_LABEL_HOME=${preparedLaunch.selectedLabelHome}`,
    "-D", `ADAPTER_RUNTIME_ROOT=${preparedLaunch.runtimeRoot}`,
    "-f", preparedLaunch.profilePath,
    preparedLaunch.command,
    ...(Array.isArray(args) ? args : []),
  ];
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
    || !normalizedAbsolute(prepared.homeDir)
    || !normalizedAbsolute(prepared.configDir)
    || !normalizedAbsolute(prepared.profilePath)
    || !normalizedAbsolute(prepared.sandboxExecPath)
    || !normalizedAbsolute(prepared.adapterDir)
  ) {
    throw new Error("Claude launch requires a completed no-Keychain preflight.");
  }
  const launchEnv = buildContainedLaunchEnvironment({ preparedLaunch: prepared, env });
  const child = spawnImpl(process.execPath, [
    SUPERVISOR_PATH,
    prepared.sandboxExecPath,
    ...buildSandboxArgs(prepared, args),
  ], {
    stdio: ["inherit", "inherit", "inherit", "ipc"],
    env: launchEnv,
    cwd: resolvedCwd,
  });
  if (child?.error) {
    throw child.error;
  }
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
    if (signal?.aborted) {
      onAbort();
    } else {
      signal?.addEventListener?.("abort", onAbort, { once: true });
    }
  });
}
