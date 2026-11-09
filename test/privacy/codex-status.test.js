import test from "node:test";
import assert from "node:assert/strict";
import { inspectCodexPrivacyStatus, formatCodexPrivacyStatus } from "../../src/privacy/codex-status.js";

const artifact = { version: "0.0.0-test", artifactSet: "a".repeat(64), approvalKind: "offsite-test" };
const healthy = { admit: () => artifact, environment: () => ({}), policy: () => ({}), maintenance: () => {} };

test("local runtime status distinguishes test approval and does not claim account login", () => {
  const result = inspectCodexPrivacyStatus(healthy);
  assert.equal(result.ready, true);
  assert.match(formatCodexPrivacyStatus(result), /isolated test runtime/);
  assert.equal(result.runtime.approval, "offsite-test");
});

test("unapproved bytes never enter the native policy reader and pending maintenance remains visible", () => {
  let calls = 0;
  const result = inspectCodexPrivacyStatus({ ...healthy,
    admit: () => { throw new Error("Unknown runtime"); },
    policy: () => { calls++; }, maintenance: () => { throw new Error("Maintenance pending"); } });
  assert.equal(calls, 0);
  assert.equal(result.ready, false);
  assert.equal(result.environmentProvisioned, true);
  assert.equal(result.maintenanceClear, false);
  assert.deepEqual(result.errors, ["Unknown runtime", "Maintenance pending"]);
});
