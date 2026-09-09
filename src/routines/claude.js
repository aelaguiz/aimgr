import { buildSupervisorArgs, buildContainedLaunchEnvironment } from "../targets/claude-runner.js";
import { startJsonlRoutineTurn } from "./native-turn.js";

export function claudeRoutineArgs(routine) {
  return ["--model", routine.model, "--effort", routine.thinking, "--dangerously-skip-permissions"];
}

export async function runClaudeRoutineSession(context, options) {
  const [{ loadCommandDefaultDeps }, { runAutomaticClaudeSession }] = await Promise.all([
    import("../cli/deps.js"),
    import("../cli/commands/claude.js"),
  ]);
  return runAutomaticClaudeSession({ ...await loadCommandDefaultDeps("claude"), ...context }, options);
}

export function startClaudeRoutineTurn({ launch, routine, sessionId, prompt, ...options }) {
  let initialized = false;
  let acknowledged = false;
  let completed = false;
  return startJsonlRoutineTurn({
    ...options,
    agentName: "Claude",
    // Keep the managed launcher's parent-liveness supervisor: losing AIM's
    // IPC connection must also stop the Claude process holding its account.
    command: process.execPath,
    stdio: ["pipe", "pipe", "pipe", "ipc"],
    args: buildSupervisorArgs(launch.preparedLaunch, [
      ...claudeRoutineArgs(routine),
      "--print", "--verbose", "--input-format", "stream-json", "--output-format", "stream-json",
      "--replay-user-messages", "--session-id", sessionId,
    ]),
    cwd: routine.cwd,
    env: buildContainedLaunchEnvironment({ preparedLaunch: launch.preparedLaunch, env: launch.env }),
    signal: launch.signal,
    prompt: `${JSON.stringify({ type: "user", session_id: sessionId, message: { role: "user", content: prompt }, parent_tool_use_id: null })}\n`,
    consumeEvent(event) {
      const init = event.type === "system" && event.subtype === "init";
      const replay = event.type === "user" && event.isReplay === true && !event.parent_tool_use_id;
      const result = event.type === "result";
      if ((init || replay || result) && event.session_id !== sessionId) {
        throw new Error("Claude emitted an unexpected session ID.");
      }
      if (init) {
        if (initialized) throw new Error("Claude emitted a repeated session initialization.");
        initialized = true;
      } else if (replay) {
        const content = event.message?.content;
        const text = typeof content === "string" ? content : Array.isArray(content)
          ? content.filter((block) => block.type === "text").map((block) => block.text).join("\n") : null;
        if (acknowledged || text !== prompt) throw new Error("Claude acknowledged a different or repeated routine prompt.");
        acknowledged = true;
      } else if (result) {
        if (!initialized || completed) throw new Error("Claude emitted an unexpected turn completion.");
        if (event.subtype !== "success" || event.is_error !== false) {
          throw new Error(`Claude turn failed: ${event.errors?.join("; ") || event.result || event.subtype || "unknown error"}`);
        }
        if (!acknowledged) throw new Error("Claude completed without acknowledging the routine prompt.");
        completed = true;
        if (event.result) options.stdout?.write?.(`${event.result}\n`);
      }
      return { sessionId: initialized ? sessionId : null, ready: init, completed: result, usage: event.usage };
    },
  });
}
