import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkTempHome } from "../helpers/files.js";
import { preparePrimeInvocation, resolvePrimeLauncher } from "../../src/targets/prime-launcher.js";

test("Prime launcher uses the installed PATH entry instead of an inherited launcher override", () => {
  const home = mkTempHome();
  const binDir = path.join(home, "bin");
  const installedLauncher = path.join(binDir, "prime-agent");
  const inheritedLauncher = path.join(home, "old-prime-agent");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(installedLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  fs.writeFileSync(inheritedLauncher, "#!/bin/sh\nexit 0\n", { mode: 0o700 });

  assert.equal(resolvePrimeLauncher({
    env: {
      PATH: binDir,
      PRIME_AGENT_LAUNCHER_PATH: inheritedLauncher,
    },
  }), fs.realpathSync(installedLauncher));
});

test("Prime invocation leaves execution-lane selection to the installed launcher", () => {
  assert.deepEqual(preparePrimeInvocation({
    command: "/tmp/prime-agent",
    args: ["--resume", "session-123"],
  }), {
    command: "/tmp/prime-agent",
    args: ["--resume", "session-123"],
  });
  assert.throws(
    () => preparePrimeInvocation({ command: "/tmp/prime-agent", args: ["--dist", "--resume", "session-123"] }),
    /must not select Prime Agent's source\/dist execution lane/,
  );
});
