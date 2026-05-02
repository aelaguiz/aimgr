import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeChromeLocalState, writeJson, writeOpenclawBrowserLocalState } from "../helpers/files.js";
import { writeHermesAuthFile } from "../helpers/hermes.js";

test("TTY shorthand label routes into the guided control panel", async () => {
  const home = mkTempHome();
  let invoked = null;

  await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    runLabelControlPanelImpl: async (args) => {
      invoked = args;
    },
  });

  assert.equal(invoked.label, "cfo");
  assert.equal(invoked.homeDir, home);
});

test("non-TTY shorthand label keeps the one-shot maintenance contract", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const staleJwt = makeFakeJwt({
    email: "cfo@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_cfo",
      chatgpt_plan_type: "pro",
    },
  });
  writeHermesAuthFile(home, "agent_ads_analyst", {
    accessToken: staleJwt,
    refreshToken: "OLD_REFRESH",
  });
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: {
        provider: "openai-codex",
        reauth: { mode: "manual-callback" },
      },
    },
    credentials: {
      "openai-codex": {
        cfo: {
          access: staleJwt,
          refresh: "OLD_REFRESH",
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          accountId: "acct_cfo",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: false },
    stdout: { isTTY: false },
    runLabelControlPanelImpl: async () => {
      throw new Error("panel should not run in non-interactive mode");
    },
    refreshOpenAICodexImpl: async () => ({
      access: makeFakeJwt({ sub: "fresh" }),
      refresh: "NEW_REFRESH",
      expires: Date.now() + 3600_000,
      accountId: "acct_cfo",
    }),
  });

  const parsed = JSON.parse(out);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.label, "cfo");
  assert.equal(parsed.provider, "openai-codex");
  assert.equal(parsed.hermesSync.status, "applied");
  assert.deepEqual(parsed.hermesSync.syncedHomeIds, ["agent_ads_analyst"]);
  const hermesAuth = JSON.parse(
    fs.readFileSync(path.join(home, ".hermes", "profiles", "agent_ads_analyst", "auth.json"), "utf8"),
  );
  assert.equal(hermesAuth.providers["openai-codex"].tokens.refresh_token, "NEW_REFRESH");
  assert.equal(hermesAuth.credential_pool["openai-codex"][0].refresh_token, "NEW_REFRESH");
});

test("guided panel cancellation leaves malformed browser setup unchanged", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: {
          mode: "agent-browser",
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

  const opened = [];
  const answers = ["1", "0", "0"];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    readOpenclawBindingsFromConfigImpl: () => [],
    readOpenclawAgentsListFromConfigImpl: () => [],
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // Backing out of setup after discovering a malformed binding should not start
  // a dead browser launch or record maintenance/credential changes.
  assert.deepEqual(persisted.accounts.cfo.browser, {
    mode: "agent-browser",
    agentBrowserSession: "agent-cfo",
  });
  assert.equal(persisted.accounts.cfo.reauth.lastAttemptAt, undefined);
  assert.equal(persisted.credentials["openai-codex"].cfo.refresh, "REFRESH");
  assert.deepEqual(opened, []);
  assert.match(out, /Browser setup unchanged\./);
  assert.doesNotMatch(out, /Opened cfo/);
});

test("guided panel can adopt a suggested agent-browser binding and make the label ready", async () => {
  const home = mkTempHome();
  const repoRoot = path.join(home, "repo");
  const profileDir = path.join(home, ".agent-browser", "profiles", "agent-cfo");
  const workspace = path.join(repoRoot, "agents", "agent_cfo_bot");
  const statePath = path.join(home, ".aimgr", "secrets.json");
  fs.mkdirSync(profileDir, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(
    path.join(workspace, "agent-browser.json"),
    JSON.stringify({ session: "agent-cfo", profile: profileDir, headed: true }, null, 2),
  );
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: { provider: "openai-codex" },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["1", "1", "1", "0"];
  const opened = [];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    repoRoot,
    promptLineImpl: async () => answers.shift(),
    readOpenclawBindingsFromConfigImpl: () => [{ agentId: "agent_cfo_bot", match: { channel: "slack", accountId: "cfo" } }],
    readOpenclawAgentsListFromConfigImpl: () => [{ id: "agent_cfo_bot", name: "CFO Bot", workspace }],
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
    loginOpenAICodexImpl: async ({ onAuth }) => {
      onAuth({ url: "https://chatgpt.com/oauth" });
      return {
        access: makeFakeJwt({ sub: "cfo" }),
        refresh: "REFRESHED",
        expires: Date.now() + 3600_000,
        accountId: "acct_cfo",
      };
    },
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.accounts.cfo.browser.mode, "agent-browser");
  assert.equal(persisted.accounts.cfo.browser.agentBrowserProfile, profileDir);
  assert.equal(persisted.accounts.cfo.browser.agentBrowserSession, "agent-cfo");
  assert.equal(persisted.accounts.cfo.reauth.mode, "browser-managed");
  assert.equal(persisted.credentials["openai-codex"].cfo.accountId, "acct_cfo");
  assert.deepEqual(opened, [
    {
      binding: {
        mode: "agent-browser",
        agentBrowserProfile: profileDir,
        agentBrowserSession: "agent-cfo",
      },
      url: "https://chatgpt.com/oauth",
    },
  ]);
  assert.match(out, /Next screen will offer agent-browser session "agent-cfo" using profile /);
  assert.match(out, new RegExp(profileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.match(out, /AIM found it from exact OpenClaw binding cfo -> agent_cfo_bot/);
  assert.match(
    out,
    new RegExp(
      `Will save AIM browser path ${path
        .join(home, ".aimgr", "browser", "cfo", "user-data")
        .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} and then start login for cfo\\.`,
    ),
  );
  assert.match(out, /Will not use a local browser for cfo\./);
  assert.match(out, /Saved browser setup for cfo\./);
  assert.match(out, /cfo is ready\./);
});

test("guided panel can adopt a discovered chrome profile and make the label ready", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const userDataDir = writeChromeLocalState(home, [
    {
      profileDirectory: "Profile 5",
      name: "Marcus",
      userName: "marcus@fun.country",
    },
    {
      profileDirectory: "Default",
      name: "Personal",
      userName: "amir@fun.country",
    },
  ]);
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: { provider: "openai-codex" },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["3", "1", "1", "0"];
  const opened = [];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    readOpenclawBindingsFromConfigImpl: () => [],
    readOpenclawAgentsListFromConfigImpl: () => [],
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
    loginOpenAICodexImpl: async ({ onAuth }) => {
      onAuth({ url: "https://chatgpt.com/oauth" });
      return {
        access: makeFakeJwt({ sub: "cfo" }),
        refresh: "REFRESHED",
        expires: Date.now() + 3600_000,
        accountId: "acct_cfo",
      };
    },
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.accounts.cfo.browser.mode, "chrome-profile");
  assert.equal(persisted.accounts.cfo.browser.userDataDir, userDataDir);
  assert.equal(persisted.accounts.cfo.browser.profileDirectory, "Profile 5");
  assert.equal(persisted.accounts.cfo.reauth.mode, "browser-managed");
  assert.equal(persisted.credentials["openai-codex"].cfo.accountId, "acct_cfo");
  assert.deepEqual(opened, [
    {
      binding: {
        mode: "chrome-profile",
        userDataDir,
        profileDirectory: "Profile 5",
      },
      url: "https://chatgpt.com/oauth",
    },
  ]);
  assert.match(out, /Next screen will offer 2 discovered Chrome profiles on this Mac and let you pick one\./);
  assert.match(out, /Option 1: Google Chrome · Marcus · marcus@fun.country\./);
  assert.match(
    out,
    new RegExp(
      `Would save Chrome user-data-dir ${userDataDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")} with profile-directory "Profile 5"\\.`,
    ),
  );
  assert.match(out, /Discovered Chrome profiles for cfo/);
  assert.match(out, /Google Chrome · Marcus · marcus@fun.country/);
  assert.match(out, /Saved browser setup for cfo\./);
  assert.match(out, /cfo is ready\./);
});

test("guided panel can adopt a discovered OpenClaw browser home through the chrome-profile lane", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const openclawUserDataDir = writeOpenclawBrowserLocalState(home, "agent-cfo", {
    name: "Marcus",
    user_name: "marcus@fun.country",
  });
  writeChromeLocalState(home, [
    {
      profileDirectory: "Profile 1",
      name: "Personal",
      userName: "amir@fun.country",
    },
  ]);
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: { provider: "openai-codex" },
    },
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const answers = ["3", "1", "1", "0"];
  const opened = [];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    readOpenclawBindingsFromConfigImpl: () => [],
    readOpenclawAgentsListFromConfigImpl: () => [],
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
    loginOpenAICodexImpl: async ({ onAuth }) => {
      onAuth({ url: "https://chatgpt.com/oauth" });
      return {
        access: makeFakeJwt({ sub: "cfo" }),
        refresh: "REFRESHED",
        expires: Date.now() + 3600_000,
        accountId: "acct_cfo",
      };
    },
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(persisted.accounts.cfo.browser.mode, "chrome-profile");
  assert.equal(persisted.accounts.cfo.browser.userDataDir, openclawUserDataDir);
  assert.equal(persisted.accounts.cfo.browser.profileDirectory, undefined);
  assert.equal(persisted.accounts.cfo.reauth.mode, "browser-managed");
  assert.deepEqual(opened, [
    {
      binding: {
        mode: "chrome-profile",
        userDataDir: openclawUserDataDir,
      },
      url: "https://chatgpt.com/oauth",
    },
  ]);
  assert.match(out, /Includes 1 OpenClaw browser home and 1 host Chrome profile\./);
  assert.match(out, /Option 1: OpenClaw browser · agent-cfo · Marcus · marcus@fun\.country\./);
  assert.match(out, /Discovered Chrome profiles for cfo/);
  assert.match(out, /OpenClaw browser · agent-cfo · Marcus · marcus@fun\.country/);
  assert.match(out, /This is OpenClaw browser profile "agent-cfo"\./);
  assert.match(out, /Saved browser setup for cfo\./);
  assert.match(out, /cfo is ready\./);
});
