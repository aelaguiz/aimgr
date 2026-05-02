import test from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import {
  applySessionsModelViaGatewayOps,
  probeOpenclawGateway,
  restartOpenclawGateway,
} from "../../src/io/process.js";
import { installFakeOpenclaw, readFakeOpenclawRestarts, readFakeOpenclawSessionPatches } from "../helpers/fakes.js";
import { mkTempHome, withEnv } from "../helpers/files.js";

test("OpenClaw gateway process helpers use fake PATH commands and preserve failure details", async () => {
  const home = mkTempHome();
  const fakeBinDir = installFakeOpenclaw({ rootDir: home, agentsList: [] });

  await withEnv({ PATH: `${fakeBinDir}:${process.env.PATH}` }, async () => {
    // These helpers are the live OpenClaw process boundary. Audit proof must keep
    // them on a fake PATH entry so a probe/restart never touches the operator's gateway.
    const probe = probeOpenclawGateway({ timeoutMs: 1234 });
    assert.deepEqual(probe, {
      ok: false,
      reason: "nonzero_exit",
      status: 1,
      stderr: "fake gateway unavailable",
    });

    const restart = restartOpenclawGateway({ timeoutMs: 1234 });
    assert.deepEqual(restart, {
      ok: true,
      status: "restarted",
      stdout: "restarted",
    });
    assert.equal(readFakeOpenclawRestarts(home).length, 1);
  });
});

test("OpenClaw session patch helper reports per-session failures without throwing", async () => {
  const home = mkTempHome();
  const fakeBinDir = installFakeOpenclaw({
    rootDir: home,
    agentsList: [],
    failSessionPatchKeys: ["session_bad"],
  });

  await withEnv({ PATH: `${fakeBinDir}:${process.env.PATH}` }, async () => {
    // Session model patching is a partial-failure boundary: callers need the
    // failed session key back as structured data, while successful patches stay observable.
    const result = await applySessionsModelViaGatewayOps({
      timeoutMs: 5678,
      ops: [
        { key: "session_ok", modelRef: "openai-codex/gpt-5.4" },
        { key: "session_bad", modelRef: "openai-codex/gpt-5.4" },
      ],
    });

    assert.equal(result.ok, false);
    assert.deepEqual(result.failures, [
      { key: "session_bad", error: "fake session patch failed for session_bad" },
    ]);

    const patches = readFakeOpenclawSessionPatches(home);
    assert.equal(patches.length, 1);
    assert.equal(patches[0].args[2], "sessions.patch");
    const params = JSON.parse(patches[0].args[patches[0].args.indexOf("--params") + 1]);
    assert.deepEqual(params, { key: "session_ok", model: "openai-codex/gpt-5.4" });
    assert.equal(path.basename(fakeBinDir), "bin");
  });
});
