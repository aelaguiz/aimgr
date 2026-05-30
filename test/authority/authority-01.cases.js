import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { resolveAuthorityLocator } from "../../src/credentials/authority.js";
import { buildAnthropicCredentialFingerprint } from "../../src/credentials/anthropic.js";
import { buildCodexCredentialFingerprint } from "../../src/credentials/codex.js";
import { getAuthorityAnthropicImportLabelStatus } from "../../src/state/authority-anthropic.js";
import { getAuthorityCodexImportLabelStatus } from "../../src/state/authority-codex.js";
import { loadAimgrStateFromJsonValue } from "../../src/state/schema.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { runCli } from "../helpers/cli-runner.js";
import { makeFakeJwt, mkTempHome, writeJson } from "../helpers/files.js";

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

test("state normalization drops malformed OpenClaw assignment rows before they reach status or sync", () => {
  const state = loadAimgrStateFromJsonValue({
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {},
    },
    imports: { authority: { codex: {}, anthropic: {} } },
    pins: {
      openclaw: {
        agent_top: "Boss",
        agent_top_bad: "bad label",
      },
    },
    targets: {
      openclaw: {
        assignments: {
          agent_existing: "Boss",
          "bad agent": "boss",
          agent_bad_label: "bad label",
        },
        pins: {
          agent_legacy: "Boss",
          agent_legacy_bad: "default",
        },
      },
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  // Status and sync are read-like operator surfaces; stale malformed pins should be pruned during
  // normalization instead of throwing later or being written back as non-canonical SSOT rows.
  assert.deepEqual(state.targets.openclaw.assignments, {
    agent_existing: "boss",
    agent_top: "boss",
    agent_legacy: "boss",
  });
  assert.equal(state.pins, undefined);
  assert.equal(state.targets.openclaw.pins, undefined);
});

test("codex authority metadata keeps dirty state when legacy label keys normalize", () => {
  const importedJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const currentJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    localRefresh: true,
  });
  const importedCredential = {
    access: importedJwt,
    refresh: "IMPORTED_REFRESH",
    idToken: importedJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const currentCredential = {
    access: currentJwt,
    refresh: "CURRENT_REFRESH",
    idToken: currentJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };
  const dirtyObservedAt = new Date(1000).toISOString();
  const state = loadAimgrStateFromJsonValue({
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
    },
    credentials: {
      "openai-codex": {
        boss: currentCredential,
      },
      anthropic: {},
    },
    imports: {
      authority: {
        codex: {
          importedAt: new Date(0).toISOString(),
          labels: ["Boss"],
          labelsByName: {
            Boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(importedCredential),
              dirtyLocal: true,
              dirtyObservedAt,
            },
          },
        },
        anthropic: {},
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  // Imported dirty metadata is the overwrite guard for authority sync/promote; normalizing the label
  // key must not silently reset it and make a locally refreshed credential look clean.
  assert.deepEqual(state.imports.authority.codex.labels, ["boss"]);
  assert.equal(state.imports.authority.codex.labelsByName.Boss, undefined);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
  assert.equal(state.imports.authority.codex.labelsByName.boss.dirtyObservedAt, dirtyObservedAt);
  assert.equal(
    state.imports.authority.codex.labelsByName.boss.baseCredentialFingerprint,
    buildCodexCredentialFingerprint(importedCredential),
  );
  assert.equal(getAuthorityCodexImportLabelStatus(state, "Boss").dirty, true);
});

test("anthropic authority metadata keeps dirty state when legacy label keys normalize", () => {
  const importedCredential = buildAnthropicClaudeCredential({
    access: "IMPORTED_ACCESS",
    refresh: "IMPORTED_REFRESH",
  });
  const currentCredential = buildAnthropicClaudeCredential({
    access: "CURRENT_ACCESS",
    refresh: "CURRENT_REFRESH",
  });
  const baseIdentity = {
    accountUuid: "acct_boss",
    emailAddress: "boss@example.com",
    organizationUuid: "org_boss",
  };
  const dirtyObservedAt = new Date(1000).toISOString();
  const state = loadAimgrStateFromJsonValue({
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "anthropic" },
    },
    credentials: {
      "openai-codex": {},
      anthropic: {
        boss: currentCredential,
      },
    },
    imports: {
      authority: {
        codex: {},
        anthropic: {
          importedAt: new Date(0).toISOString(),
          labels: ["Boss"],
          labelsByName: {
            Boss: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(importedCredential),
              baseIdentity,
              dirtyLocal: true,
              dirtyObservedAt,
            },
          },
        },
      },
    },
    targets: { openclaw: { assignments: {}, exclusions: {} }, claudeCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  // Claude authority imports use the same dirty metadata to protect native-bundle promotions; casing
  // cleanup of imported labels must keep the identity/fingerprint baseline that blocks stale writes.
  assert.deepEqual(state.imports.authority.anthropic.labels, ["boss"]);
  assert.equal(state.imports.authority.anthropic.labelsByName.Boss, undefined);
  assert.equal(state.imports.authority.anthropic.labelsByName.boss.dirtyLocal, true);
  assert.equal(state.imports.authority.anthropic.labelsByName.boss.dirtyObservedAt, dirtyObservedAt);
  assert.equal(
    state.imports.authority.anthropic.labelsByName.boss.baseCredentialFingerprint,
    buildAnthropicCredentialFingerprint(importedCredential),
  );
  assert.deepEqual(state.imports.authority.anthropic.labelsByName.boss.baseIdentity, baseIdentity);
  assert.equal(getAuthorityAnthropicImportLabelStatus(state, "Boss").dirty, true);
});

test("status normalizes malformed SSOT rows on disk without clearing dirty authority metadata", async () => {
  const home = mkTempHome();
  const statePath = path.join(home, ".aimgr", "secrets.json");
  const importedCodexJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
  });
  const currentCodexJwt = makeFakeJwt({
    email: "boss@example.com",
    "https://api.openai.com/auth": { chatgpt_account_id: "acct_123", chatgpt_plan_type: "pro" },
    localRefresh: true,
  });
  const importedCodexCredential = {
    access: importedCodexJwt,
    refresh: "IMPORTED_REFRESH",
    idToken: importedCodexJwt,
    expiresAt: new Date(Date.now() + 3600_000).toISOString(),
    accountId: "acct_123",
  };
  const currentCodexCredential = {
    access: currentCodexJwt,
    refresh: "CURRENT_REFRESH",
    idToken: currentCodexJwt,
    expiresAt: new Date(Date.now() + 7200_000).toISOString(),
    accountId: "acct_123",
  };
  const importedClaudeCredential = buildAnthropicClaudeCredential({
    access: "IMPORTED_CLAUDE_ACCESS",
    refresh: "IMPORTED_CLAUDE_REFRESH",
  });
  const currentClaudeCredential = buildAnthropicClaudeCredential({
    access: "CURRENT_CLAUDE_ACCESS",
    refresh: "CURRENT_CLAUDE_REFRESH",
  });

  writeJson(statePath, {
    schemaVersion: "0.2",
    accounts: {
      boss: { provider: "openai-codex" },
      claude: { provider: "anthropic", reauth: { mode: "native-claude" } },
    },
    credentials: {
      "openai-codex": {
        boss: currentCodexCredential,
      },
      anthropic: {
        claude: currentClaudeCredential,
      },
    },
    imports: {
      authority: {
        codex: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
          labels: ["Boss"],
          labelsByName: {
            Boss: {
              importedAt: new Date(0).toISOString(),
              baseAccountId: "acct_123",
              baseCredentialFingerprint: buildCodexCredentialFingerprint(importedCodexCredential),
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
        anthropic: {
          source: "agents@studio",
          importedAt: new Date(0).toISOString(),
          labels: ["Claude"],
          labelsByName: {
            Claude: {
              importedAt: new Date(0).toISOString(),
              baseCredentialFingerprint: buildAnthropicCredentialFingerprint(importedClaudeCredential),
              baseIdentity: {
                accountUuid: "acct_boss",
                emailAddress: "boss@example.com",
                organizationUuid: "org_boss",
              },
              dirtyLocal: true,
              dirtyObservedAt: new Date(1000).toISOString(),
            },
          },
        },
      },
    },
    targets: {
      openclaw: {
        assignments: {
          agent_existing: "Boss",
          "bad agent": "boss",
          agent_bad_label: "bad label",
        },
        pins: {
          agent_legacy: "Boss",
          agent_legacy_bad: "default",
        },
      },
      codexCli: {},
      claudeCli: {},
      piCli: {},
    },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  });

  const parsed = JSON.parse(await runCli(["status", "--json", "--home", home], {
    probeUsageSnapshotsByProviderImpl: async () => ({
      "openai-codex": {},
      anthropic: {},
    }),
  }));
  const persisted = JSON.parse(fs.readFileSync(statePath, "utf8"));

  // `aim status` is read-like for users, but it intentionally writes schema normalization back.
  // That write must canonicalize malformed rows without losing dirty authority overwrite guards.
  assert.deepEqual(persisted.targets.openclaw.assignments, {
    agent_existing: "boss",
    agent_legacy: "boss",
  });
  assert.equal(persisted.targets.openclaw.pins, undefined);
  assert.deepEqual(persisted.imports.authority.codex.labels, ["boss"]);
  assert.deepEqual(persisted.imports.authority.anthropic.labels, ["claude"]);
  assert.equal(persisted.imports.authority.codex.labelsByName.boss.dirtyLocal, true);
  assert.equal(persisted.imports.authority.anthropic.labelsByName.claude.dirtyLocal, true);
  assert.deepEqual(parsed.imports.authority.codex.dirtyLabels, ["boss"]);
  assert.deepEqual(parsed.imports.authority.anthropic.dirtyLabels, ["claude"]);
});

test("removed promote command fails before authority writes", async () => {
  await assert.rejects(
    () => runCli(["promote", "codex", "--to", path.join(mkTempHome(), ".aimgr", "source.json"), "boss", "--home", mkTempHome()]),
    /removed in the Redis cutover/,
  );
  await assert.rejects(
    () => runCli(["promote", "claude", "--to", path.join(mkTempHome(), ".aimgr", "source.json"), "boss", "--home", mkTempHome()]),
    /removed in the Redis cutover/,
  );
});
