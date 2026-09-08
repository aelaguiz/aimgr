import { spawn } from "node:child_process";
import fs from "node:fs";
import { StringDecoder } from "node:string_decoder";

export function codexRoutineArgs(routine) {
  return [
    "--profile", routine.profile,
    "--model", routine.model,
    "-c", `model_reasoning_effort=${JSON.stringify(routine.thinking)}`,
    "-c", 'model_provider="openai"',
    "-c", 'forced_login_method="chatgpt"',
    "-c", 'cli_auth_credentials_store="file"',
    "--cd", routine.cwd,
  ];
}

// Consume Codex's supported exec JSONL protocol, keeping the full event stream
// on disk and only a single pending line in memory. Success requires both a
// completed turn and a clean process exit; a thread header alone is not success.
export function startCodexRoutineTurn({
  command,
  args,
  cwd,
  env,
  prompt,
  eventsPath,
  stdout,
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
      cwd, env, stdio: ["pipe", "pipe", "pipe"], shell: false,
      detached: process.platform !== "win32",
    });
  } catch (error) {
    fs.closeSync(fd);
    throw error;
  }
  let buffer = "";
  const decoder = new StringDecoder("utf8");
  let sessionId = null;
  let turnStarted = false;
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
      if (error.code !== "ESRCH") stderr?.write?.(`Codex stop failed: ${error.message}\n`);
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
    if (event.type === "thread.started") {
      if (sessionId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(event.thread_id ?? "")) {
        throw new Error("Codex emitted an invalid or repeated thread ID.");
      }
      sessionId = event.thread_id;
    } else if (event.type === "turn.started") {
      if (!sessionId || turnStarted) throw new Error("Codex emitted an unexpected turn start.");
      turnStarted = true;
    } else if (event.type === "turn.completed") {
      if (!turnStarted || completed) throw new Error("Codex emitted an unexpected turn completion.");
      completed = event;
    } else if (event.type === "turn.failed") {
      throw new Error(`Codex turn failed: ${event.error?.message ?? "unknown error"}`);
    }
    if (event.type === "item.completed" && event.item?.type === "agent_message") {
      stdout.write(`${event.item.text}\n`);
    }
    // Error events may describe a recoverable retry. A terminal turn.failed or
    // unsuccessful exit still fails the routine.
    if (event.type === "error") stderr?.write?.(`Codex: ${event.message ?? "error"}\n`);
    onEvent?.(event);
    if (event.type === "turn.started") readyResolve({ sessionId });
  };
  const timeout = setTimeout(() => stop(new Error(`Codex initial turn exceeded ${timeoutMs}ms.`)), timeoutMs);
  const onInterrupt = () => stop(new Error("Codex routine interrupted by SIGINT."));
  const onTerminate = () => stop(new Error("Codex routine interrupted by SIGTERM."));
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const result = new Promise((resolve) => {
    const finish = (code, error = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      clearTimeout(killTimer);
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
      if (!failure && code !== 0) failure = new Error(`Codex exec exited ${code ?? "by signal"}.`);
      if (!failure && !completed) failure = new Error("Codex exited without a completed turn.");
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
        if (buffer.length > 8 * 1024 * 1024) throw new Error("Codex event line exceeded 8 MiB.");
      } catch (error) {
        buffer = "";
        stop(error);
      }
    });
    child.stderr.on("data", (chunk) => stderr?.write?.(chunk));
    child.stdin.on("error", (error) => stop(error));
    child.stdin.end(prompt);
  });
  return { ready, result, stop };
}
