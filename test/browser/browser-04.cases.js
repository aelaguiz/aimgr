import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  discoverOpenclawBrowserProfiles,
  formatOpenclawBrowserProfileChoice,
  openclawBrowserProfileExists,
  resolveOpenclawBrowserProfileFromInput,
} from "../../src/browser/openclaw.js";
import { seedAimBrowserProfileFromOpenclaw } from "../../src/browser/seed.js";
import { derivePoolAccountStatus } from "../../src/pool/account-status.js";
import { runCli } from "../helpers/cli-runner.js";
import {
  makeFakeJwt,
  mkTempHome,
  writeAimBrowserLocalState,
  writeJson,
  writeOpenclawBrowserLocalState,
} from "../helpers/files.js";

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
      claude: { provider: "anthropic", reauth: { mode: "native-claude" } },
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

  const out = await runCli(["status", "--accounts", "--home", home]);
  assert.match(out, /ACCOUNTS \(2\)/);
  assert.match(out, /label\s+st\s+login\s+exp\s+5h_used\s+5h_in\s+wk_used\s+wk_in\s+provider\s+flags/);
  assert.match(out, /claude\s+reauth\s+native-claude\s+--\s+--\s+--\s+--\s+--\s+anthropic\s+missing_credentials/);
  assert.match(out, /manual_label\s+reauth\s+manual-callback\s+--\s+--\s+--\s+--\s+--\s+openai-codex\s+missing_credentials/);
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
  const fetchImpl = async (url, init) => {
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

    const result = JSON.parse(await runCli(["codex", "use", "--home", home], { fetchImpl }));
    assert.equal(result.ok, true);
    assert.equal(result.activated.status, "activated");
    assert.equal(result.activated.receipt.label, "coder2");
    assert.deepEqual(result.activated.receipt.reasons, ["round_robin_bootstrap_first_eligible"]);

    const auth = JSON.parse(fs.readFileSync(path.join(home, ".codex", "auth.json"), "utf8"));
    assert.equal(auth.tokens.account_id, "acct_coder2");

    const status = JSON.parse(await runCli(["status", "--json", "--home", home], { fetchImpl }));
    const coder2 = status.accounts.find((account) => account.label === "coder2");
    assert.equal(coder2.operator.status, "ready");
    assert.equal(coder2.operator.detailReason, "missing_browser");
    assert.equal(status.codexCli.activeLabel, "coder2");
});

test("derivePoolAccountStatus requires a complete native Claude bundle for anthropic readiness", () => {
  const now = Date.now();
  const status = derivePoolAccountStatus({
    account: {
      provider: "anthropic",
      reauth: { mode: "native-claude" },
    },
    label: "boss",
    credentials: {
      access: "ACCESS_BOSS",
      refresh: "REFRESH_BOSS",
      expiresAt: new Date(now + 3600_000).toISOString(),
    },
    browserFacts: { exists: true, bindingPresent: true },
    now,
  });

  assert.equal(status.operatorStatus, "reauth");
  assert.equal(status.detailReason, "missing_native_claude_bundle");
  assert.equal(status.eligible, false);
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

test("OpenClaw browser discovery ignores incomplete homes and resolves operator input", () => {
  const home = mkTempHome();
  const openclawStateDir = path.join(home, ".openclaw");
  writeOpenclawBrowserLocalState(home, "agent-boss", {
    name: "Boss Browser",
    user_name: "boss@example.com",
    gaia_name: "Boss Agent",
  });
  fs.mkdirSync(path.join(openclawStateDir, "browser", "ghost-profile"), { recursive: true });

  const profiles = discoverOpenclawBrowserProfiles({ openclawStateDir });

  // OpenClaw browser profile selection drives OAuth repair. Incomplete homes must
  // stay out of the picker so an operator cannot bind a label to a dead browser path.
  assert.deepEqual(profiles.map((profile) => profile.profileId), ["agent-boss"]);
  assert.equal(openclawBrowserProfileExists({ openclawStateDir, profileId: "agent-boss" }), true);
  assert.equal(openclawBrowserProfileExists({ openclawStateDir, profileId: "ghost-profile" }), false);
  assert.equal(formatOpenclawBrowserProfileChoice(profiles[0]), "agent-boss — Boss Browser — boss@example.com — Boss Agent");
  assert.equal(resolveOpenclawBrowserProfileFromInput({ input: "1", profiles }), "agent-boss");
  assert.equal(resolveOpenclawBrowserProfileFromInput({ input: "AGENT-BOSS", profiles }), "agent-boss");
  assert.equal(resolveOpenclawBrowserProfileFromInput({ input: "2", profiles }), null);
  assert.equal(resolveOpenclawBrowserProfileFromInput({ input: "manual-entry", profiles }), "manual-entry");
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
