import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { resolveAimgrStateDir } from "../io/paths.js";

// Amir, 2026-09-24: scheduled morning jobs kept failing because every Claude
// account was held by sessions he had left open. When a scheduled job finds no
// free account, it stops the least recently used idle AIM session instead of
// failing. The pane stays open and gets a note saying what was stopped and how
// to resume it.

function processInfo(pid, execFileSyncImpl) {
  try {
    const out = execFileSyncImpl("ps", ["-o", "ppid=,tty=", "-p", String(pid)], { encoding: "utf8" }).trim();
    if (!out) return null;
    const [ppid, tty] = out.split(/\s+/);
    const parent = execFileSyncImpl("ps", ["-o", "command=", "-p", ppid], { encoding: "utf8" }).trim();
    return { ppid: Number(ppid), tty: tty && tty !== "??" ? tty : null, parent };
  } catch {
    return null;
  }
}

/**
 * Live Claude processes that AIM launched on this machine, one row per process,
 * read from Claude's own per-process record (`<home>/.claude/sessions/<pid>.json`).
 * Processes AIM didn't launch hold no account lease, so they are left out.
 */
export function listLocalAimClaudeSessions({
  homeDir,
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  execFileSyncImpl = execFileSync,
} = {}) {
  const homesRoot = path.join(resolveAimgrStateDir({ homeDir }), "claude-homes");
  let labels = [];
  try {
    labels = fs.readdirSync(homesRoot);
  } catch {
    return [];
  }
  const sessions = [];
  for (const label of labels) {
    const dir = path.join(homesRoot, label, ".claude", "sessions");
    let files = [];
    try {
      files = fs.readdirSync(dir).filter((name) => /^\d+\.json$/.test(name));
    } catch {
      continue;
    }
    for (const name of files) {
      let record;
      try {
        record = JSON.parse(fs.readFileSync(path.join(dir, name), "utf8"));
      } catch {
        continue;
      }
      const pid = Number(record?.pid);
      if (!Number.isSafeInteger(pid) || pid < 1 || !isAlive(pid)) continue;
      const info = processInfo(pid, execFileSyncImpl);
      if (!info || !info.parent.includes("claude-supervisor.js")) continue;
      sessions.push({
        label,
        pid,
        sessionId: typeof record.sessionId === "string" ? record.sessionId : null,
        cwd: typeof record.cwd === "string" ? record.cwd : null,
        status: typeof record.status === "string" ? record.status : "unknown",
        lastActiveMs: Number(record.updatedAt) || Number(record.startedAt) || 0,
        tty: info.tty,
      });
    }
  }
  return sessions;
}

/**
 * The account to free: among accounts the job could otherwise use, the one whose
 * most recent activity is oldest, with no session in the middle of a turn.
 */
export function chooseClaudeAccountToFree(sessions, eligibleLabels) {
  const byLabel = new Map();
  for (const session of sessions) {
    if (!eligibleLabels.has(session.label)) continue;
    const group = byLabel.get(session.label) ?? [];
    group.push(session);
    byLabel.set(session.label, group);
  }
  const candidates = [...byLabel.entries()]
    .filter(([, group]) => group.every((session) => session.status !== "busy"))
    .map(([label, group]) => ({
      label,
      sessions: group,
      lastActiveMs: Math.max(...group.map((session) => session.lastActiveMs)),
    }))
    .sort((left, right) => left.lastActiveMs - right.lastActiveMs || left.label.localeCompare(right.label));
  return candidates[0] ?? null;
}

function stopNotice(session, { jobName, nowMs }) {
  const when = new Date(nowMs).toLocaleString("en-US", {
    timeZone: "America/Chicago", month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
  });
  const lines = [
    "",
    `[aim] Stopped this Claude session on ${when} (Chicago) to free account ${session.label} for the scheduled job "${jobName}".`,
    session.sessionId ? `[aim] Session ${session.sessionId}${session.cwd ? ` in ${session.cwd}` : ""}.` : null,
    session.sessionId ? `[aim] Resume it with: aim claude resume ${session.sessionId}` : null,
    "",
  ].filter((line) => line !== null);
  return `${lines.join("\n")}\n`;
}

/**
 * Stop every AIM session on the chosen account gracefully (SIGTERM, which Claude
 * handles by saving and exiting; AIM then releases the account lease), then
 * print the notice on each session's terminal once it has exited.
 */
export async function stopClaudeAccountSessions(target, {
  jobName,
  nowMs = Date.now,
  killImpl = (pid, signal) => process.kill(pid, signal),
  isAlive = (pid) => {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  },
  writeTtyImpl = (tty, text) => fs.appendFileSync(path.join("/dev", tty), text),
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  exitWaitMs = 30_000,
} = {}) {
  const stopped = [];
  for (const session of target.sessions) {
    try {
      killImpl(session.pid, "SIGTERM");
    } catch {
      continue;
    }
    stopped.push(session);
  }
  for (let waited = 0; waited < exitWaitMs && stopped.some((session) => isAlive(session.pid)); waited += 500) {
    await sleep(500);
  }
  for (const session of stopped) {
    if (!session.tty || isAlive(session.pid)) continue;
    try {
      writeTtyImpl(session.tty, stopNotice(session, { jobName, nowMs: nowMs() }));
    } catch {
      // The pane may be gone; the job's own log still names the session.
    }
  }
  return stopped;
}
