import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkTempHome } from "../helpers/files.js";
import { recordClaudeRoutineHook } from "../../src/routines/claude-hook.js";
import {
  claudeRoutineArgs,
  inheritClaudeRoutineTrust,
  parseClaudeRoutineJobStatus,
  prepareInteractiveClaudeRoutine,
  readClaudeRoutineEvents,
} from "../../src/routines/claude.js";

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value));
}

test("Claude hooks record lifecycle and prompt hashes without logging prompt or assistant contents", () => {
  const eventsPath = path.join(mkTempHome(), "events.jsonl");
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const prompt = "Private scheduled instructions";
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId,
    prompt, transcript_path: "/tmp/transcript.jsonl", last_assistant_message: "Private answer" }) });
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId, prompt: "Later background message" }) });
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "StopFailure", session_id: sessionId, error: "rate_limit" }) });
  const events = readClaudeRoutineEvents(eventsPath);
  assert.equal(events.length, 3);
  assert.equal(events[0].promptSha256, createHash("sha256").update(prompt).digest("hex"));
  assert.equal(events[2].error, "rate_limit");
  assert.doesNotMatch(fs.readFileSync(eventsPath, "utf8"), /Private|Later background/);
  assert.equal(fs.statSync(eventsPath).mode & 0o777, 0o600);
});

test("Claude observer ignores other sessions and unsupported hooks", () => {
  const eventsPath = path.join(mkTempHome(), "events.jsonl");
  recordClaudeRoutineHook({ eventsPath, sessionId: "expected", input: JSON.stringify({ hook_event_name: "Stop", session_id: "other" }) });
  recordClaudeRoutineHook({ eventsPath, sessionId: "expected", input: JSON.stringify({ hook_event_name: "SubagentStop", session_id: "expected" }) });
  assert.equal(fs.existsSync(eventsPath), false);
});

test("routine trust copies only the configured project's existing decision and preserves the selected account", () => {
  const home = mkTempHome();
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const configDir = path.join(home, "account");
  writeJson(path.join(home, ".claude.json"), {
    oauthAccount: { accountUuid: "must-not-copy" },
    projects: { [cwd]: { hasTrustDialogAccepted: true, allowedTools: ["must-not-copy"] }, "/unrelated": { hasTrustDialogAccepted: true } },
  });
  writeJson(path.join(configDir, ".claude.json"), { oauthAccount: { accountUuid: "selected-account" },
    projects: { [cwd]: { existing: "keep" } }, marker: "keep" });
  assert.equal(inheritClaudeRoutineTrust({ userHomeDir: home, configDir, cwd }), true);
  const state = JSON.parse(fs.readFileSync(path.join(configDir, ".claude.json")));
  assert.equal(state.oauthAccount.accountUuid, "selected-account");
  assert.deepEqual(state.projects[cwd], { existing: "keep", hasTrustDialogAccepted: true });
  assert.equal(state.projects["/unrelated"], undefined);
  assert.equal(state.marker, "keep");
});

test("routine setup keeps user hooks and explicit bypass acknowledgement, without inventing project trust", () => {
  const home = mkTempHome();
  const cwd = path.join(home, "work");
  fs.mkdirSync(cwd);
  const configDir = path.join(home, "account");
  writeJson(path.join(home, ".claude", "settings.json"), { skipDangerousModePermissionPrompt: true });
  writeJson(path.join(home, ".claude.json"), { projects: { [cwd]: { hasTrustDialogAccepted: false } } });
  const hooksPath = path.join(home, "hooks.json");
  writeJson(hooksPath, { hooks: { Stop: [{ hooks: [{ type: "command", command: "existing-hook" }] }] }, statusLine: { type: "command", command: "existing-status" } });
  const launch = { userHomeDir: home, configDir, preparedLaunch: { userHooksPath: hooksPath, userPluginDirs: ["/plugin"] } };
  const prepared = prepareInteractiveClaudeRoutine({ launch, routine: { cwd, model: "claude-fable-5-1", thinking: "xhigh" }, sessionId: "expected", eventsPath: path.join(home, "events.jsonl") });
  const settings = JSON.parse(fs.readFileSync(prepared.preparedLaunch.userHooksPath));
  assert.equal(settings.skipDangerousModePermissionPrompt, true);
  assert.equal(settings.hooks.Stop[0].hooks[0].command, "existing-hook");
  assert.equal(settings.hooks.Stop.length, 2);
  assert.equal(settings.statusLine.command, "existing-status");
  assert.deepEqual(prepared.preparedLaunch.userPluginDirs, ["/plugin"]);
  assert.equal(fs.existsSync(path.join(configDir, ".claude.json")), false);
});

test("Claude turn-end hooks record the job status line and in-flight background work, not the message", () => {
  const eventsPath = path.join(mkTempHome(), "events.jsonl");
  const sessionId = "expected";
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "UserPromptSubmit", session_id: sessionId,
    prompt: "<task-notification>\n<task-id>abc</task-id>" }) });
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "Stop", session_id: sessionId,
    last_assistant_message: "Private report body\n\n**AIM-JOB: needs-input Post drafts 1 and 2?**",
    background_tasks: [{ id: "a", type: "subagent", status: "running", description: "x" }], session_crons: [] }) });
  recordClaudeRoutineHook({ eventsPath, sessionId, input: JSON.stringify({ hook_event_name: "Stop", session_id: sessionId }) });
  const events = readClaudeRoutineEvents(eventsPath);
  assert.equal(events[0].promptSource, "task-notification");
  assert.deepEqual(events[1].jobStatus, { state: "needs-input", detail: "Post drafts 1 and 2?" });
  assert.equal(events[1].backgroundTasks, 1);
  assert.equal(events[1].sessionCrons, 0);
  assert.equal(events[2].jobStatus, null);
  assert.equal(events[2].backgroundTasks, null);
  assert.doesNotMatch(fs.readFileSync(eventsPath, "utf8"), /Private report/);
});

test("Claude turn-end hooks fall back to the transcript's last main-thread assistant text", () => {
  const home = mkTempHome();
  const eventsPath = path.join(home, "events.jsonl");
  const transcriptPath = path.join(home, "transcript.jsonl");
  const line = (value) => `${JSON.stringify(value)}\n`;
  fs.writeFileSync(transcriptPath, line({ type: "assistant", message: { content: [{ type: "text", text: "Done.\nAIM-JOB: done" }] } })
    + line({ type: "assistant", isSidechain: true, message: { content: [{ type: "text", text: "AIM-JOB: blocked child" }] } })
    + line({ type: "system", subtype: "turn_duration" }));
  recordClaudeRoutineHook({ eventsPath, sessionId: "s", input: JSON.stringify({ hook_event_name: "Stop", session_id: "s", transcript_path: transcriptPath }) });
  assert.deepEqual(readClaudeRoutineEvents(eventsPath)[0].jobStatus, { state: "done", detail: null });
});

test("Claude job status lines parse through common Markdown wrapping and ignore look-alikes", () => {
  assert.deepEqual(parseClaudeRoutineJobStatus("x\n`AIM-JOB: blocked — Reddit login expired`\n```"), { state: "blocked", detail: "Reddit login expired" });
  assert.deepEqual(parseClaudeRoutineJobStatus("AIM-JOB: DONE"), { state: "done", detail: null });
  assert.equal(parseClaudeRoutineJobStatus("I will print AIM-JOB: done at the end"), null);
  assert.equal(parseClaudeRoutineJobStatus("AIM-JOB: finished"), null);
  assert.equal(parseClaudeRoutineJobStatus(null), null);
});

test("Claude routines append the job status rule to the system prompt", () => {
  const args = claudeRoutineArgs({ model: "claude-opus-5-5", thinking: "high" });
  const rule = args[args.indexOf("--append-system-prompt") + 1];
  assert.match(rule, /AIM-JOB: done/);
  assert.match(rule, /AIM-JOB: needs-input/);
  assert.match(rule, /AIM-JOB: blocked/);
});
