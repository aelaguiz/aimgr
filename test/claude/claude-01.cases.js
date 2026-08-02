import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseAnthropicAuthorizationPaste } from "../../src/credentials/oauth.js";
import { derivePoolAccountStatus } from "../../src/pool/account-status.js";
import { parseArgs } from "../../src/cli/args.js";
import { buildAnthropicClaudeCredential, writeClaudeNativeBundle } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

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

  const automaticFablePassthrough = parseArgs([
    "claude",
    "run",
    "fable",
    "--",
    "--version",
  ]);
  assert.deepEqual(automaticFablePassthrough.positional, ["claude", "run"]);
  assert.deepEqual(automaticFablePassthrough.opts.afterDoubleDash, [
    "--dangerously-skip-permissions",
    "--model",
    "claude-fable-5",
    "--effort",
    "xhigh",
    "--version",
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
  const credential = updatedState.credentials.anthropic.boss;
  assert.deepEqual(Object.keys(credential), ["nativeClaudeBundle"]);
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.accessToken, "ACCESS_BOSS");
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.refreshToken, "REFRESH_BOSS");
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.subscriptionType, "claude_max");
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.rateLimitTier, "oauth_claude_max");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.emailAddress, "boss@example.com");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.organizationName, "Boss Org");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.organizationUuid, "org_boss");
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
  const credential = updatedState.credentials.anthropic.first;
  assert.deepEqual(Object.keys(credential), ["nativeClaudeBundle"]);
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.accessToken, "ACCESS_FIRST");
  assert.equal(credential.nativeClaudeBundle.claudeAiOauth.refreshToken, "REFRESH_FIRST");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.emailAddress, "first@example.com");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.organizationName, "First Org");
  assert.equal(credential.nativeClaudeBundle.oauthAccount.organizationUuid, "org_first");
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
