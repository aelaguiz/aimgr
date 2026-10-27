import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  chooseClaudeAccountToFree,
  listLocalAimClaudeSessions,
  stopClaudeAccountSessions,
} from "../../src/targets/claude-idle-stop.js";

const session = (label, pid, status, lastActiveMs, extra = {}) => ({
  label, pid, status, lastActiveMs, sessionId: `s-${pid}`, cwd: "/w", tty: `ttys0${pid}`, ...extra,
});

test("frees the eligible account whose latest activity is oldest, never one mid-turn", () => {
  const sessions = [
    session("pro1", 1, "idle", 5_000),
    session("pro2", 2, "idle", 1_000),
    session("pro2", 3, "idle", 2_000),
    session("pro3", 4, "busy", 100),
    session("pro4", 5, "idle", 50),
  ];
  const target = chooseClaudeAccountToFree(sessions, new Set(["pro1", "pro2", "pro3"]));
  assert.equal(target.label, "pro2");
  assert.deepEqual(target.sessions.map((s) => s.pid), [2, 3]);
  assert.equal(chooseClaudeAccountToFree([session("pro3", 4, "busy", 1)], new Set(["pro3"])), null);
});

test("stops every session on the account and leaves a resume note on each pane", async () => {
  const alive = new Set([2, 3]);
  const notes = [];
  const stopped = await stopClaudeAccountSessions({ label: "pro2", sessions: [session("pro2", 2, "idle", 1), session("pro2", 3, "idle", 2)] }, {
    jobName: "whats-working",
    nowMs: () => Date.UTC(2026, 8, 24, 9, 10),
    killImpl: (pid, signal) => { assert.equal(signal, "SIGTERM"); alive.delete(pid); },
    isAlive: (pid) => alive.has(pid),
    writeTtyImpl: (tty, text) => notes.push({ tty, text }),
    sleep: async () => {},
  });
  assert.equal(stopped.length, 2);
  assert.equal(notes.length, 2);
  assert.match(notes[0].text, /to free account pro2 for the scheduled job "whats-working"/);
  assert.match(notes[0].text, /Resume it with: aim claude resume s-2/);
});

test("lists only live Claude processes that AIM launched", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-idle-"));
  const dir = path.join(home, ".aimgr", "claude-homes", "pro9", ".claude", "sessions");
  fs.mkdirSync(dir, { recursive: true });
  const write = (pid) => fs.writeFileSync(path.join(dir, `${pid}.json`),
    JSON.stringify({ pid, sessionId: `id-${pid}`, cwd: "/w", status: "idle", updatedAt: 42 }));
  [10, 11, 12].forEach(write);
  const exec = (cmd, args) => {
    const pid = args.at(-1);
    if (args[1] === "ppid=,tty=") return pid === "10" ? "100 ttys010" : "200 ??";
    return pid === "100" ? "node /x/aimgr/src/targets/claude-supervisor.js /claude" : "timeout claude -p";
  };
  const sessions = listLocalAimClaudeSessions({ homeDir: home, isAlive: (pid) => pid !== 12, execFileSyncImpl: exec });
  assert.deepEqual(sessions.map((s) => [s.label, s.pid, s.sessionId, s.tty, s.lastActiveMs]), [["pro9", 10, "id-10", "ttys010", 42]]);
});
