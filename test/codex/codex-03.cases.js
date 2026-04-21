import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { Readable } from "node:stream";
import { promoteCodexToAuthority } from "../../src/credentials/authority.js";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

test("internal apply-codex-promotion reads the payload from stdin and updates the authority state", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const authorityJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const refreshedJwt = makeFakeJwt({
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
  const refreshedCredential = {
    access: refreshedJwt,
    refresh: "REFRESHED_REFRESH",
    idToken: refreshedJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback", blockedReason: "stale" } },
    },
    credentials: {
      "openai-codex": { boss: authorityCredential },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  });

  const payload = {
    kind: "aimgr.codexPromotion.v1",
    sentAt: new Date().toISOString(),
    sourceAuthority: "agents@studio",
    labels: {
      boss: {
        provider: "openai-codex",
        accountId: "acct_123",
        credential: refreshedCredential,
        base: {
          accountId: "acct_123",
          credentialFingerprint: buildCodexCredentialFingerprint(authorityCredential),
        },
      },
    },
  };

  await runCli(["internal", "apply-codex-promotion", "--home", home], {
    stdin: Readable.from([JSON.stringify(payload)]),
  });

  const updatedState = JSON.parse(fs.readFileSync(statePath, "utf8"));
  assert.equal(updatedState.credentials["openai-codex"].boss.refresh, "REFRESHED_REFRESH");
  assert.equal(updatedState.accounts.boss.reauth.blockedReason, undefined);
});

test("internal apply-codex-promotion rejects missing or invalid stdin before authority writes", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const authorityJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const originalState = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback", blockedReason: "stale" } },
    },
    credentials: {
      "openai-codex": {
        boss: {
          access: authorityJwt,
          refresh: "AUTHORITY_REFRESH",
          idToken: authorityJwt,
          expiresAt: new Date(Date.now() + 3600_000).toISOString(),
          accountId: "acct_123",
        },
      },
      anthropic: {},
    },
    imports: { authority: { codex: { labels: [], labelsByName: {} } } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] } },
  };

  writeJson(statePath, originalState);

  // The internal receiver is the remote authority write endpoint used over SSH.
  // Empty or malformed stdin must fail before it can rewrite authority credentials or cleanup metadata.
  await assert.rejects(
    () => runCli(["internal", "apply-codex-promotion", "--home", home], { stdin: Readable.from([""]) }),
    /Missing codex promotion payload on stdin/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), originalState);

  await assert.rejects(
    () => runCli(["internal", "apply-codex-promotion", "--home", home], { stdin: Readable.from(["{"]) }),
    /Invalid codex promotion payload JSON/,
  );
  assert.deepEqual(JSON.parse(fs.readFileSync(statePath, "utf8")), originalState);
});

test("promoteCodexToAuthority uses the SSH receiver and sends the payload on stdin", () => {
  const authorityCredential = {
    access: makeFakeJwt({
      email: "boss@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    }),
    refresh: "AUTHORITY_REFRESH",
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const localCredential = {
    access: makeFakeJwt({
      email: "boss@example.com",
      "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
      refreshed: true,
    }),
    refresh: "LOCAL_REFRESH",
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };

  const state = {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex", reauth: { mode: "manual-callback" } },
    },
    credentials: {
      "openai-codex": {
        boss: localCredential,
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          source: "agents@studio",
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
  };

  const calls = [];
  const promoted = promoteCodexToAuthority(
    {
      to: "agents@studio",
      labels: ["boss"],
      state,
    },
    {
      spawnImpl: (cmd, args, options) => {
        calls.push({ cmd, args, options });
        return {
          status: 0,
          stdout: JSON.stringify({ ok: true, applied: { status: "applied", observedAt: new Date().toISOString() } }),
          stderr: "",
        };
      },
    },
  );

  assert.equal(promoted.status, "applied");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].cmd, "ssh");
  assert.equal(calls[0].args[0], "agents@studio");
  assert.match(calls[0].args[1], /aim internal apply-codex-promotion/);
  const payload = JSON.parse(calls[0].options.input);
  assert.equal(payload.kind, "aimgr.codexPromotion.v1");
  assert.deepEqual(Object.keys(payload.labels), ["boss"]);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyLocal, false);
});
