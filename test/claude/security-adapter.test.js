import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { mkTempHome } from "../helpers/files.js";

const SOURCE_PATH = fileURLToPath(new URL(
  "../../native/claude/security_shim.c",
  import.meta.url,
));

function compileAdapter({ delegatePath }) {
  const buildDir = mkTempHome();
  const adapterPath = path.join(buildDir, "security");
  const result = spawnSync("cc", [
    "-Wall",
    "-Wextra",
    "-Werror",
    "-std=c11",
    `-DSYSTEM_SECURITY_PATH=${JSON.stringify(delegatePath)}`,
    SOURCE_PATH,
    "-o",
    adapterPath,
  ], {
    encoding: "utf8",
    timeout: 10_000,
  });
  assert.equal(result.status, 0, result.stderr);
  return adapterPath;
}

function makeSyntheticDelegate() {
  const root = mkTempHome();
  const delegatePath = path.join(root, "synthetic-security");
  const argsPath = path.join(root, "args");
  const stdinPath = path.join(root, "stdin");
  fs.writeFileSync(delegatePath, [
    "#!/bin/sh",
    'printf "%s\\n" "$@" > "$AIMGR_TEST_DELEGATE_ARGS"',
    'cat > "$AIMGR_TEST_DELEGATE_STDIN"',
    'exit "${AIMGR_TEST_DELEGATE_EXIT:-0}"',
    "",
  ].join("\n"), { mode: 0o700 });
  return { delegatePath, argsPath, stdinPath };
}

function delegateEnv({ argsPath, stdinPath, exit = 0 }) {
  return {
    ...process.env,
    AIMGR_TEST_DELEGATE_ARGS: argsPath,
    AIMGR_TEST_DELEGATE_STDIN: stdinPath,
    AIMGR_TEST_DELEGATE_EXIT: String(exit),
  };
}

test("security adapter intercepts only exact Claude credential-service argv", () => {
  const delegate = makeSyntheticDelegate();
  const adapterPath = compileAdapter(delegate);
  const cases = [
    { operation: "find-generic-password", service: "Claude Code-credentials", status: 44 },
    { operation: "find-generic-password", service: "Claude Code-credentials-ae077abc", status: 44 },
    { operation: "add-generic-password", service: "Claude Code-ae077abc", status: 1 },
    { operation: "delete-generic-password", service: "Claude Code", status: 44 },
  ];

  for (const { operation, service, status } of cases) {
    const result = spawnSync(adapterPath, [operation, "-a", "synthetic", "-s", service, "-w"], {
      env: delegateEnv({ ...delegate, exit: 23 }),
      timeout: 2_000,
    });
    assert.equal(result.status, status, `${operation}:${service}`);
  }
  assert.equal(fs.existsSync(delegate.argsPath), false);
  assert.equal(fs.existsSync(delegate.stdinPath), false);

  const unrelatedArgs = [
    "find-generic-password",
    "-a",
    "synthetic",
    "-s",
    "Claude Code-credentials-AE077ABC",
    "-w",
  ];
  const unrelated = spawnSync(adapterPath, unrelatedArgs, {
    env: delegateEnv({ ...delegate, exit: 23 }),
    timeout: 2_000,
  });
  assert.equal(unrelated.status, 23);
  assert.deepEqual(
    fs.readFileSync(delegate.argsPath, "utf8").trimEnd().split("\n"),
    unrelatedArgs,
  );
  assert.equal(fs.readFileSync(delegate.stdinPath).length, 0);
});

test("security adapter intercepts exact Claude stdin scripts and replays unrelated bytes", () => {
  const delegate = makeSyntheticDelegate();
  const adapterPath = compileAdapter(delegate);
  const claudeScript = Buffer.from(
    'add-generic-password -U -a "synthetic" -s "Claude Code-credentials-ae077abc" -w "synthetic-payload"\n',
  );
  const intercepted = spawnSync(adapterPath, ["-i"], {
    input: claudeScript,
    env: delegateEnv({ ...delegate, exit: 23 }),
    timeout: 2_000,
  });
  assert.equal(intercepted.status, 1);
  assert.equal(fs.existsSync(delegate.argsPath), false);
  assert.equal(fs.existsSync(delegate.stdinPath), false);

  const unrelatedScript = Buffer.from(
    'find-generic-password -s "Unrelated Synthetic Service" -w\nopaque-line: $*[]{}\n',
  );
  const delegated = spawnSync(adapterPath, ["-i"], {
    input: unrelatedScript,
    env: delegateEnv({ ...delegate, exit: 23 }),
    timeout: 2_000,
  });
  assert.equal(delegated.status, 23);
  assert.equal(fs.readFileSync(delegate.argsPath, "utf8"), "-i\n");
  assert.deepEqual(fs.readFileSync(delegate.stdinPath), unrelatedScript);
});

test("security adapter fails closed when its exact system delegate cannot execute", () => {
  const root = mkTempHome();
  const adapterPath = compileAdapter({ delegatePath: path.join(root, "missing-security") });

  const argvResult = spawnSync(adapterPath, [
    "find-generic-password",
    "-s",
    "Unrelated Synthetic Service",
    "-w",
  ], { timeout: 2_000 });
  assert.equal(argvResult.status, 71);

  const stdinResult = spawnSync(adapterPath, ["-i"], {
    input: 'find-generic-password -s "Unrelated Synthetic Service" -w\n',
    timeout: 2_000,
  });
  assert.equal(stdinResult.status, 71);
});

test("security adapter bounds noninteractive stdin before parsing or replay", () => {
  const delegate = makeSyntheticDelegate();
  const adapterPath = compileAdapter(delegate);
  const result = spawnSync(adapterPath, ["-i"], {
    input: Buffer.alloc((1024 * 1024) + 1, 0x78),
    env: delegateEnv({ ...delegate, exit: 23 }),
    timeout: 3_000,
  });
  assert.equal(result.status, 74);
  assert.equal(fs.existsSync(delegate.argsPath), false);
  assert.equal(fs.existsSync(delegate.stdinPath), false);
});
