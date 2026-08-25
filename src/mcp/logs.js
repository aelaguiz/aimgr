// Named log surface for the MCP `aim_log_tail` tool. The watcher and maintainer
// logs live at fixed paths on every pool machine, so agents can ask by name instead
// of memorizing paths. A missing log is a fact, not an error.

import fs from "node:fs";
import path from "node:path";

export const AIM_MCP_DEFAULT_TAIL_LINES = 200;
export const AIM_MCP_MAX_TAIL_LINES = 2_000;
export const AIM_MCP_MAX_TAIL_BYTES = 1_048_576;

export function buildAimLogMap({ homeDir }) {
  const aimgrLogsDir = path.join(homeDir, ".aimgr", "logs");
  return {
    "auth-maintainer": {
      out: path.join(aimgrLogsDir, "auth-maintainer.out.log"),
      err: path.join(aimgrLogsDir, "auth-maintainer.err.log"),
    },
    "codex-watch": {
      out: "/tmp/agents_host_aim_codex_watch.out.log",
      err: "/tmp/agents_host_aim_codex_watch.err.log",
    },
    "hermes-watch": {
      out: "/tmp/agents_host_aim_hermes_watch.out.log",
      err: "/tmp/agents_host_aim_hermes_watch.err.log",
    },
    "mcp-serve": {
      out: path.join(aimgrLogsDir, "mcp-serve.out.log"),
      err: path.join(aimgrLogsDir, "mcp-serve.err.log"),
    },
  };
}

export function statLogFile(filePath, { fsImpl = fs, nowMs = Date.now() } = {}) {
  try {
    const stats = fsImpl.statSync(filePath);
    return {
      path: filePath,
      present: true,
      sizeBytes: stats.size,
      mtime: new Date(stats.mtimeMs).toISOString(),
      ageSeconds: Math.max(0, Math.round((nowMs - stats.mtimeMs) / 1000)),
    };
  } catch {
    return { path: filePath, present: false };
  }
}

function readTailText(filePath, { fsImpl, sizeBytes }) {
  const readBytes = Math.min(sizeBytes, AIM_MCP_MAX_TAIL_BYTES);
  if (readBytes <= 0) return { text: "", bytesRead: 0 };
  const fd = fsImpl.openSync(filePath, "r");
  try {
    const buffer = Buffer.alloc(readBytes);
    fsImpl.readSync(fd, buffer, 0, readBytes, sizeBytes - readBytes);
    return { text: buffer.toString("utf8"), bytesRead: readBytes };
  } finally {
    fsImpl.closeSync(fd);
  }
}

function tailFile(filePath, { stream, lines, fsImpl, nowMs }) {
  const stat = statLogFile(filePath, { fsImpl, nowMs });
  if (!stat.present) return { stream, ...stat };
  const { text, bytesRead } = readTailText(filePath, { fsImpl, sizeBytes: stat.sizeBytes });
  const allLines = text.split("\n");
  if (allLines.length > 0 && allLines[allLines.length - 1] === "") allLines.pop();
  const tail = allLines.slice(-lines);
  return {
    stream,
    ...stat,
    bytesRead,
    lineCount: tail.length,
    text: tail.join("\n"),
  };
}

export function tailLog({ name, path: filePath, lines = AIM_MCP_DEFAULT_TAIL_LINES } = {}, {
  homeDir,
  logMap = buildAimLogMap({ homeDir }),
  fsImpl = fs,
  nowMs = Date.now(),
} = {}) {
  const requestedLines = Number(lines);
  if (!Number.isFinite(requestedLines) || requestedLines < 1) {
    throw new Error("lines must be a positive integer.");
  }
  const effectiveLines = Math.min(Math.floor(requestedLines), AIM_MCP_MAX_TAIL_LINES);
  const known = Object.keys(logMap).join(", ");

  if (name !== undefined && filePath !== undefined) {
    throw new Error(`Pass either name or path, not both. Known names: ${known}.`);
  }
  if (name !== undefined) {
    const entry = logMap[name];
    if (!entry) throw new Error(`Unknown log name: ${name}. Known names: ${known}.`);
    return {
      name,
      lines: effectiveLines,
      files: [
        tailFile(entry.out, { stream: "out", lines: effectiveLines, fsImpl, nowMs }),
        tailFile(entry.err, { stream: "err", lines: effectiveLines, fsImpl, nowMs }),
      ],
    };
  }
  if (filePath !== undefined) {
    if (!path.isAbsolute(String(filePath))) {
      throw new Error(`path must be absolute: ${filePath}`);
    }
    return {
      path: String(filePath),
      lines: effectiveLines,
      files: [tailFile(String(filePath), { stream: "file", lines: effectiveLines, fsImpl, nowMs })],
    };
  }
  throw new Error(`Pass a log name or an absolute path. Known names: ${known}.`);
}
