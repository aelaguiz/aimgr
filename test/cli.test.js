import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  buildOpenclawModelSyncOps,
  discoverOpenclawBrowserProfiles,
  extractOpenclawConfigAgentModelPrimary,
  extractSessionModelRefFromEntry,
  main,
  parseAnthropicAuthorizationPaste,
  planEvenLabelAssignments,
  resetSessionEntryToDefaults,
  resolveAuthorityLocator,
  scanOpenclawSessionsStoreForKeysNeedingModelReset,
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

function makeFakeJwt(payload = {}) {
  const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(payload)}.sig`;
}

async function runCli(argv) {
  const chunks = [];
  const origWrite = process.stdout.write;
  process.stdout.write = (chunk, encoding, cb) => {
    chunks.push(typeof chunk === "string" ? chunk : chunk.toString(encoding));
    if (typeof cb === "function") cb();
    return true;
  };
  try {
    await main(argv);
  } finally {
    process.stdout.write = origWrite;
  }
  return chunks.join("");
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

test("apply writes OpenClaw auth-profiles.json with labeled profile ids", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");

  writeJson(statePath, {
    schemaVersion: "0.1",
    accounts: {
      boss: { provider: "openai-codex", openclawBrowserProfile: "agent-boss" },
    },
    pins: { openclaw: { agent_boss: "boss" } },
    credentials: {
      "openai-codex": {
        boss: {
          access: "ACCESS_TOKEN",
          refresh: "REFRESH_TOKEN",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
    },
  });

  await runCli(["apply", "--home", home]);

  const mainStorePath = path.join(home, ".openclaw", "agents", "main", "agent", "auth-profiles.json");
  const mainStore = JSON.parse(fs.readFileSync(mainStorePath, "utf8"));
  assert.ok(mainStore.profiles["openai-codex:boss"]);
  assert.equal(mainStore.profiles["openai-codex:boss"].provider, "openai-codex");
  assert.ok(Array.isArray(mainStore.order["openai-codex"]));
  assert.deepEqual(mainStore.order["openai-codex"], ["openai-codex:boss"]);

  const agentStorePath = path.join(home, ".openclaw", "agents", "agent_boss", "agent", "auth-profiles.json");
  const agentStore = JSON.parse(fs.readFileSync(agentStorePath, "utf8"));
  assert.deepEqual(agentStore.order["openai-codex"], ["openai-codex:boss"]);
  assert.equal(agentStore.lastGood["openai-codex"], "openai-codex:boss");
});

test("sync codex bootstraps consumer state and strips authority-local OpenClaw metadata", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  writeJson(authorityStatePath, {
    schemaVersion: "0.1",
    accounts: {
      boss: { provider: "openai-codex", openclawBrowserProfile: "agent-boss" },
    },
    pins: { openclaw: { agent_boss: "boss" } },
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
    },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.codex.source, path.resolve(authorityStatePath));
  assert.deepEqual(consumerState.imports.authority.codex.labels, ["boss"]);
  assert.equal(consumerState.accounts.boss.provider, "openai-codex");
  assert.equal(consumerState.accounts.boss.openclawBrowserProfile, undefined);
  assert.deepEqual(consumerState.targets.openclaw.pins, {});
  assert.deepEqual(consumerState.targets.openclaw.browserProfiles, {});
  assert.equal(consumerState.targets.codexCli.activeLabel, undefined);
  assert.equal(fs.existsSync(path.join(consumerHome, ".openclaw", "agents", "main", "agent", "auth-profiles.json")), false);
});

test("codex use fails loudly before any authority import", async () => {
  const home = mkTempHome();
  await assert.rejects(
    () => runCli(["codex", "use", "boss", "--home", home]),
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
      boss: { provider: "openai-codex" },
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
      openclaw: { pins: {}, browserProfiles: {} },
      codexCli: {},
    },
  });

  await runCli(["codex", "use", "boss", "--home", home]);

  const authPath = path.join(home, ".codex", "auth.json");
  const auth = JSON.parse(fs.readFileSync(authPath, "utf8"));
  assert.equal(auth.OPENAI_API_KEY, null);
  assert.equal(auth.tokens.account_id, "acct_123");
  assert.equal(auth.tokens.access_token, fakeJwt);
  assert.equal(auth.tokens.id_token, fakeJwt);

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.targets.codexCli.activeLabel, "boss");
  assert.equal(updatedState.targets.codexCli.storeMode, "file");

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
    const out = await runCli(["status", "--json", "--home", home]);
    const parsed = JSON.parse(out);
    assert.equal(parsed.codexCli.activeLabel, "boss");
    assert.equal(parsed.codexCli.source, "ssh://studio.local/~/.aimgr/secrets.json");
    assert.equal(parsed.codexCli.storeMode, "file");
    assert.equal(parsed.codexCli.actualAccountId, "acct_123");
    assert.ok(parsed.warnings.every((warning) => !String(warning.kind).startsWith("codex_target_")));
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
      boss: { provider: "openai-codex" },
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
      openclaw: { pins: {}, browserProfiles: {} },
      codexCli: {},
    },
  });

  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(
    path.join(home, ".codex", "config.toml"),
    'cli_auth_credentials_store = "auto"\n',
    "utf8",
  );

  await assert.rejects(
    () => runCli(["codex", "use", "boss", "--home", home]),
    /Managed Codex activation requires file-backed auth storage/,
  );
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

test("planEvenLabelAssignments spreads unpinned agents evenly across pool labels", () => {
  const { assignments } = planEvenLabelAssignments({
    candidateAgentIds: ["agent_a", "agent_b", "agent_c", "agent_d", "agent_e", "agent_boss"],
    existingPinsByAgentId: {
      agent_boss: "boss",
      agent_illustrator: "illustrator",
    },
    poolLabels: ["boss", "illustrator", "lessons", "product_growth", "qa"],
  });

  assert.deepEqual(assignments, {
    agent_a: "lessons",
    agent_b: "product_growth",
    agent_c: "qa",
    agent_d: "boss",
    agent_e: "illustrator",
  });
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

  const patched = resetSessionEntryToDefaults({ entry: before, desiredProvider, desiredModel });
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
    },
    desiredProvider,
    desiredModel,
  });

  assert.deepEqual(keys.toSorted(), ["k1", "k3"]);
});
