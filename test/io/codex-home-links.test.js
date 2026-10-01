import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { linkManagedCodexHome } from "../../src/io/codex-home-links.js";
import { mkTempHome } from "../helpers/files.js";

test("the managed Codex home shares settings and history but keeps its own login", () => {
  const home = mkTempHome();
  const nativeHome = path.join(home, ".codex");
  const managedHome = path.join(home, ".aimgr", "codex-cli");
  fs.mkdirSync(path.join(nativeHome, "sessions"), { recursive: true });
  fs.mkdirSync(path.join(nativeHome, "app-server-control"), { recursive: true });
  for (const name of ["config.toml", "AGENTS.md", "state_5.sqlite", "state_5.sqlite-wal", "state_5.sqlite-shm",
    "auth.json", "auth.json.bak", "installation_id", ".codex-global-state.json"]) {
    fs.writeFileSync(path.join(nativeHome, name), name);
  }
  fs.mkdirSync(managedHome, { recursive: true });
  fs.writeFileSync(path.join(managedHome, "AGENTS.md"), "managed copy");

  const { linked } = linkManagedCodexHome({ managedHome, nativeHome });

  assert.deepEqual(linked.sort(), ["config.toml", "sessions", "state_5.sqlite"]);
  for (const name of linked) {
    assert.equal(fs.readlinkSync(path.join(managedHome, name)), path.join(nativeHome, name));
  }
  for (const name of ["auth.json", "auth.json.bak", "installation_id", ".codex-global-state.json", "app-server-control",
    "state_5.sqlite-wal", "state_5.sqlite-shm"]) {
    assert.equal(fs.existsSync(path.join(managedHome, name)), false, `${name} must stay per-home`);
  }
  assert.equal(fs.readFileSync(path.join(managedHome, "AGENTS.md"), "utf8"), "managed copy");
  assert.deepEqual(linkManagedCodexHome({ managedHome, nativeHome }).linked, []);
  assert.deepEqual(linkManagedCodexHome({ managedHome: nativeHome, nativeHome }).linked, []);
});

test("Codex state and goals databases are found through the managed home's links", async () => {
  const { resolveCodexGoalsDbPath, resolveCodexStateDbPath, findRolloutPathById } = await import("../../src/targets/codex-rollout.js");
  const home = mkTempHome();
  const nativeHome = path.join(home, ".codex");
  const managedHome = path.join(home, ".aimgr", "codex-cli");
  const threadId = "01a0ef43-8c94-7bc3-b35b-f8d13a9a5be9";
  const day = path.join(nativeHome, "sessions", "2026", "09", "29");
  fs.mkdirSync(day, { recursive: true });
  fs.writeFileSync(path.join(day, `rollout-2026-09-29T17-22-56-${threadId}.jsonl`), "{}\n");
  for (const name of ["state_4.sqlite", "state_5.sqlite", "goals_1.sqlite"]) fs.writeFileSync(path.join(nativeHome, name), "");
  fs.mkdirSync(managedHome, { recursive: true });
  fs.symlinkSync(path.join(nativeHome, "missing_9.sqlite"), path.join(managedHome, "state_9.sqlite"));

  linkManagedCodexHome({ managedHome, nativeHome });

  assert.equal(resolveCodexStateDbPath({ codexHome: managedHome }), path.join(managedHome, "state_5.sqlite"));
  assert.equal(resolveCodexGoalsDbPath({ codexHome: managedHome }), path.join(managedHome, "goals_1.sqlite"));
  assert.match(String(findRolloutPathById({ codexHome: managedHome, threadId })?.path ?? findRolloutPathById({ codexHome: managedHome, threadId })), new RegExp(threadId));
});
