import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { discoverSuggestedBrowserBindings } from "../../src/browser/agent-browser.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeChromeLocalState, writeJson } from "../helpers/files.js";

test("aim browser set and show manage explicit browser bindings", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  fs.mkdirSync(profileDir, { recursive: true });

  const setOut = await runCli([
    "browser",
    "set",
    "cfo",
    "--home",
    home,
    "--mode",
    "agent-browser",
    "--profile",
    profileDir,
    "--session",
    "agent-cfo",
  ]);
  const setParsed = JSON.parse(setOut);
  assert.equal(setParsed.ok, true);
  assert.equal(setParsed.browser.current.binding.mode, "agent-browser");
  assert.equal(setParsed.browser.current.binding.profile, profileDir);
  assert.equal(setParsed.browser.current.binding.session, "agent-cfo");

  const showParsed = JSON.parse(await runCli(["browser", "show", "cfo", "--home", home]));
  assert.deepEqual(showParsed, {
    label: "cfo",
    reauthMode: "browser-managed",
    binding: {
      mode: "agent-browser",
      profile: profileDir,
      session: "agent-cfo",
    },
    resolvedPaths: {
      agentBrowserProfile: profileDir,
    },
    warnings: [],
  });
});

test("aim browser set and show manage explicit chrome-profile bindings", async () => {
  const home = mkTempHome();
  const userDataDir = writeChromeLocalState(home, [
    {
      profileDirectory: "Profile 5",
      name: "Marcus",
      userName: "marcus@fun.country",
    },
  ]);

  const setOut = await runCli([
    "browser",
    "set",
    "cfo",
    "--home",
    home,
    "--mode",
    "chrome-profile",
    "--user-data-dir",
    userDataDir,
    "--profile-directory",
    "Profile 5",
  ]);
  const setParsed = JSON.parse(setOut);
  assert.equal(setParsed.ok, true);
  assert.equal(setParsed.browser.current.binding.mode, "chrome-profile");
  assert.equal(setParsed.browser.current.binding.userDataDir, userDataDir);
  assert.equal(setParsed.browser.current.binding.profileDirectory, "Profile 5");

  const showParsed = JSON.parse(await runCli(["browser", "show", "cfo", "--home", home]));
  assert.deepEqual(showParsed, {
    label: "cfo",
    reauthMode: "browser-managed",
    binding: {
      mode: "chrome-profile",
      userDataDir,
      profileDirectory: "Profile 5",
    },
    resolvedPaths: {
      userDataDir,
    },
    warnings: [],
  });
});

test("malformed mapped browser bindings are projected as missing bindings", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      chrome_missing: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: { mode: "chrome-profile" },
      },
      agent_missing: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: { mode: "agent-browser", agentBrowserSession: "agent-missing" },
      },
    },
    credentials: {
      "openai-codex": {
        chrome_missing: {
          access: makeFakeJwt({ sub: "chrome-missing" }),
          refresh: "REFRESH_CHROME",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_chrome_missing",
        },
        agent_missing: {
          access: makeFakeJwt({ sub: "agent-missing" }),
          refresh: "REFRESH_AGENT",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_agent_missing",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const chromeShow = JSON.parse(await runCli(["browser", "show", "chrome_missing", "--home", home]));
  assert.equal(chromeShow.binding, null);
  assert.deepEqual(chromeShow.warnings, [{ reason: "binding_missing_for_future_reauth" }]);

  const fetchImpl = async (url) => {
    if (String(url).includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 4,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${url}`);
  };

  const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
  for (const label of ["chrome_missing", "agent_missing"]) {
    const account = status.accounts.find((entry) => entry.label === label);
    // Malformed mapped bindings are repair work, not usable browser identities.
    // Status/login must agree so operators are sent to `aim browser set` instead of a dead launch path.
    assert.equal(account.login.bindingPresent, false);
    assert.equal(account.login.binding, undefined);
    assert.equal(account.browser.bindingPresent, false);
    assert.equal(account.operator.detailReason, "binding_missing_for_future_reauth");
    assert.equal(account.operator.actionRequired, "run_aim_browser_set");
  }
});

test("aim browser set fails loud when agent-browser session is missing", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  fs.mkdirSync(profileDir, { recursive: true });

  await assert.rejects(
    () =>
      runCli([
        "browser",
        "set",
        "cfo",
        "--home",
        home,
        "--mode",
        "agent-browser",
        "--profile",
        profileDir,
      ]),
    /requires --profile <abs-path> and --session <name>/,
  );
});

test("discoverSuggestedBrowserBindings prefers exact OpenClaw binding and dedupes identical profile/session candidates", () => {
  const repoRoot = mkTempHome();
  const profileDir = path.join(repoRoot, ".agent-browser", "profiles", "agent-cfo");
  const cfoWorkspace = path.join(repoRoot, "agents", "agent_cfo_bot");
  const duplicateWorkspace = path.join(repoRoot, "agents", "agent_cfo_shadow");
  const officeWorkspace = path.join(repoRoot, "agents", "agent_office");

  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(cfoWorkspace, { recursive: true });
  fs.mkdirSync(duplicateWorkspace, { recursive: true });
  fs.mkdirSync(officeWorkspace, { recursive: true });
  fs.writeFileSync(
    path.join(cfoWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-cfo", profile: profileDir, headed: true }, null, 2),
  );
  fs.writeFileSync(
    path.join(duplicateWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-cfo", profile: profileDir, headed: true }, null, 2),
  );
  fs.writeFileSync(
    path.join(officeWorkspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-office", profile: path.join(repoRoot, ".agent-browser", "profiles", "agent-office"), headed: true }, null, 2),
  );
  fs.mkdirSync(path.join(repoRoot, ".agent-browser", "profiles", "agent-office"), { recursive: true });

  const results = discoverSuggestedBrowserBindings({
    label: "cfo",
    repoRoot,
    bindings: [
      {
        agentId: "agent_cfo_bot",
        match: { channel: "slack", accountId: "cfo" },
      },
    ],
    agentsList: [
      { id: "agent_cfo_bot", name: "CFO Bot", workspace: cfoWorkspace },
      { id: "agent_cfo_shadow", name: "CFO Shadow", workspace: duplicateWorkspace },
      { id: "agent_office", name: "Office", workspace: officeWorkspace },
    ],
  });

  assert.equal(results[0].source, "openclaw-binding");
  assert.equal(results[0].agentId, "agent_cfo_bot");
  assert.equal(
    results.filter(
      (candidate) =>
        candidate.agentBrowserProfile === profileDir && candidate.agentBrowserSession === "agent-cfo",
    ).length,
    1,
  );
});

test("manual chrome-profile entry accepts blank profile-directory as Default", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const userDataDir = path.join(home, "Library", "Application Support", "Google", "Chrome-Pro1");
  fs.mkdirSync(path.join(userDataDir, "Default"), { recursive: true });
  writeJson(path.join(userDataDir, "Local State"), {
    profile: {
      info_cache: {
        Default: {
          name: "Pro1",
          user_name: "pro1@fun.country",
          gaia_name: "",
        },
      },
    },
  });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      pro1: { provider: "openai-codex" },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["3", userDataDir, "0"];
  const opened = [];
  let sawBlankDefault = false;
  const out = await runCli(["pro1", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async (message, opts = {}) => {
      if (String(message).includes('Chrome profile-directory for "pro1"')) {
        assert.equal(opts.defaultValue, "");
        sawBlankDefault = true;
        return opts.defaultValue;
      }
      return answers.shift();
    },
    readOpenclawBindingsFromConfigImpl: () => [],
    readOpenclawAgentsListFromConfigImpl: () => [],
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
    loginOpenAICodexImpl: async ({ onAuth }) => {
      onAuth({ url: "https://chatgpt.com/oauth" });
      return {
        access: makeFakeJwt({ sub: "pro1" }),
        refresh: "REFRESHED",
        expires: Date.now() + 3600_000,
        accountId: "acct_pro1",
      };
    },
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(sawBlankDefault, true);
  assert.equal(persisted.accounts.pro1.browser.mode, "chrome-profile");
  assert.equal(persisted.accounts.pro1.browser.userDataDir, userDataDir);
  assert.equal(persisted.accounts.pro1.browser.profileDirectory, undefined);
  assert.equal(persisted.accounts.pro1.reauth.mode, "browser-managed");
  assert.deepEqual(opened, [
    {
      binding: {
        mode: "chrome-profile",
        userDataDir,
      },
      url: "https://chatgpt.com/oauth",
    },
  ]);
  assert.match(out, /Saved browser setup for pro1\./);
  assert.match(out, /pro1 is ready\./);
});

test("guided ready panel can show details and change browser setup", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  const statePath = path.join(home, ".aimgr", "secrets.json");
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: {
          mode: "agent-browser",
          agentBrowserProfile: profileDir,
          agentBrowserSession: "agent-cfo",
        },
      },
    },
    credentials: {
      "openai-codex": {
        cfo: {
          access: makeFakeJwt({ sub: "cfo" }),
          refresh: "REFRESH",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_cfo",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["4", "3", "4", "0"];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    readOpenclawBindingsFromConfigImpl: () => [],
    readOpenclawAgentsListFromConfigImpl: () => [],
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.accounts.cfo.reauth.mode, "manual-callback");
  assert.equal(persisted.accounts.cfo.browser, null);
  assert.match(out, /"mode": "agent-browser"/);
  assert.match(out, /"session": "agent-cfo"/);
});

test("guided reauth panel can refresh login and return to ready", async () => {
  const home = mkTempHome();
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  const statePath = path.join(home, ".aimgr", "secrets.json");
  fs.mkdirSync(profileDir, { recursive: true });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: {
          mode: "agent-browser",
          agentBrowserProfile: profileDir,
          agentBrowserSession: "agent-cfo",
        },
      },
    },
    credentials: {
      "openai-codex": {
        cfo: {
          access: makeFakeJwt({ sub: "cfo-old" }),
          refresh: "OLD_REFRESH",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_cfo",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["1", "0"];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    refreshOpenAICodexImpl: async () => ({
      access: makeFakeJwt({ sub: "cfo-new" }),
      refresh: "NEW_REFRESH",
      expires: Date.now() + 3600_000,
      accountId: "acct_cfo",
    }),
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.credentials["openai-codex"].cfo.refresh, "NEW_REFRESH");
  assert.match(out, /Will try token refresh first\./);
  assert.match(out, /If refresh is not enough, AIM will open https:\/\/chatgpt\.com using agent-browser session "agent-cfo" using profile /);
  assert.match(out, /cfo is ready\./);
});
