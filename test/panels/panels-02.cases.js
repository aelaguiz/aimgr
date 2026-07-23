import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";
import { buildAnthropicLabelPanelActions } from "../../src/panels/render.js";

test("guided panel open browser delegates to the existing binding launcher", async () => {
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

  const answers = ["1", "0"];
  const opened = [];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
    openUrlImpl: ({ binding, url }) => {
      opened.push({ binding, url });
      return { ok: true };
    },
  });

  assert.equal(opened.length, 1);
  assert.equal(opened[0].url, "https://chatgpt.com");
  assert.equal(opened[0].binding.agentBrowserSession, "agent-cfo");
  assert.match(out, /Will open https:\/\/chatgpt\.com using agent-browser session "agent-cfo" using profile /);
  assert.match(out, /Opened cfo in agent-browser \/ agent-cfo\./);
});

test("guided panel reports missing browser paths without mutating state", async () => {
  const home = mkTempHome();
  const missingProfileDir = path.join(home, ".agent-browser", "profiles", "missing-cfo");
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      cfo: {
        provider: "openai-codex",
        reauth: { mode: "browser-managed" },
        browser: {
          mode: "agent-browser",
          agentBrowserProfile: missingProfileDir,
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

  const answers = ["1", "0"];
  const out = await runCli(["cfo", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => answers.shift(),
  });

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  // Opening a stale mapped profile should produce a repairable message without
  // recording a maintenance attempt or rewriting the user's saved binding.
  assert.deepEqual(persisted.accounts.cfo.browser, {
    mode: "agent-browser",
    agentBrowserProfile: missingProfileDir,
    agentBrowserSession: "agent-cfo",
  });
  assert.equal(persisted.accounts.cfo.reauth.lastAttemptAt, undefined);
  assert.equal(persisted.credentials["openai-codex"].cfo.refresh, "REFRESH");
  assert.match(out, new RegExp(`Configured browser path is missing: ${missingProfileDir.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
});

test("interactive Anthropic label panel offers native Claude actions and no manual callback setup", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
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

  const out = await runCli(["boss", "--home", home], {
    stdin: { isTTY: true },
    stdout: { isTTY: true },
    promptLineImpl: async () => "0",
  });

  assert.match(out, /Capture current native Claude login/);
  assert.match(out, /Import native Claude bundle/);
  assert.match(out, /Export current live native bundle/);
  assert.doesNotMatch(out, /Manual callback login/);
  assert.doesNotMatch(out, /Change browser setup/);
  assert.doesNotMatch(out, /Browser:/);
  assert.match(out, /Native bundle: missing/);
});

test("Anthropic panel never offers a direct rotating-token refresh action", () => {
  const actions = buildAnthropicLabelPanelActions({
    label: "pro7",
    nativeBundleComplete: true,
  });

  assert.equal(actions.some((action) => action.action === "refresh_native_claude_bundle"), false);
  assert.equal(actions.some((action) => /refresh native bundle/i.test(action.label)), false);
});
