import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import {
  loginClaudeFigmaGrant,
  maintainClaudeFigmaGrant,
  normalizeFigmaEmail,
  verifyClaudeFigmaIdentity,
} from "../../credentials/claude-figma.js";
import { readClaudeFigmaGrant } from "../../credentials/claude-figma-store.js";

const run = promisify(execFile);
const installer = new URL("../../../scripts/install-claude-figma-maintainer.py", import.meta.url);
const releaseMarker = new URL("../../../.aimgr-release", import.meta.url);
const usage = "Usage: aim claude figma login --email <work-email> [--port <local-callback-port>] | status [--json] [--fresh] | maintain [--json] [--fresh] | install-maintainer [--json]";

async function installMaintainer({ homeDir, env }, { onLogin = false } = {}) {
  if (!fs.existsSync(releaseMarker)) {
    if (onLogin) return;
    throw new Error("Run `aim claude figma install-maintainer` from the installed AI Manager release.");
  }
  const accountHome = os.userInfo().homedir;
  if (fs.realpathSync(homeDir) !== fs.realpathSync(accountHome)) {
    if (onLogin) return;
    throw new Error("The Figma maintainer must be installed from the current user's home.");
  }
  const wrapper = path.resolve(env.XDG_BIN_HOME || path.join(homeDir, ".local", "bin"), "aim");
  const configHome = env.XDG_CONFIG_HOME;
  const runtimeDir = process.platform === "linux" ? `/run/user/${process.getuid()}` : null;
  try {
    await run("/usr/bin/python3", ["-I", fileURLToPath(installer), wrapper], {
      env: { HOME: accountHome, PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
        ...(path.isAbsolute(configHome ?? "") ? { XDG_CONFIG_HOME: configHome } : {}),
        ...(runtimeDir ? { XDG_RUNTIME_DIR: runtimeDir } : {}) },
      timeout: 20_000,
    });
  } catch {
    throw new Error(onLogin
      ? "Figma sign-in is saved. Automatic renewal setup failed. Run `aim claude figma install-maintainer` to retry."
      : "Automatic Figma renewal could not be set up on this machine.");
  }
}

async function figmaStatus(context) {
  let grant;
  try {
    grant = readClaudeFigmaGrant({ homeDir: context.homeDir });
  } catch {
    return { status: "unavailable" };
  }
  if (!grant) return { status: "not_enrolled" };
  const metadata = { email: grant.email, expiresAt: new Date(grant.expiresAt).toISOString() };
  if (grant.expiresAt <= Date.now()) return { status: "expired", ...metadata };
  if (!context.opts.fresh) return { status: "signed_in", ...metadata };
  try {
    await verifyClaudeFigmaIdentity(grant, context);
    return { status: "signed_in", ...metadata, verified: true };
  } catch {
    return { status: "unavailable", ...metadata, verified: false };
  }
}

const statusMessages = {
  not_enrolled: "Figma MCP needs sign-in on this machine.",
  unavailable: "Figma MCP sign-in could not be verified on this machine.",
};

export async function handleClaudeFigma(context) {
  const { positional, opts, stdout, setExitCode } = context;
  const subcommand = positional[2];
  if (positional.length !== 3 || opts.afterDoubleDash?.length || !["login", "status", "maintain", "install-maintainer"].includes(subcommand)) {
    throw new Error(usage);
  }
  if (subcommand !== "login" && (opts.claudeLoginEmail || opts.port !== undefined)) throw new Error(usage);
  if (subcommand === "login") {
    if (opts.json || opts.fresh) throw new Error(usage);
    const email = normalizeFigmaEmail(opts.claudeLoginEmail);
    if (!email) throw new Error("Use `aim claude figma login --email <work-email>` to verify the Figma account.");
    const callbackPort = opts.port === undefined ? undefined : Number(opts.port);
    if (callbackPort !== undefined && (!Number.isInteger(callbackPort) || callbackPort < 1 || callbackPort > 65_535)) {
      throw new Error("--port requires a TCP port between 1 and 65535.");
    }
    stdout.write("Open the authorization URL in BrowserOS Work.\n");
    await loginClaudeFigmaGrant(context, { email, callbackPort });
    await installMaintainer(context, { onLogin: true });
    stdout.write(`Figma MCP is signed in as ${email} on this machine.\n`);
    return;
  }
  const emit = (result, message) => {
    if (opts.json) stdout.write(`${JSON.stringify(result)}\n`);
    else if (message) stdout.write(`${message}\n`);
  };
  if (subcommand === "install-maintainer") {
    if (opts.fresh) throw new Error(usage);
    await installMaintainer(context);
    emit({ status: "installed" }, "Automatic Figma renewal is scheduled on this machine.");
    return;
  }
  if (subcommand === "maintain") {
    const result = await maintainClaudeFigmaGrant(context, { force: opts.fresh === true });
    const messages = {
      refreshed: "Figma MCP sign-in renewed on this machine.",
      retryable: "Figma MCP sign-in could not be renewed on this machine.",
    };
    emit(result, messages[result.outcome]);
    if (result.outcome === "retryable") setExitCode(1);
    return;
  }
  const result = await figmaStatus(context);
  const message = result.status === "signed_in"
    ? `Figma MCP is signed in as ${result.email} on this machine. Access expires at ${result.expiresAt}.`
    : result.status === "expired"
      ? `Figma MCP access for ${result.email} expired at ${result.expiresAt}.`
      : statusMessages[result.status];
  emit(result, message);
  if (result.status === "unavailable" || (opts.fresh && !result.verified)) setExitCode(1);
}
