import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { launchBrowserBindingForUrl } from "../../src/browser/launch.js";
import { ensureOpenAICodexInteractiveLoginBinding } from "../../src/credentials/codex-login.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome, writeChromeLocalState, writeJson } from "../helpers/files.js";

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
