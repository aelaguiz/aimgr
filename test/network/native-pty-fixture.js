import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { prepareClaudeNativeRoute } from "../../src/network/claude-native-route.js";

const exec = promisify(execFile);

export async function verifyNativeTerminalCleanup(profile) {
  for (const mode of ["hard-exit", "background"]) {
    const invocation = await prepareClaudeNativeRoute({ profile, command: "/usr/bin/python3",
      args: ["-I", "-c", mode === "hard-exit" ? "import tty,os,signal;tty.setraw(0);os.kill(os.getpid(),signal.SIGKILL)" : "pass"] });
    const result = await exec("/usr/bin/python3", [fileURLToPath(new URL("./native-tty-fixture.py", import.meta.url)), mode, invocation.command, ...invocation.args], { timeout: 20000 });
    console.log(JSON.stringify({ nativeTerminalCleanup: JSON.parse(result.stdout) }));
  }
}

export async function verifyInteractiveRoutine({ root: parentRoot, profile, destination, claudeBin, failure = null, defaultServices = null }) {
  const root = path.join(parentRoot, `interactive-routine${failure ? "-" + failure : ""}`);
  await fs.mkdir(root);
  const info = path.join(root, "info.json"), final = path.join(root, "final.json");
  const entry = path.join(root, "interactive.mjs");
  await fs.writeFile(entry, `import fs from 'node:fs';
import {createNativeRoutineFixture} from ${JSON.stringify(new URL("./native-routine-fixture.js", import.meta.url).href)};
const fixture=await createNativeRoutineFixture(${JSON.stringify({ root, profile, destination, claudeBin, printMode: false, defaultServices })});
const occurrence=await fixture.start(0,'Run the synthetic Bash task. ROUTINE_SUCCESS_CANARY.');
fs.writeFileSync(${JSON.stringify(info)},JSON.stringify({receiptPath:occurrence.queued.receiptPath,cwd:fixture.cwd,failure:${JSON.stringify(failure)},stdinTTY:Boolean(process.stdin.isTTY),stdoutTTY:Boolean(process.stdout.isTTY)}));
const receipt=await occurrence.finished;
await fixture.close();
fs.writeFileSync(${JSON.stringify(final)},JSON.stringify(receipt));
// Keep AIM alive long enough to check the launcher's cleanup independently
// of Node's own terminal reset when the outer process exits.
await new Promise(resolve=>setTimeout(resolve,1000));
`);
  const result = await exec("/usr/bin/python3", [fileURLToPath(new URL("./native-pty-driver.py", import.meta.url)), process.execPath, entry, info, final], { timeout: 160000, maxBuffer: 256 * 1024 });
  const receipt = JSON.parse(result.stdout.trim().split("\n").at(-1));
  assert.equal(receipt.initialTurnCompleted, true);
  assert.equal(receipt.followupCompleted, true);
  assert.equal(receipt.nativeExit, failure ? 125 : 0);
  assert.equal(receipt.terminalRestored, true);
  assert.equal(receipt.inSessionScheduledWakeupCompleted, !failure);
  console.log(JSON.stringify({ interactiveRoutine: receipt }));
  return receipt;
}

export async function verifyScheduledInterruption({ root, profile, destination, claudeBin, modelRequests, phase, stopRoute, repairRoute }) {
  const running = verifyInteractiveRoutine({ root, profile, destination, claudeBin, failure: phase });
  running.catch(() => {});
  const marker = `NATIVE_SCHEDULE_INTERRUPT_${phase.toUpperCase()}`;
  const requests = () => modelRequests.filter(body => JSON.stringify(body.messages).includes(marker));
  const started = Date.now();
  while (Date.now() - started < 120000) {
    const ready = requests().some(body => phase === "before"
      ? body.messages.flatMap(row => Array.isArray(row.content) ? row.content : []).some(call => call.type === "tool_use" && call.name === "ScheduleWakeup"
        && body.messages.some(row => Array.isArray(row.content) && row.content.some(result => result.type === "tool_result" && result.tool_use_id === call.id && !result.is_error)))
      : body.messages.some(row => row.role === "user" && (typeof row.content === "string" ? row.content.includes("NATIVE_WAKE_FIRED_CANARY")
        : row.content.some(block => block.type === "text" && block.text.includes("NATIVE_WAKE_FIRED_CANARY")))));
    if (ready) break;
    await delay(50);
  }
  assert.ok(requests().length, "scheduled interruption did not reach a model turn");
  assert.ok(Date.now() - started < 120000, "scheduled interruption did not reach its requested phase");
  await stopRoute();
  const receipt = await running;
  const stoppedCount = requests().length;
  await repairRoute();
  await delay(500);
  assert.equal(requests().length, stoppedCount, "repair must not replay the interrupted scheduling session");
  console.log(JSON.stringify({ inSessionScheduledFailure: { phase, nativeExit: receipt.nativeExit, repairedWithoutReplay: true, terminalRestored: receipt.terminalRestored } }));
  return () => assert.equal(requests().length, stoppedCount, "later native work cannot revive the interrupted scheduling session");
}
