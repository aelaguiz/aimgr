import fs from "node:fs";
import path from "node:path";
import { resolveAimgrStateDir } from "../io/paths.js";

function isPidAlive(pid) {
  const normalized = Number(pid);
  if (!Number.isInteger(normalized) || normalized <= 0) return false;
  try {
    process.kill(normalized, 0);
    return true;
  } catch (err) {
    return err?.code === "EPERM";
  }
}

function lockPathForThread({ homeDir, threadId }) {
  return path.join(resolveAimgrStateDir({ homeDir }), "codex-tend-locks", `${threadId}.json`);
}

function readLock(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function acquireCodexTendThreadLock({
  homeDir,
  threadId,
  runid,
  originator,
  cwd,
  mode,
  now = () => new Date(),
  pid = process.pid,
}) {
  const filePath = lockPathForThread({ homeDir, threadId });
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const payload = {
    pid,
    threadId,
    runid,
    originator,
    cwd,
    mode,
    startedAt: now().toISOString(),
  };

  while (true) {
    let fd = null;
    try {
      fd = fs.openSync(filePath, "wx", 0o600);
      fs.writeFileSync(fd, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
      break;
    } catch (err) {
      if (err?.code !== "EEXIST") throw err;
      const existing = readLock(filePath);
      if (existing && isPidAlive(existing.pid)) {
        return {
          status: "blocked",
          reason: "thread_already_tended",
          path: filePath,
          existing,
        };
      }
      try {
        fs.unlinkSync(filePath);
      } catch (unlinkErr) {
        if (unlinkErr?.code !== "ENOENT") throw unlinkErr;
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  let released = false;
  return {
    status: "acquired",
    path: filePath,
    payload,
    release() {
      if (released) return;
      released = true;
      try {
        const current = readLock(filePath);
        if (!current || (current.pid === pid && current.runid === runid && current.threadId === threadId)) {
          fs.unlinkSync(filePath);
        }
      } catch (err) {
        if (err?.code !== "ENOENT") throw err;
      }
    },
  };
}
