import { startJsonlRoutineTurn } from "./native-turn.js";

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

export function startCodexRoutineTurn(options) {
  let sessionId = null;
  let turnStarted = false;
  let completed = false;
  return startJsonlRoutineTurn({
    ...options,
    agentName: "Codex",
    consumeEvent(event) {
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
        completed = true;
      } else if (event.type === "turn.failed") {
        throw new Error(`Codex turn failed: ${event.error?.message ?? "unknown error"}`);
      }
      if (event.type === "item.completed" && event.item?.type === "agent_message") {
        options.stdout.write(`${event.item.text}\n`);
      }
      if (event.type === "error") options.stderr?.write?.(`Codex: ${event.message ?? "error"}\n`);
      return { sessionId, ready: event.type === "turn.started", completed: event.type === "turn.completed", usage: event.usage };
    },
  });
}
