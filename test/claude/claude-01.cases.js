import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseAnthropicAuthorizationPaste } from "../../src/credentials/oauth.js";
import { derivePoolAccountStatus } from "../../src/pool/account-status.js";
import { parseArgs } from "../../src/cli/args.js";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { installFakeClaude } from "../helpers/fakes.js";
import { mkTempHome, withEnv, writeJson } from "../helpers/files.js";

test("plain status shows provider account tables and active labels", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const nowMs = Date.parse("2026-03-17T20:15:21Z");
  const codexFiveHourReset = "2026-03-17T21:45:21Z";
  const codexWeekReset = "2026-03-18T17:00:45Z";
  const claudeFiveHourReset = "2026-03-17T22:10:00Z";
  const claudeWeekReset = "2026-03-19T00:00:00Z";

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", browser: {}, reauth: { mode: "aim-browser-profile" } },
      claude: { provider: "anthropic", browser: {}, reauth: { mode: "aim-browser-profile" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(nowMs + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claude: buildAnthropicClaudeCredential({
          access: "ANTHROPIC_ACCESS",
          refresh: "ANTHROPIC_REFRESH",
          expiresAtMs: nowMs + 3600_000,
        }),
      },
    },
    imports: { authority: { codex: {} } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  const fetchImpl = async (url) => {
    const u = String(url ?? "");

    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 10,
              limit_window_seconds: 18000,
              reset_at: Math.floor(Date.parse(codexFiveHourReset) / 1000),
            },
            secondary_window: {
              used_percent: 20,
              limit_window_seconds: 604800,
              reset_at: Math.floor(Date.parse(codexWeekReset) / 1000),
            },
          },
        }),
      };
    }

    if (u.includes("api.anthropic.com/api/oauth/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          five_hour: { utilization: 12, resets_at: claudeFiveHourReset },
          seven_day: { utilization: 34, resets_at: claudeWeekReset },
          seven_day_opus: { utilization: 44 },
        }),
      };
    }

    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  const nowImpl = () => nowMs;

  const out = await runCli(["status", "--home", home], { fetchImpl, nowImpl });
  assert.doesNotMatch(out, /Usage detail/);
  assert.doesNotMatch(out, /usage=5h/);
  assert.match(out, /^CODEX ACCOUNTS \(1\)/);
  assert.match(out, /\nCLAUDE ACCOUNTS \(1\)/);
  assert.match(out, /average\s+--\s+--\s+\S+\s+10%\s+1\.5h\s+20%\s+20\.8h\s+all\s+-/);
  assert.match(out, /average\s+--\s+--\s+\S+\s+12%\s+1\.9h\s+34%\s+27\.7h\s+all\s+-/);
  assert.match(
    out,
    /\nCODEX ACTIVE\nlabel=boss  5h_used=10%  5h_in=1\.5h  wk_used=20%  wk_in=20\.8h\n\nCLAUDE ACTIVE\nlabel=none\n$/,
  );
  assert.doesNotMatch(out, /aim SSOT|POOL NOW|WINDOWS|PRESSURE|PROJECTION @ CURRENT RATE|WARNINGS/);

  const accountsOut = await runCli(["status", "--accounts", "--home", home], { fetchImpl, nowImpl });
  assert.match(accountsOut, /^CODEX ACCOUNTS \(1\)/);
  assert.match(accountsOut, /\nCLAUDE ACCOUNTS \(1\)/);
  assert.match(accountsOut, /label\s+st\s+login\s+exp\s+5h_used\s+5h_in\s+wk_used\s+wk_in\s+provider\s+flags/);
  assert.match(accountsOut, /boss\s+ready\s+aim-profile\s+\S+\s+10%\s+1\.5h\s+20%\s+20\.8h\s+openai-codex/);
  assert.match(accountsOut, /claude\s+ready\s+native-claude\s+\S+\s+12%\s+1\.9h\s+34%\s+27\.7h\s+anthropic/);
  assert.doesNotMatch(accountsOut, /POOL NOW|WINDOWS|PROJECTION @ CURRENT RATE/);

  const compactOut = await runCli(["status", "--compact", "--home", home], { fetchImpl, nowImpl });
  assert.match(compactOut, /^load=/);
  assert.match(compactOut, /spare=/);
  assert.match(compactOut, /5h_floor=/);
  assert.match(compactOut, /7d_floor=/);
  assert.match(compactOut, /eta=/);
});

test("parseAnthropicAuthorizationPaste accepts callback URLs and code#state", () => {
  assert.equal(
    parseAnthropicAuthorizationPaste(
      "https://console.anthropic.com/oauth/code/callback?code=CODE123&state=STATE456",
    ),
    "CODE123#STATE456",
  );

  assert.equal(parseAnthropicAuthorizationPaste("CODE123#STATE456"), "CODE123#STATE456");

  assert.equal(parseAnthropicAuthorizationPaste("code=CODE123&state=STATE456"), "CODE123#STATE456");

  assert.throws(() => parseAnthropicAuthorizationPaste("https://console.anthropic.com/oauth/code/callback?code=CODE123"));
});

test("help text prefers Redis primary-host setup over authority sync examples", async () => {
  const out = await runCli([]);
  assert.match(out, /aim redis configure --url <redis-url>/);
  assert.match(out, /aim auth maintain\s+# refresh due Redis-backed Claude and Codex OAuth credentials once/);
  assert.match(
    out,
    /aim claude resume <row-or-thread-id-or-name> \[--account <label>\] \[--switch-account fable\|opus\]/,
  );
  assert.match(out, /aim claude run \(opus\|fable\) \[--resume\]/);
  assert.match(out, /aim claude run <label> \(opus\|fable\) \[--resume\]/);
  assert.match(out, /aim claude run <label> \[-- <claude args\.\.\.>\]\s+# project the Redis-backed Claude label into a per-label home and launch Claude/);
  assert.match(out, /aim pi use\s+# activate the next-best pooled openai-codex label for local Pi CLI/);
  assert.match(out, /--primary-host <host>\s+Human-readable Redis primary host, e\.g\. agents@amirs-mac-studio/);
  assert.match(out, /redis:\/\/amirs-mac-studio:6380/);
  assert.doesNotMatch(out, /Examples: agents@amirs-mac-studio/);
  assert.doesNotMatch(out, /ssh:\/\/agents@amirs-mac-studio\/~\/\.aimgr\/secrets\.json/);
});

test("Claude run presets expand into the existing explicit passthrough boundary", () => {
  const automaticOpus = parseArgs(["claude", "run", "opus", "--resume"]);
  assert.deepEqual(automaticOpus.positional, ["claude", "run"]);
  assert.equal(automaticOpus.opts.claudeAutoSelect, true);
  assert.equal(automaticOpus.opts.claudeAutoSelectPreset, "opus");
  assert.deepEqual(automaticOpus.opts.afterDoubleDash, [
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--effort",
    "max",
    "--resume",
  ]);

  const automaticFable = parseArgs(["claude", "run", "fable"]);
  assert.deepEqual(automaticFable.positional, ["claude", "run"]);
  assert.equal(automaticFable.opts.claudeAutoSelect, true);
  assert.equal(automaticFable.opts.claudeAutoSelectPreset, "fable");
  assert.deepEqual(automaticFable.opts.afterDoubleDash, [
    "--dangerously-skip-permissions",
    "--model",
    "claude-fable-5",
    "--effort",
    "xhigh",
  ]);

  const opus = parseArgs(["claude", "run", "pro7", "opus", "--resume"]);
  assert.deepEqual(opus.positional, ["claude", "run", "pro7"]);
  assert.equal(opus.opts.claudeAutoSelect, false);
  assert.equal(opus.opts.claudeAutoSelectPreset, null);
  assert.deepEqual(opus.opts.afterDoubleDash, [
    "--dangerously-skip-permissions",
    "--model",
    "opus",
    "--effort",
    "max",
    "--resume",
  ]);

  const fable = parseArgs(["claude", "run", "pro8", "fable"]);
  assert.deepEqual(fable.positional, ["claude", "run", "pro8"]);
  assert.equal(fable.opts.claudeAutoSelectPreset, null);
  assert.deepEqual(fable.opts.afterDoubleDash, [
    "--dangerously-skip-permissions",
    "--model",
    "claude-fable-5",
    "--effort",
    "xhigh",
  ]);

  const explicit = parseArgs(["claude", "run", "pro9", "--", "--model", "sonnet"]);
  assert.deepEqual(explicit.positional, ["claude", "run", "pro9"]);
  assert.equal(explicit.opts.claudeAutoSelect, false);
  assert.deepEqual(explicit.opts.afterDoubleDash, ["--model", "sonnet"]);
  assert.equal(explicit.opts.claudeAutoSelectPreset, null);
});

test("Claude resume accepts an exact destination account and only supported model presets", () => {
  const fable = parseArgs([
    "claude",
    "resume",
    "36",
    "--account",
    "pro2",
    "--switch-account",
    "fable",
  ]);
  assert.deepEqual(fable.positional, ["claude", "resume", "36"]);
  assert.equal(fable.opts.claudeResumeAccountLabel, "pro2");
  assert.equal(fable.opts.claudeResumeSwitchAccountPreset, "fable");

  const opus = parseArgs([
    "claude",
    "resume",
    "thread-id",
    "--switch-account",
    "opus",
  ]);
  assert.equal(opus.opts.claudeResumeSwitchAccountPreset, "opus");

  assert.throws(
    () => parseArgs(["claude", "resume", "36", "--switch-account", "sonnet"]),
    /--switch-account requires fable or opus/,
  );
  assert.throws(
    () => parseArgs(["claude", "resume", "36", "--switch-account"]),
    /--switch-account requires fable or opus/,
  );
  assert.throws(
    () => parseArgs(["claude", "run", "pro7", "--switch-account", "fable"]),
    /Unknown option: --switch-account/,
  );
  assert.throws(
    () => parseArgs(["claude", "resume", "36", "--account"]),
    /--account requires a Claude account label/,
  );
  assert.throws(
    () => parseArgs(["claude", "run", "pro7", "--account", "pro2"]),
    /Unknown option: --account/,
  );
});

test("Claude run rejects an unknown preset before Redis or launch work", async () => {
  const home = mkTempHome();
  await assert.rejects(
    () => runCli(["claude", "run", "pro7", "opuz"], {
      env: { HOME: home },
    }),
    /Unknown Claude run preset: opuz/,
  );
});

test("anthropic label maintenance captures the current native Claude login without OAuth flow", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_BOSS",
    refreshToken: "REFRESH_BOSS",
    subscriptionType: "claude_max",
    rateLimitTier: "oauth_claude_max",
    oauthAccount: {
      emailAddress: "boss@example.com",
      organizationName: "Boss Org",
      organizationUuid: "org_boss",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const out = JSON.parse(await runCli(["boss", "--home", home]));

  assert.equal(out.ok, true);
  assert.equal(out.maintenance.status, "ready");

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.credentials.anthropic.boss.access, "ACCESS_BOSS");
  assert.equal(updatedState.credentials.anthropic.boss.refresh, "REFRESH_BOSS");
  assert.equal(updatedState.credentials.anthropic.boss.subscriptionType, "claude_max");
  assert.equal(updatedState.credentials.anthropic.boss.rateLimitTier, "oauth_claude_max");
  assert.equal(updatedState.credentials.anthropic.boss.emailAddress, "boss@example.com");
  assert.equal(updatedState.credentials.anthropic.boss.organizationName, "Boss Org");
  assert.equal(updatedState.credentials.anthropic.boss.organizationUuid, "org_boss");
  assert.equal(updatedState.credentials.anthropic.boss.nativeClaudeBundle.claudeAiOauth.accessToken, "ACCESS_BOSS");
  assert.equal(updatedState.credentials.anthropic.boss.nativeClaudeBundle.oauthAccount.emailAddress, "boss@example.com");
  assert.equal(updatedState.accounts.boss.reauth.mode, "native-claude");
  // Native Claude labels must stay out of the browser reauth path after successful maintenance;
  // a stray browser object can make later status/control-panel surfaces suggest the wrong reauth substrate.
  assert.equal(updatedState.accounts.boss.browser, null);
});

test("aim claude capture-native initializes first-time Claude account maintenance state", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeClaudeNativeBundle(home, {
    accessToken: "ACCESS_FIRST",
    refreshToken: "REFRESH_FIRST",
    oauthAccount: {
      emailAddress: "first@example.com",
      organizationName: "First Org",
      organizationUuid: "org_first",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {},
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const out = JSON.parse(await runCli(["claude", "capture-native", "first", "--home", home]));
  assert.equal(out.ok, true);
  assert.equal(out.captured.label, "first");
  assert.equal(out.captured.emailAddress, "first@example.com");

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.accounts.first.provider, "anthropic");
  assert.equal(updatedState.accounts.first.reauth.mode, "native-claude");
  assert.equal(typeof updatedState.accounts.first.reauth.lastAttemptAt, "string");
  assert.equal(updatedState.accounts.first.reauth.lastVerifiedAt, updatedState.accounts.first.reauth.lastAttemptAt);
  assert.equal(updatedState.credentials.anthropic.first.access, "ACCESS_FIRST");
  assert.equal(updatedState.credentials.anthropic.first.refresh, "REFRESH_FIRST");
  assert.equal(updatedState.credentials.anthropic.first.emailAddress, "first@example.com");
  assert.equal(updatedState.credentials.anthropic.first.organizationName, "First Org");
  assert.equal(updatedState.credentials.anthropic.first.organizationUuid, "org_first");
});

test("derivePoolAccountStatus ignores a stale duplicate native Claude blocker when the stored bundle is still usable", () => {
  const now = Date.now();
  const status = derivePoolAccountStatus({
    account: {
      provider: "anthropic",
      reauth: {
        mode: "native-claude",
        blockedReason:
          "That native Claude login is already stored on label=claudalyst. Refusing duplicate Anthropic bundle capture/import.",
      },
    },
    label: "boss",
    credentials: buildAnthropicClaudeCredential(),
    browserFacts: { exists: true, bindingPresent: true },
    now,
  });

  assert.equal(status.operatorStatus, "ready");
  assert.equal(status.detailReason, "native_claude");
  assert.equal(status.eligible, true);
});

test("aim claude use <label> activates the requested Claude label without probing usage", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeClaudeBin = installFakeClaude({ rootDir: path.join(home, "fake-claude") });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: buildAnthropicClaudeCredential(),
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });
  const fetchImpl = async () => {
    throw new Error("explicit Claude activation should not probe usage");
  };

  await withEnv(
    {
      PATH: `${fakeClaudeBin}${path.delimiter}${process.env.PATH}`,
    },
    async () => {
        const out = JSON.parse(await runCli(["claude", "use", "boss", "--home", home], { fetchImpl }));
        assert.equal(out.ok, true);
        assert.equal(out.activated.status, "activated");
        assert.equal(out.activated.receipt.label, "boss");
        assert.equal(out.activated.receipt.explicit, true);
        assert.equal(out.activated.receipt.subscriptionType, "max");
        assert.equal(out.activated.receipt.credentialsPath, path.join(home, ".claude", ".credentials.json"));
        assert.equal(out.activated.receipt.appStatePath, path.join(home, ".claude.json"));

        const auth = JSON.parse(fs.readFileSync(path.join(home, ".claude", ".credentials.json"), "utf8"));
        assert.deepEqual(auth.claudeAiOauth, {
          accessToken: "ACCESS_BOSS",
          refreshToken: "REFRESH_BOSS",
          expiresAt: auth.claudeAiOauth.expiresAt,
          subscriptionType: "max",
          rateLimitTier: "max_20x",
          scopes: ["user:profile", "user:inference", "user:sessions:claude_code"],
        });
        assert.equal(typeof auth.claudeAiOauth.expiresAt, "number");

        const appState = JSON.parse(fs.readFileSync(path.join(home, ".claude.json"), "utf8"));
        assert.equal(appState.oauthAccount.emailAddress, "boss@example.com");
        assert.equal(appState.oauthAccount.organizationName, "Boss Org");
        assert.equal(appState.oauthAccount.organizationUuid, "org_boss");

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.claudeCli.activeLabel, "boss");
        assert.equal(updatedState.targets.claudeCli.credentialsPath, path.join(home, ".claude", ".credentials.json"));
        assert.equal(updatedState.targets.claudeCli.appStatePath, path.join(home, ".claude.json"));
        assert.equal(updatedState.targets.claudeCli.lastSelectionReceipt.status, "activated");

        const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
        assert.equal(status.claudeCli.activeLabel, "boss");
        assert.equal(status.claudeCli.actualSubscriptionType, "max");
        assert.equal(status.claudeCli.actualEmailAddress, "boss@example.com");
        assert.equal(status.claudeCli.actualOrganizationName, "Boss Org");
        assert.equal(status.claudeCli.readback.credentials.claudeAiOauthPresent, true);
        assert.equal(status.claudeCli.readback.appState.oauthAccountPresent, true);
        assert.equal(status.claudeCli.authStatus.available, true);
        assert.equal(status.claudeCli.authStatus.ok, true);
        assert.equal(status.claudeCli.authStatus.loggedIn, true);
        assert.ok(status.warnings.every((warning) => !String(warning.kind).startsWith("claude_target_")));

        const textOut = await runCli(["status", "--home", home], { fetchImpl });
        assert.match(textOut, /\nCLAUDE ACCOUNTS \(1\)\n/);
        assert.match(textOut, /\nCLAUDE ACTIVE\nlabel=boss\n$/);
        assert.doesNotMatch(textOut, /credentials_path|app_state_path/);
    },
  );
});
