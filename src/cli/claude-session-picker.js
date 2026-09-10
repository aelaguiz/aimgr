import readline from "node:readline";
import { stripVTControlCharacters } from "node:util";
import { formatDurationRough } from "../core/time.js";
import { listRecentManagedClaudeSessions } from "../targets/claude-sessions.js";
import { isInteractiveTerminal } from "./tty.js";

const PAGE_SIZE = 10;
const LOAD_SIZE = 50;

function displayText(value, width) {
  const text = stripVTControlCharacters(String(value ?? ""))
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ").replace(/\s+/g, " ").trim();
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}

// Keep one readline interface for the whole picker, and settle pending input on
// EOF/Ctrl-C so cancellation cannot fall through into credential activation.
function createQuestions(stdin, stdout) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  let pending;
  let closed = false;
  rl.on("close", () => {
    closed = true;
    pending?.(null);
    pending = null;
  });
  rl.on("SIGINT", () => rl.close());
  return {
    ask(message) {
      if (closed) return Promise.resolve(null);
      return new Promise((resolve) => {
        pending = resolve;
        rl.question(message, (answer) => {
          pending = null;
          resolve(answer);
        });
      });
    },
    close() { rl.close(); },
  };
}

export async function pickClaudeSession({
  homeDir,
  stdin = process.stdin,
  stdout = process.stdout,
  nowMs = Date.now(),
  promptLineImpl,
  listSessions = listRecentManagedClaudeSessions,
}) {
  if (!isInteractiveTerminal({ stdin, stdout })) {
    throw new Error("The Claude session picker needs an interactive terminal. Use `aim claude list`, then `aim claude resume <row-or-thread-id-or-name>`.");
  }
  let requested = 0;
  let sessions = [];
  let hasMore = true;
  const loadMore = () => {
    requested += LOAD_SIZE;
    const rows = listSessions({ homeDir, limit: requested });
    const known = new Set(sessions.map((session) => session.transcriptPath));
    // Claude also writes metadata-only files that cannot be resumed as a
    // conversation. Keep actual prompts/titles or recorded assistant turns.
    sessions = sessions.concat(rows.filter((session) => (
      !known.has(session.transcriptPath)
      && (session.description || session.threadName || session.model)
    )));
    hasMore = rows.length === requested;
  };
  while (sessions.length === 0 && hasMore) loadMore();
  if (sessions.length === 0) {
    stdout.write("No managed Claude sessions found on this machine.\n");
    return null;
  }
  let page = 0;
  const questions = promptLineImpl ? null : createQuestions(stdin, stdout);
  const ask = promptLineImpl ?? questions.ask;
  try {
    while (true) {
      const start = page * PAGE_SIZE;
      const visible = sessions.slice(start, start + PAGE_SIZE);
      const width = Math.max(30, Math.min(110, (stdout.columns ?? 100) - 7));
      stdout.write(`\nClaude sessions · newest first · ${start + 1}–${start + visible.length}\n\n`);
      for (const [offset, session] of visible.entries()) {
        const rank = start + offset + 1;
        const title = session.description ?? session.threadName ?? `Untitled session (${session.threadId.slice(0, 8)})`;
        const cwd = session.cwd === homeDir ? "~"
          : session.cwd.startsWith(`${homeDir}/`) ? `~/${session.cwd.slice(homeDir.length + 1)}` : session.cwd;
        const age = formatDurationRough(Math.max(0, nowMs - session.lastUsedMs));
        stdout.write(`  ${rank}. ${displayText(title, width)}\n`);
        stdout.write(`     ${age} ago · ${displayText(session.account, 40)} · ${displayText(cwd, width)}\n`);
        if (!session.model || !session.effort) {
          stdout.write("     No saved model/effort; requires --switch-account fable or opus.\n");
        }
      }
      const canNext = start + PAGE_SIZE < sessions.length || hasMore;
      const choices = [canNext ? "n: older" : null, page > 0 ? "p: newer" : null, "q/Enter: cancel"].filter(Boolean);
      const answer = await ask(`\nChoose a session number (${choices.join(", ")}): `);
      const choice = String(answer ?? "").trim().toLowerCase();
      if (!choice || choice === "q") {
        stdout.write("Resume cancelled.\n");
        return null;
      }
      if (choice === "p" && page > 0) {
        page -= 1;
        continue;
      }
      if (choice === "n" && canNext) {
        while (start + PAGE_SIZE >= sessions.length && hasMore) {
          // Preserve the displayed numbering even if another session advances
          // while the user is choosing. Resume is pinned to the chosen account/ID.
          loadMore();
        }
        if (start + PAGE_SIZE < sessions.length) page += 1;
        else stdout.write("No older sessions.\n");
        continue;
      }
      const index = /^\d+$/.test(choice) ? Number(choice) - 1 : -1;
      if (Number.isSafeInteger(index) && index >= start && index < start + visible.length) {
        return sessions[index];
      }
      stdout.write("Choose one of the displayed numbers or navigation keys.\n");
    }
  } finally {
    questions?.close();
  }
}
