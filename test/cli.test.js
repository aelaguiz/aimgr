import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOpenclawModelSyncOps,
  derivePoolAccountStatus,
  discoverOpenclawBrowserProfiles,
  ensureOpenAICodexInteractiveLoginBinding,
  extractOpenclawConfigAgentModelPrimary,
  extractSessionModelRefFromEntry,
  main,
  parseAnthropicAuthorizationPaste,
  planOpenclawRebalance,
  partitionOpenclawPinsByConfiguredAgents,
  pickNextBestPoolLabel,
  projectPoolCapacity,
  rankPoolCandidates,
  rebalanceOpenclawPool,
  refreshOrLoginCodex,
  resetSessionEntryToDefaults,
  resolveAuthorityLocator,
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

async function runCli(argv) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const origExitCode = process.exitCode;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    await main(argv);
  } finally {
    process.stdout.write = origWrite;
    process.exitCode = origExitCode;
  }
  return chunks.join("");
}

async function runCliWithExitCode(argv) {
  const chunks = [];
  const origWrite = process.stdout.write;
  const origExitCode = process.exitCode;
  process.exitCode = 0;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    await main(argv);
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
    assert.ok(
      out.includes(
        "usage=5h 10% used (resets Mar 17, 4:45 PM CDT, 1.5h left) · Week 20% used (resets Mar 18, 12:00 PM CDT, 20.8h left)",
      ),
    );
    assert.ok(
      out.includes(
        "usage=5h 12% used (resets Mar 17, 5:10 PM CDT, 1.9h left) · Week 34% used (resets Mar 18, 7:00 PM CDT, 27.7h left) · Opus 44% used",
      ),
    );
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
  assert.equal(persisted.accounts.boss.browser.seededFrom, "agent-boss");
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

test("rebalance openclaw surfaces applied_with_warnings at the real CLI boundary when agents must be skipped", async () => {
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
        assert.deepEqual(parsed.rebalanced.receipt.skipped, [{ agentId: "agent_idle", reason: "no_eligible_pool_account" }]);

        const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
        assert.equal(updatedState.targets.openclaw.lastApplyReceipt.status, "applied_with_warnings");
        assert.deepEqual(updatedState.targets.openclaw.lastApplyReceipt.skipped, [{ agentId: "agent_idle", reason: "no_eligible_pool_account" }]);
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
  assert.match(out, /openai-codex manual_label login=manual-callback/);
  assert.match(out, /anthropic claude login=aim-browser-profile/);
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
          observedAt: new Date().toISOString(),
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
    assert.equal(parsed.codexCli.lastSelectionReceipt.status, "activated_with_warnings");
    assert.equal(parsed.capacity.needMoreAccounts, true);
    assert.equal(parsed.capacity.riskLevel, "high");
    assert.deepEqual(parsed.capacity.basedOn.currentHighUtilizationLabels, ["boss"]);
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
  assert.equal(state.accounts.boss.browser.seededFrom, "agent-boss");
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
  assert.equal(updatedState.accounts.boss.reauth.mode, "aim-browser-profile");
  assert.ok(typeof updatedState.accounts.boss.reauth.lastAttemptAt === "string");
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
        windows: [{ kind: "primary", usedPct: 18 }, { kind: "secondary", usedPct: 12 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPct: 12 }, { kind: "secondary", usedPct: 10 }],
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

test("planOpenclawRebalance uses the shared selector and blocks when no eligible labels remain", () => {
  const plan = planOpenclawRebalance({
    configuredAgents: ["agent_a", "agent_b"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: ["boss", "qa"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPct: 18 }, { kind: "secondary", usedPct: 12 }],
      },
      qa: {
        ok: true,
        windows: [{ kind: "primary", usedPct: 12 }, { kind: "secondary", usedPct: 10 }],
      },
    },
    now: Date.now(),
  });

  assert.equal(plan.status, "applied");
  assert.deepEqual(plan.assignments, {
    agent_a: "boss",
    agent_b: "qa",
  });
  assert.deepEqual(plan.unchanged, [{ agentId: "agent_a", label: "boss" }]);
  assert.deepEqual(plan.moved, [{ agentId: "agent_b", from: null, to: "qa", reason: "next_best" }]);

  const blocked = planOpenclawRebalance({
    configuredAgents: ["agent_a"],
    currentAssignments: { agent_a: "boss" },
    eligibleLabels: [],
    usage: {},
    now: Date.now(),
  });

  assert.equal(blocked.status, "blocked");
  assert.deepEqual(blocked.assignments, {});
  assert.deepEqual(blocked.skipped, [{ agentId: "agent_a", reason: "no_eligible_pool_account" }]);
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
    ],
    liveUsage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPct: 96 }],
      },
    },
  });

  assert.equal(projected.needMoreAccounts, true);
  assert.equal(projected.riskLevel, "high");
  assert.deepEqual(projected.basedOn.currentHighUtilizationLabels, ["boss"]);
  assert.ok(projected.reasons.some((reason) => reason.includes("blocked receipt")));
  assert.ok(projected.reasons.some((reason) => reason.includes("no spare eligible capacity")));
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
            windows: [{ kind: "primary", usedPct: 5 }],
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
