import { DEFAULT_CODEX_WATCH_INTERVAL_SECONDS, DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT } from "./constants.js";

export function parseIntegerOption(rawValue, { name, minimum = 0, maximum = Number.POSITIVE_INFINITY } = {}) {
  const raw = String(rawValue ?? "").trim();
  if (!raw) {
    throw new Error(`Missing value for ${name}.`);
  }
  if (!/^-?\d+$/.test(raw)) {
    throw new Error(`Invalid ${name}: ${raw}. Expected an integer.`);
  }
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Invalid ${name}: ${raw}. Expected an integer between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

export function resolveCodexWatchIntervalSeconds(rawValue) {
  if (rawValue === undefined) return DEFAULT_CODEX_WATCH_INTERVAL_SECONDS;
  return parseIntegerOption(rawValue, {
    name: "--interval-seconds",
    minimum: 1,
    maximum: 86400,
  });
}

export function resolveCodexWatchThresholdPct(rawValue) {
  if (rawValue === undefined) return DEFAULT_CODEX_WATCH_ROTATE_BELOW_5H_REMAINING_PCT;
  return parseIntegerOption(rawValue, {
    name: "--rotate-below-5h-remaining-pct",
    minimum: 0,
    maximum: 100,
  });
}
