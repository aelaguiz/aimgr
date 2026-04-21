import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

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
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, false);
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.baseAccountId, "acct_123");
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
