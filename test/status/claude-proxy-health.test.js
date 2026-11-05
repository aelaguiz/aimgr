import test from "node:test";
import assert from "node:assert/strict";
import { readClaudeProxyHealth } from "../../src/status/claude-proxy-health.js";
import { formatClaudeProxyHealth, projectClaudeEgress } from "../../src/status/claude-egress.js";

test("Mac health batches assigned profiles and returns only known service states", async () => {
  let calls = 0;
  const health = await readClaudeProxyHealth(["proxy2", "gcp-proxy", "proxy2", "../other", null], {
    platform: "darwin",
    execFileImpl: async (command, args, options) => {
      calls++;
      assert.equal(command, "/usr/bin/python3");
      assert.deepEqual(JSON.parse(args.at(-1)), ["proxy2", "gcp-proxy"]);
      assert.equal(options.timeout, 2000);
      return { stdout: JSON.stringify({ proxy2: "running", "gcp-proxy": "stopped", secret: "PRIVATE" }) };
    },
  });
  assert.equal(calls, 1);
  assert.deepEqual(health, { proxy2: "running", "gcp-proxy": "stopped" });
  assert.equal(formatClaudeProxyHealth({ mode: "proxy", profileRef: "gcp-proxy", health: health["gcp-proxy"] }), "stopped");
});

test("failed or unsupported health observations never report running", async () => {
  for (const execFileImpl of [
    async () => { throw new Error("timeout PRIVATE"); },
    async () => ({ stdout: "malformed PRIVATE" }),
    async () => ({ stdout: '{"proxy2":"PRIVATE"}' }),
  ]) {
    assert.deepEqual(await readClaudeProxyHealth(["proxy2"], { platform: "darwin", execFileImpl }), { proxy2: "unknown" });
  }
  const noCommand = async () => { assert.fail("no service query needed"); };
  assert.deepEqual(await readClaudeProxyHealth([], { execFileImpl: noCommand }), {});
  assert.deepEqual(await readClaudeProxyHealth(["proxy2"], { platform: "win32", execFileImpl: noCommand }), { proxy2: "unknown" });
  assert.deepEqual(projectClaudeEgress({ mode: "proxy", profileRef: "proxy2", health: "PRIVATE" }), { mode: "proxy", profileRef: "proxy2" });
});

test("Linux health distinguishes running, stopped, starting and missing services even on partial failure", async () => {
  const states = [
    ["running", "loaded", "active", "running"],
    ["stopped", "loaded", "failed", "failed"],
    ["starting", "loaded", "activating", "start"],
    ["absent", "not-found", "inactive", "dead"],
  ];
  const result = await readClaudeProxyHealth(states.map(([name]) => name), {
    platform: "linux",
    execFileImpl: async (command, args) => {
      assert.equal(command, "/usr/bin/systemctl");
      assert.equal(args[0], "show");
      throw Object.assign(new Error("unit absent"), { stdout: states.map(([name, load, active, sub]) =>
        `Id=aimgr-claude-proxy-${name}.service\nLoadState=${load}\nActiveState=${active}\nSubState=${sub}`).join("\n\n") });
    },
  });
  assert.deepEqual(result, { running: "running", stopped: "stopped", starting: "starting", absent: "not_installed" });
});

test("Linux transient recovery is current service state, not cached healthy usage", async () => {
  const result = await readClaudeProxyHealth(["recovering", "other"], {
    platform: "linux", existsSync: file => file === "/run/aimgr-claude-proxy-recovering/starting",
    execFileImpl: async () => ({ stdout: ["recovering", "other"].map(name =>
      `Id=aimgr-claude-proxy-${name}.service\nLoadState=loaded\nActiveState=active\nSubState=running`).join("\n\n") }),
  });
  assert.deepEqual(result, { recovering: "starting", other: "running" });
});
