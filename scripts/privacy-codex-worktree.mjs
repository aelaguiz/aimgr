#!/usr/bin/env node
// Synthetic native-library worktree allocation/configuration fixture.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile, spawnSync } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

assert.ok(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"));
assert.notEqual(process.getuid(), 0);
const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const binaries = path.join(repo, "native/codex/config-state/target/debug");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-worktree-")));
const taskHome = path.join(root, "home"), codexHome = path.join(taskHome, ".codex");
const source = path.join(root, "source"), sourceCwd = path.join(source, "subdirectory");
fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
fs.mkdirSync(sourceCwd, { recursive: true });
fs.mkdirSync(path.join(source, ".codex"));
fs.writeFileSync(path.join(sourceCwd, "keep.txt"), "synthetic source subdirectory");
const env = { HOME: taskHome, PATH: "/usr/bin:/bin", TMPDIR: root, LANG: "en_US.UTF-8" };
const git = args => {
  const result = spawnSync("git", args, { cwd: source, env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
};
git(["init"]);
git(["config", "user.name", "Synthetic Fixture"]);
git(["config", "user.email", "synthetic@example.invalid"]);
const config = path.join(source, ".codex/config.toml");
const committedState = path.join(root, "committed-state"), dirtyState = path.join(root, "dirty-state");
const committedLogs = path.join(root, "committed-logs"), dirtyLogs = path.join(root, "dirty-logs");
const projectConfig = (state, logs) => `sqlite_home=${JSON.stringify(state)}\nlog_dir=${JSON.stringify(logs)}\n`;
fs.writeFileSync(config, projectConfig(committedState, committedLogs));
git(["add", "."]); git(["commit", "-qm", "Synthetic committed settings"]);
fs.writeFileSync(config, projectConfig(dirtyState, dirtyLogs));
const container = path.join(root, "custom-worktrees");
fs.writeFileSync(path.join(codexHome, "config.toml"), `check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[projects.${JSON.stringify(source)}]\ntrust_level="trusted"\n[desktop]\ngit-worktree-root=${JSON.stringify(container)}\n`);
const execute = promisify(execFile);
async function call(name, request, expectFailure = false, overrides = {}) {
  const promise = execute(path.join(binaries, name), [], { cwd: source, env: { ...env, ...overrides }, encoding: "utf8", timeout: 30_000 });
  promise.child.stdin.on("error", () => {});
  promise.child.stdin.end(JSON.stringify(request));
  if (expectFailure) { await assert.rejects(promise); return; }
  const result = await promise;
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
const request = { operation: "inputs", artifact_set: "b".repeat(64), codex_home: codexHome,
  cwd: sourceCwd, config: [], worktree: true, forced_config: "", forced_requirements: "" };
await call("aimgr-codex-config-state", request, true, { CODEX_EXEC_SERVER_URL: "ws://127.0.0.1:1" });
assert.ok(!fs.existsSync(container), "remote refusal precedes worktree allocation");
const initial = await call("aimgr-codex-config-state", request);
assert.equal(initial.worktree_root, container);
assert.equal(initial.source_untrusted, false);
assert.ok(initial.database_roots.includes(dirtyState), "TUI uses full source settings before checkout creation");
const headless = await call("aimgr-codex-config-state", { ...request, headless: true });
assert.ok(!headless.database_roots.includes(dirtyState), "exec source gate ignores project settings before checkout creation");
const { checkout } = await call("aimgr-codex-worktree", { operation: "create", root: initial.worktree_root, source_cwd: sourceCwd });
assert.equal(path.relative(checkout.root, checkout.cwd), "subdirectory");
assert.equal(fs.readFileSync(config, "utf8"), projectConfig(dirtyState, dirtyLogs));
assert.equal(fs.readFileSync(path.join(checkout.root, ".codex/config.toml"), "utf8"), projectConfig(committedState, committedLogs));
const final = await call("aimgr-codex-config-state", { ...request, cwd: checkout.cwd, worktree: false, operation: "initialize" });
assert.ok(final.database_roots.includes(committedState));
assert.ok(final.database_roots.includes(committedLogs));
assert.ok(!fs.existsSync(dirtyState));
assert.ok(final.reads.includes(config), "linked checkout hooks retain their main-checkout config input");
console.log("PASS real destination HEAD settings, custom container, source subdirectory and main-checkout hook origin");
const bind = { operation: "bind", root: container, checkout: checkout.root, thread_id: "11111111-2222-4333-8444-555555555555" };
assert.equal((await call("aimgr-codex-worktree", bind)).bound, true);
assert.equal((await call("aimgr-codex-worktree", bind)).bound, true);
await call("aimgr-codex-worktree", { ...bind, thread_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" }, true);
console.log("PASS native ownership binding is idempotent and preserves a different owner");
console.log(JSON.stringify({ fixture: path.basename(root), platform: process.platform }));
