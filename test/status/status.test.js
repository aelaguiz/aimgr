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

test("status text keeps actionable warning identifiers from the JSON warning projection", () => {
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

  // The text renderer is the operator-facing warning surface. It must preserve
  // the same identifiers that make JSON warnings actionable: labels, Hermes
  // home ids, Claude override method/env names, and usage-scope blockers.
  assert.match(text, /- account_id_collision provider=openai-codex labels=alpha,beta accountId=acct_shared/);
  assert.match(text, /- hermes_home_auth_drifted system=hermes label=boss homeId=agent_boss matchMode=account_id/);
  assert.match(text, /- claude_target_env_override system=claude-cli label=boss authMethod=api_key env=ANTHROPIC_API_KEY/);
  assert.match(text, /- usage_scope_missing label=claude provider=anthropic status=403 missingScope=true/);
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
  assert.match(textOut, /- usage_scope_missing label=claude provider=anthropic status=403 missingScope=true/);
  assert.doesNotMatch(textOut, /ANTHROPIC_ACCESS_STATUS_SECRET/);
  assert.doesNotMatch(textOut, /ANTHROPIC_REFRESH_STATUS_SECRET/);
});
