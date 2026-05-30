import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildRemoteCatCommand,
  buildRemoteStateArg,
  loadAuthorityState,
  resolveAuthorityLocator,
} from "../../src/credentials/authority.js";
import { makeFakeJwt, mkTempHome, withEnv, writeJson } from "../helpers/files.js";

function installFakeSsh({ rootDir, stdout, stderr = "", status = 0 }) {
  const binDir = path.join(rootDir, "bin");
  const logPath = path.join(rootDir, "ssh-args.json");
  fs.mkdirSync(binDir, { recursive: true });
  const scriptPath = path.join(binDir, "ssh");
  fs.writeFileSync(
    scriptPath,
    `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(logPath)}, JSON.stringify(args, null, 2) + "\\n");
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(${JSON.stringify(status)});
`,
    { encoding: "utf8", mode: 0o755 },
  );
  return { binDir, logPath };
}

test("authority SSH locators normalize home paths and quote remote shell fragments", () => {
  const source = resolveAuthorityLocator(
    "ssh://agents@studio.local:2222/~/Authority%20Dir/secrets%20%22quoted%22%20%24x.json",
  );

  // Authority SSH locators are remote write/read targets. Home-path normalization and quoting must
  // happen before AIM constructs remote cat/apply commands so spaces and shell metacharacters stay data.
  assert.equal(source.kind, "ssh");
  assert.equal(source.target, "agents@studio.local");
  assert.equal(source.port, "2222");
  assert.equal(source.remotePath, '$HOME/Authority Dir/secrets "quoted" $x.json');
  assert.equal(buildRemoteCatCommand(source.remotePath), 'cat -- "$HOME/Authority Dir/secrets \\"quoted\\" \\$x.json"');
  assert.equal(buildRemoteStateArg(source.remotePath), '--state "$HOME/Authority Dir/secrets \\"quoted\\" \\$x.json"');
});

test("loadAuthorityState reads SSH authority state through fake ssh without touching production remotes", async () => {
  const home = mkTempHome();
  const authorityState = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: makeFakeJwt({
            email: "boss@example.com",
            "https://api.openai.com/auth": { chatgpt_account_id: "acct_boss", chatgpt_plan_type: "pro" },
          }),
          refresh: "REFRESH_BOSS",
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_boss",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };
  const statePath = path.join(home, "authority.json");
  writeJson(statePath, authorityState);
  const { binDir, logPath } = installFakeSsh({
    rootDir: home,
    stdout: fs.readFileSync(statePath, "utf8"),
  });

  await withEnv({ HOME: home, PATH: `${binDir}:${process.env.PATH}` }, async () => {
    const loaded = loadAuthorityState("ssh://agents@studio.local:2222/~/Authority%20Dir/secrets.json");
    assert.equal(loaded.source.display, "ssh://agents@studio.local:2222/~/Authority%20Dir/secrets.json");
    assert.equal(loaded.state.accounts.boss.provider, "openai-codex");
    assert.equal(loaded.state.credentials["openai-codex"].boss.accountId, "acct_boss");
  });

  assert.deepEqual(JSON.parse(fs.readFileSync(logPath, "utf8")), [
    "-p",
    "2222",
    "agents@studio.local",
    'cat -- "$HOME/Authority Dir/secrets.json"',
  ]);
});
