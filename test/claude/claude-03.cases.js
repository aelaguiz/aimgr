import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildAnthropicCredentialFingerprint } from "../../src/credentials/anthropic.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome, writeJson } from "../helpers/files.js";

test("promote claude updates only the selected authority labels and clears local dirty state", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const bossAuthorityCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_AUTHORITY_BOSS",
    refresh: "REFRESH_AUTHORITY_BOSS",
  });
  const bossLocalCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_LOCAL_BOSS",
    refresh: "REFRESH_LOCAL_BOSS",
  });
  const qaCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_QA",
    refresh: "REFRESH_QA",
    emailAddress: "qa@example.com",
    organizationName: "QA Org",
    organizationUuid: "org_qa",
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
      qa: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: bossAuthorityCredential,
        qa: qaCredential,
      },
    },
    imports: { authority: { codex: {}, anthropic: { labels: [], labelsByName: {} } } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
      qa: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: bossLocalCredential,
        qa: qaCredential,
      },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss", "qa"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(bossAuthorityCredential),
              baseIdentity: {
                accountUuid: "acct_boss",
                emailAddress: "boss@example.com",
                organizationUuid: "org_boss",
              },
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
            qa: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(qaCredential),
              baseIdentity: {
                accountUuid: "acct_boss",
                emailAddress: "qa@example.com",
                organizationUuid: "org_qa",
              },
              dirtyLocal: false,
            },
          },
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const out = JSON.parse(await runCli(["promote", "claude", "--to", authorityStatePath, "boss", "--home", consumerHome]));
  assert.equal(out.promoted.status, "applied");
  assert.deepEqual(out.promoted.labels, ["boss"]);

  const authorityState = JSON.parse(fs.readFileSync(authorityStatePath, "utf8"));
  assert.equal(authorityState.credentials.anthropic.boss.refresh, "REFRESH_LOCAL_BOSS");
  assert.equal(authorityState.credentials.anthropic.qa.refresh, "REFRESH_QA");

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, false);
  assert.equal(
    consumerState.imports.authority.anthropic.labelsByName.boss.baseCredentialFingerprint,
    buildAnthropicCredentialFingerprint(bossLocalCredential),
  );
  assert.ok(typeof consumerState.imports.authority.anthropic.labelsByName.boss.lastPromotedAt === "string");
});

test("promote claude fails loudly when the authority credential changed since import", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const importedCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_IMPORTED",
    refresh: "REFRESH_IMPORTED",
  });
  const authorityCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_AUTHORITY_NOW",
    refresh: "REFRESH_AUTHORITY_NOW",
  });
  const consumerCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_LOCAL",
    refresh: "REFRESH_LOCAL",
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: authorityCredential,
      },
    },
    imports: { authority: { codex: {}, anthropic: { labels: [], labelsByName: {} } } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: consumerCredential,
      },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(importedCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["promote", "claude", "--to", authorityStatePath, "boss", "--home", consumerHome]),
    /authority credentials changed since the consumer imported them/,
  );

  const authorityState = JSON.parse(fs.readFileSync(authorityStatePath, "utf8"));
  assert.equal(authorityState.credentials.anthropic.boss.refresh, "REFRESH_AUTHORITY_NOW");

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, true);
});

test("sync claude blocks dirty imported labels until discard-dirty is explicit", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const authorityCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_AUTHORITY",
    refresh: "REFRESH_AUTHORITY",
  });
  const localCredential = buildAnthropicClaudeCredential({
    access: "ACCESS_LOCAL",
    refresh: "REFRESH_LOCAL",
  });

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { boss: authorityCredential },
    },
    imports: { authority: { codex: {}, anthropic: { labels: [], labelsByName: {} } } },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {},
      anthropic: { boss: localCredential },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(authorityCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: {
      openclaw: { assignments: {}, exclusions: {} },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["sync", "claude", "--from", authorityStatePath, "--home", consumerHome]),
    /Authority import would discard locally refreshed imported Claude labels: boss/,
  );

  let consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.credentials.anthropic.boss.refresh, "REFRESH_LOCAL");
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, true);

  await runCli(["sync", "claude", "--from", authorityStatePath, "--discard-dirty", "--home", consumerHome]);

  consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.credentials.anthropic.boss.refresh, "REFRESH_AUTHORITY");
  assert.equal(consumerState.imports.authority.anthropic.labelsByName.boss.dirtyLocal, false);
  assert.equal(
    consumerState.imports.authority.anthropic.labelsByName.boss.baseCredentialFingerprint,
    buildAnthropicCredentialFingerprint(authorityCredential),
  );
});
