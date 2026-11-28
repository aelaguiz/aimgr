import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { runAgyAcp } from "./agy-acp.js";
import { admitAgyArtifact } from "./agy-artifacts.js";
import { stageLaunchEnvironment } from "./launch-environment.js";
import { canonicalWorkingPath, workingDirectories } from "./working-directories.js";
import { prepareAgyNativeRoute } from "../network/agy-native-route.js";
import { validateAgyLabel } from "../credentials/agy-local.js";

const valueFlags = new Set([
  "--print", "--model", "--effort", "--mode", "--output-format", "--print-timeout",
]);
const resumeFlags = new Set(["--print"]);
const terminalVariables = ["TERM", "COLORTERM", "LANG", "LC_ALL", "LC_CTYPE", "NO_COLOR"];
const emailAddress = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function printArguments(args, operation) {
  const resume = operation === "resume";
  const allowed = resume ? resumeFlags : valueFlags;
  const nativeArgs = [];
  const seen = new Set();
  for (let index = 0; index < args.length; index++) {
    const argument = args[index];
    const equals = argument.indexOf("=");
    const flag = equals === -1 ? argument : argument.slice(0, equals);
    // In particular, conversation selection, remote agents, and native login
    // switches need their own ownership checks before AIM can pass them through.
    if (!allowed.has(flag) || seen.has(flag)) throw new Error("Unsupported managed Antigravity argument.");
    const value = equals === -1 ? args[++index] : argument.slice(equals + 1);
    if (!value || (equals === -1 && flag !== "--print" && value.startsWith("-"))) {
      throw new Error(`Antigravity ${flag} requires a value.`);
    }
    nativeArgs.push(`${flag}=${value}`);
    seen.add(flag);
  }
  if (!seen.has("--print")) throw new Error("Antigravity requires a prompt through --print.");
  return nativeArgs;
}

function nativeEnvironment(env, home, proxyUrl) {
  const result = Object.fromEntries(terminalVariables.flatMap(key => env[key] === undefined ? [] : [[key, env[key]]]));
  return {
    PATH: "/usr/bin:/bin",
    ...result,
    HOME: home,
    BROWSER: "/usr/bin/true",
    // The native CLI's documented SSH flow prints the URL and reads the code.
    SSH_CONNECTION: "127.0.0.1 49152 127.0.0.1 22",
    AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    ...(proxyUrl ? { HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, ALL_PROXY: proxyUrl, NO_PROXY: "" } : {}),
  };
}

function defaultWorkspace(homeDir, label) {
  validateAgyLabel(label);
  const target = path.join(homeDir, "workspace", "antigravity", label);
  let workspace = homeDir;
  for (const part of ["workspace", "antigravity", label]) {
    workspace = path.join(workspace, part);
    try {
      fs.mkdirSync(workspace, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const stat = fs.lstatSync(workspace);
    if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o022)
        || (workspace === target && (stat.mode & 0o7777) !== 0o700)) {
      throw new Error("Antigravity could not use the private workspace for this connection.");
    }
  }
  return workspace;
}

async function askAccountAddress(question) {
  const terminal = createInterface({ input: process.stdin, output: process.stderr });
  terminal.on("SIGINT", () => terminal.close());
  try {
    process.stderr.write(question);
    for await (const line of terminal) return line.trim().toLowerCase();
    return "";
  } finally {
    terminal.close();
  }
}

function childExitCode(child) {
  return new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (exitCode, signal) => resolve(exitCode ?? (128 + (os.constants.signals[signal] ?? 0))));
  });
}

function signalManagedProcess(child, signal) {
  const pid = child.pid;
  if (Number.isInteger(pid) && pid > 1) {
    try {
      process.kill(-pid, signal);
      return;
    } catch (error) {
      if (error.code === "ESRCH" || child.exitCode !== null || child.signalCode !== null) return;
    }
  }
  child.kill(signal);
}

async function readStatusReport(child, signalChild) {
  const chunks = [];
  let length = 0;
  let interrupted = false;
  function stop() {
    if (interrupted) return;
    interrupted = true;
    signalChild("SIGKILL");
  }
  child.stdout.on("data", (chunk) => {
    if (interrupted) return;
    length += chunk.length;
    if (length > 64 * 1024) stop();
    else chunks.push(chunk);
  });
  child.stdout.on("error", stop);
  const timer = setTimeout(stop, 20_000);
  try {
    const exitCode = await childExitCode(child);
    return interrupted ? { exitCode: 1 } : { exitCode, statusReport: Buffer.concat(chunks).toString("utf8") };
  } finally {
    clearTimeout(timer);
  }
}

/** The admitted launcher enforces the privacy policy and starts native agy.
 * Sign-in inherits the terminal. ACP keeps its protocol on separate pipes. */
export async function runAgyNative({ operation, label, accountHome, cwd, homeDir, config, profileRef, env, args, sessionId, stdout, stderr }, {
  platform = process.platform,
  arch = process.arch,
  isInteractive = process.stdin.isTTY && process.stderr.isTTY,
  admitArtifact = admitAgyArtifact,
  spawnImpl = spawn,
  askAddress = askAccountAddress,
  resolveWorkingDirectories = workingDirectories,
  prepareRoute = prepareAgyNativeRoute,
  runAcp = runAgyAcp,
} = {}) {
  const login = operation === "login";
  const logout = operation === "logout";
  const interactive = operation === "run" && !args?.length;
  const acp = interactive || operation === "resume" || logout;
  const status = operation === "usage" || operation === "credits";
  const managed = acp || status;
  const privateWorkspace = status || login || logout;
  if (!login && !acp && !status && operation !== "run") throw new Error("Unsupported Antigravity operation.");
  if (status && args?.length) throw new Error("Antigravity quota checks take no native launch arguments.");
  if (interactive && !isInteractive) throw new Error("Antigravity chat requires an interactive terminal. Use `-- --print <prompt>` for headless runs.");
  const printArgs = (operation === "run" && !interactive) || operation === "resume" ? printArguments(args, operation) : [];
  const nativeArgs = operation === "run" ? printArgs : [];
  const artifact = admitArtifact({ platform, arch });
  if (login && !isInteractive) throw new Error("Antigravity manual sign-in requires an interactive terminal.");
  const account = login
    ? await askAddress(`Google address for connection ${label}: `)
    : undefined;
  if (login && !emailAddress.test(account)) throw new Error("Antigravity requires a Google account address.");

  const home = fs.realpathSync(accountHome);
  let workspace;
  if (!privateWorkspace) {
    workspace = fs.realpathSync(cwd);
    const callerHome = fs.realpathSync(homeDir ?? os.homedir());
    if (workspace === callerHome) workspace = defaultWorkspace(callerHome, label);
  }
  const roots = privateWorkspace ? [] : [...new Set(resolveWorkingDirectories({ homeDir, env, platform, accountRoot: home, config,
    configKey: "agyWorkingDirectories" }).map(canonicalWorkingPath))];
  const scratch = fs.mkdtempSync(path.join(fs.realpathSync("/tmp"), "aim-agy-"));
  workspace ??= scratch;
  // The launcher's "resume" entry starts the fixed ACP server. The client
  // chooses whether to create or resume a session through that server.
  const launcherOperation = interactive ? "resume" : operation;
  let envFd;
  try {
    const launcherArgs = ["v1", launcherOperation, home, workspace, scratch, "3", String(roots.length), ...roots, "--", ...nativeArgs];
    const route = await prepareRoute({ config, label, profileRef, artifact, args: launcherArgs, platform });
    envFd = stageLaunchEnvironment(nativeEnvironment(env, home, route.proxyUrl), scratch);
    if (login) {
      const finish = platform === "darwin"
        ? "Wait for agy to finish signing in."
        : "Decline optional data collection if prompted and exit after you see your signed-in account.";
      stderr.write(`Open the URL from agy in the existing BrowserOS profile for ${label}. Paste Google's code into agy. ${finish}\n`);
    }
    const child = spawnImpl(route.command, route.args, {
      cwd: workspace,
      env: { PATH: "/usr/bin:/bin" },
      // Only stdio protocols own a group. Real terminal launches receive
      // foreground signals with AIM, including Ctrl+C during login.
      detached: managed,
      stdio: [...(status ? ["ignore", "pipe", "ignore"] : acp ? ["pipe", "pipe", "pipe"] : ["inherit", "inherit", "inherit"]), envFd],
    });
    fs.closeSync(envFd);
    envFd = undefined;
    if (managed) {
      const signalChild = signal => signalManagedProcess(child, signal);
      if (!acp) return await readStatusReport(child, signalChild);
      let interrupted = false;
      // Before readline takes over the terminal, Ctrl+C still arrives as a
      // signal to AIM. The detached server needs an explicit shutdown then.
      const interrupt = () => {
        interrupted = true;
        signalChild("SIGKILL");
      };
      if (interactive) process.on("SIGINT", interrupt);
      try {
        const result = await runAcp(child, { operation: interactive ? "interactive" : operation, label, sessionId, cwd: workspace,
          args: printArgs, stdout, stderr, signalChild });
        return interrupted ? { exitCode: 130 } : result;
      } finally {
        if (interactive) process.removeListener("SIGINT", interrupt);
      }
    }
    const exitCode = await childExitCode(child);
    if (!login || exitCode !== 0) return { exitCode };
    const observed = await askAddress("Google address shown by Antigravity: ");
    return observed === account ? { exitCode, account } : { exitCode };
  } finally {
    if (envFd !== undefined) fs.closeSync(envFd);
    if (platform === "darwin" || privateWorkspace) fs.rmSync(scratch, { recursive: true, force: true });
    else fs.rmdirSync(scratch);
  }
}
