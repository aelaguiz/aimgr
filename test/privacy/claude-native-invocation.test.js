import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { prepareClaudeNativeInvocation } from "../../src/privacy/claude-native-invocation.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-native-preparation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = path.join(root, "config"); fs.mkdirSync(config, { mode: 0o700 });
  fs.writeFileSync(path.join(config, ".claude.json"), JSON.stringify({ oauthAccount: { accountUuid: "account-a", organizationUuid: "org-a" } }));
  fs.writeFileSync(path.join(config, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "SYNTHETIC_ACCOUNT_SECRET", subscriptionType: "pro", scopes: ["user:inference"],
  }, mcpOAuth: { server: "SYNTHETIC_MCP_SECRET" } }));
  const artifact = { command: path.join(root, "claude"), launcher: path.join(root, "launcher"),
    policy: path.join(root, "policy.json"), artifactSet: "a".repeat(64), version: "2.1.316", approvalKind: "offsite-test" };
  fs.writeFileSync(artifact.policy, JSON.stringify({ schema: 1, platform: process.platform, arch: process.arch,
    version: artifact.version, vendorCommit: "cd7ceb459c68", testedKernelRelease: os.release() }));
  let admitted = 0, validated = 0, composed;
  return { root, artifact, counters: () => ({ admitted, validated }), composed: () => composed, options: {
    preparedLaunch: { command: artifact.command, configDir: config, loginStaging: false },
    args: ["--settings", '{"env":{"DISABLE_GROWTHBOOK":"0","REQUIRED_BUILD_INPUT":"kept"}}', "--print", "task"],
    cwd: root, env: { HOME: root, PATH: "/usr/bin:/bin", CLAUDE_CODE_TMPDIR: root, MCP_TOOL_SECRET: "SYNTHETIC_TOOL_SECRET" },
    protectedAccount: true, readRoots: [root], updateRoots: [],
    expectedIdentity: { accountUuid: "account-a", organizationUuid: "org-a" },
    admitArtifact(inputs) { admitted++; assert.equal(inputs.selectedCommand, artifact.command); return artifact; },
    inspectManagedPolicy: () => ({ resolvedReadPaths: [], sourceCount: 0 }),
    async validateSnapshot({ snapshot, expected, scratchParent, managedPolicy }) {
      validated++; snapshot.assertUnchanged(); composed = JSON.parse(fs.readFileSync(snapshot.file));
      assert.equal(expected.entrypoint, artifact.command); assert.equal(expected.commit, "cd7ceb459c68");
      assert.equal(fs.statSync(scratchParent).mode & 0o777, 0o700); assert.equal(managedPolicy.sourceCount, 0);
    },
  } };
}

test("native preparation admits, validates exact composed bytes, then transfers environment privately", async t => {
  const f = fixture(t), prepared = await prepareClaudeNativeInvocation(f.options);
  try {
    assert.deepEqual(f.counters(), { admitted: 1, validated: 1 });
    assert.equal(f.composed().disableRemoteControl, true); assert.equal(f.composed().env.DISABLE_GROWTHBOOK, "1");
    assert.equal(f.composed().env.REQUIRED_BUILD_INPUT, "kept");
    assert.equal(prepared.command, f.artifact.launcher); assert.equal(prepared.vendorCommand, f.artifact.command);
    assert.equal(path.dirname(prepared.retainedPaths.settings), path.join(f.root, `claude-${process.getuid()}`));
    assert.equal(fs.fstatSync(prepared.environmentFd).nlink, 0);
    assert.doesNotMatch(prepared.args.join("\n"), /SYNTHETIC_.*SECRET|REQUIRED_BUILD_INPUT/);
    const separator = prepared.args.indexOf("--");
    assert.deepEqual(prepared.args.slice(separator + 1, separator + 3), ["--settings", prepared.retainedPaths.settings]);
    assert.equal(prepared.environment.MCP_TOOL_SECRET, "SYNTHETIC_TOOL_SECRET");
  } finally { prepared.disposeBeforeStart(); }
  assert.equal(fs.existsSync(prepared.retainedPaths.settings), false);
  assert.equal(fs.existsSync(prepared.retainedPaths.scratch), false);
});

test("direct and routed preparation always protects files without requiring the recorded test OS release", async t => {
  const f = fixture(t), policy = JSON.parse(fs.readFileSync(f.artifact.policy));
  for (const protectedAccount of [false, true]) {
    for (const testedKernelRelease of [os.release(), "different-from-" + os.release(), undefined]) {
      fs.writeFileSync(f.artifact.policy, JSON.stringify({ ...policy, testedKernelRelease }));
      const prepared = await prepareClaudeNativeInvocation({ ...f.options, protectedAccount });
      try {
        assert.equal(prepared.command, f.artifact.launcher);
        assert.equal(prepared.args[1], "protected");
        assert.equal(prepared.environment.CLAUDE_CODE_ENABLE_TELEMETRY, "0");
        assert.equal(prepared.vendorCommand, f.artifact.command);
      } finally { prepared.disposeBeforeStart(); }
    }
  }
  assert.deepEqual(f.counters(), { admitted: 6, validated: 6 });
});

test("different test OS does not bypass build admission or native validation failure", async t => {
  const f = fixture(t), policy = JSON.parse(fs.readFileSync(f.artifact.policy));
  fs.writeFileSync(f.artifact.policy, JSON.stringify({ ...policy, testedKernelRelease: "different-from-" + os.release() }));
  const unapproved = Object.assign(new Error("unapproved synthetic Claude build"), { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED" });
  await assert.rejects(prepareClaudeNativeInvocation({ ...f.options, admitArtifact() { throw unapproved; } }),
    { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED" });
  assert.deepEqual(f.counters(), { admitted: 0, validated: 0 });
  await assert.rejects(prepareClaudeNativeInvocation({ ...f.options, validateSnapshot: async () => { throw new Error("native policy application failed"); } }),
    { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.ok(!fs.readdirSync(f.options.preparedLaunch.configDir).some(name => name.startsWith(".aim-private-runtime-")));
});

test("started owners retain their settings and scratch for delayed native children", async t => {
  const f = fixture(t), prepared = await prepareClaudeNativeInvocation(f.options);
  prepared.markStarted(); prepared.closeEnvironment(); prepared.disposeBeforeStart();
  assert.ok(fs.existsSync(prepared.retainedPaths.settings)); assert.ok(fs.existsSync(prepared.retainedPaths.scratch));
  assert.throws(() => fs.fstatSync(prepared.environmentFd), { code: "EBADF" });
});

test("unknown account eligibility and wrong identity refuse before validation or private transfer", async t => {
  const f = fixture(t);
  await assert.rejects(prepareClaudeNativeInvocation({ ...f.options, expectedIdentity: { accountUuid: "other", organizationUuid: "org-a" } }), /not bound/);
  fs.writeFileSync(path.join(f.options.preparedLaunch.configDir, ".credentials.json"), JSON.stringify({ claudeAiOauth: {
    accessToken: "synthetic", subscriptionType: "team", scopes: ["user:inference"],
  } }));
  await assert.rejects(prepareClaudeNativeInvocation(f.options), /individual Claude Pro or Max/);
  assert.deepEqual(f.counters(), { admitted: 2, validated: 0 });
  assert.ok(!fs.readdirSync(f.options.preparedLaunch.configDir).some(name => name.startsWith(".aim-private-runtime-")));
});

test("validation failure cleans preparation state and never returns a launchable invocation", async t => {
  const f = fixture(t);
  await assert.rejects(prepareClaudeNativeInvocation({ ...f.options, validateSnapshot: async () => { throw new Error("private native diagnostic"); } }), error => {
    assert.equal(error.code, "AIMGR_CLAUDE_PRIVACY_SETTINGS"); assert.ok(!error.message.includes("private native diagnostic")); return true;
  });
  assert.ok(!fs.readdirSync(f.options.preparedLaunch.configDir).some(name => name.startsWith(".aim-private-runtime-")));
  assert.deepEqual(fs.readdirSync(path.join(f.root, `claude-${process.getuid()}`)), []);
});

test("Mac MCP aliases require the admitted helper capability for direct and routed launches", {
  skip: process.platform !== "darwin",
}, async t => {
  const f = fixture(t), external = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-external-mcp-")));
  t.after(() => fs.rmSync(external, { recursive: true, force: true }));
  const executable = path.join(external, "binary"), alias = path.join(external, "alias");
  fs.writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o700 }); fs.symlinkSync(executable, alias);
  const options = { ...f.options, readRoots: undefined, workingDirectories: () => [],
    preparedLaunch: { ...f.options.preparedLaunch, userHomeDir: f.root },
    args: [...f.options.args, "--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: { local: { command: alias } } })] };
  const policy = JSON.parse(fs.readFileSync(f.artifact.policy));
  for (const capability of [false, true]) {
    fs.writeFileSync(f.artifact.policy, JSON.stringify({ ...policy, mcpExecutableAliases: capability }));
    for (const protectedAccount of [false, true]) {
      const prepared = await prepareClaudeNativeInvocation({ ...options, protectedAccount });
      try {
        const roots = prepared.args.slice(7, 7 + Number(prepared.args[6]));
        assert.equal(roots.includes(alias), capability);
        assert.equal(roots.includes(executable), true);
        assert.ok(!roots.includes(external), "never grant the external bin directory");
      } finally { prepared.disposeBeforeStart(); }
    }
  }
});
