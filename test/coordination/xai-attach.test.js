import test from "node:test";
import assert from "node:assert/strict";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { ensureProviderConfiguredForLabel } from "../../src/credentials/oauth.js";
import { createEmptyState } from "../../src/state/empty.js";

test("explicit xai provider attaches without rewriting an existing claude account provider", async () => {
  const state = createEmptyState();
  state.accounts.pro1 = { provider: "anthropic", expect: { email: "pro1@fun.country" } };
  const provider = await ensureProviderConfiguredForLabel({
    state,
    label: "pro1",
    explicitProvider: "xai",
    promptLineImpl: async () => {
      throw new Error("should not prompt");
    },
  });
  assert.equal(provider, "xai");
  assert.equal(state.accounts.pro1.provider, "anthropic");
});

test("xai identity is the email address", () => {
  assert.deepEqual(
    buildStableIdentityForCredential("xai", { emailAddress: "Pro1@Fun.Country" }),
    { emailAddress: "pro1@fun.country" },
  );
});
