import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { prepareCodexNativeInvocation } from "../../src/privacy/codex-native-invocation.js";
import { prepareCodexAccountState } from "../../src/privacy/codex-account-state.js";

test("relative --cd is projected once while native retains its original process cwd and arguments", async t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-invocation-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"), cwd = path.join(root, "project"), selected = path.join(cwd, "child");
  fs.mkdirSync(homeDir); fs.mkdirSync(selected, { recursive: true });
  const environment = { binding: "a".repeat(64) };
  const prepared = { ...prepareCodexAccountState({ homeDir, accountId: "api-provider:deepseek", label: "fixture", environment }), keyBacked: true };
  const policy = path.join(root, "policy.json");
  fs.writeFileSync(policy, JSON.stringify({ schema: 1, version: "test", platform: process.platform, arch: process.arch,
    settingsManifest: 1, sourceCommit: "b".repeat(40) }));
  const artifact = { command: "/synthetic/codex", launcher: "/synthetic/launcher", artifactSet: "c".repeat(64),
    version: "test", policy, readPaths: [], stateIO: fileURLToPath(new URL("../../native/codex/state_io.py", import.meta.url)) };
  for (const args of [["-C", "child"], ["-C", "child", "--add-dir", "extra"]]) {
    const invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, args, environment,
      env: { HOME: homeDir, PATH: "/usr/bin:/bin" }, admitArtifact: () => artifact,
      inspectManagedPolicy: () => ({ files: [] }),
      nativeInputs: async ({ parsedArgs }) => {
        assert.equal(parsedArgs.cwd, selected);
        assert.equal(parsedArgs.processCwd, cwd);
        if (parsedArgs.worktree) assert.deepEqual(parsedArgs.directories, [path.join(cwd, "extra")]);
        return { cwd: selected, reads: [], writes: [], database_roots: [prepared.sharedHome], mcp_store: "keyring" };
      },
    });
    try {
      assert.equal(invocation.cwd, cwd);
      assert.equal(invocation.inputs.cwd, selected);
      assert.deepEqual(invocation.args.slice(invocation.args.indexOf("--") + 1), ["--no-daemon", ...args]);
    } finally { await invocation.close(); }
  }
});
