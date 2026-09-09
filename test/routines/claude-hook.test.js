import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { mkTempHome } from "../helpers/files.js";
import { recordClaudeRoutineHook } from "../../src/routines/claude-hook.js";
import { inheritClaudeRoutineTrust, prepareInteractiveClaudeRoutine, readClaudeRoutineEvents } from "../../src/routines/claude.js";

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
