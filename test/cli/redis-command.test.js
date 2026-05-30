import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

test("redis configure writes shared Redis config without creating machine identity", async () => {
  const home = mkTempHome();
  const stdout = await runCli([
    "redis",
    "configure",
    "--home",
    home,
    "--url",
    "redis://amirs-mac-studio:6380",
    "--key-prefix",
    "aimgr:test",
    "--primary-host",
    "agents@amirs-mac-studio",
    "--transport",
    "tailscale",
  ]);

  const result = JSON.parse(stdout);
  assert.equal(result.ok, true);
  assert.equal(result.redis.url, "redis://amirs-mac-studio:6380");
  assert.equal(result.redis.keyPrefix, "aimgr:test:");
  assert.equal(result.redis.primaryHost, "agents@amirs-mac-studio");
  assert.equal(result.redis.transport, "tailscale");
  assert.equal(Object.hasOwn(result, "machineId"), false);
  assert.equal(fs.existsSync(result.path), true);
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "machine-id")), false);

  const configStdout = await runCli(["redis", "config", "--home", home]);
  const config = JSON.parse(configStdout);
  assert.equal(config.exists, true);
  assert.equal(Object.hasOwn(config, "machineId"), false);
  assert.equal(Object.hasOwn(config, "machineIdPath"), false);
});

test("redis configure requires a url", async () => {
  await assert.rejects(
    () => runCli(["redis", "configure", "--home", mkTempHome(), "--primary-host", "agents@amirs-mac-studio"]),
    /Missing --url/,
  );
});
