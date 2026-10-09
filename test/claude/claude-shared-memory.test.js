import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  buildContainedLaunchEnvironment,
  prepareClaudeCliLaunch,
} from "../../src/targets/claude-runner.js";
import {
  CLAUDE_SHARED_MEMORY_ENV_KEY,
  describeFoldedClaudeMemories,
  foldManagedClaudeMemories,
  summarizeClaudeSharedMemory,
} from "../../src/targets/claude-shared-memory.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

const PROJECT = "-Users-synthetic-workspace-app";
const HOUR_MS = 60 * 60 * 1000;

function accountMemoryDir(home, label, project = PROJECT) {
  return path.join(home, ".aimgr", "claude-homes", label, ".claude", "projects", project, "memory");
}

function sharedMemoryDir(home, project = PROJECT) {
  return path.join(home, ".claude", "projects", project, "memory");
}

// Saved long enough ago that no live session can still be writing it.
function saveMemory(dir, name, text, { ageHours = 24 } = {}) {
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, name);
  fs.writeFileSync(filePath, text);
  const savedAt = new Date(Date.now() - ageHours * HOUR_MS);
  fs.utimesSync(filePath, savedAt, savedAt);
  return filePath;
}

function memory(name, description, body) {
  return `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  type: feedback\n---\n\n${body}\n`;
}

test("every managed launch points Claude's memory at the normal Claude home", () => {
  const home = mkTempHome();
  const env = buildContainedLaunchEnvironment({
    preparedLaunch: {
      userHomeDir: home,
      configDir: path.join(home, ".aimgr", "claude-homes", "alpha", ".claude"),
    },
    env: { [CLAUDE_SHARED_MEMORY_ENV_KEY]: "/wrong", PROJECT_ENV: "preserve" },
  });
  assert.equal(CLAUDE_SHARED_MEMORY_ENV_KEY, "CLAUDE_CODE_REMOTE_MEMORY_DIR");
  assert.equal(env[CLAUDE_SHARED_MEMORY_ENV_KEY], path.join(home, ".claude"));
  assert.equal(env.PROJECT_ENV, "preserve");
});

test("memories saved in account homes move into the shared store without overwriting any", () => {
  const home = mkTempHome();
  const shared = sharedMemoryDir(home);
  const alpha = accountMemoryDir(home, "alpha");
  const beta = accountMemoryDir(home, "beta");
  const kept = memory("kept", "already shared", "The shared version.");
  const fresh = memory("fresh", "saved on alpha", "Only alpha knew this.");
  const unlisted = memory("unlisted", "alpha never indexed it", "No index line.");
  const newest = memory("newest", "saved on beta", "Beta's latest.");

  saveMemory(shared, "kept.md", kept, { ageHours: 96 });
  saveMemory(shared, "MEMORY.md", "# Memory index\n\n- [Kept](kept.md) — already shared\n", { ageHours: 96 });
  saveMemory(alpha, "kept.md", kept, { ageHours: 72 });
  const freshSavedAt = fs.statSync(saveMemory(alpha, "fresh.md", fresh, { ageHours: 48 })).mtimeMs;
  saveMemory(alpha, "unlisted.md", unlisted, { ageHours: 36 });
  saveMemory(alpha, "MEMORY.md", "# Memory Index\n\n- [Kept](kept.md) — already shared\n- [Fresh](fresh.md) — saved on alpha\n");
  saveMemory(beta, "kept.md", memory("kept", "already shared", "Beta reworded it."), { ageHours: 30 });
  saveMemory(beta, "fresh.md", fresh, { ageHours: 20 });
  saveMemory(beta, "newest.md", newest, { ageHours: 10 });
  saveMemory(beta, "MEMORY.md", "- [Kept](kept.md) — beta's wording\n- [Fresh](fresh.md) — saved on alpha\n- [Newest](newest.md) — saved on beta\n");
  // A third account holds beta's wording too; it must not become a second copy.
  const gamma = accountMemoryDir(home, "gamma");
  saveMemory(gamma, "kept.md", memory("kept", "already shared", "Beta reworded it."), { ageHours: 5 });
  saveMemory(gamma, "MEMORY.md", "- [Kept](kept.md) — beta's wording\n");

  const result = foldManagedClaudeMemories({ userHomeDir: home });
  assert.equal(result.busy, false);
  assert.deepEqual(result.folded, [
    { label: "alpha", project: PROJECT, moved: 2, identical: 1, variant: 0 },
    { label: "beta", project: PROJECT, moved: 1, identical: 1, variant: 1 },
    { label: "gamma", project: PROJECT, moved: 0, identical: 1, variant: 0 },
  ]);
  assert.equal(
    describeFoldedClaudeMemories(result.folded),
    "Moved 4 Claude memories saved under alpha, beta into the shared memory store"
      + " (1 kept as a separate version of a memory already there).",
  );

  assert.deepEqual(fs.readdirSync(shared).sort(), [
    "MEMORY.md",
    "fresh.md",
    "kept--beta.md",
    "kept.md",
    "newest.md",
    "unlisted.md",
  ]);
  assert.equal(fs.readFileSync(path.join(shared, "kept.md"), "utf8"), kept);
  assert.match(fs.readFileSync(path.join(shared, "kept--beta.md"), "utf8"), /Beta reworded it\./);
  assert.equal(fs.readFileSync(path.join(shared, "fresh.md"), "utf8"), fresh);
  assert.equal(fs.statSync(path.join(shared, "fresh.md")).mtimeMs, freshSavedAt);
  // Newest first, directly under the title, ahead of what was already shared.
  assert.equal(fs.readFileSync(path.join(shared, "MEMORY.md"), "utf8"), [
    "# Memory index",
    "",
    "- [Newest](newest.md) — saved on beta",
    "- [Kept](kept--beta.md) — beta's wording (version saved on beta)",
    "- [unlisted](unlisted.md) — alpha never indexed it",
    "- [Fresh](fresh.md) — saved on alpha",
    "- [Kept](kept.md) — already shared",
    "",
  ].join("\n"));
  assert.deepEqual(fs.readdirSync(alpha), []);
  assert.deepEqual(fs.readdirSync(beta), []);
  assert.deepEqual(fs.readdirSync(gamma), []);

  assert.deepEqual(foldManagedClaudeMemories({ userHomeDir: home }), { busy: false, folded: [] });
  assert.equal(fs.existsSync(path.join(home, ".aimgr", "claude-memory-fold.lock")), false);
});

test("a memory still being written, a linked folder, and a second mover are left alone", () => {
  const home = mkTempHome();
  const writing = accountMemoryDir(home, "alpha");
  saveMemory(writing, "old.md", "settled", { ageHours: 24 });
  fs.writeFileSync(path.join(writing, "mid-write.md"), "half");

  const elsewhere = path.join(home, "elsewhere");
  saveMemory(elsewhere, "linked.md", "not an account folder", { ageHours: 24 });
  const linked = accountMemoryDir(home, "beta");
  fs.mkdirSync(path.dirname(linked), { recursive: true });
  fs.symlinkSync(elsewhere, linked, "dir");

  assert.deepEqual(foldManagedClaudeMemories({ userHomeDir: home }), { busy: false, folded: [] });
  assert.deepEqual(fs.readdirSync(writing).sort(), ["mid-write.md", "old.md"]);
  assert.deepEqual(fs.readdirSync(elsewhere), ["linked.md"]);
  assert.equal(fs.existsSync(sharedMemoryDir(home)), false);

  const settled = new Date(Date.now() - HOUR_MS);
  fs.utimesSync(path.join(writing, "mid-write.md"), settled, settled);
  const lockPath = path.join(home, ".aimgr", "claude-memory-fold.lock");
  fs.mkdirSync(lockPath);
  assert.deepEqual(foldManagedClaudeMemories({ userHomeDir: home }), { busy: true, folded: [] });
  assert.deepEqual(fs.readdirSync(writing).sort(), ["mid-write.md", "old.md"]);

  // A mover that died mid-run does not block the next one forever.
  const stale = new Date(Date.now() - 5 * 60 * 1000);
  fs.utimesSync(lockPath, stale, stale);
  assert.deepEqual(foldManagedClaudeMemories({ userHomeDir: home }).folded, [
    { label: "alpha", project: PROJECT, moved: 2, identical: 0, variant: 0 },
  ]);
  assert.deepEqual(fs.readdirSync(sharedMemoryDir(home)).sort(), ["MEMORY.md", "mid-write.md", "old.md"]);
});

test("a normal launch moves stragglers in and says so; login staging does not", async () => {
  const home = mkTempHome();
  const labelHome = path.join(home, ".aimgr", "claude-homes", "alpha");
  saveMemory(accountMemoryDir(home, "beta"), "straggler.md", memory("straggler", "saved on beta", "Late save."));

  const stagingHome = path.join(labelHome, ".login-staging");
  const stagingWarnings = [];
  await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir: stagingHome,
    configDir: path.join(stagingHome, ".claude"),
    platform: "linux",
    warn: (message) => stagingWarnings.push(message),
  });
  assert.deepEqual(stagingWarnings, []);
  assert.equal(fs.existsSync(sharedMemoryDir(home)), false);

  const warnings = [];
  await prepareClaudeCliLaunch({
    command: process.execPath,
    userHomeDir: home,
    homeDir: labelHome,
    configDir: path.join(labelHome, ".claude"),
    platform: "linux",
    warn: (message) => warnings.push(message),
  });
  assert.deepEqual(warnings, [
    "Moved 1 Claude memory saved under beta into the shared memory store.",
  ]);
  assert.equal(
    fs.readFileSync(path.join(sharedMemoryDir(home), "MEMORY.md"), "utf8"),
    "- [straggler](straggler.md) — saved on beta\n",
  );
});

test("aim claude memory moves stragglers in and flags an index Claude will not fully load", async () => {
  const home = mkTempHome();
  const big = "-Users-synthetic-workspace-big";
  const bigDir = sharedMemoryDir(home, big);
  const indexLines = ["# Memory index", ""];
  for (let i = 0; i < 201; i += 1) {
    saveMemory(bigDir, `m${i}.md`, `memory ${i}`);
    indexLines.push(`- [M${i}](m${i}.md) — memory ${i}`);
  }
  saveMemory(bigDir, "MEMORY.md", `${indexLines.join("\n")}\n`);
  saveMemory(accountMemoryDir(home, "alpha"), "one.md", memory("one", "saved on alpha", "First."));

  const output = await runCli(["claude", "memory", "--home", home]);
  assert.match(output, new RegExp(`^Shared Claude memory: ${path.join(home, ".claude", "projects", "<project>", "memory")}\n`));
  assert.match(output, /\nMoved 1 Claude memory saved under alpha into the shared memory store\.\n/);
  assert.match(output, /\n-Users-synthetic-workspace-big\s+201\s+203 lines, \d+\.\d KB\s+OVER LIMIT\n/);
  assert.match(output, /\n-Users-synthetic-workspace-app\s+1\s+1 line, 0\.0 KB\n/);
  assert.match(output, /Claude loads only the first 200 lines or 25 KB/);
  assert.deepEqual(
    summarizeClaudeSharedMemory({ userHomeDir: home }).projects.map(({ project, memories, overLimit }) => (
      { project, memories, overLimit }
    )),
    [
      { project: big, memories: 201, overLimit: true },
      { project: PROJECT, memories: 1, overLimit: false },
    ],
  );
  await assert.rejects(
    runCli(["claude", "memory", "extra", "--home", home]),
    /does not accept positional arguments/,
  );
});
