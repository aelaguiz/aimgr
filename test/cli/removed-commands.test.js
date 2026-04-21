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
});

test("removed label-first Codex and Pi activation forms fail before activation", async () => {
  await assert.rejects(
    () => runCli(["codex", "use", "boss", "--home", mkTempHome()]),
    /`aim codex use <label>` was removed.*aim codex use/s,
  );
  await assert.rejects(
    () => runCli(["pi", "use", "boss", "--home", mkTempHome()]),
    /`aim pi use <label>` was removed.*aim pi use/s,
  );
});
