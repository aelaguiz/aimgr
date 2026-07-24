import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  listRecentManagedClaudeSessions,
  readManagedClaudeSessions,
  renderRecentManagedClaudeSessions,
  resolveManagedClaudeSession,
} from "../../src/targets/claude-sessions.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-24T18:00:00.000Z");
const THREAD_IDS = [
  "00000000-0000-4000-8000-000000000001",
  "00000000-0000-4000-8000-000000000002",
  "00000000-0000-4000-8000-000000000003",
  "00000000-0000-4000-8000-000000000004",
  "00000000-0000-4000-8000-000000000005",
  "00000000-0000-4000-8000-000000000006",
  "00000000-0000-4000-8000-000000000007",
  "00000000-0000-4000-8000-000000000008",
  "00000000-0000-4000-8000-000000000009",
  "00000000-0000-4000-8000-000000000010",
  "00000000-0000-4000-8000-000000000011",
];

function writeManagedSession({
  home,
  account,
  threadId,
  cwd,
  timestamp,
  events = [],
  malformedTail = false,
  mtimeMs,
}) {
  fs.mkdirSync(cwd, { recursive: true });
  const sessionPath = path.join(
    home,
    ".aimgr",
    "claude-homes",
    account,
    ".claude",
    "projects",
    "project",
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(sessionPath), { recursive: true });
  const entries = [
    {
      type: "user",
      sessionId: threadId,
      cwd,
      ...(timestamp ? { timestamp } : {}),
    },
    ...events,
  ];
  const lines = entries.map((entry) => JSON.stringify(entry));
  if (malformedTail) lines.push("{still-being-written");
  fs.writeFileSync(sessionPath, `${lines.join("\n")}\n`, "utf8");
  if (Number.isFinite(mtimeMs)) {
    const mtime = new Date(mtimeMs);
    fs.utimesSync(sessionPath, mtime, mtime);
  }
  return sessionPath;
}

function seedElevenSessions(home) {
  for (let index = 0; index < THREAD_IDS.length; index += 1) {
    const timestampMs = NOW_MS - ((index + 1) * 3_600_000);
    const timestamp = index === THREAD_IDS.length - 1
      ? null
      : new Date(timestampMs).toISOString();
    const events = [];
    if (index === 0) {
      events.push(
        {
          type: "ai-title",
          aiTitle: "Automatic title",
          timestamp,
        },
        {
          type: "custom-title",
          customTitle: "  Current\nrelease  ",
          timestamp,
        },
        {
          type: "custom-title",
          customTitle: "   ",
          timestamp,
        },
      );
    }
    if (index === 1) {
      events.push({
        type: "ai-title",
        aiTitle: "Investigate tokens",
        timestamp,
      });
    }
    writeManagedSession({
      home,
      account: index % 2 === 0 ? "pro5" : "qa",
      threadId: THREAD_IDS[index],
      cwd: path.join(home, "workspace", `project-${index + 1}`),
      timestamp,
      events,
      malformedTail: index === 0,
      mtimeMs: index === THREAD_IDS.length - 1 ? timestampMs : undefined,
    });
  }
}

test("managed Claude sessions list the newest ten with persisted name and ID fallbacks", async () => {
  const home = mkTempHome();
  seedElevenSessions(home);

  const allSessions = readManagedClaudeSessions({ homeDir: home });
  assert.equal(allSessions.length, 11);
  assert.deepEqual(allSessions.map((session) => session.threadId), THREAD_IDS);

  const sessions = listRecentManagedClaudeSessions({ homeDir: home });
  assert.equal(sessions.length, 10);
  assert.deepEqual(
    sessions.map((session) => session.rank),
    Array.from({ length: 10 }, (_, index) => index + 1),
  );
  assert.equal(sessions[0].account, "pro5");
  assert.equal(sessions[0].threadName, "Current release");
  assert.equal(sessions[0].thread, "Current release");
  assert.equal(sessions[1].threadName, "Investigate tokens");
  assert.equal(sessions[2].threadName, null);
  assert.equal(sessions[2].thread, THREAD_IDS[2]);

  const rendered = renderRecentManagedClaudeSessions(sessions, {
    homeDir: home,
    nowMs: NOW_MS,
  });
  assert.match(rendered, /#\s+last_used\s+account\s+thread\s+working_directory/);
  assert.match(rendered, /1\s+1h ago\s+pro5\s+Current release\s+~\/workspace\/project-1/);
  assert.match(rendered, new RegExp(THREAD_IDS[2]));
  assert.doesNotMatch(rendered, new RegExp(THREAD_IDS[10]));

  let redisCalls = 0;
  const json = JSON.parse(await runCli(
    ["claude", "list", "--json", "--home", home],
    {
      nowImpl: () => NOW_MS,
      connectRedisStoreImpl: () => {
        redisCalls += 1;
        throw new Error("list must not connect to Redis");
      },
    },
  ));
  assert.equal(redisCalls, 0);
  assert.equal(json.sessions.length, 10);
  assert.deepEqual(json.sessions[0], {
    rank: 1,
    lastUsedAt: "2026-07-24T17:00:00.000Z",
    account: "pro5",
    threadName: "Current release",
    threadId: THREAD_IDS[0],
    cwd: path.join(home, "workspace", "project-1"),
  });
});

test("managed Claude sessions resolve a current row or any exact thread ID and reject missing directories", () => {
  const home = mkTempHome();
  seedElevenSessions(home);

  assert.equal(
    resolveManagedClaudeSession({ homeDir: home, selector: "2" }).threadId,
    THREAD_IDS[1],
  );
  assert.equal(
    resolveManagedClaudeSession({ homeDir: home, selector: THREAD_IDS[10] }).threadId,
    THREAD_IDS[10],
  );
  assert.throws(
    () => resolveManagedClaudeSession({ homeDir: home, selector: "11" }),
    /was not found/,
  );
  assert.throws(
    () => resolveManagedClaudeSession({ homeDir: home, selector: "not-a-thread" }),
    /Invalid Claude session selector/,
  );

  fs.rmdirSync(path.join(home, "workspace", "project-2"));
  assert.throws(
    () => resolveManagedClaudeSession({ homeDir: home, selector: "2" }),
    /working directory is unavailable/,
  );
  assert.deepEqual(listRecentManagedClaudeSessions({ homeDir: mkTempHome() }), []);
});
