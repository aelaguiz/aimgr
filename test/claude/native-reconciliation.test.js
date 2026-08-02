import test from "node:test";
import assert from "node:assert/strict";
import { syncClaudeNativeBundleBackToLabel } from "../../src/credentials/claude-native.js";
import { createEmptyState } from "../../src/state/empty.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";

const NOW_MS = Date.parse("2026-08-02T18:00:00.000Z");

function buildState() {
  const state = createEmptyState();
  state.accounts.claude = {
    provider: "anthropic",
    expect: { email: "boss@example.com" },
  };
  state.credentials.anthropic.claude = buildAnthropicClaudeCredential({
    access: "ACCESS_BASE",
    refresh: "REFRESH_BASE",
    expiresAtMs: NOW_MS + 3_600_000,
  });
  state.targets.claudeCli.lastRunLabel = "claude";
  return state;
}

test("Claude native reconciliation returns immutable pure outcomes", () => {
  const state = buildState();
  const originalCredential = structuredClone(state.credentials.anthropic.claude);

  const unchanged = syncClaudeNativeBundleBackToLabel({
    state,
    label: "claude",
    nativeClaudeBundle: originalCredential.nativeClaudeBundle,
    nowMs: NOW_MS,
  });
  assert.deepEqual(unchanged, {
    status: "unchanged",
    reason: "tokens_unchanged",
    label: "claude",
  });
  assert.equal(Object.isFrozen(unchanged), true);

  const rotated = structuredClone(originalCredential.nativeClaudeBundle);
  rotated.claudeAiOauth.accessToken = "ACCESS_ROTATED";
  rotated.claudeAiOauth.refreshToken = "REFRESH_ROTATED";
  rotated.claudeAiOauth.expiresAt = NOW_MS + 7_200_000;
  const candidate = syncClaudeNativeBundleBackToLabel({
    state,
    label: "claude",
    nativeClaudeBundle: rotated,
    nowMs: NOW_MS,
  });
  assert.equal(candidate.status, "candidate");
  assert.equal(candidate.label, "claude");
  assert.deepEqual(candidate.rotatedFields, ["accessToken", "refreshToken", "expiresAt"]);
  assert.equal(candidate.candidateCredential.nativeClaudeBundle.claudeAiOauth.refreshToken, "REFRESH_ROTATED");
  assert.equal(Object.hasOwn(candidate.candidateCredential, "refresh"), false);
  assert.equal(Object.isFrozen(candidate), true);
  assert.equal(Object.isFrozen(candidate.candidateCredential), true);
  assert.equal(Object.isFrozen(candidate.candidateCredential.nativeClaudeBundle.claudeAiOauth), true);
  assert.deepEqual(state.credentials.anthropic.claude, originalCredential);

  const unreadable = syncClaudeNativeBundleBackToLabel({
    state,
    label: "claude",
    nativeClaudeBundle: { claudeAiOauth: {}, oauthAccount: {} },
    nowMs: NOW_MS,
  });
  assert.equal(unreadable.status, "unreadable");
  assert.equal(Object.isFrozen(unreadable), true);

  const conflicting = structuredClone(rotated);
  conflicting.oauthAccount.accountUuid = "acct_other";
  const lineageConflict = syncClaudeNativeBundleBackToLabel({
    state,
    label: "claude",
    nativeClaudeBundle: conflicting,
    nowMs: NOW_MS,
  });
  assert.equal(lineageConflict.status, "lineage_conflict");
  assert.equal(lineageConflict.reason, "identity_conflict");
  assert.equal(Object.isFrozen(lineageConflict), true);
  assert.deepEqual(state.credentials.anthropic.claude, originalCredential);
});
