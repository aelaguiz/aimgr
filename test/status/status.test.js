import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderStatusText } from "../../src/status/render.js";
import { renderStatusCompactText } from "../../src/status/table.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

test("unconfigured status ignores legacy secrets and reports local target facts", async () => {
  const home = mkTempHome();
  writeJson(path.join(home, ".aimgr", "secrets.json"), {
    accounts: { retired: { provider: "openai-codex" } },
    credentials: {
      "openai-codex": {
        retired: {
          access: "LEGACY_ACCESS_SECRET",
          refresh: "LEGACY_REFRESH_SECRET",
          accountId: "legacy-account",
        },
      },
    },
  });
  writeLocalState({
    homeDir: home,
    localState: {
      targets: {
        codexCli: { activeLabel: "boss" },
        claudeCli: { lastRunLabel: "writer" },
      },
    },
  });

  const out = await runCli(["status", "--json", "--home", home]);
  const parsed = JSON.parse(out);

  assert.equal(parsed.redis.status, "unconfigured");
  assert.equal(parsed.codexCli.activeLabel, "boss");
  assert.equal(parsed.claudeCli.lastRunLabel, "writer");
  assert.deepEqual(parsed.accounts, []);
  assert.doesNotMatch(out, /LEGACY_ACCESS_SECRET|LEGACY_REFRESH_SECRET|legacy-account|retired/);
});

test("plain status shows coordination provenance, canonical account facts, and local projection state", () => {
  const nowMs = Date.parse("2026-07-23T20:00:00.000Z");
  const view = {
    nowMs,
    redis: { status: "live" },
    accounts: [{
      label: "boss",
      provider: "openai-codex",
      operator: { status: "ready" },
      credentials: { expiresIn: "8d" },
      lock: { status: "free", source: "redis" },
      usage: {
        ok: true,
        source: "cache",
        windows: [
          { usedPercent: 12, resetAt: nowMs + 2 * 3_600_000 },
          { usedPercent: 34, resetAt: nowMs + 5 * 86_400_000 },
        ],
      },
    }],
    codexCli: { activeLabel: "boss" },
    claudeCli: { lastRunLabel: "pro7" },
  };
  const claudeUsageStatus = {
    checkedAtMs: nowMs,
    accounts: [{
      label: "pro7",
      subscriptionType: "max",
      rateLimitTier: "max_20x",
      authState: "usage_readable",
      usage: {
        ok: true,
        windows: [
          { label: "5h", kind: "session", usedPercent: 23, resetAt: nowMs + 3 * 3_600_000 },
          { label: "Week", kind: "weekly_all", usedPercent: 45, resetAt: nowMs + 6 * 86_400_000 },
          { label: "Fable", kind: "weekly_scoped", usedPercent: 67, resetAt: nowMs + 6 * 86_400_000 },
        ],
      },
      source: "cache",
      ageMs: 120_000,
      credentialReady: true,
      credentialState: "credential_ready",
      locked: true,
      rotationPending: false,
      localProjection: { state: "unpublished" },
    }],
  };

  const text = renderStatusText(view, { claudeUsageStatus });

  assert.match(text, /^COORDINATION redis=live\n\nCODEX ACCOUNTS \(1\)/);
  assert.match(text, /boss\s+ready\s+free\s+--\s+8d\s+12%\s+2\.0h\s+34%\s+5\.0d\s+openai-codex\s+cache/);
  assert.match(text, /CLAUDE: 0 ready · 1 in use · 0 AIM fixing · 0 needs you · 0 unknown/);
  assert.match(text, /pro7\s+IN USE\s+23%\s+3\.0h\s+45%\s+6\.0d\s+67%\s+6\.0d\s+--\s+--\s+2m\s+session active/);
  assert.doesNotMatch(text, /usage_readable|unpublished/);
  assert.match(text, /\nCODEX ACTIVE\nlabel=boss .*\n\nCLAUDE LAST RUN\nlabel=pro7\n$/);
  assert.doesNotMatch(text, /POOL NOW|PRESSURE|PROJECTION|NEXT BEST|WARNINGS|requests=|cache_state=/);
});

test("compact status is limited to coordination, account count, and local targets", () => {
  const text = renderStatusCompactText({
    redis: { status: "cache", cacheAgeMs: 65_000 },
    accounts: [{}, {}],
    codexCli: { inferredLabel: "boss" },
    claudeCli: { lastRunLabel: "writer" },
  });

  assert.equal(text, "redis=cache  accounts=2  codex=boss  claude_last=writer  cache_age=65s\n");
});

test("status reports the Codex identity actually present in the native auth file", () => {
  const text = renderStatusCompactText({
    redis: { status: "live" },
    accounts: [{}, {}],
    codexCli: { activeLabel: "boss", inferredLabel: "pro3" },
    claudeCli: {},
  });

  assert.match(text, /codex=pro3/);
  assert.doesNotMatch(text, /codex=boss/);
});
