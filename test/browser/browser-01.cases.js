import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchBrowserBindingForUrl } from "../../src/browser/launch.js";
import { ensureOpenAICodexInteractiveLoginBinding } from "../../src/credentials/codex-login.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeChromeLocalState, writeJson } from "../helpers/files.js";

test("status warns when tokens are expired or rejected", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.1",
    accounts: {
      boss: { provider: "openai-codex", openclawBrowserProfile: "agent-boss" },
      claude: { provider: "anthropic", openclawBrowserProfile: "agent-claude" },
    },
    pins: { openclaw: {} },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() - 60_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claude: buildAnthropicClaudeCredential({
          access: "ANTHROPIC_ACCESS",
          refresh: "ANTHROPIC_REFRESH",
          expiresAtMs: Date.now() + 3600_000,
        }),
      },
    },
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
              used_percent: 1,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }

    if (u.includes("api.anthropic.com/api/oauth/usage")) {
      return {
        ok: false,
        status: 401,
        json: async () => ({ error: { message: "unauthorized" } }),
      };
    }

    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    const out = await runCli(["status", "--json", "--home", home], { fetchImpl });
    const parsed = JSON.parse(out);
    const kinds = parsed.warnings.map((w) => w.kind).toSorted();
    assert.ok(kinds.includes("credentials_expired"));
    assert.ok(kinds.includes("token_invalid_or_expired"));
});

test("status persists migrated legacy state back to disk", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        openclawBrowserProfile: "agent-boss",
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          idToken: fakeJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: {
        pins: { agent_boss: "boss" },
        browserProfiles: { boss: "agent-boss" },
      },
      codexCli: {},
      interactiveOAuth: {
        bindings: {
          boss: { mode: "manual-callback" },
        },
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
              used_percent: 5,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

    await runCli(["status", "--json", "--home", home], { fetchImpl });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(persisted.targets.openclaw.assignments, { agent_boss: "boss" });
  assert.equal(persisted.targets.openclaw.pins, undefined);
  assert.equal(persisted.targets.openclaw.browserProfiles, undefined);
  assert.equal(persisted.targets.interactiveOAuth, undefined);
  assert.equal(persisted.accounts.boss.openclawBrowserProfile, undefined);
  assert.equal(persisted.accounts.boss.reauth.mode, "manual-callback");
  assert.equal(persisted.accounts.boss.browser, null);
});

test("ensureOpenAICodexInteractiveLoginBinding stores manual-callback choice without OpenClaw browser state", async () => {
  const home = mkTempHome();
  const state = {
    schemaVersion: "0.2",
    accounts: {
      manual_label: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  };

  const prompts = [];
  const binding = await ensureOpenAICodexInteractiveLoginBinding({
    state,
    label: "manual_label",
    homeDir: home,
    promptLineImpl: async (question, opts) => {
      prompts.push({ question, opts });
      return "2";
    },
  });

  assert.deepEqual(binding, { mode: "manual-callback" });
  assert.equal(state.accounts.manual_label.reauth.mode, "manual-callback");
  assert.equal(state.accounts.manual_label.browser?.seededFrom, undefined);
  assert.equal(prompts.length, 1);
  assert.match(prompts[0].question, /Login mode for "manual_label"/);
});

test("ensureOpenAICodexInteractiveLoginBinding stores explicit agent-browser binding when prompted", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  fs.mkdirSync(profileDir, { recursive: true });
  const state = {
    schemaVersion: "0.2",
    accounts: {
      cfo: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {},
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  };

  const answers = ["1", "3", profileDir, "agent-cfo"];
  const binding = await ensureOpenAICodexInteractiveLoginBinding({
    state,
    label: "cfo",
    homeDir: home,
    promptLineImpl: async () => answers.shift(),
  });

  assert.equal(binding.mode, "browser-managed");
  assert.deepEqual(binding.binding, {
    mode: "agent-browser",
    agentBrowserProfile: profileDir,
    agentBrowserSession: "agent-cfo",
  });
  assert.equal(state.accounts.cfo.reauth.mode, "browser-managed");
  assert.deepEqual(state.accounts.cfo.browser, {
    mode: "agent-browser",
    agentBrowserProfile: profileDir,
    agentBrowserSession: "agent-cfo",
  });
});

test("launchBrowserBindingForUrl uses explicit agent-browser profile session and neutral cwd", () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  fs.mkdirSync(profileDir, { recursive: true });

  const calls = [];
  const result = launchBrowserBindingForUrl({
    binding: {
      mode: "agent-browser",
      agentBrowserProfile: profileDir,
      agentBrowserSession: "agent-cfo",
    },
    url: "https://example.com/login",
    homeDir: home,
    spawnImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      cmd: "agent-browser",
      args: ["--profile", profileDir, "--session-name", "agent-cfo", "--headed", "open", "https://example.com/login"],
      options: { stdio: "ignore", cwd: home },
    },
  ]);
});

test("launchBrowserBindingForUrl refuses missing mapped browser paths before spawn", () => {
  const home = mkTempHome();
  const missingAgentProfile = path.join(home, ".agent-browser", "profiles", "missing-cfo");
  const missingChromeDir = path.join(home, "Library", "Application Support", "Google", "Chrome-Missing");
  const calls = [];
  const spawnImpl = (cmd, args, options) => {
    calls.push({ cmd, args, options });
    return { status: 0 };
  };

  const agentResult = launchBrowserBindingForUrl({
    binding: {
      mode: "agent-browser",
      agentBrowserProfile: missingAgentProfile,
      agentBrowserSession: "agent-cfo",
    },
    url: "https://example.com/login",
    homeDir: home,
    spawnImpl,
  });
  const chromeResult = launchBrowserBindingForUrl({
    binding: {
      mode: "chrome-profile",
      userDataDir: missingChromeDir,
    },
    url: "https://example.com/login",
    homeDir: home,
    spawnImpl,
  });

  // Missing mapped browser homes are operator repair work, not a reason to invoke
  // `open` or `agent-browser` against some fallback identity.
  assert.deepEqual(agentResult, { ok: false, reason: "missing_browser_path", path: missingAgentProfile });
  assert.deepEqual(chromeResult, { ok: false, reason: "missing_browser_path", path: missingChromeDir });
  assert.deepEqual(calls, []);
});

test(
  "launchBrowserBindingForUrl passes chrome profile-directory through to Google Chrome",
  { skip: process.platform !== "darwin" },
  () => {
  const home = mkTempHome();
  const userDataDir = writeChromeLocalState(home, [
    {
      profileDirectory: "Profile 5",
      name: "Marcus",
      userName: "marcus@fun.country",
    },
  ]);

  const calls = [];
  const result = launchBrowserBindingForUrl({
    binding: {
      mode: "chrome-profile",
      userDataDir,
      profileDirectory: "Profile 5",
    },
    url: "https://example.com/login",
    homeDir: home,
    spawnImpl: (cmd, args, options) => {
      calls.push({ cmd, args, options });
      return { status: 0 };
    },
  });

  assert.equal(result.ok, true);
  assert.deepEqual(calls, [
    {
      cmd: "open",
      args: [
        "-n",
        "-a",
        "Google Chrome",
        "--args",
        `--user-data-dir=${userDataDir}`,
        "--profile-directory=Profile 5",
        "https://example.com/login",
      ],
      options: { stdio: "ignore" },
    },
  ]);
  },
);
