import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

function writeState(home) {
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const token = makeFakeJwt({
    exp,
    "https://api.openai.com/auth": {
      chatgpt_account_id: "acct_123",
      chatgpt_plan_type: "pro",
    },
  });
  writeJson(path.join(home, ".aimgr", "secrets.json"), {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" }, pool: { enabled: true } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: token,
          refresh: "REFRESH_TOKEN",
          idToken: token,
          accountId: "acct_123",
          expiresAt: new Date(exp * 1000).toISOString(),
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} }, anthropic: { labels: [], labelsByName: {} } } },
    pool: { openaiCodex: { history: [] } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
  });
}

test("redis migrate collect and plan write redacted operator summaries", async () => {
  const home = mkTempHome();
  const migrationDir = path.join(home, ".aimgr", "redis-migration");
  const bundlePath = path.join(migrationDir, "bundle.json");
  const planPath = path.join(migrationDir, "plan.json");
  writeState(home);

  const collectOut = await runCli([
    "redis",
    "migrate",
    "collect",
    "--home",
    home,
    "--out",
    bundlePath,
  ]);
  const collect = JSON.parse(collectOut);
  assert.equal(collect.ok, true);
  assert.equal(collect.summary.candidateCount, 1);
  assert.equal(fs.existsSync(bundlePath), true);
  assert.doesNotMatch(collectOut, /REFRESH_TOKEN/);

  const planOut = await runCli([
    "redis",
    "migrate",
    "plan",
    "--home",
    home,
    "--from",
    migrationDir,
    "--out",
    planPath,
  ]);
  const planSummary = JSON.parse(planOut);
  assert.equal(planSummary.ok, true);
  assert.equal(planSummary.summary.importCredentialCount, 1);
  assert.equal(fs.existsSync(planPath), true);
  assert.doesNotMatch(planOut, /REFRESH_TOKEN/);
});

test("redis migrate apply requires the breaking cutover confirmation", async () => {
  const home = mkTempHome();
  const planPath = path.join(home, "plan.json");
  writeJson(planPath, { kind: "aimgr.redisMigration.plan.v1", credentials: [] });

  await assert.rejects(
    () => runCli(["redis", "migrate", "apply", "--home", home, "--plan", planPath]),
    /--confirm-breaking-cutover/,
  );
});
