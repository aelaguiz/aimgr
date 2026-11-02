import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveClaudeSessionHeaders, claudeLocalSettingsRoot, pinClaudeSessionHeaders } from "../../src/privacy/claude-session-headers.js";

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-headers-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), config = path.join(home, "config"), project = path.join(root, "project");
  const cwd = path.join(project, "nested");
  for (const file of [config, cwd, path.join(project, ".git")]) fs.mkdirSync(file, { recursive: true });
  const options = { args: [], cwd, configDir: config, userHomeDir: home,
    composition: { settings: { env: {} } }, env: { HOME: home, ANTHROPIC_CUSTOM_HEADERS: "X-Source: inherited" },
    appState: { env: { ANTHROPIC_CUSTOM_HEADERS: "X-Source: legacy" } },
    sourceAccepted: async source => source.model !== 7 };
  function write(file, value, extra = {}) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ env: { ANTHROPIC_CUSTOM_HEADERS: value }, ...extra }));
  }
  return { root, home, config, project, cwd, options, write };
}

test("native tier precedence pins whole strings including explicit empty values", async t => {
  const f = fixture(t), check = () => resolveClaudeSessionHeaders(f.options);
  assert.equal(await check(), "X-Source: legacy");
  f.write(path.join(f.config, "settings.json"), "X-Source: user"); assert.equal(await check(), "X-Source: user");
  f.write(path.join(f.project, ".claude/settings.json"), "X-Source: ignored-ancestor"); assert.equal(await check(), "X-Source: user");
  f.write(path.join(f.cwd, ".claude/settings.json"), "X-Source: project"); assert.equal(await check(), "X-Source: project");
  f.write(path.join(f.cwd, ".claude/settings.local.json"), "X-Source: legacy-local"); assert.equal(await check(), "X-Source: legacy-local");
  f.write(path.join(f.project, ".claude/settings.local.json"), "X-Source: canonical-local"); assert.equal(await check(), "X-Source: canonical-local");
  f.options.composition.settings.env.ANTHROPIC_CUSTOM_HEADERS = ""; assert.equal(await check(), "");
});

test("native-ignored source falls through; coerced authentication values refuse", async t => {
  const f = fixture(t);
  f.write(path.join(f.config, "settings.json"), "X-Source: ignored", { model: 7 });
  assert.equal(await resolveClaudeSessionHeaders(f.options), "X-Source: legacy");
  f.write(path.join(f.config, "settings.json"), ["Authorization: SYNTHETIC_SECRET"]);
  await assert.rejects(resolveClaudeSessionHeaders(f.options), error => /header-based authentication/.test(error.message) && !error.message.includes("SYNTHETIC_SECRET"));
  f.write(path.join(f.config, "settings.json"), ["X-Source: array"]);
  assert.equal(await resolveClaudeSessionHeaders(f.options), "X-Source: array");
  f.write(path.join(f.config, "settings.json"), null);
  assert.equal(await resolveClaudeSessionHeaders(f.options), "null");
});

test("exact key spelling, enabled sources, explicit project root and trust filtering match native", async t => {
  const f = fixture(t);
  f.write(path.join(f.config, "settings.json"), "X-Source: user");
  f.write(path.join(f.cwd, ".claude/settings.json"), "X-Source: project");
  f.write(path.join(f.project, ".claude/settings.local.json"), "X-Source: local");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--setting-sources", "user"] }), "X-Source: user");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--setting-sources", "user, project"] }), "X-Source: project");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--setting-sources", ""] }), "X-Source: legacy");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["-p", "task"],
    env: { ...f.options.env, CLAUDE_CODE_IGNORE_PERSISTED_TRUST: " ON " } }), "X-Source: user");
  const explicit = path.join(f.root, "explicit");
  f.write(path.join(explicit, ".claude/settings.local.json"), "X-Source: explicit");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--project-config-root", explicit] }), "X-Source: explicit");
  fs.writeFileSync(path.join(f.config, "settings.json"), JSON.stringify({ env: { anthropic_custom_headers: "X-Source: wrong-case" } }));
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--setting-sources", "user"] }), "X-Source: legacy");
});

test("native restricted selection ignores disk headers without changing flag or inherited headers", async t => {
  const f = fixture(t);
  f.write(path.join(f.config, "settings.json"), "Authorization: SYNTHETIC_IGNORED");
  f.write(path.join(f.cwd, ".claude/settings.json"), "Authorization: SYNTHETIC_IGNORED");
  for (const options of [
    { args: ["--restricted", "--setting-sources", "user,project,local"] },
    { env: { ...f.options.env, CLAUDE_CODE_RESTRICTED: " ON " } },
  ]) assert.equal(await resolveClaudeSessionHeaders({ ...f.options, ...options }), "X-Source: legacy");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--restricted"], appState: {} }), "X-Source: inherited");
  await assert.rejects(resolveClaudeSessionHeaders({ ...f.options, args: ["--name", "--restricted"] }), /header-based authentication/);
  await assert.rejects(resolveClaudeSessionHeaders({ ...f.options, args: ["--", "--restricted"] }), /header-based authentication/);
  f.options.composition.settings.env.ANTHROPIC_CUSTOM_HEADERS = "X-Source: flag";
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, args: ["--restricted"] }), "X-Source: flag");
});

test("cowork filename, primitive-only legacy state and absent-value pin preserve the initial value", async t => {
  const f = fixture(t);
  f.write(path.join(f.config, "cowork_settings.json"), "X-Source: cowork");
  assert.equal(await resolveClaudeSessionHeaders({ ...f.options, env: { ...f.options.env, CLAUDE_CODE_USE_COWORK_PLUGINS: "1" } }), "X-Source: cowork");
  f.options.appState.env.ANTHROPIC_CUSTOM_HEADERS = ["X-Source: unsupported-legacy"];
  assert.equal(await resolveClaudeSessionHeaders(f.options), "X-Source: inherited");
  delete f.options.env.ANTHROPIC_CUSTOM_HEADERS;
  assert.equal(await resolveClaudeSessionHeaders(f.options), "");
  const composition = { settings: { env: { KEEP_LIVE: "initial" }, model: "sonnet" } };
  pinClaudeSessionHeaders(composition, "X-Source: pinned");
  assert.equal(JSON.parse(composition.serialized).env.ANTHROPIC_CUSTOM_HEADERS, "X-Source: pinned");
  assert.equal(composition.settings.env.KEEP_LIVE, "initial");
});

test("linked worktree inherits canonical local settings while home Git root does not", t => {
  const f = fixture(t), worktree = path.join(f.root, "worktree"), admin = path.join(f.project, ".git/worktrees/feature");
  fs.mkdirSync(worktree); fs.mkdirSync(admin, { recursive: true });
  fs.writeFileSync(path.join(worktree, ".git"), `gitdir: ${admin}\n`);
  fs.writeFileSync(path.join(admin, "commondir"), "../..\n");
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(worktree, ".git") + "\n");
  assert.equal(claudeLocalSettingsRoot(worktree, f.home), f.project);
  fs.writeFileSync(path.join(admin, "gitdir"), path.join(f.project, ".git") + "\n");
  assert.equal(claudeLocalSettingsRoot(worktree, f.home), worktree);
  fs.mkdirSync(path.join(f.home, ".git"));
  assert.equal(claudeLocalSettingsRoot(f.config, f.home), f.config);
});

test("NUL values ignored by native cannot disable the immutable header pin", async t => {
  const f = fixture(t);
  f.options.composition.settings.env.ANTHROPIC_CUSTOM_HEADERS = "X-Ignored: \0";
  f.write(path.join(f.config, "settings.json"), "X-Ignored: \0");
  assert.equal(await resolveClaudeSessionHeaders(f.options), "X-Source: legacy");
  f.options.appState.env.ANTHROPIC_CUSTOM_HEADERS = "X-Ignored: \0";
  assert.equal(await resolveClaudeSessionHeaders(f.options), "X-Source: inherited");
  assert.throws(() => pinClaudeSessionHeaders(f.options.composition, "X-Invalid: \0"), /invalid environment value/);
});
