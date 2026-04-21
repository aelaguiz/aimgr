import test from "node:test";
import assert from "node:assert/strict";
import { resetSessionEntryToDefaults, scanOpenclawSessionsStoreForKeysNeedingModelReset, sessionEntryNeedsModelReset } from "../../src/openclaw/sessions.js";
import { planWeightedOpenclawRebalance } from "../../src/pool/weighted-planner.js";

test("planWeightedOpenclawRebalance is stable on immediate repeat when weekly headroom is unchanged", () => {
  const first = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_heavy", "agent_medium", "agent_light", "agent_idle"],
    currentAssignments: {
      agent_heavy: "coder",
      agent_medium: "pro1",
      agent_light: "boss",
      agent_idle: "growth",
    },
    eligibleLabels: ["boss", "coder", "growth", "office", "pro1", "pro2"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 15 }, { kind: "secondary", usedPercent: 45 }],
      },
      coder: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 20 }],
      },
      growth: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 20 }, { kind: "secondary", usedPercent: 55 }],
      },
      office: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
      pro1: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
      pro2: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_medium: { source: "openclaw-session-tokens", demandWeight: 90 },
      agent_light: { source: "openclaw-session-tokens", demandWeight: 40 },
      agent_idle: { source: "openclaw-session-tokens", demandWeight: 20 },
    },
    now: Date.now(),
  });

  const second = planWeightedOpenclawRebalance({
    configuredAgents: ["agent_heavy", "agent_medium", "agent_light", "agent_idle"],
    currentAssignments: first.assignments,
    eligibleLabels: ["boss", "coder", "growth", "office", "pro1", "pro2"],
    usage: {
      boss: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 15 }, { kind: "secondary", usedPercent: 45 }],
      },
      coder: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 10 }, { kind: "secondary", usedPercent: 20 }],
      },
      growth: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 20 }, { kind: "secondary", usedPercent: 55 }],
      },
      office: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
      pro1: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
      pro2: {
        ok: true,
        windows: [{ kind: "primary", usedPercent: 0 }, { kind: "secondary", usedPercent: 0 }],
      },
    },
    agentDemand: {
      agent_heavy: { source: "openclaw-session-tokens", demandWeight: 150 },
      agent_medium: { source: "openclaw-session-tokens", demandWeight: 90 },
      agent_light: { source: "openclaw-session-tokens", demandWeight: 40 },
      agent_idle: { source: "openclaw-session-tokens", demandWeight: 20 },
    },
    now: Date.now(),
  });

  assert.equal(second.status, "noop");
  assert.deepEqual(second.assignments, first.assignments);
  assert.equal(second.moved.length, 0);
});

test("sessionEntryNeedsModelReset detects runtime/override/provider drift vs desired model", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  assert.equal(
    sessionEntryNeedsModelReset({ entry: { modelProvider: "openai", model: "gpt-5.4" }, desiredProvider, desiredModel }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { modelProvider: "openai-codex", model: "gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    false,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { providerOverride: "openai", modelOverride: "gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { modelOverride: "openai/gpt-5.4" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai:default" },
      desiredProvider,
      desiredModel,
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai-codex:qa" },
      desiredProvider,
      desiredModel,
      desiredAuthProfileId: "openai-codex:boss",
    }),
    true,
  );

  assert.equal(
    sessionEntryNeedsModelReset({
      entry: { authProfileOverride: "openai-codex:boss" },
      clearManagedAuthProfile: true,
    }),
    true,
  );
});

test("resetSessionEntryToDefaults clears runtime/override/authProfile fields", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  const before = {
    updatedAt: 1,
    modelProvider: "openai",
    model: "gpt-5.4",
    providerOverride: "openai",
    modelOverride: "gpt-5.4",
    authProfileOverride: "openai:default",
    authProfileOverrideSource: "user",
    authProfileOverrideCompactionCount: 2,
    fallbackNoticeSelectedModel: "openai/gpt-5.4",
    fallbackNoticeActiveModel: "openai/gpt-5.4",
    fallbackNoticeReason: "fallback",
  };

  const patched = resetSessionEntryToDefaults({
    entry: before,
    desiredProvider,
    desiredModel,
    desiredAuthProfileId: "openai-codex:boss",
  });
  assert.equal(patched.changed, true);
  assert.equal(patched.entry.modelProvider, undefined);
  assert.equal(patched.entry.model, undefined);
  assert.equal(patched.entry.providerOverride, undefined);
  assert.equal(patched.entry.modelOverride, undefined);
  assert.equal(patched.entry.authProfileOverride, undefined);
  assert.equal(patched.entry.authProfileOverrideSource, undefined);
  assert.equal(patched.entry.authProfileOverrideCompactionCount, undefined);
  assert.equal(patched.entry.fallbackNoticeSelectedModel, undefined);
  assert.equal(patched.entry.fallbackNoticeActiveModel, undefined);
  assert.equal(patched.entry.fallbackNoticeReason, undefined);
  assert.ok(typeof patched.entry.updatedAt === "number");
  assert.ok(patched.entry.updatedAt > 1);
});

test("scanOpenclawSessionsStoreForKeysNeedingModelReset finds mismatched keys", () => {
  const desiredProvider = "openai-codex";
  const desiredModel = "gpt-5.4";

  const keys = scanOpenclawSessionsStoreForKeysNeedingModelReset({
    store: {
      k1: { modelProvider: "openai", model: "gpt-5.4" },
      k2: { modelProvider: "openai-codex", model: "gpt-5.4" },
      k3: { providerOverride: "openai", modelOverride: "gpt-4.1" },
      k4: { authProfileOverride: "openai-codex:qa" },
    },
    desiredProvider,
    desiredModel,
    desiredAuthProfileId: "openai-codex:boss",
  });

  assert.deepEqual(keys.toSorted(), ["k1", "k3", "k4"]);
});
