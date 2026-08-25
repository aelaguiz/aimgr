import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AIM_MCP_OUTPUT_CAP_CHARS,
  buildAimChildEnv,
  resolveAimBinPath,
  runAimCommand,
} from "../../src/mcp/exec.js";
import { mkTempHome } from "../helpers/files.js";

// Stand-in for bin/aimgr.js: the exec boundary must be provable without running
// real credential commands, so tests point `binPath` at this script instead.
// Exit codes are set, never forced: process.exit() would truncate the pipe writes
// this fixture exists to measure.
const FIXTURE = `
const [mode, ...rest] = process.argv.slice(2);
if (mode === "emit") {
  process.stdout.write("out:" + rest.join(","));
  process.stderr.write("err:line");
  process.exitCode = 3;
}
if (mode === "env") {
  process.stdout.write(JSON.stringify({
    NO_COLOR: process.env.NO_COLOR ?? null,
    FORCE_COLOR: process.env.FORCE_COLOR ?? null,
    cwd: process.cwd(),
  }));
}
if (mode === "flood") {
  process.stdout.write("x".repeat(Number(rest[0])));
  process.stderr.write("y".repeat(Number(rest[0])));
}
if (mode === "hang") {
  setInterval(() => {}, 1000);
}
if (mode === "orphan") {
  // A detached grandchild that inherits this process's stdout/stderr pipes. It is
  // in its own process group, so the group kill never reaches it and it keeps the
  // pipe write ends open — the exact shape that used to hang "close"-based settle.
  // It self-exits so no test ever leaves a stray process behind.
  const { spawn } = require("node:child_process");
  spawn(process.execPath, ["-e", "setTimeout(() => process.exit(0), 5000)"], {
    detached: true,
    stdio: "inherit",
  }).unref();
  setInterval(() => {}, 1000);
}
`;

function installFixtureBin() {
  const home = mkTempHome();
  const binPath = path.join(home, "bin", "fake-aim.js");
  fs.mkdirSync(path.dirname(binPath), { recursive: true });
  fs.writeFileSync(binPath, FIXTURE, "utf8");
  return { home, binPath };
}

test("aim exec captures stdout, stderr, and the exit code separately", async () => {
  const { binPath } = installFixtureBin();
  const result = await runAimCommand(["emit", "status", "--json"], { binPath });

  assert.equal(result.ok, false);
  assert.equal(result.exitCode, 3);
  assert.equal(result.signal, null);
  assert.equal(result.stdout, "out:status,--json");
  assert.equal(result.stderr, "err:line");
  assert.equal(result.truncated, false);
  assert.equal(typeof result.durationMs, "number");

  const success = await runAimCommand(["env"], { binPath });
  assert.equal(success.ok, true);
  assert.equal(success.exitCode, 0);
});

test("the child runs with NO_COLOR and without FORCE_COLOR", async () => {
  const { home, binPath } = installFixtureBin();
  const result = await runAimCommand(["env"], {
    binPath,
    env: { ...process.env, FORCE_COLOR: "3" },
  });
  const child = JSON.parse(result.stdout);

  assert.equal(child.NO_COLOR, "1");
  assert.equal(child.FORCE_COLOR, null);
  assert.equal(fs.realpathSync(child.cwd), fs.realpathSync(home));
  assert.equal(buildAimChildEnv({ FORCE_COLOR: "3" }).FORCE_COLOR, undefined);
  assert.equal(buildAimChildEnv({}).NO_COLOR, "1");
});

test("a hung command is killed on timeout instead of holding the MCP request", async () => {
  const { binPath } = installFixtureBin();
  const result = await runAimCommand(["hang"], { binPath, timeoutMs: 200, killGraceMs: 100 });

  assert.equal(result.ok, false);
  assert.equal(result.signal, "SIGTERM");
  assert.equal(result.timedOut, true);
  assert.match(result.stderr, /\[aim mcp: killed after 200ms\]$/);
  assert.ok(result.durationMs >= 150, `expected the timeout to elapse, got ${result.durationMs}ms`);
});

test("an orphaned grandchild holding the pipes cannot block the timeout", async () => {
  const { binPath } = installFixtureBin();
  const startedAt = Date.now();
  const result = await runAimCommand(["orphan"], {
    binPath,
    timeoutMs: 300,
    killGraceMs: 100,
    drainMs: 250,
  });
  const elapsedMs = Date.now() - startedAt;

  assert.equal(result.timedOut, true);
  assert.equal(result.ok, false);
  assert.equal(result.signal, "SIGTERM");
  // timeout + grace + drain, with slack for a loaded machine. Before settling on
  // `exit` this call never resolved at all.
  assert.ok(elapsedMs < 3_000, `expected a bounded settle, took ${elapsedMs}ms`);
});

test("output is capped with an explicit truncation notice", async () => {
  const { binPath } = installFixtureBin();
  const result = await runAimCommand(["flood", String(AIM_MCP_OUTPUT_CAP_CHARS)], { binPath });

  assert.equal(result.truncated, true);
  assert.match(result.stdout, new RegExp(`\\[aim mcp: output truncated at ${AIM_MCP_OUTPUT_CAP_CHARS} characters\\]$`));
  // The cap is shared across both streams, so the whole envelope stays bounded.
  const captured = result.stdout.replace(/\n\[aim mcp:[^\]]+\]$/, "").length
    + result.stderr.replace(/\n\[aim mcp:[^\]]+\]$/, "").length;
  assert.equal(captured, AIM_MCP_OUTPUT_CAP_CHARS);
});

test("a missing binary reports the spawn failure instead of throwing", async () => {
  const { home } = installFixtureBin();
  const result = await runAimCommand(["emit"], { binPath: path.join(home, "bin", "absent.js") });

  assert.equal(result.ok, false);
  assert.match(result.stderr, /Cannot find module|failed to spawn aim/);
  assert.equal(path.basename(resolveAimBinPath()), "aimgr.js");
});
