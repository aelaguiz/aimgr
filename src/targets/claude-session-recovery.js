import fs from "node:fs";
import path from "node:path";

export const CLAUDE_SESSION_RECOVERY_MESSAGE_TYPE = "aimgr:claude-session-recovery-v1";
const SESSION_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function normalizeClaudeRecoverySession(value) {
  if (typeof value?.sessionId !== "string" || !SESSION_ID_PATTERN.test(value.sessionId)) return null;
  return { sessionId: value.sessionId.toLowerCase() };
}

// Claude's per-process record changes when an in-TUI resume or fork changes
// the session. Watch only our child PID; another session on the same account
// must never supply this launch's resume command. Cache the last valid record
// because Claude can remove its process record before emitting close.
export function trackClaudeRecoverySession({
  pid,
  configDir,
  startedAt = Date.now(),
  onSession,
} = {}) {
  let session = null;
  let stopped = false;
  if (!Number.isSafeInteger(pid) || pid < 1 || !path.isAbsolute(configDir ?? "")) {
    return { stop: () => session };
  }
  const recordPath = path.join(configDir, "sessions", `${pid}.json`);
  const refresh = () => {
    try {
      const record = JSON.parse(fs.readFileSync(recordPath, "utf8"));
      // A crashed process can leave a record behind and its PID can be reused.
      if (record.pid !== pid || !Number.isFinite(record.startedAt)
        || record.startedAt < startedAt - 1_000) return;
      const observed = normalizeClaudeRecoverySession(record);
      if (!observed || observed.sessionId === session?.sessionId) return;
      session = observed;
      onSession?.(session);
    } catch {
      // Missing, removed, or partially written process records are retryable.
    }
  };
  fs.watchFile(recordPath, { persistent: false, interval: 250 }, refresh);
  refresh();
  return {
    stop() {
      if (stopped) return session;
      refresh();
      fs.unwatchFile(recordPath, refresh);
      stopped = true;
      return session;
    },
  };
}

export function printClaudeResumeHint(session, { stdout = process.stdout, signal = null } = {}) {
  const observed = normalizeClaudeRecoverySession(session);
  if (!observed) return false;
  // A killed TUI can leave its alternate screen active and cursor hidden.
  const restore = signal && stdout.isTTY ? "\u001b[?1049l\u001b[?25h\u001b[0m" : "";
  const hint = `${restore}\n[aim] Resume this session with:\naim claude resume ${observed.sessionId}\n`;
  try {
    // The supervisor preserves the terminating signal immediately afterward;
    // an asynchronous write could be lost when it signals itself.
    if (Number.isInteger(stdout.fd)) fs.writeSync(stdout.fd, hint);
    else stdout.write(hint);
    return true;
  } catch {
    return false;
  }
}
