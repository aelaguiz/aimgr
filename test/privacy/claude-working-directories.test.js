import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { claudeWorkingDirectories } from "../../src/privacy/claude-working-directories.js";
import { resolveClaudeTaskReadRoots, resolveClaudeConfiguredInputs } from "../../src/privacy/claude-launch-inputs.js";
import { readAimgrConfig, writeAimgrConfig } from "../../src/config/aimgr-config.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(process.platform === "linux" ? "/var/tmp" : os.tmpdir(), "claude-work-areas-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const homeDir = path.join(root, "home"), cwd = path.join(homeDir, "workspace/one");
  const configDir = path.join(homeDir, ".aimgr/claude-homes/a/.claude");
  for (const directory of [cwd, configDir]) fs.mkdirSync(directory, { recursive: true });
  return { root, homeDir, cwd, configDir };
}

test("Claude extras survive AIM writes independently of Codex and retain future OS work areas", t => {
  const { homeDir, cwd, configDir } = fixture(t);
  writeAimgrConfig({ homeDir, config: { claudeWorkingDirectories: ["~/selected"], codexWorkingDirectories: ["~/codex-only"] } });
  const config = readAimgrConfig({ homeDir }).config;
  writeAimgrConfig({ homeDir, config: { ...config, redis: { url: "redis://fixture" } } });
  const directories = claudeWorkingDirectories({ homeDir, platform: "linux", env: {} });
  assert.ok(directories.includes(path.join(homeDir, "selected")));
  assert.ok(!directories.includes(path.join(homeDir, "codex-only")));
  const roots = resolveClaudeTaskReadRoots({ cwd, userHomeDir: homeDir, configDir, workingDirectories: directories });
  for (const relative of ["workspace", "Downloads", "Pictures/Screenshots", "selected"]) {
    assert.ok(roots.includes(path.join(homeDir, relative)), relative);
  }
  assert.equal(fs.existsSync(path.join(homeDir, "Downloads")), false, "root selection does not create folders");
  assert.ok(roots.includes(fs.realpathSync("/tmp")), "temporary alias resolves to its physical work root");
  assert.ok(!roots.includes(homeDir));
  fs.mkdirSync(path.join(homeDir, "Downloads/later"), { recursive: true });
  fs.writeFileSync(path.join(homeDir, "Downloads/later/new.png"), "later image");
  assert.deepEqual(resolveClaudeTaskReadRoots({ cwd, userHomeDir: homeDir, configDir, workingDirectories: directories }), roots);
  for (const directory of ["/", homeDir, path.join(homeDir, ".aimgr")]) {
    assert.throws(() => resolveClaudeTaskReadRoots({ cwd, userHomeDir: homeDir, configDir, workingDirectories: [directory] }), /entire home or account collection/);
  }
});

test("Claude discovers Mac screenshot and user temp locations without replacing the caller TMPDIR", t => {
  const { root, homeDir } = fixture(t);
  const preferences = path.join(homeDir, "Library/Preferences/com.apple.screencapture.plist");
  fs.mkdirSync(path.dirname(preferences), { recursive: true }); fs.writeFileSync(preferences, "synthetic");
  const temporary = path.join(root, "os-user-temp");
  const directories = claudeWorkingDirectories({ homeDir, platform: "darwin", env: { TMPDIR: "/caller/private/tmp" },
    spawnSyncImpl: command => ({ status: 0, stdout: command.endsWith("getconf") ? temporary : "~/Screenshots" }) });
  assert.ok(directories.includes(temporary)); assert.ok(directories.includes(path.join(homeDir, "Screenshots")));
  assert.ok(!directories.includes("/caller/private/tmp"));
});

test("literal native outside Read selection grants canonical files without parent or wildcard inference", t => {
  const { root, homeDir, cwd, configDir } = fixture(t);
  const outside = path.join(homeDir, "private/selected image.png"), sibling = path.join(homeDir, "private/neighbor.png");
  fs.mkdirSync(path.dirname(outside)); fs.writeFileSync(outside, "selected"); fs.writeFileSync(sibling, "unselected");
  const alias = path.join(root, "selected-alias.png"); fs.symlinkSync(outside, alias);
  const input = { cwd, userHomeDir: homeDir, configDir, composition: { settings: {} } };
  for (const args of [["--allowedTools", `Read(/${alias})`, "-p", "read selected"],
    ["--allowed-tools", `Read(/${alias})`, "-p", "read selected"]]) {
    const task = resolveClaudeConfiguredInputs({ ...input, args });
    const roots = resolveClaudeTaskReadRoots({ ...task, userHomeDir: homeDir, configDir });
    assert.ok(roots.includes(outside)); assert.ok(!roots.includes(sibling)); assert.ok(!roots.includes(path.dirname(outside)));
  }
  for (const rule of [`Read(${outside})`, `Read(/${path.dirname(outside)}/**)`, `Edit(/${outside})`]) {
    assert.ok(!resolveClaudeConfiguredInputs({ ...input, args: ["--allowedTools", rule, "-p", "task"] }).taskFiles.includes(outside));
  }
  assert.ok(!resolveClaudeConfiguredInputs({ ...input, args: ["-p", `--allowedTools Read(/${outside})`] }).taskFiles.includes(outside));
  const composition = { settings: { permissions: { allow: [`Read(/${outside})`] } } };
  assert.ok(resolveClaudeConfiguredInputs({ ...input, args: [], composition }).taskFiles.includes(outside));
  fs.writeFileSync(path.join(configDir, "settings.json"), JSON.stringify(composition.settings));
  assert.ok(resolveClaudeConfiguredInputs({ ...input, args: [] }).taskFiles.includes(outside));
  assert.ok(!resolveClaudeConfiguredInputs({ ...input, args: ["--setting-sources", "project"] }).taskFiles.includes(outside));
  assert.ok(!resolveClaudeConfiguredInputs({ ...input, args: ["--restricted"] }).taskFiles.includes(outside));
  assert.ok(!resolveClaudeConfiguredInputs({ ...input, args: [], env: { CLAUDE_CODE_RESTRICTED: "1" } }).taskFiles.includes(outside));
});
