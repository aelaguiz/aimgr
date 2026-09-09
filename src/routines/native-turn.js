import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

// Shared process lifecycle for native CLI JSONL protocols. Keep the full stream
// on disk and only one pending line in memory; completion also needs exit 0.
export function startJsonlRoutineTurn({
  agentName,
  consumeEvent,
  signal: abortSignal,
  command,
  args,
  cwd,
  env,
  stdio = ["pipe", "pipe", "pipe"],
  prompt,
  eventsPath,
  stderr,
  onEvent,
  spawnImpl = spawn,
  timeoutMs = 2 * 60 * 60 * 1_000,
  killGraceMs = 5_000,
}) {
  const fd = fs.openSync(eventsPath, "wx", 0o600);
  let child;
  try {
    child = spawnImpl(command, args, {
      cwd, env, stdio, shell: false,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let sessionId = null;
  let completed = null;
  let failure = null;
  let settled = false;
  let killTimer;
  let readyResolve;
  const ready = new Promise((resolve) => { readyResolve = resolve; });
  const signal = (name) => {
    try {
      if (spawnImpl === spawn && process.platform !== "win32" && child.pid) process.kill(-child.pid, name);
      else child.kill(name);
    } catch (error) {
      if (error.code !== "ESRCH") stderr?.write?.(`${agentName} stop failed: ${error.message}\n`);
    }
  };
  const stop = (error) => {
    if (failure || settled) return;
    failure = error;
    signal("SIGTERM");
    if (!settled) killTimer = setTimeout(() => signal("SIGKILL"), killGraceMs);
  };
  const consume = (line) => {
    if (!line.trim() || failure) return;
    const event = JSON.parse(line);
    const state = consumeEvent(event);
    if (state?.sessionId) sessionId = state.sessionId;
    if (state?.completed) completed = state;
    onEvent?.(event);
    if (state?.ready) readyResolve({ sessionId });
  };
  const timeout = setTimeout(() => stop(new Error(`${agentName} initial turn exceeded ${timeoutMs}ms.`)), timeoutMs);
  const onInterrupt = () => stop(new Error(`${agentName} routine interrupted by SIGINT.`));
  const onTerminate = () => stop(new Error(`${agentName} routine interrupted by SIGTERM.`));
  const onAbort = () => stop(new Error(`${agentName} account lease lost or launch aborted.`));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const result = new Promise((resolve) => {
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
      abortSignal?.removeEventListener("abort", onAbort);
      process.removeListener("SIGINT", onInterrupt);
      process.removeListener("SIGTERM", onTerminate);
      try {
        buffer += decoder.end();
        if (buffer.trim()) consume(buffer);
      } catch (parseError) {
        failure ??= parseError;
      }
      fs.closeSync(fd);
      failure ??= error;
      if (!failure && code !== 0) failure = new Error(`${agentName} exec exited ${code ?? "by signal"}.`);
      if (!failure && !completed) failure = new Error(`${agentName} exited without a completed turn.`);
      readyResolve({ sessionId, error: failure });
      resolve({ sessionId, usage: completed?.usage ?? null, error: failure });
    };
    child.once("error", (error) => finish(1, error));
    child.once("close", (code) => finish(code));
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      try {
        fs.writeSync(fd, chunk);
        buffer += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        let newline;
        while ((newline = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          consume(line);
        }
        if (buffer.length > 8 * 1024 * 1024) throw new Error(`${agentName} event line exceeded 8 MiB.`);
      } catch (error) {
        buffer = "";
        stop(error);
      }
    });
    child.stderr.on("data", (chunk) => stderr?.write?.(chunk));
    child.stdin.on("error", (error) => stop(error));
    if (abortSignal?.aborted) onAbort();
    else {
      abortSignal?.addEventListener("abort", onAbort, { once: true });
      child.stdin.end(prompt);
    }
  });
  return { ready, result, stop };
}
