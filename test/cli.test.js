import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOpenclawModelSyncOps,
  discoverSuggestedBrowserBindings,
  derivePoolAccountStatus,
  discoverOpenclawBrowserProfiles,
  ensureOpenAICodexInteractiveLoginBinding,
  extractOpenclawConfigAgentModelPrimary,
  extractSessionModelRefFromEntry,
  launchBrowserBindingForUrl,
  main,
  parseAnthropicAuthorizationPaste,
  planOpenclawRebalance,
  planWeightedOpenclawRebalance,
  partitionOpenclawPinsByConfiguredAgents,
  pickNextBestPoolLabel,
  projectPoolCapacity,
  rankPoolCandidates,
  readOpenclawAgentTokenUsage,
  rebalanceOpenclawPool,
  refreshOpenclawAgentDemandLedger,
  refreshOrLoginCodex,
  resetSessionEntryToDefaults,
  resolveAuthorityLocator,
  setBrowserBinding,
  showBrowserBinding,
  scanOpenclawSessionsStoreForKeysNeedingModelReset,
  seedAimBrowserProfileFromOpenclaw,
  sessionEntryNeedsModelReset,
} from "../src/cli.js";

function mkTempHome() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-test-"));
  return dir;
}

function writeJson(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
}

function writeAimBrowserLocalState(home, label, profileInfo = {}) {
  writeJson(path.join(home, ".aimgr", "browser", label, "user-data", "Local State"), {
    profile: {
      info_cache: {
        Default: {
          name: label,
          user_name: "",
          gaia_name: "",
          ...profileInfo,
        },
      },
    },
  });
}

function writeChromeLocalState(home, profiles = []) {
  const userDataDir = path.join(home, "Library", "Application Support", "Google", "Chrome");
  const infoCache = {};
  for (const profile of profiles) {
    const profileDirectory = String(profile.profileDirectory ?? "").trim() || "Default";
    fs.mkdirSync(path.join(userDataDir, profileDirectory), { recursive: true });
    infoCache[profileDirectory] = {
      name: profile.name ?? profileDirectory,
      user_name: profile.userName ?? "",
      gaia_name: profile.gaiaName ?? "",
    };
  }
  writeJson(path.join(userDataDir, "Local State"), {
    profile: {
      info_cache: infoCache,
    },
  });
  return userDataDir;
}

function writeOpenclawBrowserLocalState(home, profileId, profileInfo = {}) {
  writeJson(path.join(home, ".openclaw", "browser", profileId, "user-data", "Local State"), {
    profile: {
      info_cache: {
        Default: {
          name: profileId,
          user_name: "",
          gaia_name: "",
          ...profileInfo,
        },
      },
    },
  });
  return path.join(home, ".openclaw", "browser", profileId, "user-data");
}

function writeOpenclawAuthStore(home, agentId, data) {
  writeJson(path.join(home, ".openclaw", "agents", agentId, "agent", "auth-profiles.json"), data);
}

function writeOpenclawSessionsStore(home, agentId, data) {
  writeJson(path.join(home, ".openclaw", "agents", agentId, "sessions", "sessions.json"), data);
}

async function withEnv(overrides, fn) {
  const previous = new Map();
  for (const [key, value] of Object.entries(overrides)) {
    previous.set(key, process.env[key]);
    if (value === undefined || value === null) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  try {
    return await fn();
  } finally {
    for (const [key, value] of previous.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

function installFakeOpenclaw({ rootDir, agentsList }) {
  const binDir = path.join(rootDir, "bin");
  const agentsListPath = path.join(rootDir, "agents-list.json");
  fs.mkdirSync(binDir, { recursive: true });
  writeJson(agentsListPath, agentsList);
  const scriptPath = path.join(binDir, "openclaw");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "config" && args[1] === "get" && args[2] === "agents.list" && args.includes("--json")) {
  process.stdout.write(fs.readFileSync(${JSON.stringify(agentsListPath)}, "utf8"));
  process.exit(0);
}
if (args[0] === "config" && args[1] === "set") {
  process.exit(0);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.list") {
  process.stderr.write("fake gateway unavailable");
  process.exit(1);
}
if (args[0] === "gateway" && args[1] === "call" && args[2] === "sessions.patch") {
  process.exit(0);
}
process.stderr.write("unexpected openclaw args: " + args.join(" "));
process.exit(2);
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return binDir;
}

function makeFakeJwt(payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

async function runCli(argv, deps = {}) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const origExitCode = process.exitCode;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
    if (typeof cb === "function") cb();
    return true;
  };
  const wrappedDeps =
    typeof deps.promptLineImpl === "function"
      ? {
          ...deps,
          promptLineImpl: async (...args) => {
            const answer = await deps.promptLineImpl(...args);
            if (answer === undefined) {
              throw new Error(`test prompt exhausted for: ${String(args[0] ?? "").trim() || "<unknown prompt>"}`);
            }
            return answer;
          },
        }
      : deps;
  try {
    await main(argv, wrappedDeps);
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = origExitCode;
  }
  return chunks.join("");
}

async function runCliWithExitCode(argv, deps = {}) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
    if (typeof cb === "function") cb();
    return true;
  };
  const wrappedDeps =
    typeof deps.promptLineImpl === "function"
      ? {
          ...deps,
          promptLineImpl: async (...args) => {
            const answer = await deps.promptLineImpl(...args);
            if (answer === undefined) {
              throw new Error(`test prompt exhausted for: ${String(args[0] ?? "").trim() || "<unknown prompt>"}`);
            }
            return answer;
          },
        }
      : deps;
  try {
    await main(argv, wrappedDeps);
    return { stdout: chunks.join(""), exitCode: process.exitCode ?? 0 };
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = origExitCode;
  }
}

test("status --json never leaks access/refresh tokens", async () => {
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
          access: "ACCESS_TOKEN_SHOULD_NOT_LEAK",
          refresh: "REFRESH_TOKEN_SHOULD_NOT_LEAK",
          idToken: "ID_TOKEN_SHOULD_NOT_LEAK",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claude: {
          access: "ANTHROPIC_ACCESS_SHOULD_NOT_LEAK",
          refresh: "ANTHROPIC_REFRESH_SHOULD_NOT_LEAK",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
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
          five_hour: { utilization: 12, resets_at: "2026-03-10T00:00:00Z" },
          seven_day: { utilization: 34, resets_at: "2026-03-12T00:00:00Z" },
          seven_day_opus: { utilization: 44 },
        }),
      };
    }

    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    const out = await runCli(["status", "--json", "--home", home]);
    assert.doesNotMatch(out, /ACCESS_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /REFRESH_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ID_TOKEN_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ANTHROPIC_ACCESS_SHOULD_NOT_LEAK/);
    assert.doesNotMatch(out, /ANTHROPIC_REFRESH_SHOULD_NOT_LEAK/);
    const parsed = JSON.parse(out);
    const boss = parsed.accounts.find((a) => a.label === "boss");
    const claude = parsed.accounts.find((a) => a.label === "claude");
    assert.equal(boss.provider, "openai-codex");
    assert.equal(claude.provider, "anthropic");
    assert.equal(claude.usage.ok, true);
    assert.ok(claude.usage.windows.some((w) => w.label === "Opus"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

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
        claude: {
          access: "ANTHROPIC_ACCESS",
          refresh: "ANTHROPIC_REFRESH",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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

  try {
    const out = await runCli(["status", "--json", "--home", home]);
    const parsed = JSON.parse(out);
    const kinds = parsed.warnings.map((w) => w.kind).toSorted();
    assert.ok(kinds.includes("credentials_expired"));
    assert.ok(kinds.includes("token_invalid_or_expired"));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("status text shows usage reset timestamps for each window", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const nowMs = Date.parse("2026-03-17T20:15:21Z");
  const codexFiveHourReset = "2026-03-17T21:45:21Z";
  const codexWeekReset = "2026-03-18T17:00:45Z";
  const claudeFiveHourReset = "2026-03-17T22:10:00Z";
  const claudeWeekReset = "2026-03-19T00:00:00Z";

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
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {
        claude: {
          access: "ANTHROPIC_ACCESS",
          refresh: "ANTHROPIC_REFRESH",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
        },
      },
    },
  });

  const origDateNow = Date.now;
  const origFetch = globalThis.fetch;
  Date.now = () => nowMs;
  globalThis.fetch = async (url) => {
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

  try {
    const out = await runCli(["status", "--home", home]);
    assert.match(out, /label\s+st\s+login\s+exp\s+5h_used\s+5h_in\s+wk_used\s+wk_in\s+provider\s+flags/);
    assert.match(out, /boss\s+ready\s+aim-profile\s+\S+\s+10%\s+1\.5h\s+20%\s+20\.8h\s+openai-codex/);
    assert.match(out, /claude\s+ready\s+aim-profile\s+\S+\s+12%\s+1\.9h\s+34%\s+27\.7h\s+anthropic/);
    assert.doesNotMatch(out, /Usage detail/);
    assert.doesNotMatch(out, /usage=5h/);
  } finally {
    Date.now = origDateNow;
    globalThis.fetch = origFetch;
  }
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

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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

  try {
    await runCli(["status", "--json", "--home", home]);
  } finally {
    globalThis.fetch = origFetch;
  }

  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(persisted.targets.openclaw.assignments, { agent_boss: "boss" });
  assert.equal(persisted.targets.openclaw.pins, undefined);
  assert.equal(persisted.targets.openclaw.browserProfiles, undefined);
  assert.equal(persisted.targets.interactiveOAuth, undefined);
  assert.equal(persisted.accounts.boss.openclawBrowserProfile, undefined);
  assert.equal(persisted.accounts.boss.reauth.mode, "manual-callback");
  assert.equal(persisted.accounts.boss.browser, null);
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

test("launchBrowserBindingForUrl passes chrome profile-directory through to Google Chrome", () => {
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
});

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

test("TTY shorthand label routes into the guided control panel", async () => {
  const home = mkTempHome();
  let invoked = null;

  await main(["cfo", "--home", home], {
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
          access: makeFakeJwt({ sub: "old" }),
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

test("refreshOrLoginCodex manual-callback prompts for callback URL and skips browser launch", async () => {
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
      openclaw: { pins: {}, browserProfiles: {} },
      codexCli: {},
      interactiveOAuth: { bindings: { manual_label: { mode: "manual-callback" } } },
    },
  };

  const prompts = [];
  const pastedValues = [];
  let openUrlCalls = 0;

  const cred = await refreshOrLoginCodex({
    state,
    label: "manual_label",
    homeDir: mkTempHome(),
    interactiveBinding: { mode: "manual-callback" },
    loginImpl: async ({ onAuth, onManualCodeInput, onPrompt, originator }) => {
      assert.equal(originator, "aimgr");
      onAuth({ url: "https://auth.openai.example/authorize" });
      pastedValues.push(await onManualCodeInput());
      pastedValues.push(await onPrompt());
      return {
        access: "ACCESS_TOKEN",
        refresh: "REFRESH_TOKEN",
        expires: Date.now() + 3600_000,
        accountId: "acct_manual",
      };
    },
    promptImpl: async (question) => {
      prompts.push(question);
      return "http://localhost:1455/auth/callback?code=CODE123&state=STATE456";
    },
    openUrlImpl: () => {
      openUrlCalls += 1;
      return { ok: true };
    },
  });

  assert.equal(openUrlCalls, 0);
  assert.equal(prompts.length, 2);
  assert.ok(prompts.every((question) => question.includes("Paste the full callback URL")));
  assert.deepEqual(pastedValues, [
    "http://localhost:1455/auth/callback?code=CODE123&state=STATE456",
    "http://localhost:1455/auth/callback?code=CODE123&state=STATE456",
  ]);
  assert.equal(cred.accountId, "acct_manual");
  assert.equal(cred.idToken, "ACCESS_TOKEN");
});

test("resolveAuthorityLocator accepts bare ssh targets for the default AIM state path", () => {
  assert.deepEqual(resolveAuthorityLocator("agents@amirs-mac-studio"), {
    kind: "ssh",
    target: "agents@amirs-mac-studio",
    port: null,
    remotePath: "$HOME/.aimgr/secrets.json",
    display: "agents@amirs-mac-studio",
  });

  assert.deepEqual(resolveAuthorityLocator("ssh://agents@amirs-mac-studio"), {
    kind: "ssh",
    target: "agents@amirs-mac-studio",
    port: null,
    remotePath: "$HOME/.aimgr/secrets.json",
    display: "ssh://agents@amirs-mac-studio",
  });
});

test("help text prefers agents@amirs-mac-studio as the authority example", async () => {
  const out = await runCli([]);
  assert.match(out, /aim sync codex --from <authority>/);
  assert.match(out, /Examples: agents@amirs-mac-studio/);
  assert.match(out, /ssh:\/\/agents@amirs-mac-studio\/~\/\.aimgr\/secrets\.json/);
});

test("apply materializes only assigned managed profiles and clears stale per-agent overrides", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true }, browser: {} },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true }, browser: {} },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
        qa: {
          access: "ACCESS_TOKEN_QA",
          refresh: "REFRESH_TOKEN_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_456",
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
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawAuthStore(home, "main", {
    version: 1,
    profiles: {
      "openai-codex:boss": { provider: "openai-codex", type: "oauth" },
      "openai-codex:qa": { provider: "openai-codex", type: "oauth" },
    },
    order: {
      "openai-codex": ["openai-codex:boss", "openai-codex:qa"],
    },
  });
  writeOpenclawAuthStore(home, "agent_stale", {
    version: 1,
    profiles: {},
    order: {
      "openai-codex": ["openai-codex:qa"],
    },
    lastGood: {
      "openai-codex": "openai-codex:qa",
    },
  });

  await runCli(["apply", "--home", home]);

  const mainStorePath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const mainStore = JSON.parse(fs.readFileSync(mainStorePath, "utf8"));
  assert.ok(mainStore.profiles["openai-codex:boss"]);
  assert.equal(mainStore.profiles["openai-codex:qa"], undefined);
  assert.equal(mainStore.profiles["openai-codex:boss"].provider, "openai-codex");
  assert.equal(mainStore.order?.["openai-codex"], undefined);
  assert.equal(mainStore.lastGood?.["openai-codex"], undefined);

  const agentStorePath = path.join(home, ".openclaw", "agents", "agent_boss", "agent", "auth-profiles.json");
  const agentStore = JSON.parse(fs.readFileSync(agentStorePath, "utf8"));
  assert.deepEqual(agentStore.order["openai-codex"], ["openai-codex:boss"]);
  assert.equal(agentStore.lastGood["openai-codex"], "openai-codex:boss");

  const staleStorePath = path.join(home, ".openclaw", "agents", "agent_stale", "agent", "auth-profiles.json");
  const staleStore = JSON.parse(fs.readFileSync(staleStorePath, "utf8"));
  assert.equal(staleStore.order?.["openai-codex"], undefined);
  assert.equal(staleStore.lastGood?.["openai-codex"], undefined);
});

test("rebalance openclaw runs the real sync path and then settles to noop on repeat", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_qa",
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
        assignments: { agent_boss: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: {
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      providerOverride: "openai-codex",
      modelOverride: "gpt-5.4",
      authProfileOverride: "openai-codex:qa",
      updatedAt: 1,
    },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 10 : 88;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    await withEnv(
      {
        HOME: home,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
      async () => {
        const firstOut = await runCli(["rebalance", "openclaw"]);
        const first = JSON.parse(firstOut);
        assert.equal(first.ok, true);
        assert.equal(first.rebalanced.status, "applied");

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.cleanupMode, "disk");

        const mainStore = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"), "utf8"),
        );
        assert.equal(mainStore.order?.["openai-codex"], undefined);
        assert.equal(mainStore.lastGood?.["openai-codex"], undefined);

        const sessions = JSON.parse(
          fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_boss", "sessions", "sessions.json"), "utf8"),
        );
        assert.equal(sessions.s1.modelProvider, undefined);
        assert.equal(sessions.s1.model, undefined);
        assert.equal(sessions.s1.providerOverride, undefined);
        assert.equal(sessions.s1.modelOverride, undefined);
        assert.equal(sessions.s1.authProfileOverride, undefined);

        const secondOut = await runCli(["rebalance", "openclaw"]);
        const second = JSON.parse(secondOut);
        assert.equal(second.ok, true);
        assert.equal(second.rebalanced.status, "noop");
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("apply fails closed for unassigned managed agents and clears stale session auth overrides", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [
      { id: "agent_boss", model: "openai/gpt-5.4" },
      { id: "agent_idle", model: "openai-codex/gpt-5.4" },
    ],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
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
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeOpenclawSessionsStore(home, "agent_idle", {
    s1: {
      modelProvider: "openai-codex",
      model: "gpt-5.4",
      authProfileOverride: "openai-codex:qa",
      updatedAt: 1,
    },
  });

  await withEnv(
    {
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
    async () => {
      const out = await runCli(["apply"]);
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);
      assert.equal(parsed.synced.sessions.mode, "disk");

      const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
      assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });

      const idleStore = JSON.parse(
        fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_idle", "agent", "auth-profiles.json"), "utf8"),
      );
      assert.deepEqual(idleStore.order["openai-codex"], []);
      assert.equal(idleStore.lastGood?.["openai-codex"], undefined);

      const idleSessions = JSON.parse(
        fs.readFileSync(path.join(home, ".openclaw", "agents", "agent_idle", "sessions", "sessions.json"), "utf8"),
      );
      assert.equal(idleSessions.s1.authProfileOverride, undefined);

      const mainStore = JSON.parse(
        fs.readFileSync(path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json"), "utf8"),
      );
      assert.equal(mainStore.order?.["openai-codex"], undefined);
    },
  );
});

test("rebalance openclaw surfaces applied_with_warnings at the real CLI boundary when weighted demand exceeds supply", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [
      { id: "agent_boss", model: "openai/gpt-5.4" },
      { id: "agent_light", model: "openai-codex/gpt-5.4" },
      { id: "agent_idle", model: "openai-codex/gpt-5.4" },
    ],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
      qa: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: "ACCESS_QA",
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
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
        assignments: { agent_boss: "boss", agent_light: "qa", agent_idle: "qa" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const now = Date.now();
  writeOpenclawSessionsStore(home, "agent_boss", {
    s1: { updatedAt: now, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
  });
  writeOpenclawSessionsStore(home, "agent_light", {
    s1: { updatedAt: now, inputTokens: 20, outputTokens: 10, totalTokens: 30 },
  });
  writeOpenclawSessionsStore(home, "agent_idle", {
    s1: { updatedAt: now, inputTokens: 10, outputTokens: 10, totalTokens: 20 },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const auth = String(options?.headers?.Authorization ?? "");
      const accessToken = auth.replace(/^Bearer\s+/i, "");
      const usedPercent = accessToken === "ACCESS_BOSS" ? 50 : 90;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: usedPercent,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    await withEnv(
      {
        HOME: home,
        PATH: `${fakeBinDir}:${process.env.PATH}`,
      },
      async () => {
        const out = await runCli(["rebalance", "openclaw"]);
        const parsed = JSON.parse(out);
        assert.equal(parsed.ok, true);
        assert.equal(parsed.rebalanced.status, "applied_with_warnings");
        assert.deepEqual(
          parsed.rebalanced.receipt.skipped.map(({ agentId, reason }) => ({ agentId, reason })),
          [
            { agentId: "agent_light", reason: "projected_demand_exceeds_eligible_supply" },
            { agentId: "agent_idle", reason: "projected_demand_exceeds_eligible_supply" },
          ],
        );
        assert.equal(parsed.rebalanced.receipt.allocationMode, "demand_weighted");
        assert.equal(parsed.rebalanced.receipt.perAccountLoad.find((entry) => entry.label === "boss")?.carriedAgentCount, 1);

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "applied_with_warnings");
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.allocationMode, "demand_weighted");
        assert.deepEqual(
          updatedState.targets.openclaw.lastApplyReceipt.skipped.map(({ agentId, reason }) => ({ agentId, reason })),
          [
            { agentId: "agent_light", reason: "projected_demand_exceeds_eligible_supply" },
            { agentId: "agent_idle", reason: "projected_demand_exceeds_eligible_supply" },
          ],
        );
      },
    );
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("rebalance openclaw reports blocked at the real CLI boundary when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_BOSS",
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_boss",
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
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const result = spawnSync(process.execPath, [path.join(process.cwd(), "bin", "aimgr.js"), "rebalance", "openclaw"], {
    cwd: process.cwd(),
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: home,
      PATH: `${fakeBinDir}:${process.env.PATH}`,
    },
  });

  assert.equal(result.status, 1);
  const parsed = JSON.parse(result.stdout);
  assert.equal(parsed.ok, false);
  assert.equal(parsed.rebalanced.status, "blocked");
  assert.deepEqual(parsed.rebalanced.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "blocked");
  assert.deepEqual(updatedState.targets.openclaw.lastApplyReceipt.blockers, [{ reason: "no_eligible_pool_account" }]);
});

test("sync codex bootstraps consumer state and strips authority-local OpenClaw metadata", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: makeFakeJwt({
            email: "boss@example.com",
            "https://api.openai.com/auth": {
              chatgpt_account_id: "acct_123",
              chatgpt_plan_type: "pro",
            },
          }),
          refresh: "REFRESH_TOKEN",
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
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "old-source",
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: {
        pins: {},
        browserProfiles: {
          boss: "stale-browser-profile",
        },
      },
      codexCli: {},
      interactiveOAuth: {
        bindings: {
          boss: { mode: "manual-callback" },
        },
      },
    },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.codex.source, path.resolve(authorityStatePath));
  assert.deepEqual(consumerState.imports.authority.codex.labels, ["boss"]);
  assert.equal(consumerState.accounts.boss.provider, "openai-codex");
  assert.equal(consumerState.accounts.boss.browser?.seededFrom, undefined);
  assert.equal(consumerState.accounts.boss.reauth?.mode, "manual-callback");
  assert.deepEqual(consumerState.targets.openclaw.assignments, {});
  assert.deepEqual(consumerState.targets.openclaw.exclusions, {});
  assert.equal(consumerState.targets.openclaw.pins, undefined);
  assert.equal(consumerState.targets.openclaw.browserProfiles, undefined);
  assert.equal(consumerState.targets.interactiveOAuth, undefined);
  assert.equal(consumerState.targets.codexCli.activeLabel, undefined);
  assert.equal(fs.existsSync(path.join(consumerHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json")), false);
});

test("status text shows manual-callback and browser-managed login modes", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  writeAimBrowserLocalState(home, "claude", {
    name: "claude",
    user_name: "claude@example.com",
    gaia_name: "Claude",
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      manual_label: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      claude: { provider: "anthropic", reauth: { mode: "aim-browser-profile" } },
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
      openclaw: {
        assignments: {},
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const out = await runCli(["status", "--home", home]);
  assert.match(out, /Accounts \(2\)/);
  assert.match(out, /label\s+st\s+login\s+exp\s+5h_used\s+5h_in\s+wk_used\s+wk_in\s+provider\s+flags/);
  assert.match(out, /claude\s+reauth\s+aim-profile\s+--\s+--\s+--\s+--\s+--\s+anthropic\s+missing_credentials/);
  assert.match(out, /manual_label\s+reauth\s+manual-callback\s+--\s+--\s+--\s+--\s+--\s+openai-codex\s+missing_credentials/);
});

test("status --json surfaces receipt and projection branches", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "auth.json"),
    `${JSON.stringify({
      OPENAI_API_KEY: null,
      tokens: {
        id_token: fakeJwt,
        access_token: fakeJwt,
        refresh_token: "REFRESH_TOKEN",
        account_id: "acct_123",
      },
      last_refresh: new Date().toISOString(),
    }, null, 2)}\n`,
    "utf8",
  );

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
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
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
        lastApplyReceipt: {
          action: "rebalance_openclaw",
          status: "applied_with_warnings",
          allocationMode: "demand_weighted",
          observedAt: new Date().toISOString(),
          perAccountLoad: [
            {
              label: "boss",
              carriedAgentCount: 3,
              carriedDemandWeight: 180,
              targetDemandWeight: 120,
            },
          ],
          warnings: [{ kind: "stale_pin" }],
          blockers: [],
        },
      },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
        lastSelectionReceipt: {
          action: "codex_use",
          status: "activated_with_warnings",
          observedAt: new Date().toISOString(),
          warnings: [{ kind: "readback_note" }],
          blockers: [],
        },
      },
    },
    pool: {
      openaiCodex: {
        agentDemand: {
          agent_heavy: {
            source: "openclaw-session-tokens",
            demandWeight: 150,
          },
          agent_cold: {
            source: "cold-start-equal-share",
            demandWeight: 75,
          },
        },
        history: [
          {
            observedAt: new Date().toISOString(),
            kind: "rebalance",
            status: "blocked",
            reason: "no_eligible_pool_account",
          },
          {
            observedAt: new Date().toISOString(),
            kind: "exhaustion",
            label: "boss",
            hadSpareEligibleCapacity: false,
          },
          {
            observedAt: new Date().toISOString(),
            kind: "rebalance",
            status: "applied_with_warnings",
          },
        ],
      },
    },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 96,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    const out = await runCli(["status", "--json", "--home", home]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.openclaw.lastApplyReceipt.status, "applied_with_warnings");
    assert.equal(parsed.openclaw.lastApplyReceipt.allocationMode, "demand_weighted");
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].label, "boss");
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].carriedAgentCount, 3);
    assert.equal(parsed.openclaw.lastApplyReceipt.perAccountLoad[0].carriedDemandWeight, 180);
    assert.equal(parsed.codexCli.lastSelectionReceipt.status, "activated_with_warnings");
    assert.equal(parsed.capacity.needMoreAccounts, true);
    assert.equal(parsed.capacity.riskLevel, "high");
    assert.deepEqual(parsed.capacity.basedOn.currentHighUtilizationLabels, ["boss"]);
    assert.equal(parsed.capacity.basedOn.knownAgentDemandCount, 1);
    assert.equal(parsed.capacity.basedOn.coldStartAgentCount, 1);
    assert.equal(parsed.capacity.byAccountPressure[0].label, "boss");
    assert.equal(parsed.capacity.byAccountPressure[0].carriedAgentCount, 3);
    assert.equal(parsed.capacity.byAccountPressure[0].carriedDemandWeight, 180);
    assert.equal(parsed.capacity.byAccountPressure[0].overTargetDemandWeight, 60);

    const textOut = await runCli(["status", "--home", home]);
    assert.match(textOut, /Last rebalance: status=applied_with_warnings observed=/);
    assert.match(textOut, /Spread: mode=demand_weighted boss=3 agent\(s\)\/180w/);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use fails loudly before any authority import", async () => {
  const home = mkTempHome();
  await assert.rejects(
    () => runCli(["codex", "use", "--home", home]),
    /Run `aim sync codex --from agents@amirs-mac-studio` first/,
  );
});

test("codex use writes auth.json and status reports active imported label", async () => {
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
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
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
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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

  try {
    await runCli(["codex", "use", "--home", home]);

    const authPath = path.join(home, ".codex", "auth.json");
    const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
    assert.equal(auth.OPENAI_API_KEY, null);
    assert.equal(auth.tokens.account_id, "acct_123");
    assert.equal(auth.tokens.access_token, fakeJwt);
    assert.equal(auth.tokens.id_token, fakeJwt);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.status, "activated");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "activated",
      label: "boss",
      accountId: "acct_123",
      hadSpareEligibleCapacity: false,
      reason: "next_best",
    });

    const out = await runCli(["status", "--json", "--home", home]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.codexCli.activeLabel, "boss");
    assert.equal(parsed.codexCli.source, "ssh://studio.local/~/.aimgr/secrets.json");
    assert.equal(parsed.codexCli.storeMode, "file");
    assert.equal(parsed.codexCli.actualAccountId, "acct_123");
    assert.equal(parsed.nextBestCandidate.label, "boss");
    assert.ok(parsed.warnings.every((warning) => !String(warning.kind).startsWith("codex_target_")));
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use clears stale managed auth when no pool account is eligible", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const fakeJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: fakeJwt,
      access_token: fakeJwt,
      refresh_token: "REFRESH_TOKEN",
      account_id: "acct_123",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: fakeJwt,
          refresh: "REFRESH_TOKEN",
          idToken: fakeJwt,
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_123",
        lastAppliedAt: new Date().toISOString(),
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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

  try {
    const result = await runCliWithExitCode(["codex", "use", "--home", home]);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.activated.status, "blocked");
    assert.equal(parsed.activated.receipt.previousLabel, "boss");
    assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, undefined);
    assert.equal(updatedState.targets.codexCli.expectedAccountId, undefined);
    assert.equal(updatedState.targets.codexCli.lastAppliedAt, undefined);
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.status, "blocked");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "blocked",
      reason: "no_eligible_pool_account",
      hadSpareEligibleCapacity: false,
    });
    assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), false);

    const status = JSON.parse(await runCli(["status", "--json", "--home", home]));
    assert.equal(status.codexCli.activeLabel, null);
    assert.equal(status.codexCli.readback.exists, false);
    assert.equal(status.codexCli.lastSelectionReceipt.status, "blocked");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use blocks instead of selecting a weekly-exhausted ready account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const cratejoyJwt = makeFakeJwt({
    email: "cratejoy@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_cratejoy",
      chatgpt_plan_type: "pro",
    },
  });
  const funCountryJwt = makeFakeJwt({
    email: "fun-country@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_fun_country",
      chatgpt_plan_type: "pro",
    },
  });
  const personalJwt = makeFakeJwt({
    email: "personal@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_personal",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(path.join(home, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: cratejoyJwt,
      access_token: cratejoyJwt,
      refresh_token: "REFRESH_CRATEJOY",
      account_id: "acct_cratejoy",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      amir_cratejoy_personal: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      amir_elaguizy_fun_country: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      amir_personal: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        amir_cratejoy_personal: {
          access: cratejoyJwt,
          refresh: "REFRESH_CRATEJOY",
          idToken: cratejoyJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_cratejoy",
        },
        amir_elaguizy_fun_country: {
          access: funCountryJwt,
          refresh: "REFRESH_FUN_COUNTRY",
          idToken: funCountryJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_fun_country",
        },
        amir_personal: {
          access: personalJwt,
          refresh: "REFRESH_PERSONAL",
          idToken: personalJwt,
          expiresAt: new Date(Date.now() + 6 * 24 * 3600_000).toISOString(),
          accountId: "acct_personal",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["amir_cratejoy_personal", "amir_elaguizy_fun_country", "amir_personal"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "amir_cratejoy_personal",
        expectedAccountId: "acct_cratejoy",
        lastAppliedAt: new Date().toISOString(),
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const accountId =
        init && init.headers && typeof init.headers["ChatGPT-Account-Id"] === "string"
          ? init.headers["ChatGPT-Account-Id"]
          : "";
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 5 * 3600,
            },
            secondary_window: {
              used_percent: accountId === "acct_cratejoy" ? 99 : 100,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    const result = await runCliWithExitCode(["codex", "use", "--home", home]);
    assert.equal(result.exitCode, 1);
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.ok, false);
    assert.equal(parsed.activated.status, "blocked");
    assert.deepEqual(parsed.activated.receipt.blockers, [{ reason: "no_eligible_pool_account" }]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, undefined);
    assert.equal(fs.existsSync(path.join(home, ".codex", "auth.json")), false);
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use selects fresh browser-managed labels even when the AIM browser dir is missing", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const lessonsJwt = makeFakeJwt({
    email: "lessons@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_lessons",
      chatgpt_plan_type: "pro",
    },
  });
  const coder2Jwt = makeFakeJwt({
    email: "coder2@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_coder2",
      chatgpt_plan_type: "pro",
    },
  });
  const cratejoyJwt = makeFakeJwt({
    email: "cratejoy@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_cratejoy",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      lessons: { provider: "openai-codex", reauth: { mode: "aim-browser-profile" }, browser: {} },
      coder2: { provider: "openai-codex", reauth: { mode: "aim-browser-profile" }, browser: {} },
      amir_cratejoy_personal: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        lessons: {
          access: lessonsJwt,
          refresh: "REFRESH_LESSONS",
          idToken: lessonsJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_lessons",
        },
        coder2: {
          access: coder2Jwt,
          refresh: "REFRESH_CODER2",
          idToken: coder2Jwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_coder2",
        },
        amir_cratejoy_personal: {
          access: cratejoyJwt,
          refresh: "REFRESH_CRATEJOY",
          idToken: cratejoyJwt,
          expiresAt: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
          accountId: "acct_cratejoy",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@localhost",
          importedAt: new Date().toISOString(),
          labels: ["lessons", "coder2", "amir_cratejoy_personal"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "amir_cratejoy_personal",
        expectedAccountId: "acct_cratejoy",
        lastAppliedAt: new Date().toISOString(),
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const u = String(url ?? "");
    if (u.includes("/backend-api/wham/usage")) {
      const accountId =
        init && init.headers && typeof init.headers["ChatGPT-Account-Id"] === "string"
          ? init.headers["ChatGPT-Account-Id"]
          : "";
      const secondaryUsedPercent =
        accountId === "acct_lessons" ? 44 : accountId === "acct_coder2" ? 51 : 99;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          plan_type: "pro",
          rate_limit: {
            primary_window: {
              used_percent: 0,
              limit_window_seconds: 10800,
              reset_at: Math.floor(Date.now() / 1000) + 5 * 3600,
            },
            secondary_window: {
              used_percent: secondaryUsedPercent,
              limit_window_seconds: 7 * 24 * 3600,
              reset_at: Math.floor(Date.now() / 1000) + 24 * 3600,
            },
          },
        }),
      };
    }
    throw new Error(`Unexpected fetch url in test: ${u}`);
  };

  try {
    const result = JSON.parse(await runCli(["codex", "use", "--home", home]));
    assert.equal(result.ok, true);
    assert.equal(result.activated.status, "activated");
    assert.equal(result.activated.receipt.label, "lessons");

    const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    assert.equal(auth.tokens.account_id, "acct_lessons");

    const status = JSON.parse(await runCli(["status", "--json", "--home", home]));
    const lessons = status.accounts.find((account) => account.label === "lessons");
    assert.equal(lessons.operator.status, "ready");
    assert.equal(lessons.operator.detailReason, "missing_browser");
    assert.equal(status.codexCli.activeLabel, "lessons");
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use skips expired labels and activates the next eligible pool account", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() - 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss", "qa"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  const origFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
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

  try {
    await runCli(["codex", "use", "--home", home]);

    const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
    assert.equal(updatedState.targets.codexCli.activeLabel, "qa");
    assert.equal(updatedState.targets.codexCli.lastSelectionReceipt.label, "qa");
    assert.deepEqual(updatedState.pool.openaiCodex.history.at(-1), {
      observedAt: updatedState.targets.codexCli.lastSelectionReceipt.observedAt,
      kind: "selection",
      status: "activated",
      label: "qa",
      accountId: "acct_qa",
      hadSpareEligibleCapacity: false,
      reason: "next_best",
    });
  } finally {
    globalThis.fetch = origFetch;
  }
});

test("codex use refuses non-file-backed Codex homes", async () => {
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
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
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
        codex: {
          source: "ssh://studio.local/~/.aimgr/secrets.json",
          importedAt: new Date().toISOString(),
          labels: ["boss"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    'cli_auth_credentials_store = "auto"\n',
    "utf8",
  );

  await assert.rejects(
    () => runCli(["codex", "use", "--home", home]),
    /Managed Codex activation requires file-backed auth storage/,
  );
});

test("sync codex clears stale managed auth when the active imported label is removed", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");
  const qaJwt = makeFakeJwt({
    email: "qa@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_qa",
      chatgpt_plan_type: "pro",
    },
  });
  const bossJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_boss",
      chatgpt_plan_type: "pro",
    },
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      qa: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
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
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(path.join(consumerHome, ".codex", "auth.json"), {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: bossJwt,
      access_token: bossJwt,
      refresh_token: "REFRESH_BOSS",
      account_id: "acct_boss",
    },
    last_refresh: new Date().toISOString(),
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
      qa: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: bossJwt,
          refresh: "REFRESH_BOSS",
          idToken: bossJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
        qa: {
          access: qaJwt,
          refresh: "REFRESH_QA",
          idToken: qaJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_qa",
        },
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "old-source",
          importedAt: new Date(0).toISOString(),
          labels: ["boss", "qa"],
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {
        activeLabel: "boss",
        expectedAccountId: "acct_boss",
        lastAppliedAt: new Date().toISOString(),
        lastSelectionReceipt: {
          action: "codex_use",
          status: "activated",
          label: "boss",
          observedAt: new Date().toISOString(),
        },
      },
    },
    pool: { openaiCodex: { history: [] } },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.accounts.boss, undefined);
  assert.equal(consumerState.credentials["openai-codex"].boss, undefined);
  assert.equal(consumerState.targets.codexCli.activeLabel, undefined);
  assert.equal(consumerState.targets.codexCli.expectedAccountId, undefined);
  assert.equal(consumerState.targets.codexCli.lastAppliedAt, undefined);
  assert.equal(consumerState.targets.codexCli.lastSelectionReceipt, undefined);
  assert.equal(fs.existsSync(path.join(consumerHome, ".codex", "auth.json")), false);
});

test("discoverOpenclawBrowserProfiles reads user-data/Local State for friendly names", () => {
  const openclawStateDir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-openclaw-"));

  const bossLocalState = path.join(openclawStateDir, "browser", "agent-boss", "user-data", "Local State");
  writeJson(bossLocalState, {
    profile: {
      info_cache: {
        Default: { name: "agent-boss", user_name: "boss@fun.country", gaia_name: "Boss Agent" },
      },
    },
  });

  const coderLocalState = path.join(openclawStateDir, "browser", "coder", "user-data", "Local State");
  writeJson(coderLocalState, {
    profile: {
      info_cache: {
        Default: { name: "coder", user_name: "", gaia_name: "" },
      },
    },
  });

  const profiles = discoverOpenclawBrowserProfiles({ openclawStateDir });
  assert.equal(profiles.length, 2);
  assert.equal(profiles[0].profileId, "agent-boss");
  assert.equal(profiles[0].userName, "boss@fun.country");
  assert.equal(profiles[1].profileId, "coder");
});

test("seedAimBrowserProfileFromOpenclaw copies the source profile once and records provenance", () => {
  const home = mkTempHome();
  const sourceDir = path.join(home, ".openclaw", "browser", "agent-boss", "user-data");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "Cookies"), "cookie-state", "utf8");

  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "aim-browser-profile" },
        pool: { enabled: true },
      },
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

  const first = seedAimBrowserProfileFromOpenclaw({
    state,
    label: "boss",
    homeDir: home,
    profileId: "agent-boss",
  });
  assert.equal(first.status, "seeded");
  assert.equal(
    fs.readFileSync(path.join(home, ".aimgr", "browser", "boss", "user-data", "Cookies"), "utf8"),
    "cookie-state",
  );
  assert.equal(state.accounts.boss.browser.seededFromOpenclawProfileId, "agent-boss");
  assert.ok(typeof state.accounts.boss.browser.seededAt === "string");

  const second = seedAimBrowserProfileFromOpenclaw({
    state,
    label: "boss",
    homeDir: home,
    profileId: "agent-boss",
  });
  assert.equal(second.status, "skipped");
});

test("real CLI login fails loud on a missing migration profile and leaves OpenClaw assignments untouched", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: { seededFrom: "agent-boss" },
        reauth: { mode: "aim-browser-profile" },
        pool: { enabled: true },
      },
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
      openclaw: {
        assignments: { agent_boss: "boss" },
        exclusions: {},
      },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["boss", "--home", home]),
    /AIM browser profile is missing and no OpenClaw migration source is available on this host/,
  );

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.deepEqual(updatedState.targets.openclaw.assignments, { agent_boss: "boss" });
  assert.equal(updatedState.accounts.boss.reauth.mode, "browser-managed");
  assert.ok(typeof updatedState.accounts.boss.reauth.lastAttemptAt === "string");
});

test("derivePoolAccountStatus keeps fresh browser-managed credentials ready when the AIM browser is missing", () => {
  const now = Date.now();

  const status = derivePoolAccountStatus({
    account: {
      provider: "openai-codex",
      reauth: { mode: "aim-browser-profile" },
      browser: {},
    },
    credentials: {
      access: "ACCESS_TOKEN",
      refresh: "REFRESH_TOKEN",
      expiresAt: new Date(now + 3600_000).toISOString(),
      accountId: "acct_123",
    },
    browserFacts: { exists: false },
    now,
  });

  assert.equal(status.operatorStatus, "ready");
  assert.equal(status.detailReason, "binding_missing_for_future_reauth");
  assert.equal(status.eligible, true);
  assert.equal(status.actionRequired, "run_aim_browser_set");
});

test("extractOpenclawConfigAgentModelPrimary handles string/object/null", () => {
  assert.equal(extractOpenclawConfigAgentModelPrimary(null), null);
  assert.equal(extractOpenclawConfigAgentModelPrimary(undefined), null);
  assert.equal(extractOpenclawConfigAgentModelPrimary(" openai/gpt-5.4 "), "openai/gpt-5.4");
  assert.equal(extractOpenclawConfigAgentModelPrimary({ primary: "openai-codex/gpt-5.4" }), "openai-codex/gpt-5.4");
  assert.equal(extractOpenclawConfigAgentModelPrimary({ primary: 123 }), null);
});

test("buildOpenclawModelSyncOps enforces openai-codex/gpt-5.4 for pinned agents", () => {
  const agentsList = [
    { id: "agent_boss", model: "openai/gpt-5.4" },
    { id: "agent_coder", model: { primary: "openai-codex/gpt-5.4" } },
    { id: "agent_lessons", model: null },
    { id: "agent_growth_analyst", model: { primary: "openai-codex/gpt-5.3-codex", fallbacks: ["openai/gpt-5.4"] } },
  ];

  const ops = buildOpenclawModelSyncOps({
    agentsList,
    pinnedAgentIds: ["agent_boss", "agent_coder", "agent_lessons", "agent_growth_analyst"],
  });

  assert.deepEqual(ops, [
    { path: "agents.list[0].model", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[2].model", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[3].model.primary", value: "\"openai-codex/gpt-5.4\"" },
    { path: "agents.list[3].model.fallbacks", value: "[]" },
  ]);
});

test("buildOpenclawModelSyncOps supports per-agent desired model refs", () => {
  const agentsList = [
    { id: "agent_boss", model: "openai-codex/gpt-5.4" },
    { id: "agent_claudalyst", model: "openai-codex/gpt-5.4" },
  ];

  const ops = buildOpenclawModelSyncOps({
    agentsList,
    pinnedAgentIds: ["agent_boss", "agent_claudalyst"],
    modelRefByAgentId: {
      agent_boss: "openai-codex/gpt-5.4",
      agent_claudalyst: "anthropic/claude-opus-4-6",
    },
  });

  assert.deepEqual(ops, [{ path: "agents.list[1].model", value: "\"anthropic/claude-opus-4-6\"" }]);
});

test("partitionOpenclawPinsByConfiguredAgents separates stale pins from active pins", () => {
  const partition = partitionOpenclawPinsByConfiguredAgents({
    pinsByAgentId: {
      agent_boss: "boss",
      agent_lessons: "lessons",
      agent_growth_analyst: "growth",
    },
    agentsList: [
      { id: "agent_boss", model: "openai-codex/gpt-5.4" },
      { id: "agent_growth_analyst", model: "openai-codex/gpt-5.4" },
    ],
  });

  assert.deepEqual(partition.activePins, {
    agent_boss: "boss",
    agent_growth_analyst: "growth",
  });
  assert.deepEqual(partition.stalePins, [{ agentId: "agent_lessons", label: "lessons" }]);
});

test("rankPoolCandidates keeps current label when it stays within the keep-current threshold", () => {
  const ranked = rankPoolCandidates({
    labels: ["boss", "qa"],
    currentLabel: "boss",
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 18 }, { kind: "secondary", usedPercent: 12 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 12 }, { kind: "secondary", usedPercent: 10 }],
      },
    },
    assignedCounts: { boss: 0, qa: 0 },
    now: Date.now(),
  });

  assert.equal(ranked[0].label, "boss");
  assert.equal(ranked[0].keptCurrent, true);
  assert.deepEqual(ranked[0].reasons, ["within_keep_current_threshold"]);
  assert.equal(pickNextBestPoolLabel({ rankedCandidates: ranked }).label, "boss");
});

test("refreshOpenclawAgentDemandLedger imports OpenClaw session counters and seeds cold-start demand", () => {
  const home = mkTempHome();
  const now = Date.parse("2026-03-21T12:00:00Z");
  const recent = now - 60_000;
  const stale = now - 10 * 24 * 60 * 60 * 1000;
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [], agentDemand: {} } },
  };

  writeOpenclawSessionsStore(home, "agent_heavy", {
    s1: { updatedAt: recent, inputTokens: 120, outputTokens: 30, totalTokens: 150 },
    s2: { updatedAt: recent, inputTokens: 60, outputTokens: 10, totalTokens: 70 },
    stale: { updatedAt: stale, inputTokens: 999, outputTokens: 999, totalTokens: 999 },
  });
  writeOpenclawSessionsStore(home, "agent_cold", {
    s1: { updatedAt: recent, inputTokens: 0, outputTokens: 0, totalTokens: 0 },
  });

  const refreshed = refreshOpenclawAgentDemandLedger({
    state,
    homeDir: home,
    configuredAgents: ["agent_heavy", "agent_cold"],
    now,
    lookbackDays: 7,
  });

  assert.equal(refreshed.allocationMode, "demand_weighted");
  assert.equal(readOpenclawAgentTokenUsage({ homeDir: home, agentId: "agent_heavy", now, lookbackDays: 7 }).totalTokens, 220);
  assert.deepEqual(state.pool.openaiCodex.agentDemand.agent_heavy, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "openclaw-session-tokens",
    inputTokens: 180,
    outputTokens: 40,
    totalTokens: 220,
    demandWeight: 220,
  });
  assert.deepEqual(state.pool.openaiCodex.agentDemand.agent_cold, {
    updatedAt: new Date(now).toISOString(),
    lookbackDays: 7,
    source: "cold-start-equal-share",
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    demandWeight: 220,
  });
});

test("planWeightedOpenclawRebalance supports many-to-one cold-start spread without burning labels after one use", () => {
  const plan = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_a", "agent_b", "agent_c"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 10 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 40 }, { kind: "secondary", usedPercent: 40 }],
      },
    },
    agentDemand: {},
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.equal(plan.allocationMode, "cold_start_equal_share");
  assert.deepEqual(plan.assignments, {
    agent_a: "boss",
    agent_b: "qa",
    agent_c: "boss",
  });
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "boss")?.carriedAgentCount, 2);
  assert.deepEqual(plan.unchanged[0], {
    agentId: "agent_a",
    label: "boss",
    reason: "kept_current_hysteresis",
    demandWeight: 1,
    demandSource: "cold-start-equal-share",
    targetDemandWeight: 1.8,
    projectedDemandWeight: 1,
  });

  const blocked = planOpenclawRebalance({
    configuredAgents: ["agent_a"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: [],
    usage: {},
    agentDemand: {},
    now: Date.now(),
  });

  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.assignments, {});
  assert.deepEqual(blocked.skipped, [{ agentId: "agent_a", reason: "no_eligible_pool_account" }]);
  assert.deepEqual(blocked.blockers, [{ reason: "no_eligible_pool_account" }]);
});

test("planWeightedOpenclawRebalance skips agents only when projected demand exceeds weighted supply", () => {
  const plan = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_heavy", "agent_medium", "agent_light", "agent_idle"],
    currentAssignments: {
      agent_heavy: "boss",
      agent_medium: "boss",
      agent_light: "qa",
      agent_idle: "qa",
    },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 50 }, { kind: "secondary", usedPercent: 50 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 90 }, { kind: "secondary", usedPercent: 90 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_medium: { source: "openclaw-session-tokens", demandWeight: 50 },
      agent_light: { source: "openclaw-session-tokens", demandWeight: 30 },
      agent_idle: { source: "openclaw-session-tokens", demandWeight: 20 },
    },
    now: Date.now(),
  });

  assert.equal(plan.status, "applied_with_warnings");
  assert.equal(plan.allocationMode, "demand_weighted");
  assert.deepEqual(plan.assignments, {
    agent_heavy: "boss",
    agent_medium: "boss",
  });
  assert.deepEqual(
    plan.skipped.map(({ agentId, reason }) => ({ agentId, reason })),
    [
      { agentId: "agent_light", reason: "projected_demand_exceeds_eligible_supply" },
      { agentId: "agent_idle", reason: "projected_demand_exceeds_eligible_supply" },
    ],
  );
  assert.equal(plan.perAccountLoad.find((entry) => entry.label === "boss")?.carriedDemandWeight, 200);
});

test("projectPoolCapacity flags high risk from blocked receipts and no-spare exhaustion", () => {
  const now = Date.parse("2026-03-21T12:00:00Z");
  const projected = projectPoolCapacity({
    now,
    history: [
      {
        observedAt: "2026-03-20T12:00:00Z",
        kind: "rebalance",
        status: "blocked",
        reason: "no_eligible_pool_account",
      },
      {
        observedAt: "2026-03-19T12:00:00Z",
        kind: "exhaustion",
        label: "boss",
        hadSpareEligibleCapacity: false,
      },
      {
        observedAt: "2026-03-18T12:00:00Z",
        kind: "exhaustion",
        label: "qa",
        hadSpareEligibleCapacity: false,
      },
      {
        observedAt: "2026-03-17T12:00:00Z",
        kind: "rebalance",
        status: "applied_with_warnings",
      },
      {
        observedAt: "2026-03-16T12:00:00Z",
        kind: "rebalance",
        status: "applied_with_warnings",
        reason: "projected_demand_exceeds_eligible_supply",
      },
    ],
    liveUsage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 96 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_cold: { source: "cold-start-equal-share", demandWeight: 75 },
    },
    lastApplyReceipt: {
      perAccountLoad: [
        {
          label: "boss",
          carriedAgentCount: 3,
          carriedDemandWeight: 180,
          targetDemandWeight: 120,
        },
      ],
    },
  });

  assert.equal(projected.needMoreAccounts, true);
  assert.equal(projected.riskLevel, "high");
  assert.deepEqual(projected.basedOn.currentHighUtilizationLabels, ["boss"]);
  assert.equal(projected.basedOn.knownAgentDemandCount, 1);
  assert.equal(projected.basedOn.coldStartAgentCount, 1);
  assert.equal(projected.byAccountPressure[0].label, "boss");
  assert.ok(projected.reasons.some((reason) => reason.includes("blocked receipt")));
  assert.ok(projected.reasons.some((reason) => reason.includes("no spare eligible capacity")));
  assert.ok(projected.reasons.some((reason) => reason.includes("overflowed projected demand")));
});

test("rebalanceOpenclawPool reports applied_with_warnings when sync returns warnings", async () => {
  const home = mkTempHome();
  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: {
        provider: "openai-codex",
        browser: {},
        reauth: { mode: "manual-callback" },
        pool: { enabled: true },
      },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
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
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
    },
    pool: { openaiCodex: { history: [] } },
  };

  const result = await rebalanceOpenclawPool(
    { home },
    state,
    {
      probeUsageSnapshotsByProviderImpl: async () => ({
        "openai-codex": {
          boss: {
            ok: true,
            windows: [{ kind: "primary", usedPercent: 5 }],
          },
        },
        anthropic: {},
      }),
      readOpenclawAgentsListFromConfigImpl: () => [{ id: "agent_boss", model: "openai-codex/gpt-5.4" }],
      syncOpenclawFromStateImpl: async () => ({
        auth: { wrote: [] },
        sessions: { reason: "disk" },
        warnings: [{ kind: "test_warning", system: "openclaw" }],
      }),
    },
  );

  assert.equal(result.status, "applied_with_warnings");
  assert.equal(state.targets.openclaw.lastApplyReceipt.status, "applied_with_warnings");
  assert.equal(state.targets.openclaw.lastApplyReceipt.warnings[0].kind, "test_warning");
});

test("sessionEntryNeedsModelReset detects runtime/override/provider drift vs desired model", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  assert.equal(
    sessionEntryNeedsModelReset({ entry: { modelProvider: "openai", model: "gpt-5.4" }, desiredProvider, desiredModel }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { modelProvider: "openai-codex", model: "gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    false,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { providerOverride: "openai", modelOverride: "gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { modelOverride: "openai/gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai:default" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai-codex:qa" },
      desiredProvider,
      desiredModel,
      desiredAuthProfileId: "openai-codex:boss",
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai-codex:boss" },
      clearManagedAuthProfile: true,
    }),
    true,
  );
});

test("resetSessionEntryToDefaults clears runtime/override/authProfile fields", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  const before = {
    updatedAt: 1,
    modelProvider: "openai",
    model: "gpt-5.4",
    providerOverride: "openai",
    modelOverride: "gpt-5.4",
    authProfileOverride: "openai:default",
    authProfileOverrideSource: "user",
    authProfileOverrideCompactionCount: 2,
    fallbackNoticeSelectedModel: "openai/gpt-5.4",
    fallbackNoticeActiveModel: "openai/gpt-5.4",
    fallbackNoticeReason: "fallback",
  };

  const patched = resetSessionEntryToDefaults({
    entry: before,
    desiredProvider,
    desiredModel,
    desiredAuthProfileId: "openai-codex:boss",
  });
  assert.equal(patched.changed, true);
  assert.equal(patched.entry.modelProvider, undefined);
  assert.equal(patched.entry.model, undefined);
  assert.equal(patched.entry.providerOverride, undefined);
  assert.equal(patched.entry.modelOverride, undefined);
  assert.equal(patched.entry.authProfileOverride, undefined);
  assert.equal(patched.entry.authProfileOverrideSource, undefined);
  assert.equal(patched.entry.authProfileOverrideCompactionCount, undefined);
  assert.equal(patched.entry.fallbackNoticeSelectedModel, undefined);
  assert.equal(patched.entry.fallbackNoticeActiveModel, undefined);
  assert.equal(patched.entry.fallbackNoticeReason, undefined);
  assert.ok(typeof patched.entry.updatedAt === "number");
  assert.ok(patched.entry.updatedAt > 1);
});

test("extractSessionModelRefFromEntry prefers runtime over override", () => {
  const parsed = extractSessionModelRefFromEntry({
    modelProvider: "openai",
    model: "gpt-5.4",
    providerOverride: "openai-codex",
    modelOverride: "gpt-5.4",
  });
  assert.deepEqual(parsed, { source: "runtime", provider: "openai", model: "gpt-5.4" });
});

test("scanOpenclawSessionsStoreForKeysNeedingModelReset finds mismatched keys", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  const keys = scanOpenclawSessionsStoreForKeysNeedingModelReset({
    store: {
      k1: { modelProvider: "openai", model: "gpt-5.4" },
      k2: { modelProvider: "openai-codex", model: "gpt-5.4" },
      k3: { providerOverride: "openai", modelOverride: "gpt-4.1" },
      k4: { authProfileOverride: "openai-codex:qa" },
    },
    desiredProvider,
    desiredModel,
    desiredAuthProfileId: "openai-codex:boss",
  });

  assert.deepEqual(keys.toSorted(), ["k1", "k3", "k4"]);
});
