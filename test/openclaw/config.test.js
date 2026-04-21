import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  applyOpenclawModelSyncOps,
  readOpenclawAgentsListFromConfig,
  readOpenclawBindingsFromConfig,
} from "../../src/openclaw/config.js";
import { installFakeOpenclaw } from "../helpers/fakes.js";
import { mkTempHome, withEnv } from "../helpers/files.js";

test("OpenClaw config readers use fake PATH output and fail closed on malformed reads", async () => {
  const home = mkTempHome();
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [{ id: "agent_boss", model: "openai/gpt-5.4" }],
    bindingsList: [{ label: "boss", provider: "openai-codex" }],
  });

  await withEnv({ HOME: home, PATH: `${fakeBinDir}:${process.env.PATH}` }, async () => {
    assert.deepEqual(readOpenclawAgentsListFromConfig(), [{ id: "agent_boss", model: "openai/gpt-5.4" }]);
    assert.deepEqual(readOpenclawBindingsFromConfig(), [{ label: "boss", provider: "openai-codex" }]);
  });

  const malformedHome = mkTempHome();
  const malformedBinDir = installFakeOpenclaw({
    rootDir: malformedHome,
    agentsList: [],
    configGetRawByKey: { "agents.list": "{\"not\":\"an-array\"}" },
  });

  await withEnv({ HOME: malformedHome, PATH: `${malformedBinDir}:${process.env.PATH}` }, async () => {
    // Config reads are the live OpenClaw discovery boundary. Malformed CLI output must stop before
    // AIM derives assignments or writes auth/model changes from a bad fleet snapshot.
    assert.throws(() => readOpenclawAgentsListFromConfig(), /expected JSON array/);
  });

  const failedHome = mkTempHome();
  const failedBinDir = installFakeOpenclaw({
    rootDir: failedHome,
    agentsList: [],
    failConfigGetKeys: ["bindings"],
  });

  await withEnv({ HOME: failedHome, PATH: `${failedBinDir}:${process.env.PATH}` }, async () => {
    assert.throws(() => readOpenclawBindingsFromConfig(), /fake config get failed for bindings/);
  });
});

test("OpenClaw config set helper reports the failing path after earlier fake writes", async () => {
  const home = mkTempHome();
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [
      { id: "agent_boss", model: "openai/gpt-5.3" },
      { id: "agent_qa", model: "openai/gpt-5.3" },
    ],
    failConfigSetPaths: ["agents.list[1].model"],
  });

  await withEnv({ HOME: home, PATH: `${fakeBinDir}:${process.env.PATH}` }, async () => {
    // Model sync is a sequential live write. If one OpenClaw config set fails, the error needs to
    // identify the exact path so a blocked sync/rebalance receipt points operators at the bad write.
    assert.throws(
      () =>
        applyOpenclawModelSyncOps([
          { path: "agents.list[0].model", value: JSON.stringify("openai-codex/gpt-5.4") },
          { path: "agents.list[1].model", value: JSON.stringify("openai-codex/gpt-5.4") },
        ]),
      /openclaw config set failed for agents\.list\[1\]\.model.*fake config set failed/s,
    );
  });

  const list = JSON.parse(fs.readFileSync(path.join(home, "agents-list.json"), "utf8"));
  assert.equal(list[0].model, "openai-codex/gpt-5.4");
  assert.equal(list[1].model, "openai/gpt-5.3");
});
