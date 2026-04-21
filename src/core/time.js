import { STATUS_RESET_FORMATTER } from "./constants.js";

export function formatTimestampForBackup(date = new Date()) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const pad3 = (n) => String(n).padStart(3, "0");
  const yyyy = String(date.getFullYear());
  const mm = pad2(date.getMonth() + 1);
  const dd = pad2(date.getDate());
  const hh = pad2(date.getHours());
  const mi = pad2(date.getMinutes());
  const ss = pad2(date.getSeconds());
  const ms = pad3(date.getMilliseconds());
  return `${yyyy}${mm}${dd}-${hh}${mi}${ss}${ms}`;
}

export function parseExpiresAtToMs(expiresAt) {
  const raw = String(expiresAt ?? "").trim();
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : null;
}

export function toIsoFromExpiresMs(expiresMs) {
  if (!Number.isFinite(Number(expiresMs))) return null;
  return new Date(Number(expiresMs)).toISOString();
}

export function formatDurationRough(ms) {
  const abs = Math.abs(ms);
  const sign = ms < 0 ? "-" : "";
  const minutes = Math.round(abs / 60000);
  if (minutes < 60) return `${sign}${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${sign}${hours}h`;
  const days = Math.round(hours / 24);
  return `${sign}${days}d`;
}

export function formatExpiresIn(expiresAt, now = Date.now()) {
  const ms = parseExpiresAtToMs(expiresAt);
  if (!ms) return "unknown";
  const delta = ms - now;
  if (delta <= 0) return `expired (${formatDurationRough(delta)})`;
  return formatDurationRough(delta);
}

export function formatAgeSince(isoTimestamp, now = Date.now()) {
  const ms = parseExpiresAtToMs(isoTimestamp);
  if (!ms) return "unknown";
  return formatDurationRough(now - ms);
}

export function formatResetAtForStatus(resetAt) {
  if (resetAt === undefined || resetAt === null) return null;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  return STATUS_RESET_FORMATTER.format(new Date(ms));
}

export function formatHoursUntilReset(resetAt, now = Date.now()) {
  if (resetAt === undefined || resetAt === null) return null;
  const ms = typeof resetAt === "number" ? resetAt : Number(resetAt);
  if (!Number.isFinite(ms)) return null;
  const deltaHours = (ms - now) / 3600000;
  const roundedHours = Math.abs(Math.round(deltaHours * 10) / 10).toFixed(1);
  if (deltaHours <= 0) return `${roundedHours}h ago`;
  return `${roundedHours}h left`;
}
