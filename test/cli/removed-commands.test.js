import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

test("removed top-level commands fail loud with replacement guidance", async () => {
  await assert.rejects(
    () => runCli(["pin", "--home", mkTempHome()]),
    /`aim pin` was removed.*aim rebalance openclaw/s,
  );
  await assert.rejects(
    () => runCli(["autopin", "openclaw", "--home", mkTempHome()]),
    /`aim autopin openclaw` was removed.*aim rebalance openclaw/s,
  );
  await assert.rejects(
    () => runCli(["sync", "claude", "--from", "/tmp/authority.json", "--home", mkTempHome()]),
    /`aim sync claude` was removed in the Redis cutover/,
  );
  await assert.rejects(
    () => runCli(["sync", "openclaw", "--home", mkTempHome()]),
    /`aim sync openclaw` was removed in the Redis cutover/,
  );
  await assert.rejects(
    () => runCli(["internal", "apply-codex-promotion", "--home", mkTempHome()]),
    /removed in the Redis cutover/,
  );
  await assert.rejects(
    () => runCli(["internal", "apply-claude-promotion", "--home", mkTempHome()]),
    /removed in the Redis cutover/,
  );
});

test("removed label-first Pi activation form fails before activation", async () => {
  await assert.rejects(
    () => runCli(["pi", "use", "boss", "--home", mkTempHome()]),
    /`aim pi use <label>` was removed.*aim pi use/s,
  );
});
