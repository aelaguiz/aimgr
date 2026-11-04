#!/usr/bin/env node
// Offline synthetic saved-thread lookup and post-exit navigation ownership.
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
const binary = path.join(repo, "native/codex/config-state/target/debug/aimgr-codex-config-state");
const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-saved-worktree-")));
const taskHome = path.join(root, "home"), codexHome = path.join(taskHome, ".codex");
const cwd = path.join(root, "checkout"), latest = path.join(root, "latest-workspace");
for (const dir of [codexHome, cwd, latest]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
fs.writeFileSync(path.join(codexHome, "config.toml"), 'check_for_update_on_startup=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n');
const env = { HOME: taskHome, PATH: "/usr/bin:/bin", LANG: "en_US.UTF-8", TMPDIR: root };
const execute = promisify(execFile);
const base = { artifact_set: "c".repeat(64), codex_home: codexHome, cwd, config: [],
  forced_config: "", forced_requirements: "" };
async function call(request, fail = false) {
  const promise = execute(binary, [], { cwd, env, encoding: "utf8", timeout: 90_000 });
  promise.child.stdin.on("error", () => {}); promise.child.stdin.end(JSON.stringify({ ...base, ...request }));
  if (fail) { await assert.rejects(promise); return; }
  const result = await promise;
  assert.equal(result.stderr, "");
  return JSON.parse(result.stdout);
}
const stamp = "2026-11-04T12:00:05.000Z";
const id = number => `11111111-2222-4333-8444-${String(number).padStart(12, "0")}`;
const sessionDir = path.join(codexHome, "sessions/2026/11/04");
fs.mkdirSync(sessionDir, { recursive: true });
function rollout(number, label, overrides = {}, contexts = []) {
  const thread = id(number);
  const header = { id: thread, session_id: thread, timestamp: stamp, cwd,
    originator: "synthetic-offline-fixture", cli_version: "0.166.0",
    source: "cli", model_provider: "openai", creator_account_id: "synthetic-account-A", ...overrides };
  const lines = [{ timestamp: stamp, type: "session_meta", payload: header },
    { timestamp: stamp, type: "event_msg", payload: { type: "user_message", message: label, kind: "plain" } },
    ...contexts.map(directory => ({ timestamp: stamp, type: "turn_context", payload: {
      cwd: directory, approval_policy: "never", sandbox_policy: { type: "read-only" }, model: "synthetic-model",
    } }))];
  const file = path.join(sessionDir, `rollout-2026-11-04T12-00-05-${thread}.jsonl`);
  fs.writeFileSync(file, lines.map(line => JSON.stringify(line)).join("\n") + "\n", { mode: 0o600 });
  return { file, header };
}
const first = rollout(1, "exact-source", {}, [cwd, latest]);
rollout(2, "duplicate-name", { creator_account_id: "synthetic-account-B" });
rollout(3, "duplicate-name", { creator_account_id: "synthetic-account-B" });
rollout(4, "foreign-provider", { model_provider: "synthetic-foreign", creator_account_id: "synthetic-account-B" });
rollout(5, "exec-source", { source: "exec", creator_account_id: "synthetic-account-B" });
rollout(6, "older-source", { timestamp: "2026-11-03T12:00:05.000Z" });
rollout(7, "subagent-source", { parent_thread_id: id(1) });
rollout(8, "later-source", { timestamp: "2026-11-04T13:00:00.000Z" });
const fork = selector => ({ operation: "fork_source", fork_source: { selector, headless: false } });
const projection = await call(fork(id(1)));
assert.deepEqual(projection.fork_source, { thread_id: id(1), cwd: latest });
assert.equal((await call(fork("exact-source"))).fork_source.thread_id, id(1));
await call(fork("duplicate-name"), true);
await call(fork("foreign-provider"), true);
await call(fork("exec-source"), true);
assert.equal((await call(fork(id(4)))).fork_source.thread_id, id(4), "explicit UUID is not provider filtered");
console.log("PASS native fork UUID/name lookup, newest saved cwd, ambiguity and TUI provider/source filters");

const database = projection.database_files.find(file => /^state_.*\.sqlite$/.test(path.basename(file)));
assert.ok(database);
function sql(statement, parameters = []) {
  const result = spawnSync("python3", ["-c", "import sqlite3,json,sys; c=sqlite3.connect(sys.argv[1]); c.execute(sys.argv[2],json.loads(sys.argv[3])); c.commit(); c.close()", database, statement, JSON.stringify(parameters)], { env, encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
}
const files = projection.database_files.map(file => {
  const stat = fs.statSync(file);
  return { path: file, device: stat.dev, inode: stat.ino };
});
const owner = { cwd, account_id: "synthetic-account-A", source: "cli", forked_from_id: null,
  started_at: "2026-11-04T12:00:00.000Z", ended_at: "2026-11-04T12:01:00.000Z", database_files: files };
const own = patch => call({ operation: "worktree_owner", owner: { ...owner, ...patch } });
assert.equal((await own({})).owner_thread_id, id(1));
assert.equal((await own({ database_files: [...files].reverse() })).owner_thread_id, id(1), "database identity is independent of projection order");
assert.equal((await own({ account_id: "synthetic-account-B" })).owner_thread_id, null, "same-account multiple matches remain unbound");
assert.equal((await own({ forked_from_id: id(2) })).owner_thread_id, null);
assert.equal((await own({ database_files: files.map((file, i) => i ? file : { ...file, inode: file.inode + 1 }) })).owner_thread_id, null);
console.log("PASS exact account, time window, root thread, fork lineage and database identity ownership checks");

// Native's current DB rollout, not an older filename for the same thread, is
// authoritative after a revert. Metadata contents remain synthetic.
const replacement = path.join(sessionDir, `rollout-2026-11-04T12-00-30-${id(1)}.jsonl`);
fs.copyFileSync(first.file, replacement);
sql("UPDATE threads SET rollout_path=? WHERE id=?", [replacement, id(1)]);
fs.writeFileSync(first.file, "invalid old rollout must not be read\n");
assert.equal((await own({})).owner_thread_id, id(1));
sql("UPDATE threads SET archived=1 WHERE id=?", [id(1)]);
assert.equal((await own({})).owner_thread_id, id(1), "archiving does not erase browser navigation ownership");
const valid = fs.readFileSync(replacement, "utf8");
fs.writeFileSync(replacement, "invalid current rollout\n");
await call({ operation: "worktree_owner", owner }, true);
fs.writeFileSync(replacement, valid);
console.log("PASS current reverted rollout, archived ownership and incomplete-metadata refusal");
console.log(JSON.stringify({ fixture: path.basename(root), platform: process.platform }));
