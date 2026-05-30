import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

test("sync codex is removed after the Redis cutover", async () => {
  await assert.rejects(
    () => runCli(["sync", "codex", "--from", "/tmp/authority.json", "--home", mkTempHome()]),
    /sync codex.*removed in the Redis cutover/s,
  );
});
