import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "../../src/cli/args.js";
import { loadCommandDefaultDeps } from "../../src/cli/deps.js";
import { formatCliError } from "../../src/cli/error.js";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("Claude run and resume pass unknown native arguments through unchanged", () => {
  const run = parseArgs([
    "claude",
    "run",
    "boss",
    "--home",
    "/tmp/aim-home",
    "--future-native-flag",
    "value",
    "--model",
    "opus",
  ]);
  assert.deepEqual(run.positional, ["claude", "run", "boss"]);
  assert.equal(run.opts.home, "/tmp/aim-home");
  assert.deepEqual(run.opts.afterDoubleDash, ["--future-native-flag", "value", "--model", "opus"]);

  const resume = parseArgs(["claude", "resume", "thread-1", "--future-resume-flag", "value"]);
  assert.deepEqual(resume.positional, ["claude", "resume", "thread-1"]);
  assert.deepEqual(resume.opts.afterDoubleDash, ["--future-resume-flag", "value"]);
});

test("AIM rejects unknown options outside native Claude passthrough, including --state", () => {
  assert.throws(() => parseArgs(["status", "--future-native-flag"]), /Unknown option: --future-native-flag/);
  assert.throws(() => parseArgs(["status", "--state", "/tmp/secrets.json"]), /Unknown option: --state/);
});

test("auth lazy defaults expose only executable resolution for maintenance", async () => {
  const deps = await loadCommandDefaultDeps("auth");

  assert.deepEqual(Object.keys(deps), ["resolveExecutableOnPathImpl"]);
  assert.equal(typeof deps.resolveExecutableOnPathImpl, "function");
  assert.equal(path.isAbsolute(deps.resolveExecutableOnPathImpl(path.basename(process.execPath))), true);
});

test("CLI error formatting preserves an endpoint while removing credentials and token material", () => {
  const formatted = formatCliError(new Error(
    "connect rediss://alice:password@example.test:6380/0?token=URL_SECRET failed; access_token=TOKEN_SECRET Bearer BEARER_SECRET",
  ));

  assert.equal(
    formatted,
    "aim: connect rediss://example.test:6380/0 failed; access_token=[redacted] Bearer [redacted]",
  );
  assert.doesNotMatch(formatted, /alice|password|URL_SECRET|TOKEN_SECRET|BEARER_SECRET/);
});

test("executable boundary prints one expected error line without a stack", () => {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "bin/aimgr.js"), "pin"], {
    cwd: repoRoot,
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.equal(result.stderr, "aim: Unknown command: pin\n");
  assert.doesNotMatch(result.stderr, /\n\s+at /);
});
