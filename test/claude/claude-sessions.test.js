import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildManagedClaudeSessionForkName,
  listRecentManagedClaudeSessions,
  readManagedClaudeSessions,
  renderRecentManagedClaudeSessions,
  resolveManagedClaudeSession,
  stageManagedClaudeSessionFork,
} from "../../src/targets/claude-sessions.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-24T18:00:00.000Z");
const THREAD_IDS = Array.from(
  { length: 51 },
  (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
);

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

function seedFiftyOneSessions(home) {
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

test("managed Claude sessions list the newest 50 with persisted name and ID fallbacks", async () => {
  const home = mkTempHome();
  seedFiftyOneSessions(home);

  const allSessions = readManagedClaudeSessions({ homeDir: home });
  assert.equal(allSessions.length, 51);
  assert.deepEqual(allSessions.map((session) => session.threadId), THREAD_IDS);

  const sessions = listRecentManagedClaudeSessions({ homeDir: home });
  assert.equal(sessions.length, 50);
  assert.deepEqual(
    sessions.map((session) => session.rank),
    Array.from({ length: 50 }, (_, index) => index + 1),
  );
  assert.equal(sessions[0].account, "pro5");
  assert.equal(sessions[0].threadName, "Current release");
  assert.equal(sessions[0].thread, "Current release");
  assert.equal(sessions[1].threadName, "Investigate tokens");
  assert.equal(sessions[2].threadName, null);
  assert.equal(sessions[2].thread, THREAD_IDS[2]);

  const allListedSessions = listRecentManagedClaudeSessions({
    homeDir: home,
    limit: 51,
  });
  assert.equal(allListedSessions.length, 51);
  assert.equal(allListedSessions[50].rank, 51);
  assert.throws(
    () => listRecentManagedClaudeSessions({ homeDir: home, limit: 0 }),
    /positive integer/,
  );

  const rendered = renderRecentManagedClaudeSessions(sessions, {
    homeDir: home,
    nowMs: NOW_MS,
  });
  assert.match(rendered, /#\s+last_used\s+account\s+thread\s+working_directory/);
  assert.match(rendered, /1\s+1h ago\s+pro5\s+Current release\s+~\/workspace\/project-1/);
  assert.match(rendered, new RegExp(THREAD_IDS[2]));
  assert.doesNotMatch(rendered, new RegExp(THREAD_IDS[50]));

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
  assert.equal(json.sessions.length, 50);
  assert.deepEqual(json.sessions[0], {
    rank: 1,
    lastUsedAt: "2026-07-24T17:00:00.000Z",
    account: "pro5",
    threadName: "Current release",
    threadId: THREAD_IDS[0],
    cwd: path.join(home, "workspace", "project-1"),
  });

  const expandedJson = JSON.parse(await runCli(
    ["claude", "list", "51", "--json", "--home", home],
    { nowImpl: () => NOW_MS },
  ));
  assert.equal(expandedJson.sessions.length, 51);
  await assert.rejects(
    runCli(["claude", "list", "0", "--home", home]),
    /Usage: aim claude list \[count\]/,
  );
});

test("managed Claude sessions resolve a current row or any exact thread ID and reject missing directories", () => {
  const home = mkTempHome();
  seedFiftyOneSessions(home);

  assert.equal(
    resolveManagedClaudeSession({ homeDir: home, selector: "2" }).threadId,
    THREAD_IDS[1],
  );
  assert.equal(
    resolveManagedClaudeSession({ homeDir: home, selector: THREAD_IDS[50] }).threadId,
    THREAD_IDS[50],
  );
  assert.equal(
    resolveManagedClaudeSession({ homeDir: home, selector: "51" }).threadId,
    THREAD_IDS[50],
  );
  assert.throws(
    () => resolveManagedClaudeSession({ homeDir: home, selector: "52" }),
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

test("managed Claude session fork staging copies exact source data and cleans only its destination copy", () => {
  const home = mkTempHome();
  const threadId = THREAD_IDS[0];
  const sourcePath = writeManagedSession({
    home,
    account: "pro10",
    threadId,
    cwd: path.join(home, "workspace", "puzzledb"),
    timestamp: new Date(NOW_MS).toISOString(),
    events: [{
      type: "custom-title",
      customTitle: "Review puzzle quality",
      timestamp: new Date(NOW_MS).toISOString(),
    }],
  });
  const sourceCompanionPath = path.join(path.dirname(sourcePath), threadId);
  fs.mkdirSync(path.join(sourceCompanionPath, "tool-results"), { recursive: true });
  fs.writeFileSync(
    path.join(sourceCompanionPath, "tool-results", "result.txt"),
    "source tool result\n",
    "utf8",
  );
  const sourceContent = fs.readFileSync(sourcePath, "utf8");
  const session = resolveManagedClaudeSession({ homeDir: home, selector: threadId });
  const targetConfigDir = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "pro11",
    ".claude",
  );

  assert.equal(
    buildManagedClaudeSessionForkName(session),
    `[fork from pro10/${threadId.slice(0, 8)}] Review puzzle quality`,
  );
  const staged = stageManagedClaudeSessionFork({ session, targetConfigDir });
  assert.equal(fs.existsSync(staged.targetMarkerPath), true);
  assert.equal(fs.readFileSync(staged.targetTranscriptPath, "utf8"), sourceContent);
  assert.equal(
    fs.readFileSync(path.join(staged.targetCompanionPath, "tool-results", "result.txt"), "utf8"),
    "source tool result\n",
  );
  assert.deepEqual(
    readManagedClaudeSessions({ homeDir: home })
      .filter((candidate) => candidate.threadId === threadId)
      .map((candidate) => candidate.account),
    ["pro10"],
  );

  staged.cleanup();
  assert.equal(fs.existsSync(staged.targetMarkerPath), false);
  assert.equal(fs.existsSync(staged.targetTranscriptPath), false);
  assert.equal(fs.existsSync(staged.targetCompanionPath), false);
  assert.equal(fs.readFileSync(sourcePath, "utf8"), sourceContent);
});

test("managed Claude session fork staging refuses an existing destination transcript", () => {
  const home = mkTempHome();
  const threadId = THREAD_IDS[0];
  const sourcePath = writeManagedSession({
    home,
    account: "pro10",
    threadId,
    cwd: path.join(home, "workspace", "puzzledb"),
    timestamp: new Date(NOW_MS).toISOString(),
  });
  const session = resolveManagedClaudeSession({ homeDir: home, selector: threadId });
  const targetConfigDir = path.join(
    home,
    ".aimgr",
    "claude-homes",
    "pro11",
    ".claude",
  );
  const targetPath = path.join(
    targetConfigDir,
    "projects",
    path.basename(path.dirname(sourcePath)),
    `${threadId}.jsonl`,
  );
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, "existing destination\n", "utf8");

  assert.throws(
    () => stageManagedClaudeSessionFork({ session, targetConfigDir }),
    /already exists in the selected destination account/,
  );
  assert.equal(fs.readFileSync(targetPath, "utf8"), "existing destination\n");
});
