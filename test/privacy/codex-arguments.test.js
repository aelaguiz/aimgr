import assert from "node:assert/strict";
import test from "node:test";
import { codexArguments } from "../../src/privacy/codex-arguments.js";

test("escaped prompt words cannot attach to a shared daemon", () => {
  for (const before of [[], ["resume", "thread"], ["fork", "thread"]]) {
    const args = [...before, "--", "--no-daemon"];
    assert.deepEqual(codexArguments(args).args, ["--no-daemon", ...args]);
  }
  assert.deepEqual(codexArguments(["--no-daemon", "hello"]).args, ["--no-daemon", "hello"]);
  assert.equal(codexArguments(["--", "login"]).command, null);
});

test("native greedy images admit every path without interpreting names as commands", () => {
  for (const before of [[], ["exec"], ["e"]]) {
    const args = [...before, "--image", "one.png", "app-server", "two.png", "--", "prompt"];
    assert.deepEqual(codexArguments(args, { cwd: "/work" }).images, ["/work/one.png", "/work/app-server", "/work/two.png"]);
  }
  assert.deepEqual(codexArguments(["exec", "resume", "thread", "--image", "one.png", "prompt"], { cwd: "/work" }).images, ["/work/one.png"]);
});

test("owned app server accepts only stdio in either native value spelling", () => {
  for (const args of [["app-server", "--listen", "tcp://127.0.0.1:9000"], ["app-server", "--listen=tcp://127.0.0.1:9000"]]) {
    assert.throws(() => codexArguments(args, { ownedAppServer: true }), /stdio/);
  }
  for (const args of [["app-server"], ["app-server", "--listen", "stdio://"], ["app-server", "--listen=stdio://"]]) {
    assert.doesNotThrow(() => codexArguments(args, { ownedAppServer: true }));
    assert.throws(() => codexArguments(args), /stdio/);
  }
  assert.throws(() => codexArguments(["-p", "invalid.name"]), /profile/);
});
