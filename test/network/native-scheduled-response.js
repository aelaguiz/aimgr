// Scripted model responses exercise the pinned CLI's actual timer/tool runtime.
export function scheduledResponse(body, sequence) {
  const text = body.messages.filter(row => row.role === "user").flatMap(row => typeof row.content === "string" ? [row.content]
    : row.content.filter(block => block.type === "text").map(block => block.text)).join("\n");
  if (!text.includes("NATIVE_SCHEDULE_REQUEST")) return null;
  const calls = body.messages.flatMap(row => Array.isArray(row.content) ? row.content.filter(block => block.type === "tool_use") : []);
  const tool = (name, input) => ({ type: "tool_use", id: `scheduled_${sequence}`, name, input });
  if (!calls.some(call => call.name === "ScheduleWakeup")) return tool("ScheduleWakeup", {
    delaySeconds: 60, reason: "Verify a scheduled test turn uses the assigned route", prompt: "NATIVE_WAKE_FIRED_CANARY", noop: false,
  });
  if (!text.includes("NATIVE_WAKE_FIRED_CANARY")) return { type: "text", text: "Waiting for the scheduled synthetic turn." };
  if (text.includes("NATIVE_SCHEDULE_INTERRUPT_DURING")) return { hold: true };
  if (!calls.some(call => call.name === "Bash" && call.input.command.includes("wakeup-proof"))) return tool("Bash", {
    command: "printf native-wakeup-ok > wakeup-proof.txt", description: "Write scheduled-turn proof",
  });
  if (!calls.some(call => call.name === "ScheduleWakeup" && call.input.stop)) return tool("ScheduleWakeup", { stop: true });
  return { type: "text", text: "NATIVE_WAKE_COMPLETED\nAIM-JOB: done" };
}
