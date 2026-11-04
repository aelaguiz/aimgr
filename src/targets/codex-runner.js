import { spawn } from "node:child_process";
import { prepareCodexNativeInvocation } from "../privacy/codex-native-invocation.js";
import { codexArguments } from "../privacy/codex-arguments.js";
import { superviseCodexAppServerStdio } from "../io/codex-app-server-stdio.js";

export async function runCodexInteractive({
  homeDir,
  cwd = process.cwd(),
  env = process.env,
  args = [],
  prepared,
  spawnImpl = spawn,
  prepareInvocation = prepareCodexNativeInvocation,
  stdin = process.stdin,
  stdout = process.stdout,
} = {}) {
  if (!Array.isArray(args) || !args.every((arg) => typeof arg === "string")) {
    throw new Error("Codex launch arguments must be strings.");
  }
  const ownedAppServer = codexArguments(args, { cwd, ownedAppServer: true }).command === "app-server";
  const onError = error => process.stderr.write(`[aim] Codex settings reload failed: ${error.message}\n`);
  const invocation = await prepareInvocation({ prepared, homeDir, cwd, env, args, ownedAppServer,
    onWarning: warning => process.stderr.write(`[aim] Codex settings conflict in ${warning.source}; preserved alternative: ${warning.recovery}\n`),
    onError,
  });
  let child;
  try {
    child = spawnImpl(invocation.command, invocation.args, {
      cwd: invocation.cwd, env: invocation.env,
      stdio: ownedAppServer ? ["pipe", "pipe", "inherit", invocation.environmentFd] : ["inherit", "inherit", "inherit", invocation.environmentFd], shell: false,
    });
  } catch (error) { await invocation.close(); throw error; }
  finally { invocation.closeEnvironment(); }
  if (child?.error) { await invocation.close(); throw child.error; }
  if (!child || typeof child.once !== "function") {
    await invocation.close();
    throw new Error("Codex launch did not return a process handle.");
  }
  const transport = ownedAppServer ? superviseCodexAppServerStdio({ input: stdin, output: stdout, child,
    entry: invocation.entries.at(-1), flush: invocation.flushSettings, onError }) : null;
  try { return await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({
      code: Number.isInteger(code) ? code : 1,
      signal: signal ?? null,
    }));
  }); } finally {
    try { await transport?.finished; }
    finally { try { await transport?.close(); } finally { await invocation.close(); } }
  }
}
