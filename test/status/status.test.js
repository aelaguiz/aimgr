import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { ensureAgyAccountMetadata } from "../../src/coordination/agy-metadata.js";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { supportsAgyPlatform } from "../../src/privacy/agy-artifacts.js";
import { readLocalAgyStatus } from "../../src/status/agy-view.js";
import { renderStatusText } from "../../src/status/render.js";
import { renderStatusCompactText } from "../../src/status/table.js";
import { writeLocalState } from "../../src/state/local-state.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
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
  assert.deepEqual(parsed.agy.connections, []);
  assert.doesNotMatch(out, /LEGACY_ACCESS_SECRET|LEGACY_REFRESH_SECRET|legacy-account|retired/);
});

test("status reports Antigravity grant state, launch readiness and shared labels", async (t) => {
  const home = mkTempHome();
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const root = path.join(home, ".aimgr", "agy");
  for (const label of ["connected", "signed-out", "invalid"]) {
    const dir = path.join(root, label);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(dir, "connection.json"), JSON.stringify({
      version: label === "invalid" ? 0 : 1,
      label,
      profileRef: "route-private-marker",
    }), { mode: 0o600 });
  }
  const grantDir = path.join(root, "connected", "home", ".gemini", "antigravity-cli");
  fs.mkdirSync(grantDir, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(grantDir, "antigravity-oauth-token"), "secret-native-grant-marker", { mode: 0o600 });

  const client = new FakeRedisClient();
  const keyPrefix = "aimgr:agy-status-test";
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fixture", keyPrefix } } });
  const connect = () => connectRedisStore({ client, keyPrefix });
  const store = await connect();
  await ensureAgyAccountMetadata(store, { label: "remote-only" });
  const cli = (format, connectRedisStoreImpl = connect) => runCli(["status", "--home", home, ...format], {
    connectRedisStoreImpl,
    fetchJsonWithTimeoutImpl: () => assert.fail("Status used provider networking"),
    readLocalAgyStatusImpl: (homeDir, options) => readLocalAgyStatus(homeDir, {
      ...options, runtimeRoot: path.join(home, "missing-runtime"),
    }),
  });
  const [json, text, compact] = await Promise.all([cli(["--json"]), cli([]), cli(["--compact"])]);
  const runtime = supportsAgyPlatform() ? "supported" : "unsupported";
  const { agy, pools } = JSON.parse(json);
  assert.equal(agy.runtime, runtime);
  assert.equal(agy.localState, "available");
  assert.deepEqual(agy.connections.map(({ label, status }) => ({ label, status })), [
    { label: "connected", status: "ready" },
    { label: "invalid", status: "invalid-state" },
    { label: "remote-only", status: "not-enrolled" },
    { label: "signed-out", status: "needs-sign-in" },
  ]);
  assert.deepEqual(pools.agy, {
    readings: "this machine",
    accountRows: agy.connections.map((connection) => ({ ...connection, observation: null })),
  });
  assert.match(text, /ANTIGRAVITY \(4\).*quota unavailable/);
  assert.match(text, /connected\s+local grant present/);
  assert.match(text, /signed-out\s+sign-in required/);
  assert.match(text, /invalid\s+invalid local state/);
  assert.match(text, /remote-only\s+not enrolled here/);
  assert.match(compact, /quota=unavailable\nagy\/connected=local-grant-present.*\nagy\/invalid=invalid-local-state.*\nagy\/remote-only=not-enrolled-here.*\nagy\/signed-out=sign-in-required/);
  for (const output of [json, text, compact]) assert.doesNotMatch(output, /route-private-marker|secret-native-grant-marker|antigravity-oauth-token/);

  const offline = JSON.parse(await cli(["--json"], async () => { throw new Error("fixture Redis outage"); }));
  assert.deepEqual(offline.agy, { ...agy, connections: agy.connections.filter(({ label }) => label !== "remote-only") });
  assert.ok(["cache", "unavailable"].includes(offline.redis.status));

  fs.chmodSync(root, 0o755);
  const unsafe = JSON.parse(await cli(["--json"]));
  assert.equal(unsafe.agy.runtime, runtime);
  assert.equal(unsafe.agy.localState, "unavailable");
  assert.deepEqual(unsafe.agy.connections.map(({ label, status }) => ({ label, status })), [{ label: "remote-only", status: "unknown" }]);
  assert.equal(unsafe.redis.status, "live");
  assert.ok(Array.isArray(unsafe.accounts));
  assert.equal(readLocalAgyStatus(home, { platform: "darwin", arch: "x64" }).runtime, "unsupported");

  fs.chmodSync(root, 0o700);
  await client.sAdd(store.keys.agyAccountLabels(), "private-roster-address@example.test");
  const corruptRoster = await cli(["--json"]);
  assert.doesNotMatch(corruptRoster, /private-roster-address/);
  assert.equal(JSON.parse(corruptRoster).redis.status, "live");
  assert.deepEqual(JSON.parse(corruptRoster).agy, offline.agy);
});

test("plain status shows coordination provenance and canonical account facts", () => {
  const nowMs = Date.parse("2026-07-23T20:00:00.000Z");
  const view = {
    nowMs,
    redis: { status: "live" },
    accountNotes: [],
    accounts: [{
      label: "boss",
      provider: "openai-codex",
      plan: "pro ($1.50)",
      operator: { status: "ready" },
      credentials: { expiresAt: new Date(nowMs + 8 * 86_400_000).toISOString(), expiresIn: "8d" },
      lock: { status: "free", source: "redis" },
      usage: {
        ok: true,
        source: "cache",
        resetCreditsAvailable: 3,
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
    }],
  };

  const text = renderStatusText(view, { claudeUsageStatus });

  assert.match(text, /^COORDINATION redis=live\n\nCODEX ACCOUNTS \(1\)/);
  assert.match(text, /resets\s+provider/);
  assert.match(text, /boss\s+ready\s+pro \(\$1\.50\)\s+free\s+--\s+8d\s+12%\s+2\.0h\s+3\s+openai-codex\s+cache/);
  assert.match(text, /\npool\s+--\s+--\s+--\s+--\s+8d\s+12%\s+2\.0h.*\nPool: 0\.5 Pro Max weeks \(a pro account counts 0\.46\) · 0\.1 used \(12%\) · 0\.4 left \(88%\)/);
  assert.match(text, /\npool\s+--\s+--\s+23%\s+--\s+45%\s+6\.0d\s+67%\s+--.*\nPool: 1\.0 Max 20x weeks · 0\.5 used \(45%\) · 0\.6 left \(55%\)/);
  assert.match(text, /CLAUDE: 0 ready · 0 limited · 1 in use · 0 needs you · 0 unknown/);
  assert.match(text, /pro7\s+IN USE\s+max\/max_20x\s+23%\s+3\.0h\s+45%\s+6\.0d\s+67%\s+6\.0d\s+--\s+--\s+2m\s+unknown\s+--\s+session active/);
  assert.doesNotMatch(text, /usage_readable|unpublished/);
  assert.match(text, /\nCODEX ACTIVE\nlabel=boss\s+wk_used=12%\s+wk_in=2\.0h\n\nCLAUDE LAST RUN\nlabel=pro7\n$/);
  assert.doesNotMatch(text, /POOL NOW|PRESSURE|PROJECTION|NEXT BEST|WARNINGS|requests=|cache_state=/);
});

test("pool capacity reports weighted weekly resets for visible accounts with readings", () => {
  const nowMs = Date.parse("2026-07-23T20:00:00.000Z");
  const hour = 3_600_000;
  const codex = (label, status, usedPercent, resetInMs) => ({
    label,
    provider: "openai-codex",
    plan: label === "half" ? "pro" : "promax",
    operator: { status },
    credentials: {},
    lock: { status: "free" },
    usage: { ok: true, source: "cache", windows: [{ usedPercent, resetAt: nowMs + resetInMs }] },
  });
  const claude = (label, windows) => ({
    label,
    subscriptionType: "max",
    authState: "usage_readable",
    credentialState: "credential_ready",
    credentialReady: true,
    locked: false,
    source: "cache",
    ageMs: 0,
    usage: { ok: windows.length > 0, windows },
  });
  const view = {
    nowMs,
    redis: { status: "live" },
    accounts: [
      codex("full", "ready", 100, 3 * hour),
      codex("half", "reauth", 50, 23 * hour),
      codex("later", "ready", 60, 30 * hour),
      codex("blocked", "blocked", 90, 1 * hour),
    ],
  };
  const claudeUsageStatus = {
    checkedAtMs: nowMs,
    accounts: [
      claude("soon", [
        { label: "5h", kind: "session", usedPercent: 80, resetAt: nowMs + 1 * hour },
        { label: "Week", kind: "weekly_all", usedPercent: 100, resetAt: nowMs + 10 * hour },
      ]),
      claude("later", [{ label: "Week", kind: "weekly_all", usedPercent: 40, resetAt: nowMs + 3 * 24 * hour }]),
      claude("unread", []),
    ],
  };

  const text = renderStatusText(view, { claudeUsageStatus });

  assert.match(text, /\nPool: 2\.5 Pro Max weeks \(a pro account counts 0\.46\) · 1\.8 used \(74%\) · 0\.6 left \(26%\)/);
  assert.match(text, /\nComes back: 1\.0 in 6h · 1\.0 in 12h · 1\.2 in 24h · 1\.8 in 2d · 1\.8 in 3d · 1\.8 in 5d · half of what's used within 3\.0h\n/);
  assert.match(text, /\nPool: 2\.0 Max 20x weeks · 1\.4 used \(70%\) · 0\.6 left \(30%\)/);
  assert.match(text, /\nComes back: 0\.0 in 6h · 1\.0 in 12h · 1\.0 in 24h · 1\.0 in 2d · 1\.4 in 3d · 1\.4 in 5d · half of what's used within 10\.0h\nNot counted: 1 account without a reading\nPlans with no measured size, counted as 1: max\n/);
});

test("compact status is limited to coordination, account count, and local targets", () => {
  const text = renderStatusCompactText({
    redis: { status: "cache", cacheAgeMs: 65_000 },
    accounts: [{}, {}],
    codexCli: { inferredLabel: "boss" },
    claudeCli: { lastRunLabel: "writer" },
  });

  assert.equal(text, "redis=cache  accounts=2  codex=boss  claude_last=writer  cache_age=65s\naccount notes unavailable (Redis could not be read)\n");
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
