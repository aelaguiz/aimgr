import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { runCodexInteractive } from "../../src/targets/codex-runner.js";

test("ordinary Codex launch executes its admitted artifact even when PATH has no Codex", async () => {
  let closed = 0, prepared = 0;
  const result = await runCodexInteractive({ homeDir: "/synthetic-home", cwd: "/synthetic-project", env: { PATH: "/empty" },
    prepareInvocation: async request => {
      assert.equal(request.command, undefined);
      prepared++;
      return { command: "/immutable/approved/launcher", args: ["native-arguments"], cwd: request.cwd,
        env: { PATH: "/usr/bin:/bin" }, environmentFd: 3, closeEnvironment() {}, async close() { closed++; } };
    },
    spawnImpl: (command, args) => {
      assert.equal(command, "/immutable/approved/launcher"); assert.deepEqual(args, ["native-arguments"]);
      const child = new EventEmitter(); queueMicrotask(() => child.emit("close", 0, null)); return child;
    },
  });
  assert.equal(result.code, 0); assert.equal(prepared, 1); assert.equal(closed, 1);
});
