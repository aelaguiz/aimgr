import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { spawnSync } from "node:child_process";
import { readClaudeLaunchState, stageClaudeLaunchEnvironment, buildClaudePrivacyEnvironment,
  resolveClaudeTaskReadRoots, resolveClaudeConfiguredInputs,
  resolveClaudeUpdateRoots } from "../../src/privacy/claude-launch-inputs.js";

const covered = (roots, file) => roots.some(root => file === root || file.startsWith(root + path.sep));

function fixture(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-launch-inputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test("updater protection follows empty, absent and relative XDG locations without hiding project tools", t => {
  const root = fixture(t), home = path.join(root, "home"), cwd = path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const input = { userHomeDir: home, cwd, vendorCommand: "/approved/claude" };
  const defaults = resolveClaudeUpdateRoots({ ...input, env: {} });
  assert.ok(defaults.includes(path.join(home, ".local/share/claude/versions")));
  assert.ok(defaults.includes(path.join(home, ".cache/claude/staging")));
  assert.ok(defaults.includes(path.join(home, ".local/state/claude/locks")));
  const empty = resolveClaudeUpdateRoots({ ...input,
    env: { XDG_DATA_HOME: "", XDG_CACHE_HOME: "", XDG_STATE_HOME: "" } });
  for (const kind of ["versions", "staging", "locks"]) {
    assert.ok(empty.includes(path.join(cwd, "claude", kind)));
  }
  assert.equal(empty.length, 4); // Three vendor roots and its home launcher.
  assert.equal(covered(empty, path.join(cwd, "ordinary-build")), false);
  assert.equal(covered(empty, path.join(cwd, "node_modules/mcp-server/index.js")), false);
  const relative = resolveClaudeUpdateRoots({ ...input, env: { XDG_DATA_HOME: "data" } });
  assert.ok(relative.includes(path.join(cwd, "data/claude/versions")));
});

test("nested launch resolves updater denies while the parent sandbox still blocks their reads and writes", {
  skip: process.platform !== "darwin",
}, t => {
  const root = fixture(t), home = path.join(root, "home"), cwd = path.join(root, "project");
  fs.mkdirSync(home); fs.mkdirSync(cwd);
  const input = { userHomeDir: home, cwd, env: {}, vendorCommand: "/approved/claude" };
  const roots = resolveClaudeUpdateRoots(input);
  for (const directory of roots.slice(0, 3)) fs.mkdirSync(directory, { recursive: true });
  const policy = `(version 1)(allow default)(deny network*)${roots.slice(0, 3)
    .map(directory => `(deny file-read* file-write* process-exec file-map-executable (subpath ${JSON.stringify(directory)}))`).join("")}`;
  const moduleUrl = new URL("../../src/privacy/claude-launch-inputs.js", import.meta.url).href;
  const script = `import fs from "node:fs";
    import { resolveClaudeUpdateRoots } from ${JSON.stringify(moduleUrl)};
    const roots = resolveClaudeUpdateRoots(${JSON.stringify(input)});
    const denied = roots.slice(0, 3).map(directory => {
      const results = [];
      for (const operation of [() => fs.statSync(directory), () => fs.writeFileSync(directory + "/probe", "no")]) {
        try { operation(); results.push("allowed"); } catch (error) { results.push(error.code); }
      }
      return results;
    });
    console.log(JSON.stringify({ roots, denied }));`;
  const result = spawnSync("/usr/bin/sandbox-exec", ["-p", policy, process.execPath, "--input-type=module", "-e", script],
    { cwd, encoding: "utf8", timeout: 10_000 });
  assert.equal(result.status, 0, result.stderr || result.error?.message);
  const actual = JSON.parse(result.stdout);
  assert.deepEqual(actual.roots, roots);
  assert.deepEqual(actual.denied, Array.from({ length: 3 }, () => ["EPERM", "EPERM"]));
});

test("update roots follow existing aliases and still refuse dangling links", t => {
  const root = fixture(t), home = path.join(root, "home"), target = path.join(root, "updates");
  fs.mkdirSync(path.join(home, ".cache/claude"), { recursive: true }); fs.mkdirSync(target);
  const link = path.join(home, ".cache/claude/staging"); fs.symlinkSync(target, link);
  const input = { userHomeDir: home, cwd: root, env: {}, vendorCommand: "/approved/claude" };
  assert.ok(resolveClaudeUpdateRoots(input).includes(target));
  fs.rmdirSync(target);
  assert.throws(() => resolveClaudeUpdateRoots(input), /dangling link/);
});


test("private environment uses an unlinked owned descriptor and preserves exact tool values", t => {
  const root = fixture(t);
  const env = { PATH: "/usr/bin:/bin", MCP_SECRET: "synthetic=a\nb", TERM: "xterm-256color", UNSET: undefined };
  const fd = stageClaudeLaunchEnvironment(env, root);
  try {
    const stat = fs.fstatSync(fd);
    assert.equal(stat.nlink, 0); assert.equal(stat.uid, process.getuid()); assert.equal(stat.mode & 0o777, 0o600);
    assert.deepEqual(fs.readdirSync(root), []);
    const bytes = Buffer.alloc(stat.size); fs.readSync(fd, bytes, 0, bytes.length, 0);
    assert.equal(bytes.toString(), "PATH=/usr/bin:/bin\0MCP_SECRET=synthetic=a\nb\0TERM=xterm-256color\0");
  } finally { fs.closeSync(fd); }
  for (const bad of [{ "BAD=KEY": "x" }, { VALUE: "a\0b" }, { VALUE: {} }, {}]) {
    assert.throws(() => stageClaudeLaunchEnvironment(bad, root), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
    assert.deepEqual(fs.readdirSync(root), []);
  }
});

test("launch state preserves MCP credentials and refuses alias/substitution hazards", t => {
  const root = fixture(t), file = path.join(root, "credentials.json"), alias = path.join(root, "alias");
  const data = { claudeAiOauth: { subscriptionType: "pro" }, mcpOAuth: { server: "synthetic-secret" } };
  fs.writeFileSync(file, JSON.stringify(data), { mode: 0o600 });
  assert.deepEqual(readClaudeLaunchState(file), data);
  fs.symlinkSync(file, alias); assert.throws(() => readClaudeLaunchState(alias)); fs.unlinkSync(alias);
  fs.linkSync(file, alias); assert.throws(() => readClaudeLaunchState(file)); fs.unlinkSync(alias);
  fs.writeFileSync(file, "private malformed value");
  assert.throws(() => readClaudeLaunchState(file), error => !error.message.includes("private malformed value"));
  assert.equal(readClaudeLaunchState(alias, { optional: true }), null);
});

test("all-account controls disable Claude diagnostics while preserving task SDK and tool credentials", () => {
  const inputs = { env: { DISABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "0", DISABLE_GROWTHBOOK: "0",
    CLAUDE_CODE_ENABLE_TELEMETRY: "1", ENABLE_BETA_TRACING_DETAILED: "1", BETA_TRACING_ENDPOINT: "http://task-collector", OTEL_TRACES_EXPORTER: "otlp", OTEL_SDK_DISABLED: "false",
    AWS_ACCESS_KEY_ID: "synthetic-build-key", NODE_OPTIONS: "--max-old-space-size=2048", TERM: "xterm-256color",
    HOSTNAME: "SYNTHETIC_HOST", TERMINATOR_UUID: "SYNTHETIC_TERMINAL", TILIX_ID: "SYNTHETIC_TILIX", GNOME_TERMINAL_SERVICE: "SYNTHETIC_GNOME",
    LD_PRELOAD: "/private/code", DYLD_INSERT_LIBRARIES: "/private/code" },
    artifactSet: "a".repeat(64), emptyProfiles: "/approved/empty", scratch: "/private/scratch" };
  const ordinary = buildClaudePrivacyEnvironment({ ...inputs, protectedAccount: false });
  assert.equal(ordinary.DISABLE_TELEMETRY, "1"); assert.equal(ordinary.DISABLE_ERROR_REPORTING, "1");
  assert.equal(ordinary.CLAUDE_CODE_ENABLE_TELEMETRY, "0");
  assert.equal(ordinary.ENABLE_BETA_TRACING_DETAILED, "0");
  assert.equal(ordinary.BETA_TRACING_ENDPOINT, "http://task-collector");
  assert.equal(ordinary.OTEL_TRACES_EXPORTER, "otlp"); assert.equal(ordinary.OTEL_SDK_DISABLED, "false");
  assert.equal(ordinary.DISABLE_GROWTHBOOK, "1"); assert.equal(ordinary.DISABLE_UPDATES, "1");
  assert.equal(ordinary.AWS_ACCESS_KEY_ID, inputs.env.AWS_ACCESS_KEY_ID); assert.equal(ordinary.NODE_OPTIONS, inputs.env.NODE_OPTIONS);
  assert.equal(ordinary.TERM, inputs.env.TERM); assert.equal(ordinary.LD_PRELOAD, undefined); assert.equal(ordinary.DYLD_INSERT_LIBRARIES, undefined);
  assert.equal(buildClaudePrivacyEnvironment({ ...inputs, protectedAccount: true }).DISABLE_TELEMETRY, "1");
  const protectedEnv = buildClaudePrivacyEnvironment({ ...inputs, protectedAccount: true });
  for (const key of ["HOSTNAME", "TERMINATOR_UUID", "TILIX_ID", "GNOME_TERMINAL_SERVICE"]) {
    assert.equal(ordinary[key], ""); assert.equal(protectedEnv[key], "");
  }
  assert.equal(protectedEnv.TERM, inputs.env.TERM);
});

test("explicit TLS files and custom memory are granted only for protected accounts", t => {
  const root = fixture(t), home = path.join(root, "home"), config = path.join(home, ".aimgr/a/.claude");
  const project = path.join(root, "project"), certs = path.join(home, "certificates");
  for (const dir of [config, project, certs]) fs.mkdirSync(dir, { recursive: true });
  for (const name of ["ca.pem", "client.pem", "client.key"]) fs.writeFileSync(path.join(certs, name), "synthetic");
  fs.writeFileSync(path.join(config, "settings.json"), JSON.stringify({ autoMemoryDirectory: "memory",
    env: { CLAUDE_CODE_CLIENT_CERT: "../home/certificates/client.pem", CLAUDE_CODE_CLIENT_KEY: "~/certificates/client.key" } }));
  const inputs = { args: [], cwd: project, userHomeDir: home, configDir: config,
    composition: { settings: {} }, env: { NODE_EXTRA_CA_CERTS: path.join(certs, "ca.pem") } };
  const ordinary = resolveClaudeConfiguredInputs({ ...inputs, discoverReadRoots: false });
  assert.deepEqual(ordinary.taskFiles, []); assert.deepEqual(ordinary.additionalDirectories, []);
  assert.equal(fs.existsSync(path.join(project, "memory")), false);
  const protectedInputs = resolveClaudeConfiguredInputs(inputs);
  const roots = resolveClaudeTaskReadRoots({ ...protectedInputs, userHomeDir: home, configDir: config });
  for (const file of ["ca.pem", "client.pem", "client.key"]) assert.ok(roots.includes(path.join(certs, file)));
  assert.ok(covered(roots, path.join(project, "memory"))); assert.ok(!roots.includes(certs)); assert.ok(!roots.includes(home));
});

test("task grants retain trusted projects, selected roots, skills and worktree metadata", t => {
  const root = fixture(t), home = path.join(root, "home"), config = path.join(home, ".aimgr/account/.claude");
  const project = path.join(home, "work/project"), trusted = path.join(home, "work/trusted");
  const packageRoot = path.join(home, "packages/required-skill"), git = path.join(home, "git/common/worktrees/project");
  for (const dir of [config, project, trusted, packageRoot, git, path.join(home, ".claude/skills")]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(path.join(home, ".claude/skills"), path.join(config, "skills"));
  fs.symlinkSync(packageRoot, path.join(home, ".claude/skills/required"));
  fs.writeFileSync(path.join(home, ".claude/skills/README.md"), "package documentation, not a package directory");
  fs.writeFileSync(path.join(project, ".git"), `gitdir: ${git}\n`);
  fs.writeFileSync(path.join(git, "commondir"), "../..\n");
  fs.writeFileSync(path.join(home, "work/CLAUDE.md"), "synthetic ancestor instruction");
  fs.mkdirSync(path.join(home, "work/.claude/rules"), { recursive: true });
  const inputs = { cwd: project, userHomeDir: home, configDir: config, appState: {
    projects: { [trusted]: { hasTrustDialogAccepted: true }, [home]: { hasTrustDialogAccepted: true } } } };
  const roots = resolveClaudeTaskReadRoots(inputs);
  assert.ok(covered(roots, trusted), "previously trusted projects retain their selected work root");
  assert.ok(covered(resolveClaudeTaskReadRoots({ ...inputs, additionalDirectories: [trusted] }), trusted));
  for (const expected of [project, packageRoot, git, path.resolve(git, "../.."),
    path.join(home, "work/CLAUDE.md"), path.join(home, "work/.claude/rules")]) assert.ok(covered(roots, expected), expected);
  for (const excluded of [home, path.join(home, ".aimgr"), path.join(home, "packages"), root]) assert.ok(!roots.includes(excluded));
  assert.throws(() => resolveClaudeTaskReadRoots({ ...inputs, additionalDirectories: [home] }));
  assert.throws(() => resolveClaudeTaskReadRoots({ ...inputs, additionalDirectories: [path.join(home, ".aimgr")] }));
  assert.ok(!resolveClaudeTaskReadRoots({ ...inputs, cwd: home }).includes(home));
  assert.throws(() => resolveClaudeTaskReadRoots({ ...inputs, sharedMemoryDirectory: path.join(home, ".claude") }));
});

test("linked-worktree package fallback and ancestor MCP preserve exact external instruction targets", t => {
  const root = fixture(t), home = path.join(root, "home"), config = path.join(home, ".aimgr/a/.claude");
  const main = path.join(home, "main"), project = path.join(home, "trees/feature");
  const gitdir = path.join(main, ".git/worktrees/feature"), packageRoot = path.join(home, "packages/skill");
  for (const dir of [config, gitdir, project, packageRoot, path.join(main, ".claude/skills")]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(project, ".git"), `gitdir: ${gitdir}\n`);
  fs.writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  fs.writeFileSync(path.join(gitdir, "gitdir"), path.join(project, ".git") + "\n");
  fs.symlinkSync(packageRoot, path.join(main, ".claude/skills/required"));
  fs.writeFileSync(path.join(packageRoot, "SKILL.md"), "required skill");
  const imported = path.join(home, "external.txt"); fs.writeFileSync(imported, "explicit instruction");
  fs.writeFileSync(path.join(config, "CLAUDE.md"), "@" + imported + "\n");
  const mcp = path.join(home, "trees/.mcp.json"); fs.writeFileSync(mcp, "{}");
  const inputs = { cwd: project, userHomeDir: home, configDir: config };
  const roots = resolveClaudeTaskReadRoots(inputs);
  for (const file of [imported, mcp, packageRoot, path.join(main, ".claude/skills")]) assert.ok(roots.includes(file), file);
  assert.ok(!roots.includes(main)); assert.ok(!roots.includes(home));
  const nested = path.join(project, "src"); fs.mkdirSync(nested);
  const nestedRoots = resolveClaudeTaskReadRoots({ ...inputs, cwd: nested });
  assert.ok(nestedRoots.includes(packageRoot)); assert.ok(covered(nestedRoots, gitdir));
  assert.ok(!nestedRoots.includes(project), "metadata discovery does not grant the entire enclosing worktree");
  fs.mkdirSync(path.join(project, ".claude/skills"), { recursive: true });
  assert.ok(!resolveClaudeTaskReadRoots(inputs).includes(packageRoot), "worktree-local skills suppress main-repo fallback");
});


test("large skill and rule collections use subtree grants while retaining exact external targets", t => {
  const root = fixture(t), home = path.join(root, "home"), config = path.join(home, ".aimgr/a/.claude");
  const project = path.join(home, "work/project"), skills = path.join(home, "skills");
  const rules = path.join(project, ".claude/rules"), external = path.join(home, "external");
  for (const dir of [config, project, skills, rules, external]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(skills, path.join(config, "skills"));
  for (let i = 0; i < 300; i++) {
    const skill = path.join(skills, `skill-${i}`); fs.mkdirSync(skill);
    fs.writeFileSync(path.join(skill, "SKILL.md"), "Required skill");
    fs.writeFileSync(path.join(rules, `rule-${i}.md`), "Required rule");
  }
  const imported = path.join(external, "imported.md"), linked = path.join(external, "linked-skill.md");
  fs.writeFileSync(imported, "External required instruction"); fs.writeFileSync(linked, "External required skill");
  fs.writeFileSync(path.join(project, "CLAUDE.md"), "@" + imported + "\n");
  fs.unlinkSync(path.join(skills, "skill-0/SKILL.md")); fs.symlinkSync(linked, path.join(skills, "skill-0/SKILL.md"));
  const roots = resolveClaudeTaskReadRoots({ cwd: project, userHomeDir: home, configDir: config });
  for (const required of [project, skills, imported, linked]) assert.ok(roots.includes(required), required);
  for (const forbidden of [home, external, path.dirname(project)]) assert.ok(!roots.includes(forbidden));
  assert.ok(roots.length < 10, "ordinary children must not consume independent native policy slots");
});


test("the selected original-browser helper and manual callback environment remain exact inputs", t => {
  const root = fixture(t), home = path.join(root, "home"), config = path.join(home, ".aimgr/account/.claude");
  const project = path.join(root, "project"), helper = path.join(root, "installation/browser-helper.mjs");
  for (const directory of [config, project, path.dirname(helper)]) fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(helper, "synthetic helper never executed");
  const callback = path.join(config, "login-url.json");
  const env = { BROWSER: helper, AIMGR_CLAUDE_LOGIN_STDIO_URL: callback };
  const inputs = resolveClaudeConfiguredInputs({ args: [], cwd: project, userHomeDir: home, configDir: config,
    composition: { settings: {} }, env });
  const roots = resolveClaudeTaskReadRoots({ ...inputs, userHomeDir: home, configDir: config });
  assert.ok(roots.includes(helper)); assert.ok(!roots.includes(path.dirname(helper)));
  const launch = buildClaudePrivacyEnvironment({ env, protectedAccount: true, artifactSet: "a".repeat(64),
    emptyProfiles: path.join(config, "profiles"), scratch: path.join(config, "scratch") });
  assert.equal(launch.BROWSER, helper); assert.equal(launch.AIMGR_CLAUDE_LOGIN_STDIO_URL, callback);
});
