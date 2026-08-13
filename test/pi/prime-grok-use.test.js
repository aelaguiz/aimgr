import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../../src/cli/args.js";
import { inspectHarnessCredentialRecord, buildHarnessIdentityFingerprint } from "../../src/credentials/harness-access.js";
import { HARNESS_MANAGED_PROVIDERS } from "../../src/targets/harness-auth.js";

test("prime use accepts --grok and grok is a managed harness provider", () => {
  const parsed = parseArgs(["prime", "use", "--grok", "aelaguiz_personal"]);
  assert.equal(parsed.opts.grok, "aelaguiz_personal");
  assert.ok(HARNESS_MANAGED_PROVIDERS.includes("xai"));
});

test("xai harness identity is the SuperGrok email", () => {
  const record = {
    provider: "xai",
    label: "aelaguiz_personal",
    identity: { emailAddress: "aelaguiz@gmail.com" },
    credential: {
      access: "access-token",
      refresh: "refresh-token",
      expiresAt: new Date(Date.now() + 60 * 60 * 1000).toISOString(),
      emailAddress: "aelaguiz@gmail.com",
    },
    policy: { reauth: {} },
  };
  const fingerprint = buildHarnessIdentityFingerprint(record);
  assert.match(fingerprint, /^aimgr-id-v1:/);
  const inspected = inspectHarnessCredentialRecord(record);
  assert.equal(inspected.provider, "xai");
  assert.equal(inspected.binding, "aelaguiz_personal");
  assert.equal(inspected.due, false);
});
