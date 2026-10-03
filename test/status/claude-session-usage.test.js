import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveAimgrClaudeSessionUsagePath } from "../../src/io/paths.js";
import { readClaudeSessionUsage } from "../../src/status/claude-session-usage.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-10-02T18:00:00.000Z");

function writeReading(homeDir, label, value, atMs = NOW_MS - 60_000) {
  const filePath = resolveAimgrClaudeSessionUsagePath({ homeDir, label });
  if (typeof value === "string") {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, value);
  } else {
    writeJson(filePath, value);
  }
  fs.utimesSync(filePath, new Date(atMs), new Date(atMs));
  return filePath;
}

test("session usage readings become five-hour and weekly windows stamped with the write time", () => {
  const homeDir = mkTempHome();
  writeReading(homeDir, "alpha", {
    rate_limits: {
      five_hour: { used_percentage: 12.5, resets_at: 1_790_000_000 },
      seven_day: { used_percentage: 140 },
    },
  });
  const readings = readClaudeSessionUsage({ homeDir, labels: ["alpha", "missing"], nowMs: NOW_MS });
  assert.deepEqual([...readings.keys()], ["alpha"]);
  assert.deepEqual(readings.get("alpha"), {
    observedAtMs: NOW_MS - 60_000,
    windows: [
      { label: "5h", kind: "session", usedPercent: 12.5, resetAt: 1_790_000_000_000, active: true },
      { label: "Week", kind: "weekly_all", usedPercent: 100, active: true },
    ],
  });
});

test("partial, foreign, oversized, future-dated, and linked files are no reading", () => {
  const homeDir = mkTempHome();
  writeReading(homeDir, "partial", "{\"rate_limits\": {\"five_hour\"");
  writeReading(homeDir, "empty", { rate_limits: { five_hour: { used_percentage: "lots" } } });
  writeReading(homeDir, "oversized", `{"rate_limits":{"five_hour":{"used_percentage":1}},"pad":"${"x".repeat(300_000)}"}`);
  writeReading(homeDir, "future", { rate_limits: { five_hour: { used_percentage: 5 } } }, NOW_MS + 60 * 60_000);
  const target = writeReading(homeDir, "target", { rate_limits: { five_hour: { used_percentage: 9 } } });
  const linked = resolveAimgrClaudeSessionUsagePath({ homeDir, label: "linked" });
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(target, linked);

  const readings = readClaudeSessionUsage({
    homeDir,
    labels: ["partial", "empty", "oversized", "future", "linked"],
    nowMs: NOW_MS,
  });
  assert.deepEqual([...readings.keys()], ["future"]);
  assert.equal(readings.get("future").observedAtMs, NOW_MS);
});
