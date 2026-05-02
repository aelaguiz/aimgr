import test from "node:test";
import assert from "node:assert/strict";
import {
  ensureProviderConfiguredForLabel,
  resolveBrowserModeSelectionFromInput,
  resolveOpenAICodexInteractiveLoginModeFromInput,
  resolveSupportedProviderFromInput,
} from "../../src/credentials/oauth.js";

test("provider and browser selection helpers keep first-run prompt defaults deterministic", async () => {
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };
  const writes = [];
  const prompts = [];

  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: "boss",
    promptLineImpl: async (question, options) => {
      prompts.push({ question, options });
      return options.defaultValue;
    },
    writeImpl: (chunk) => writes.push(chunk),
  });

  // A first-run shorthand label reaches this prompt before any credential write.
  // Pressing Enter must choose the documented Codex fast path instead of leaving provider state ambiguous.
  assert.equal(provider, "openai-codex");
  assert.equal(state.accounts.boss.provider, "openai-codex");
  assert.equal(prompts[0].options.defaultValue, "1");
  assert.match(writes.join(""), /Pick provider/);
  assert.equal(resolveSupportedProviderFromInput("2"), "anthropic");
  assert.equal(resolveSupportedProviderFromInput("Claude"), "anthropic");
  assert.equal(resolveSupportedProviderFromInput("codex"), "openai-codex");
  assert.equal(resolveOpenAICodexInteractiveLoginModeFromInput("manual_callback"), "manual-callback");
  assert.equal(resolveBrowserModeSelectionFromInput("agent_browser"), "agent-browser");
});

test("unsupported provider prompt input fails before creating a new label account", async () => {
  const state = {
    schemaVersion: "0.2",
    accounts: {},
    credentials: { "openai-codex": {}, anthropic: {} },
    imports: { authority: { codex: {}, anthropic: {} } },
    targets: { openclaw: { assignments: {}, exclusions: {} }, codexCli: {}, claudeCli: {}, piCli: {} },
    pool: { openaiCodex: { history: [] }, anthropic: { history: [] } },
  };

  // Bad provider input should be a repairable prompt error, not a partial account creation that later
  // looks like a configured label in status, panels, or target activation.
  await assert.rejects(
    () =>
      ensureProviderConfiguredForLabel({
        state,
        label: "boss",
        promptLineImpl: async () => "github",
      }),
    /Unsupported provider selection: github/,
  );
  assert.equal(state.accounts.boss, undefined);
});
