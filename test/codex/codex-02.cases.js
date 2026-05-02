import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("promote codex fails loudly when the authority credential changed since import", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const importedJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const authorityNowJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    authorityChanged: true,
  });
  const consumerJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    refreshed: true,
  });

  const importedCredential = {
    access: importedJwt,
    refresh: "IMPORTED_REFRESH",
    idToken: importedJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const authorityCredential = {
    access: authorityNowJwt,
    refresh: "AUTHORITY_REFRESH",
    idToken: authorityNowJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };
  const consumerCredential = {
    access: consumerJwt,
    refresh: "LOCAL_REFRESH",
    idToken: consumerJwt,
    expiresAt: new Date(Date.now() + 10800_000).toISOString(),
    accountId: "acct_123",
  };

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: authorityCredential,
      },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: consumerCredential,
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(importedCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["promote", "codex", "--to", authorityStatePath, "boss", "--home", consumerHome]),
    /authority credentials changed since the consumer imported them/,
  );

  const authorityState = JSON.parse(fs.readFileSync(authorityStatePath, "utf8"));
  assert.equal(authorityState.credentials["openai-codex"].boss.refresh, "AUTHORITY_REFRESH");

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
});

test("sync codex blocks when it would overwrite a locally refreshed imported label", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const authorityJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const localJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    refreshed: true,
  });
  const authorityCredential = {
    access: authorityJwt,
    refresh: "AUTHORITY_REFRESH",
    idToken: authorityJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const localCredential = {
    access: localJwt,
    refresh: "LOCAL_REFRESH",
    idToken: localJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: authorityCredential },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: localCredential },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(authorityCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  await assert.rejects(
    () => runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]),
    /Authority import would discard locally refreshed imported labels: boss/,
  );

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.credentials["openai-codex"].boss.refresh, "LOCAL_REFRESH");
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
});

test("sync codex --discard-dirty overwrites local dirty imports and clears their dirty state", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const authorityJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const localJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    refreshed: true,
  });
  const authorityCredential = {
    access: authorityJwt,
    refresh: "AUTHORITY_REFRESH",
    idToken: authorityJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const localCredential = {
    access: localJwt,
    refresh: "LOCAL_REFRESH",
    idToken: localJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: authorityCredential },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: localCredential },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(authorityCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--discard-dirty", "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.credentials["openai-codex"].boss.refresh, "AUTHORITY_REFRESH");
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, false);
  assert.equal(
    consumerState.imports.authority.codex.labelsByName.boss.baseCredentialFingerprint,
    buildCodexCredentialFingerprint(authorityCredential),
  );
});

test("sync codex clears dirty state when the authority already matches the refreshed local credential", async () => {
  const authorityHome = mkTempHome();
  const authorityStatePath = path.join(authorityHome, ".aimgr", "secrets.json");
  const consumerHome = mkTempHome();
  const consumerStatePath = path.join(consumerHome, ".aimgr", "secrets.json");

  const importedJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const refreshedJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    refreshed: true,
  });
  const importedCredential = {
    access: importedJwt,
    refresh: "IMPORTED_REFRESH",
    idToken: importedJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const refreshedCredential = {
    access: refreshedJwt,
    refresh: "REFRESHED_REFRESH",
    idToken: refreshedJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };

  writeJson(authorityStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: refreshedCredential },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  writeJson(consumerStatePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": { boss: refreshedCredential },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: path.resolve(authorityStatePath),
          importedAt: new Date(0).toISOString(),
          labels: ["boss"],
          labelsByName: {
            boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(importedCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  await runCli(["sync", "codex", "--from", authorityStatePath, "--home", consumerHome]);

  const consumerState = JSON.parse(fs.readFileSync(consumerStatePath, "utf8"));
  assert.equal(consumerState.credentials["openai-codex"].boss.refresh, "REFRESHED_REFRESH");
  assert.equal(consumerState.imports.authority.codex.labelsByName.boss.dirtyLocal, false);
});
