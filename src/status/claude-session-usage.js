import fs from "node:fs";
import { resolveAimgrClaudeSessionUsagePath } from "../io/paths.js";

const MAX_SESSION_USAGE_BYTES = 256 * 1024;

function readWindow(value, { label, kind }) {
  const usedPercent = Number(value?.used_percentage);
  if (!Number.isFinite(usedPercent)) return null;
  const resetsAtSeconds = Number(value?.resets_at);
  return {
    label,
    kind,
    usedPercent: Math.max(0, Math.min(100, usedPercent)),
    ...(Number.isFinite(resetsAtSeconds) && resetsAtSeconds > 0 ? { resetAt: resetsAtSeconds * 1000 } : {}),
    active: true,
  };
}

/**
 * Reads the usage each running managed Claude session last saw on its own
 * responses (written by the status-line tap). These readings cost no provider
 * request. Returns label -> { observedAtMs, windows } for readable files only;
 * the file's write time is when the session last saw that usage.
 */
export function readClaudeSessionUsage({ homeDir, labels, nowMs = Date.now(), fsImpl = fs } = {}) {
  const readings = new Map();
  for (const label of Array.isArray(labels) ? labels : []) {
    let filePath;
    try {
      filePath = resolveAimgrClaudeSessionUsagePath({ homeDir, label });
      const stat = fsImpl.lstatSync(filePath);
      if (!stat.isFile() || stat.size > MAX_SESSION_USAGE_BYTES) continue;
      const rateLimits = JSON.parse(fsImpl.readFileSync(filePath, "utf8"))?.rate_limits;
      const windows = [
        readWindow(rateLimits?.five_hour, { label: "5h", kind: "session" }),
        readWindow(rateLimits?.seven_day, { label: "Week", kind: "weekly_all" }),
      ].filter(Boolean);
      const observedAtMs = Math.min(Math.floor(stat.mtimeMs), nowMs);
      if (windows.length === 0 || !(observedAtMs > 0)) continue;
      readings.set(label, { observedAtMs, windows });
    } catch {
      // A missing, partial, or foreign file is simply no reading.
    }
  }
  return readings;
}
