import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseClaudeRoutineJobStatus } from "./claude.js";

const TRANSCRIPT_TAIL_BYTES = 512 * 1024;

// Older Claude builds omit last_assistant_message from Stop input; read the
// final main-thread assistant text from the transcript tail instead.
function readLastAssistantText(transcriptPath) {
  if (typeof transcriptPath !== "string" || !transcriptPath) return null;
  let fd;
  try {
    fd = fs.openSync(transcriptPath, "r");
    const { size } = fs.fstatSync(fd);
    const length = Math.min(size, TRANSCRIPT_TAIL_BYTES);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, size - length);
    const lines = buffer.toString("utf8").split("\n");
    for (let index = lines.length - 1; index >= 0; index -= 1) {
      let entry;
      try { entry = JSON.parse(lines[index]); } catch { continue; }
      if (entry?.type !== "assistant" || entry.isSidechain) continue;
      const content = entry.message?.content;
      const text = Array.isArray(content)
        ? content.filter((block) => block?.type === "text").map((block) => block.text).join("\n")
        : typeof content === "string" ? content : "";
      if (text.trim()) return text;
    }
    return null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function countOrNull(value) {
  return Array.isArray(value) ? value.length : null;
}

export function recordClaudeRoutineHook({ input, eventsPath, sessionId }) {
  const event = JSON.parse(input);
  if (event.session_id !== sessionId || !["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"].includes(event.hook_event_name)) return;
  const turnEnded = ["Stop", "StopFailure"].includes(event.hook_event_name);
  const record = {
    type: event.hook_event_name,
    sessionId,
    at: new Date().toISOString(),
    transcriptPath: event.transcript_path,
    ...(event.model ? { model: event.model } : {}),
    ...(typeof event.prompt === "string" ? {
      promptSha256: createHash("sha256").update(event.prompt).digest("hex"),
      // Background task completions arrive as prompts too; only typed input
      // means a person has joined the session.
      promptSource: event.prompt.trimStart().startsWith("<task-notification") ? "task-notification" : "user",
    } : {}),
    ...(event.error ? { error: String(event.error).slice(0, 200) } : {}),
    ...(turnEnded ? {
      jobStatus: parseClaudeRoutineJobStatus(
        typeof event.last_assistant_message === "string"
          ? event.last_assistant_message
          : readLastAssistantText(event.transcript_path),
      ),
      backgroundTasks: countOrNull(event.background_tasks),
      sessionCrons: countOrNull(event.session_crons),
    } : {}),
  };
  fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function main() {
  const [eventsPath, sessionId] = process.argv.slice(2);
  let input = "";
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 16 * 1024 * 1024) return;
    }
    recordClaudeRoutineHook({ input, eventsPath, sessionId });
  } catch {
    // This is an observer, never a permission decision or a reason to stop work.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
