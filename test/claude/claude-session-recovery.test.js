import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  printClaudeResumeHint,
  trackClaudeRecoverySession,
} from "../../src/targets/claude-session-recovery.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const ORIGINAL_ID = "11111111-1111-4111-8111-111111111111";
const FORK_ID = "22222222-2222-4222-8222-222222222222";

test("recovery follows the child PID through session changes and retains it after record deletion", async (t) => {
  const configDir = mkTempHome();
  const pid = 123;
  const startedAt = Date.now();
  const recordPath = path.join(configDir, "sessions", `${pid}.json`);
  writeJson(recordPath, { pid, startedAt, sessionId: ORIGINAL_ID });
  writeJson(path.join(configDir, "sessions", "456.json"), {
    pid: 456, startedAt, sessionId: ORIGINAL_ID,
  });
  const observed = [];
  let sawFork;
  const forkObserved = new Promise((resolve) => { sawFork = resolve; });
  const tracker = trackClaudeRecoverySession({
    pid, configDir, startedAt,
    onSession(session) {
      observed.push(session.sessionId);
      if (session.sessionId === FORK_ID) sawFork();
    },
  });
  t.after(() => {
    tracker.stop();
    fs.rmSync(configDir, { recursive: true, force: true });
  });
  writeJson(recordPath, { pid, startedAt, sessionId: FORK_ID });
  let timeout;
  try {
    await Promise.race([
      forkObserved,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error("Fork session was not observed")), 2_000);
      }),
    ]);
  } finally {
    clearTimeout(timeout);
  }
  fs.unlinkSync(recordPath);
  assert.deepEqual(tracker.stop(), { sessionId: FORK_ID });
  assert.deepEqual(observed, [ORIGINAL_ID, FORK_ID]);
});

test("recovery rejects stale reused PIDs, foreign PIDs, and invalid IDs", () => {
  const configDir = mkTempHome();
  const pid = 123;
  const startedAt = Date.now();
  const recordPath = path.join(configDir, "sessions", `${pid}.json`);
  try {
    for (const record of [
      { pid, startedAt: startedAt - 60_000, sessionId: ORIGINAL_ID },
      { pid: 456, startedAt, sessionId: ORIGINAL_ID },
      { pid, startedAt, sessionId: "a title instead of a UUID" },
    ]) {
      writeJson(recordPath, record);
      const tracker = trackClaudeRecoverySession({ pid, configDir, startedAt });
      assert.equal(tracker.stop(), null);
    }
  } finally {
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test("a resume hint restores a killed TUI and prints only a validated actual UUID", () => {
  const output = [];
  const stdout = { isTTY: true, write: (text) => output.push(text) };
  assert.equal(printClaudeResumeHint({ sessionId: FORK_ID }, { stdout, signal: "SIGKILL" }), true);
  assert.equal(output.join(""), `\u001b[?1049l\u001b[?25h\u001b[0m\n[aim] Resume this session with:\naim claude resume ${FORK_ID}\n`);
  assert.equal(printClaudeResumeHint({ sessionId: "bad\ncommand" }, { stdout }), false);
  assert.equal(printClaudeResumeHint({ sessionId: {} }, { stdout }), false);
  assert.equal(output.length, 1);
});
