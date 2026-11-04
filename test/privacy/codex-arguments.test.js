import assert from "node:assert/strict";
import test from "node:test";
import { codexArguments, codexWorktreeArguments, validateCodexWorktreeArguments } from "../../src/privacy/codex-arguments.js";

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

test("worktree handoff retains original input origins and escaped prompt text", () => {
  const before = codexArguments(["-Cchild", "--add-dir=assets", "--worktree", "fork", "named-source", "--", "--worktree", "--cd=prompt"], { cwd: "/original" });
  assert.equal(validateCodexWorktreeArguments(before), true);
  const after = codexWorktreeArguments(before, "/managed/bucket/repo/child", "11111111-2222-4333-8444-555555555555");
  assert.equal(after.cwd, "/managed/bucket/repo/child");
  assert.equal(after.processCwd, "/original");
  assert.deepEqual(after.directories, ["/original/assets"]);
  assert.equal(after.worktree, false);
  assert.deepEqual(after.args.slice(-3), ["--", "--worktree", "--cd=prompt"]);
  assert.equal(after.positionals[0], "11111111-2222-4333-8444-555555555555");
});

test("inspection and unsupported worktree modes cannot create a checkout", () => {
  for (const args of [["--worktree", "--help"], ["exec", "--worktree", "--version"]]) {
    assert.equal(validateCodexWorktreeArguments(codexArguments(args)), false);
  }
  for (const args of [["--worktree", "resume", "thread"], ["--worktree", "fork", "--last"], ["exec", "--worktree", "resume", "thread"],
    ["exec", "--worktree", "--ephemeral", "prompt"], ["exec", "--worktree", "--ignore-user-config", "prompt"]]) {
    assert.throws(() => validateCodexWorktreeArguments(codexArguments(args)), /worktree/);
  }
});

test("native subcommand permissions replace inherited groups without dropping root auto-review settings", () => {
  const readonly = codexArguments(["--yolo", "exec", "--sandbox", "read-only", "prompt"]);
  assert.equal(readonly.yolo, false);
  assert.equal(readonly.harness.sandbox, "read-only");
  const review = codexArguments(["--approve-for-me", "exec", "--sandbox", "read-only", "prompt"]);
  assert.ok(review.config.includes('approvals_reviewer="auto_review"'));
  assert.equal(review.harness.sandbox, "read-only");
  const child = codexArguments(["-a", "untrusted", "-s", "read-only", "fork", "saved", "--approve-for-me"]);
  assert.equal(child.harness.approval, undefined);
  assert.equal(child.harness.sandbox, undefined);
  assert.ok(child.config.includes('sandbox_mode="workspace-write"'));
});

test("explicit exec input/output files retain process cwd and invalid worktree flags allocate nothing", () => {
  const parsed = codexArguments(["-C", "project", "exec", "--worktree", "--output-schema", "schema.json", "-oresult.txt", "prompt"], { cwd: "/original" });
  assert.deepEqual(parsed.files, ["/original/schema.json"]);
  assert.deepEqual(parsed.outputs, ["/original/result.txt"]);
  for (const args of [["--worktree", "--unknown"], ["--worktree=false"], ["--worktree", "-wCchild"]]) {
    assert.throws(() => validateCodexWorktreeArguments(codexArguments(args)), /no checkout/);
  }
  for (const args of [["exec", "fork", "saved", "--worktree", "--sandbox", "read-only"],
    ["exec", "--worktree", "fork", "saved", "--cyber-access-program", "standard"],
    ["--output-schema", "schema.json", "exec", "--worktree", "prompt"]]) {
    assert.throws(() => validateCodexWorktreeArguments(codexArguments(args)), /no checkout/);
  }
});
