import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeConfiguredInputs, resolveClaudeTaskReadRoots } from "../../src/privacy/claude-launch-inputs.js";
import { resolveClaudeMcpExecutableReads, claudeExecutableAliasSpellings } from "../../src/privacy/claude-mcp-inputs.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-mcp-inputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), cwd = path.join(home, "project"), configDir = path.join(home, "account");
  for (const dir of [cwd, configDir, path.join(home, "private-bin")]) fs.mkdirSync(dir, { recursive: true });
  const executable = name => {
    const file = path.join(home, "private-bin", name);
    // Keep this fixture's interpreter canonical: Linux's /bin/sh adds its own
    // aliases, which are covered separately by the explicit shebang test.
    fs.writeFileSync(file, `#!${fs.realpathSync("/bin/sh")}\nexit 0\n`, { mode: 0o755 }); return file;
  };
  return { root, home, cwd, configDir, executable };
}

test("protected CLI MCP grants the exact executable without exposing private neighbors", t => {
  const f = fixture(t), binary = f.executable("node"), alias = path.join(f.home, "node-alias");
  fs.symlinkSync(binary, alias);
  const mcp = path.join(f.cwd, "mcp.json");
  fs.writeFileSync(mcp, JSON.stringify({ mcpServers: { local: { command: alias } } }));
  const inputs = { cwd: f.cwd, userHomeDir: f.home, configDir: f.configDir,
    args: ["--strict-mcp-config", "--mcp-config", mcp], composition: { settings: {} }, env: {} };
  const task = resolveClaudeConfiguredInputs(inputs);
  const roots = resolveClaudeTaskReadRoots({ ...inputs, ...task });
  assert.ok(roots.includes(binary), "vendor can open the actual configured MCP executable");
  assert.ok(!roots.some(root => path.dirname(binary) === root || path.dirname(binary).startsWith(root + path.sep)),
    "the executable grant must not expose the private bin directory or its neighbors");
  assert.deepEqual(resolveClaudeConfiguredInputs({ ...inputs, discoverReadRoots: false }).taskFiles, []);
  assert.deepEqual(inputs.args, ["--strict-mcp-config", "--mcp-config", mcp]);
  assert.deepEqual(task.executableAliases, [alias]);
});

test("MCP inventory combines settings tiers and does not crash on optional numeric PATH", t => {
  const f = fixture(t), binary = f.executable("node");
  fs.mkdirSync(path.join(f.cwd, ".claude"));
  fs.writeFileSync(path.join(f.configDir, "settings.json"), JSON.stringify({ env: { MCP_BIN: path.dirname(binary), PATH: 42 } }));
  fs.writeFileSync(path.join(f.cwd, ".claude/settings.json"), JSON.stringify({ env: { MCP_NAME: "node" } }));
  const task = resolveClaudeConfiguredInputs({ cwd: f.cwd, userHomeDir: f.home, configDir: f.configDir,
    args: ["--strict-mcp-config", "--mcp-config", JSON.stringify({ mcpServers: {
      merged: { command: "${MCP_BIN}/${MCP_NAME}" }, missing: { command: "missing" },
    } })], composition: { settings: {} }, env: {} });
  assert.ok(task.taskFiles.includes(binary));
});

test("local MCP state uses native main-worktree key independently of spawn cwd", t => {
  const f = fixture(t), main = path.join(f.root, "main"), override = path.join(f.root, "spawn");
  const admin = path.join(main, ".git/worktrees/task"), nested = path.join(f.cwd, "nested");
  for (const dir of [admin, override, nested]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(f.cwd, ".git"), "gitdir: " + admin);
  fs.writeFileSync(path.join(admin, "commondir"), "../..");
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(f.cwd, ".git"));
  const command = path.join(override, "tool"); fs.writeFileSync(command, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  const result = resolveClaudeMcpExecutableReads({ cwd: nested, projectConfigRoot: override, environments: [{}],
    appState: { projects: { [main]: { mcpServers: { local: { command: "./tool" } } },
      [override]: { mcpServers: { wrong: { command: f.executable("wrong") } } } } } });
  assert.deepEqual(result, [command]);
});

test("a native-rejected middle settings source does not hide a usable MCP executable", t => {
  const f = fixture(t), binary = f.executable("node");
  fs.mkdirSync(path.join(f.cwd, ".claude"));
  fs.writeFileSync(path.join(f.configDir, "settings.json"), JSON.stringify({ env: { MCP_BIN: path.dirname(binary) } }));
  fs.writeFileSync(path.join(f.cwd, ".claude/settings.json"), JSON.stringify({ model: 42, env: { MCP_BIN: "/does-not-exist" } }));
  fs.writeFileSync(path.join(f.cwd, ".claude/settings.local.json"), JSON.stringify({ env: { MCP_NAME: "node" } }));
  const task = resolveClaudeConfiguredInputs({ cwd: f.cwd, userHomeDir: f.home, configDir: f.configDir,
    args: ["--mcp-config", JSON.stringify({ mcpServers: { local: { command: "${MCP_BIN}/${MCP_NAME}" } } })],
    composition: { settings: {} }, env: {} });
  assert.ok(task.taskFiles.includes(binary));
});

test("disabled commands are omitted and invalid higher definitions do not mask lower candidates", t => {
  const f = fixture(t), binary = f.executable("node");
  const options = { cwd: f.cwd, environments: [{}], appState: { mcpServers: { local: { command: binary } } },
    cliConfigs: [JSON.stringify({ mcpServers: { local: { type: "unknown" } } })] };
  assert.deepEqual(resolveClaudeMcpExecutableReads(options), [binary]);
  options.appState.projects = { [f.cwd]: { disabledMcpServers: ["local"] } };
  assert.deepEqual(resolveClaudeMcpExecutableReads(options), []);
});

test("alias inventory retains every multihop and directory-rewritten full command", t => {
  const f = fixture(t), binary = f.executable("node");
  const indirect = path.join(f.root, "indirect"), aliases = path.join(f.root, "aliases");
  fs.mkdirSync(indirect); fs.mkdirSync(aliases);
  const intermediate = path.join(indirect, "node"); fs.symlinkSync(binary, intermediate);
  fs.symlinkSync(indirect, path.join(aliases, "bin"));
  const command = path.join(aliases, "bin/node");
  assert.deepEqual(claudeExecutableAliasSpellings(command), [command, intermediate]);
  const outer = path.join(aliases, "outer"); fs.symlinkSync(command, outer);
  assert.deepEqual(claudeExecutableAliasSpellings(outer), [outer, command, intermediate]);
  assert.deepEqual(claudeExecutableAliasSpellings(binary), []);
});

test("an external script's symlinked shebang interpreter gets exact alias metadata", t => {
  const f = fixture(t), interpreter = f.executable("python"), command = f.executable("mcp-server");
  const aliasDir = path.join(f.home, "private-venv"); fs.mkdirSync(aliasDir);
  const alias = path.join(aliasDir, "python"); fs.symlinkSync(interpreter, alias);
  fs.writeFileSync(command, `#!${alias} -I\nprint('never execute discovery')\n`);
  const aliases = [];
  assert.deepEqual(resolveClaudeMcpExecutableReads({ cwd: f.cwd, environments: [{}], aliases,
    cliConfigs: [JSON.stringify({ mcpServers: { local: { command } } })] }), [command]);
  assert.deepEqual(aliases, [alias]);
  assert.ok(!aliases.includes(aliasDir));
  fs.writeFileSync(command, "#!/usr/bin/env python\n");
  const envAliases = [];
  resolveClaudeMcpExecutableReads({ cwd: f.cwd, environments: [{ PATH: aliasDir }], aliases: envAliases,
    cliConfigs: [JSON.stringify({ mcpServers: { local: { command } } })] });
  assert.deepEqual(envAliases, [], "do not guess env's dynamic child from its arguments");
});

test("MCP inventory honors strict source selection and ignores inactive/invalid server types", t => {
  const f = fixture(t), user = f.executable("user"), local = f.executable("local"), project = f.executable("project"), cli = f.executable("cli");
  fs.writeFileSync(path.join(f.cwd, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command: project } } }));
  const options = { cwd: f.cwd, environments: [{}], appState: { mcpServers: { user: { command: user } },
    projects: { [f.cwd]: { mcpServers: { local: { command: local } } }, "/unrelated": { mcpServers: { ignored: { command: f.executable("unrelated") } } } } },
  cliConfigs: [JSON.stringify({ mcpServers: { cli: { command: cli }, http: { type: "http", command: user }, invalid: { command: {} } } })] };
  assert.deepEqual(resolveClaudeMcpExecutableReads(options).sort(), [user, local, project, cli].sort());
  assert.deepEqual(resolveClaudeMcpExecutableReads({ ...options, strict: true }), [cli]);
  assert.deepEqual(resolveClaudeMcpExecutableReads({ ...options, strict: true, cliConfigs: ["missing.json", "{broken"] }), []);
});

test("MCP command expansion uses launch env and searches PATH without executing candidates", t => {
  const f = fixture(t), binary = f.executable("node"), notExecutable = path.join(f.home, "private-bin", "data");
  fs.writeFileSync(notExecutable, "private data", { mode: 0o600 });
  const options = { cwd: f.cwd, strict: true, environments: [{ BIN: path.dirname(binary), PICK: "node" }],
    cliConfigs: [JSON.stringify({ mcpServers: {
      absolute: { command: "${BIN}/${PICK}", env: { PICK: "wrong" } },
      path: { command: "node", env: { PATH: "${BIN}" } },
      fallback: { command: "${MISSING:-" + binary + "}" },
      empty: { command: "${EMPTY:-" + binary + "}" },
      unresolved: { command: "${UNSET}/node" },
      unreadable: { command: notExecutable },
      directory: { command: path.dirname(binary) },
    } })] };
  options.environments[0].EMPTY = "";
  assert.deepEqual(resolveClaudeMcpExecutableReads(options), [binary]);
});
