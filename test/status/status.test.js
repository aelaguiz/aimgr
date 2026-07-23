import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { renderStatusText } from "../../src/status/render.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("status --json redacts durable Codex secrets from the CLI boundary", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const jwt = makeFakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_status",
      chatgpt_plan_type: "plus",
    },
  });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      status_label: {
        provider: "openai-codex",
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        status_label: {
          access: jwt,
          refresh: "REFRESH_STATUS_SECRET",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_status",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const out = await runCli(["status", "--json", "--home", home], {
    probeUsageSnapshotsByProviderImpl: async () => ({ "openai-codex": {} }),
  });

  assert.doesNotMatch(out, /REFRESH_STATUS_SECRET/);
  assert.doesNotMatch(out, new RegExp(jwt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  const parsed = JSON.parse(out);
  assert.equal(parsed.accounts[0].label, "status_label");
  assert.equal(parsed.accounts[0].identity.accountId, "acct_status");
});

test("plain status text contains only Codex accounts, Claude usage, and active labels", () => {
  const nowMs = Date.parse("2026-07-23T20:00:00.000Z");
  const text = renderStatusText({
    statePath: "redis:aimgr:v1:",
    nowMs,
    accounts: [{
      label: "boss",
      provider: "openai-codex",
      operator: { status: "ready" },
      login: { mode: "manual-callback" },
      credentials: { expiresIn: "8d" },
      usage: {
        ok: true,
        windows: [
          { usedPercent: 12, resetAt: nowMs + 2 * 3_600_000 },
          { usedPercent: 34, resetAt: nowMs + 5 * 86_400_000 },
        ],
      },
    }],
    codexCli: { activeLabel: "boss" },
    claudeCli: { activeLabel: "pro7" },
    openclaw: { assignments: {} },
    warnings: [{ kind: "unused_warning" }],
    pool_now: { ready_accounts: 1 },
    windows: { pool_5h_used_pct: 12 },
    pressure: { recent_overflows_14d: 0 },
    projection: { first_constraint: "5h" },
    nextBestCandidate: { label: "other" },
  }, {
    claudeUsageStatus: {
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
            { label: "Week", kind: "weekly", usedPercent: 45, resetAt: nowMs + 6 * 86_400_000 },
            { label: "Fable", kind: "weekly_scoped", usedPercent: 67, resetAt: nowMs + 6 * 86_400_000 },
          ],
        },
        source: "cache",
      }],
      requestCount: 0,
      cacheTtlSeconds: 300,
      staleMaxSeconds: 3600,
      cacheState: "ready",
      cacheWriteFailed: false,
    },
  });

  assert.match(text, /^CODEX ACCOUNTS \(1\)\n/);
  assert.match(text, /\nCLAUDE ACCOUNT USAGE \(1\)\n/);
  assert.match(text, /boss\s+ready\s+manual-callback\s+8d\s+12%\s+2\.0h\s+34%\s+5\.0d\s+openai-codex/);
  assert.match(text, /pro7\s+max\/max_20x\s+usage_readable\s+23%\s+3\.0h\s+45%\s+6\.0d\s+67%\s+6\.0d/);
  assert.match(
    text,
    /\nCODEX ACTIVE\nlabel=boss  5h_used=12%  5h_in=2\.0h  wk_used=34%  wk_in=5\.0d\n\nCLAUDE ACTIVE\nlabel=pro7\n$/,
  );
  assert.doesNotMatch(
    text,
    /aim SSOT|POOL NOW|WINDOWS|PRESSURE|PROJECTION @ CURRENT RATE|HERMES|NEXT BEST CODEX|WARNINGS|requests=|cache_state=/,
  );
});

test("plain status text suppresses warning details retained by the JSON projection", () => {
  const text = renderStatusText({
    statePath: "/tmp/aimgr/secrets.json",
    nowMs: Date.parse("2026-04-20T18:00:00Z"),
    accounts: [],
    imports: { authority: { codex: {}, anthropic: {} } },
    pool_now: {},
    windows: {},
    pressure: {},
    projection: {},
    openclaw: { assignments: {} },
    warnings: [
      { kind: "account_id_collision", provider: "openai-codex", accountId: "acct_shared", labels: ["alpha", "beta"] },
      { kind: "hermes_home_auth_drifted", system: "hermes", homeId: "agent_boss", label: "boss", matchMode: "account_id" },
      { kind: "claude_target_env_override", system: "claude-cli", label: "boss", authMethod: "api_key", env: ["ANTHROPIC_API_KEY"] },
      { kind: "usage_scope_missing", provider: "anthropic", label: "claude", status: 403, missingScope: true },
    ],
  });

  assert.doesNotMatch(
    text,
    /WARNINGS|account_id_collision|hermes_home_auth_drifted|claude_target_env_override|usage_scope_missing/,
  );
});

test("status warns when Anthropic usage is blocked by missing OAuth scope", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      claude: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        claude: buildAnthropicClaudeCredential({
          access: "ANTHROPIC_ACCESS_STATUS_SECRET",
          refresh: "ANTHROPIC_REFRESH_STATUS_SECRET",
          expiresAtMs: Date.now() + 3600_000,
        }),
      },
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const probeUsageSnapshotsByProviderImpl = async () => ({
    "openai-codex": {},
    anthropic: {
      claude: {
        provider: "anthropic",
        ok: false,
        status: 403,
        missingScope: true,
        error: "OAuth token missing scope requirement user:profile",
      },
    },
  });

  const jsonOut = await runCli(["status", "--json", "--home", home], { probeUsageSnapshotsByProviderImpl });
  const parsed = JSON.parse(jsonOut);
  const warning = parsed.warnings.find((entry) => entry.kind === "usage_scope_missing");

  // Missing Anthropic usage scope is not an expired token, but it still blocks a
  // trusted capacity projection and should be visible as a repair warning.
  assert.deepEqual(warning, {
    kind: "usage_scope_missing",
    provider: "anthropic",
    label: "claude",
    missingScope: true,
    status: 403,
  });
  assert.doesNotMatch(jsonOut, /ANTHROPIC_ACCESS_STATUS_SECRET/);
  assert.doesNotMatch(jsonOut, /ANTHROPIC_REFRESH_STATUS_SECRET/);

  const textOut = await runCli(["status", "--home", home], { probeUsageSnapshotsByProviderImpl });
  assert.doesNotMatch(textOut, /WARNINGS|usage_scope_missing/);
  assert.match(textOut, /\nCLAUDE ACCOUNTS \(1\)\n/);
  assert.doesNotMatch(textOut, /ANTHROPIC_ACCESS_STATUS_SECRET/);
  assert.doesNotMatch(textOut, /ANTHROPIC_REFRESH_STATUS_SECRET/);
});
