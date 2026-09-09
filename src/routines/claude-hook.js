import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

export function recordClaudeRoutineHook({ input, eventsPath, sessionId }) {
  const event = JSON.parse(input);
  if (event.session_id !== sessionId || !["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"].includes(event.hook_event_name)) return;
  const record = {
    type: event.hook_event_name,
    sessionId,
    at: new Date().toISOString(),
    transcriptPath: event.transcript_path,
    ...(event.model ? { model: event.model } : {}),
    ...(typeof event.prompt === "string" ? { promptSha256: createHash("sha256").update(event.prompt).digest("hex") } : {}),
    ...(event.error ? { error: String(event.error).slice(0, 200) } : {}),
  };
  fs.appendFileSync(eventsPath, `${JSON.stringify(record)}\n`, { mode: 0o600 });
}

async function main() {
  const [eventsPath, sessionId] = process.argv.slice(2);
  let input = "";
  try {
    for await (const chunk of process.stdin) {
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) return;
    }
    recordClaudeRoutineHook({ input, eventsPath, sessionId });
  } catch {
    // This is an observer, never a permission decision or a reason to stop work.
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
