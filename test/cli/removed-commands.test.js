import test from "node:test";
import assert from "node:assert/strict";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

test("retired top-level names are unknown commands with no compatibility redirect", async () => {
  for (const command of ["apply", "autopin", "internal", "pin", "promote", "session", "sync"]) {
    await assert.rejects(
      () => runCli([command, "--home", mkTempHome()]),
      new RegExp(`Unknown command: ${command}$`),
    );
  }
});

test("Pi activation rejects the unsupported label positional form", async () => {
  await assert.rejects(
    () => runCli(["pi", "use", "boss", "--home", mkTempHome()]),
    /`aim pi use` does not accept a label/,
  );
});
