import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { assertClaudeLocalInvocation, claudeCriticalSettings, composeClaudePrivacySettings, inspectClaudeArguments } from "../../src/privacy/claude-settings.js";

const cwd = path.resolve(".");
const hook = { hooks: [{ type: "command", command: "synthetic-aim-lifecycle", timeout: 5 }] };

test("Remote Control bootstrap and activation flags refuse before launch", () => {
  for (const args of [["remote-control"], ["rc"], ["remote"], ["sync"], ["bridge"],
    ["--remote-control"], ["--rc=test"], ["--model", "opus", "--remote-control=test"],
    ["-p-rc"], ["-pc-rc"], ["--", "remote-control"], ["explain", "mcp", "--rc"]]) {
    assert.throws(() => assertClaudeLocalInvocation(args), {
      code: "AIMGR_CLAUDE_PRIVACY_SETTINGS",
      message: "Claude was not started: Remote Control is disabled for AI Manager Claude accounts.",
    });
  }
});

test("Remote Control refusal preserves literal values and the separate cloud option", () => {
  for (const args of [["-p", "--", "remote-control"], ["--", "--rc"], ["-pn", "--rc"],
    ["--append-system-prompt", "--rc"], ["--settings", "--remote-control"],
    ["plugin", "init", "example", "--description", "--rc"],
    ["mcp", "add", "example", "https://example.invalid/mcp", "--transport", "http", "--client-id", "--rc"],
    ["--remote"], ["--remote=task"], ["-p", "explain remote-control"]]) {
    assert.doesNotThrow(() => assertClaudeLocalInvocation(args));
  }
});

test("excluded remote runner and extra parent policy refuse without rejecting literal task values", () => {
  for (const args of [["self-hosted-runner"], ["--managed-settings", "extra.json"],
    ["agents", "--managed-settings={}"], ["-p-managed-settings={}"]]) {
    assert.throws(() => assertClaudeLocalInvocation(args), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  }
  for (const args of [["-p", "self-hosted-runner"], ["--append-system-prompt", "--managed-settings"],
    ["--", "--managed-settings={}"]]) assert.doesNotThrow(() => assertClaudeLocalInvocation(args));
});

test("protected critical values defeat empty, false-like and conflicting forwarded settings", () => {
  for (const value of ["", "0", "false", null]) {
    const source = { disableRemoteControl: false, model: "opus", env: {
      DISABLE_TELEMETRY: value, DISABLE_ERROR_REPORTING: value, DISABLE_UPDATES: value,
      DISABLE_AUTOUPDATER: value, DISABLE_GROWTHBOOK: value, REQUIRED_MCP_TOKEN: "synthetic-required-token",
    } };
    const result = composeClaudePrivacySettings({ cwd, protectedAccount: true,
      args: ["--settings", JSON.stringify(source), "--model", "sonnet"] });
    assert.deepEqual(result.args, ["--settings", JSON.stringify(source), "--model", "sonnet"]);
    assert.equal(result.settings.model, "opus");
    assert.equal(result.settings.disableRemoteControl, true);
    for (const key of ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DISABLE_UPDATES", "DISABLE_AUTOUPDATER", "DISABLE_GROWTHBOOK"]) {
      assert.equal(result.settings.env[key], "1");
    }
    assert.equal(result.settings.env.REQUIRED_MCP_TOKEN, "synthetic-required-token");
  }
});

test("ordinary account keeps its telemetry choice and needs no proxy settings", () => {
  const result = composeClaudePrivacySettings({ cwd, protectedAccount: false,
    defaultFlagSettings: { env: { DISABLE_TELEMETRY: "", CUSTOM_BUILD_FLAG: "keep" } } });
  assert.equal(result.settings.env.DISABLE_TELEMETRY, "");
  assert.equal(result.settings.env.CUSTOM_BUILD_FLAG, "keep");
  assert.equal(Object.hasOwn(result.settings.env, "DISABLE_ERROR_REPORTING"), false);
  assert.equal(result.settings.env.DISABLE_GROWTHBOOK, "1");
  assert.deepEqual(claudeCriticalSettings({ protectedAccount: false }), {
    disableRemoteControl: true, env: { DISABLE_AUTOUPDATER: "1", DISABLE_UPDATES: "1", DISABLE_GROWTHBOOK: "1" },
  });
});

test("last explicit settings value wins while required lifecycle hooks survive exactly once", () => {
  const source = { hooks: { Stop: [hook], PreToolUse: [{ hooks: [] }] }, env: { REQUIRED: "last" } };
  const result = composeClaudePrivacySettings({ cwd, protectedAccount: true,
    defaultFlagSettings: { unused: "earlier default" },
    requiredHooks: Object.fromEntries(["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"].map(event => [event, [hook]])),
    args: ["--settings", "a-nonexistent-shadowed-file", "--settings=" + JSON.stringify(source), "-p", "do work"] });
  assert.equal(Object.hasOwn(result.settings, "unused"), false);
  assert.equal(result.settings.env.REQUIRED, "last");
  for (const event of ["SessionStart", "UserPromptSubmit", "Stop", "StopFailure"]) assert.deepEqual(result.settings.hooks[event], [hook]);
  assert.deepEqual(result.settings.hooks.PreToolUse, [{ hooks: [] }]);
  assert.deepEqual(result.args, ["--settings", "a-nonexistent-shadowed-file", "--settings=" + JSON.stringify(source), "-p", "do work"]);
  assert.deepEqual(source.hooks.Stop, [hook]);
});

test("relative explicit settings are read from the launch cwd; sources are not rewritten", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-privacy-settings-"));
  try {
    const original = JSON.stringify({ env: { BUILD_PATH: "relative/source" }, permissions: { allow: ["Bash(git *)"] } });
    fs.writeFileSync(path.join(directory, "selected.json"), original, { mode: 0o600 });
    const result = composeClaudePrivacySettings({ cwd: directory, protectedAccount: true, args: ["--settings", "selected.json"] });
    assert.equal(result.settings.env.BUILD_PATH, "relative/source");
    assert.deepEqual(result.settings.permissions, { allow: ["Bash(git *)"] });
    const canonical = fs.realpathSync(directory);
    assert.deepEqual(result.source, { kind: "file", path: path.join(canonical, "selected.json"), directory: canonical });
    assert.equal(fs.readFileSync(path.join(directory, "selected.json"), "utf8"), original);
    assert.deepEqual(composeClaudePrivacySettings({ cwd: directory, protectedAccount: true,
      args: ["--", "--settings", "prompt-not-a-filename"] }).args, ["--", "--settings", "prompt-not-a-filename"]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("preserves the native 2 MiB settings-file allowance and original source directory", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-privacy-settings-size-"));
  try {
    fs.mkdirSync(path.join(directory, "nested"));
    const filename = path.join(directory, "nested", "settings.json");
    // Unknown keys are retained by the composer; the deliberately large
    // synthetic value exercises the file bound without real user data.
    fs.writeFileSync(filename, JSON.stringify({ synthetic: "a".repeat(1500 * 1024) }));
    const result = composeClaudePrivacySettings({ cwd: directory, protectedAccount: true,
      args: ["--settings", "nested/settings.json"] });
    assert.equal(result.settings.synthetic.length, 1500 * 1024);
    assert.equal(result.source.directory, fs.realpathSync(path.join(directory, "nested")));
    fs.writeFileSync(filename, JSON.stringify({ synthetic: "a".repeat(2 * 1024 * 1024) }));
    assert.throws(() => composeClaudePrivacySettings({ cwd: directory, protectedAccount: true,
      args: ["--settings", filename] }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("uses native-resolved file origin and native temporary origin for inline JSON", () => {
  const directory = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-settings-origin-")));
  try {
    const actual = path.join(directory, "actual"); fs.mkdirSync(actual);
    const file = path.join(actual, "input.json"); fs.writeFileSync(file, '{"sandbox":{"filesystem":{"allowRead":["relative/"]}}}');
    fs.symlinkSync(file, path.join(directory, "alias.json"));
    const selected = composeClaudePrivacySettings({ cwd: directory, protectedAccount: false,
      args: ["--settings", "alias.json"] });
    assert.equal(selected.source.directory, actual);
    assert.deepEqual(selected.settings.sandbox.filesystem.allowRead, ["relative/"]);
    for (const name of ["--local.json", "{settings}.json"]) {
      fs.writeFileSync(path.join(directory, name), '{"model":"sonnet"}');
      assert.equal(composeClaudePrivacySettings({ cwd: directory, protectedAccount: false,
        args: ["--settings", name] }).settings.model, "sonnet");
    }
    assert.equal(composeClaudePrivacySettings({ cwd: directory, protectedAccount: false,
      args: ["--settings", " \uFEFF\uFEFF{}"] }).source.kind, "inline");
    for (const args of [[], ["--settings", "{}"]]) {
      const inline = composeClaudePrivacySettings({ cwd: directory, nativeTempDirectory: "/private/native-temp/claude-501",
        protectedAccount: false, args });
      assert.equal(inline.source.directory, "/private/native-temp/claude-501");
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("malformed settings refuse without printing secrets or raw parser excerpts", () => {
  for (const args of [["--settings"], ["--settings="], ["--settings", '{"secret":"do-not-print",'], ["--settings", '{"env":[]}']]) {
    assert.throws(() => composeClaudePrivacySettings({ cwd, protectedAccount: true, args }), error => {
      assert.equal(error.code, "AIMGR_CLAUDE_PRIVACY_SETTINGS");
      assert.equal(error.message.includes("do-not-print"), false);
      return true;
    });
  }
  assert.throws(() => composeClaudePrivacySettings({ cwd }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("native-accepted empty and BOM-prefixed settings files remain accepted", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-settings-native-json-"));
  try {
    const filename = path.join(directory, "settings.json");
    for (const text of ["", " \n\t", '\uFEFF{"model":"opus"}']) {
      fs.writeFileSync(filename, text);
      const result = composeClaudePrivacySettings({ cwd: directory, protectedAccount: false,
        args: ["--settings", filename] });
      assert.equal(result.settings.disableRemoteControl, true);
      assert.equal(result.settings.model, text.includes("opus") ? "opus" : undefined);
    }
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("bounds the exact composed UTF-8 bytes rather than just the original file", () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "aim-settings-composed-size-"));
  try {
    const filename = path.join(directory, "settings.json");
    const prefix = '{"synthetic":"', suffix = '"}';
    const text = prefix + "x".repeat(2 * 1024 * 1024 - prefix.length - suffix.length) + suffix;
    assert.equal(Buffer.byteLength(text), 2 * 1024 * 1024);
    fs.writeFileSync(filename, text);
    assert.throws(() => composeClaudePrivacySettings({ cwd: directory, protectedAccount: true,
      args: ["--settings", filename] }), /plus required privacy controls exceed/);
    const compact = composeClaudePrivacySettings({ cwd: directory, protectedAccount: true,
      args: ["--settings", '{ "synthetic" : "日本語" }'] });
    assert.deepEqual(JSON.parse(compact.serialized), compact.settings);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test("native argument values that look like settings flags remain unchanged", () => {
  const args = ["--append-system-prompt", "--settings", "--name", "--settings={prompt text}",
    "--settings", '{"env":{"PRESERVED":"yes"}}', "--mcp-config", "mcp.json", "--model=sonnet"];
  const result = composeClaudePrivacySettings({ cwd, protectedAccount: true, args });
  assert.deepEqual(result.args, args);
  assert.equal(result.settings.env.PRESERVED, "yes");
  for (const flag of ["--routine", "--handle-uri", "--exec", "-m"]) {
    const nativeArgs = [flag, "--settings", "--model", "sonnet"];
    assert.deepEqual(composeClaudePrivacySettings({ cwd, protectedAccount: true,
      args: nativeArgs }).args, nativeArgs);
  }
});

test("native eager settings selection stays distinct from Commander short clusters", () => {
  const source = '{"model":"opus"}';
  for (const args of [["-p-settings", source], ["-p-settings=" + source]]) {
    const parsed = inspectClaudeArguments(args);
    assert.equal(parsed.selectedSettings, undefined, "native eager loader ignores clustered settings");
    assert.equal(parsed.settings.length, 1, "Commander still sees a settings option");
    assert.equal(parsed.eagerPrint, false, "normalizing the cluster would change eager print");
    const composed = composeClaudePrivacySettings({ cwd, protectedAccount: true, args });
    assert.equal(composed.settings.model, undefined);
    assert.deepEqual(composed.args, args);
  }
  assert.equal(inspectClaudeArguments(["--name", "-p"]).eagerPrint, false);
  assert.equal(inspectClaudeArguments(["-pn", "-p"]).eagerPrint, true);
  assert.equal(inspectClaudeArguments(["--name=-p"]).eagerPrint, false);
  assert.equal(inspectClaudeArguments(["--debug", "filter", "--settings", source]).selectedSettings, source);
  assert.equal(inspectClaudeArguments(["--mcp-config", "first", "--settings", source]).selectedSettings, source);
  assert.equal(inspectClaudeArguments(["agents", "--cwd", "project", "--settings", source]).selectedSettings, source);
  assert.equal(inspectClaudeArguments(["--", "agents", "--settings", source]).selectedSettings, undefined);
});

test("ambiguous eager settings embedded in literal arguments refuse before changing the task", () => {
  for (const args of [["-pn", "--settings", "{}"],
    ["mcp", "add", "--client-id", "--settings", "{}"],
    ["agents", "--cwd", "--settings", "{}"]]) {
    assert.throws(() => composeClaudePrivacySettings({ cwd, protectedAccount: true, args }), /conflicting native meanings/);
  }
});

test("required lifecycle hooks cannot be silently suppressed by disableAllHooks", () => {
  assert.throws(() => composeClaudePrivacySettings({ cwd, protectedAccount: true,
    requiredHooks: { Stop: [hook] }, args: ["--settings", '{"disableAllHooks":true}'] }),
  { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.equal(composeClaudePrivacySettings({ cwd, protectedAccount: true,
    requiredHooks: { Stop: [hook] } }).settings.disableAllHooks, false);
  assert.equal(composeClaudePrivacySettings({ cwd, protectedAccount: true,
    args: ["--settings", '{"disableAllHooks":true}'] }).settings.disableAllHooks, true);
});
