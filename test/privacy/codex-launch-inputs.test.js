import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { resolveCodexLaunchInputs as resolveInputs, codexPrivacyEnvironment } from "../../src/privacy/codex-launch-inputs.js";

// These fixtures place their synthetic HOME beneath /tmp. Test classified
// inputs separately from the default work roots, which have their own cases.
const resolveCodexLaunchInputs = options => resolveInputs({ workingDirectories: [], ...options });

test("only the native effective inventory grants configured paths", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-inputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const view = path.join(root, "view.toml"), selected = path.join(root, "selected-input");
  fs.writeFileSync(view, ""); fs.symlinkSync(view, path.join(codexHome, "config.toml"));
  const futureInstruction = path.join(sharedHome, "AGENTS.override.md");
  fs.symlinkSync(futureInstruction, path.join(codexHome, "AGENTS.override.md"));
  fs.writeFileSync(path.join(sharedHome, "config.toml"), 'model_instructions_file="../inactive-input"\n');
  const options = { prepared: { sharedHome, codexHome }, homeDir: root, env: {},
    parsedArgs: { cwd, images: [], directories: [], config: ['model_instructions_file=../ignored'] },
    effectiveInputs: { cwd, reads: [selected], writes: [], database_roots: [sharedHome] },
    spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.equal(inputs.writes.includes(view), false);
  assert.ok(inputs.reads.includes(selected));
  assert.equal(inputs.reads.includes(path.join(root, "inactive-input")), false);
  assert.equal(inputs.reads.includes(path.join(root, "ignored")), false);
  assert.ok(inputs.writes.includes(futureInstruction), "an absent shared instruction has an exact future target grant");
  assert.equal(inputs.writes.includes(sharedHome), false, "future instructions never grant the entire shared home");
  assert.equal(inputs.writes.includes(path.join(sharedHome, "auth.json")), false);
  const missingTarget = path.join(root, "not-created-yet.md");
  fs.symlinkSync(missingTarget, futureInstruction);
  const absentOptional = resolveCodexLaunchInputs(options);
  assert.equal(absentOptional.writes.includes(missingTarget), false, "dangling optional instruction stays absent without rejecting launch");
  assert.throws(() => resolveCodexLaunchInputs({ ...options, effectiveInputs: undefined }), /native input inventory/);
});

test("selected account cannot be replaced by inherited vendor auth or originator variables", () => {
  const env = { PATH: "/tools", HOME: "/home/user", TERM: "xterm-256color", CODEX_ACCESS_TOKEN: "synthetic-token",
    CODEX_API_KEY: "synthetic-key", OPENAI_API_KEY: "synthetic-key", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "private-device",
    TERM_PROGRAM_VERSION: "private-version", VTE_VERSION: "private-version", TOOL_INPUT: "keep", TMPDIR: "/caller/tmp" };
  const result = codexPrivacyEnvironment({ env, prepared: { codexHome: "/private/codex", sharedHome: "/shared/codex" },
    artifact: { command: "/approved/codex", artifactSet: "fixture" } });
  for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "TERM_PROGRAM_VERSION", "VTE_VERSION"]) assert.equal(result[key], undefined);
  assert.equal(result.OPENAI_API_KEY, env.OPENAI_API_KEY, "ordinary SDK tools retain their independent API credential");
  assert.equal(result.TOOL_INPUT, "keep"); assert.equal(result.TERM, env.TERM);
  assert.equal(result.HOME, env.HOME); assert.equal(result.CODEX_HOME, "/private/codex");
  assert.equal(result.TMPDIR, env.TMPDIR);
  assert.equal(Object.hasOwn(codexPrivacyEnvironment({ env: {}, prepared: {}, artifact: { command: "/approved/codex" } }), "TMPDIR"), false);
});

test("Mac optional shared links retain only their exact entry while configured dangling paths still fail", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-shared-link-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const shared = path.join(sharedHome, "agents"), missing = path.join(root, "not-installed"), unrelated = path.join(sharedHome, "private.txt");
  fs.symlinkSync(missing, shared); fs.symlinkSync(shared, path.join(codexHome, "agents"));
  fs.writeFileSync(unrelated, "synthetic private sibling");
  const options = { prepared: { sharedHome, codexHome }, homeDir: root, env: {}, platform: "darwin",
    parsedArgs: { cwd, images: [], directories: [] }, spawnSyncImpl: () => ({ status: 1 }),
    effectiveInputs: { cwd, reads: [], writes: [], database_roots: [] } };
  const inputs = resolveCodexLaunchInputs(options);
  assert.ok(inputs.writes.includes(shared));
  for (const file of [sharedHome, missing, unrelated]) assert.ok(!inputs.writes.includes(file));
  assert.ok(!resolveCodexLaunchInputs({ ...options, platform: "linux" }).writes.includes(shared));
  for (const permission of ["reads", "writes"]) assert.throws(() => resolveCodexLaunchInputs({ ...options,
    effectiveInputs: { ...options.effectiveInputs, [permission]: [shared] } }), /dangling symlink/);
  fs.unlinkSync(shared); fs.mkdirSync(shared);
  assert.ok(resolveCodexLaunchInputs(options).writes.includes(shared), "replacing the optional link preserves shared state");
});

test("configured writable roots outside the project keep their native write permission", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-writable-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  const extra = path.join(root, "outside-project");
  for (const dir of [sharedHome, codexHome, cwd, extra]) fs.mkdirSync(dir);
  fs.writeFileSync(path.join(sharedHome, "config.toml"), '[sandbox_workspace_write]\nwritable_roots=["../outside-project"]\n');
  const inputs = resolveCodexLaunchInputs({ prepared: { sharedHome, codexHome }, homeDir: root, env: {},
    parsedArgs: { cwd, images: [], directories: [], config: [] },
    effectiveInputs: { cwd, reads: [], writes: [extra], database_roots: [sharedHome] }, systemConfigFile: path.join(root, "absent"),
    spawnSyncImpl: () => ({ status: 1 }) });
  assert.ok(inputs.writes.includes(extra)); assert.equal(inputs.reads.includes(extra), false);
});

test("installed user skills are writable without admitting their parent or private siblings", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-installed-skills-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, ".codex"), codexHome = path.join(root, "private"), cwd = path.join(root, "workspace/project");
  const skills = path.join(root, ".agents/skills"), privateSibling = path.join(root, ".agents/private.txt");
  for (const dir of [sharedHome, codexHome, cwd, skills]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(privateSibling, "synthetic private sibling");
  const options = { prepared: { sharedHome, codexHome }, homeDir: root, env: { HOME: root },
    parsedArgs: { cwd, images: [], directories: [] },
    effectiveInputs: { cwd, reads: [skills], writes: [], database_roots: [] }, spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.ok(inputs.writes.includes(skills));
  assert.ok(!inputs.reads.includes(skills), "the writable skill root replaces its read grant");
  for (const file of [root, path.join(root, ".agents"), privateSibling]) {
    assert.ok(!inputs.writes.includes(file)); assert.ok(!inputs.reads.includes(file));
  }
  fs.rmSync(path.join(root, ".agents"), { recursive: true });
  assert.deepEqual(resolveCodexLaunchInputs(options), inputs, "absent installed skills retain an exact future root without creating or granting the parent");
  assert.equal(fs.existsSync(path.join(root, ".agents")), false);
});

test("native skill roots inventory directory links independently of skill contents", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-linked-skills-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, ".codex"), codexHome = path.join(root, "accounts/selected"), cwd = path.join(root, "workspace/project");
  const userRoot = path.join(root, ".agents/skills"), repoRoot = path.join(cwd, ".agents/skills"), systemRoot = path.join(sharedHome, "skills/.system");
  const sources = path.join(root, "skill sources"), targets = ["invalid", "empty", "collection", ".hidden/visible", "hidden-alias", "repo", "system-link", "depth-six", "depth-seven"].map(name => path.join(sources, name));
  for (const dir of [sharedHome, codexHome, cwd, userRoot, repoRoot, systemRoot, ...targets]) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(targets[0], "SKILL.md"), "---\ninvalid frontmatter\n");
  fs.mkdirSync(path.join(targets[2], "nested"));
  for (const [name, target] of [["invalid", targets[0]], ["empty", targets[1]], ["collection", targets[2]], ["visible", targets[3]], [".hidden", targets[4]], ["cycle", userRoot]]) fs.symlinkSync(target, path.join(userRoot, name));
  fs.symlinkSync(targets[5], path.join(repoRoot, "read-only")); fs.symlinkSync(targets[6], path.join(systemRoot, "ignored"));
  const depthFive = path.join(userRoot, ...Array(5).fill("nested")); fs.mkdirSync(depthFive, { recursive: true });
  fs.symlinkSync(targets[7], path.join(depthFive, "depth-six"));
  const depthSix = path.join(depthFive, "nested"); fs.mkdirSync(depthSix); fs.symlinkSync(targets[8], path.join(depthSix, "depth-seven"));
  const linkedFile = path.join(sources, "not-a-directory.txt"); fs.writeFileSync(linkedFile, "private file"); fs.symlinkSync(linkedFile, path.join(userRoot, "file-link"));
  const inputs = resolveCodexLaunchInputs({ prepared: { sharedHome, codexHome, accountRoot: path.join(root, "accounts") }, homeDir: root, env: { HOME: root },
    parsedArgs: { images: [], directories: [] }, spawnSyncImpl: () => ({ status: 1 }),
    effectiveInputs: { cwd, reads: [], writes: [], database_roots: [], skill_roots: [userRoot, repoRoot], writable_skill_roots: [userRoot], system_skill_roots: [systemRoot] } });
  for (const directory of targets.slice(0, 4)) assert.ok(inputs.writes.includes(directory), "invalid, empty, nested and visible linked targets remain editable");
  assert.ok(!inputs.reads.includes(targets[5])); assert.ok(!inputs.writes.includes(targets[5]), "a repository child alias cannot admit a private target");
  assert.ok(inputs.writes.includes(targets[7]), "a directory link at native discovery depth six is followed");
  for (const file of [sources, targets[4], targets[6], targets[8], linkedFile]) {
    assert.ok(!inputs.reads.includes(file)); assert.ok(!inputs.writes.includes(file));
  }
});

test("optional skill aliases cannot veto launch or admit their protected parents", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-skill-aliases-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, ".codex"), codexHome = path.join(root, "accounts/selected"), cwd = path.join(root, "workspace/project");
  const accountRoot = path.join(root, "accounts"), agents = path.join(root, ".agents"), skills = path.join(agents, "skills"), sharedSkills = path.join(sharedHome, "skills");
  for (const dir of [sharedHome, codexHome, cwd, agents]) fs.mkdirSync(dir, { recursive: true });
  fs.symlinkSync(sharedSkills, path.join(codexHome, "skills"));
  const options = { prepared: { sharedHome, codexHome, accountRoot }, homeDir: root, env: { HOME: root },
    parsedArgs: { images: [], directories: [] }, spawnSyncImpl: () => ({ status: 1 }),
    effectiveInputs: { cwd, reads: [skills, path.join(codexHome, "skills"), sharedSkills], writes: [], database_roots: [],
      skill_roots: [root, sharedHome, accountRoot, agents, path.join(cwd, ".agents/skills")],
      system_skill_roots: [root, sharedHome, accountRoot, agents], writable_skill_roots: [root, sharedHome, accountRoot, agents] } };
  for (const target of [root, sharedHome, accountRoot, agents, path.join(root, "missing")]) {
    fs.symlinkSync(target, skills); fs.symlinkSync(target, sharedSkills);
    const inputs = resolveCodexLaunchInputs(options);
    for (const parent of [root, sharedHome, accountRoot, agents]) {
      assert.ok(!inputs.reads.includes(parent)); assert.ok(!inputs.writes.includes(parent));
    }
    fs.unlinkSync(skills); fs.unlinkSync(sharedSkills);
  }
  fs.mkdirSync(path.join(cwd, ".agents")); fs.symlinkSync(root, path.join(cwd, ".agents/skills"));
  const broadProject = resolveCodexLaunchInputs(options);
  assert.ok(!broadProject.reads.includes(root) && !broadProject.writes.includes(root));
  fs.rmdirSync(agents); fs.symlinkSync(path.join(root, "missing-parent"), agents);
  assert.doesNotThrow(() => resolveCodexLaunchInputs(options), "a dangling .agents parent remains unused");
});

test("saved projects retain separate roots and Git metadata without exposing their common parent", t => {
  const root=fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"codex-saved-grants-")));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  const codexHome=path.join(root,"private"), sharedHome=path.join(root,"shared"), cwd=path.join(root,"first");
  const saved=path.join(root,"saved"), git=path.join(root,"git-metadata");
  for(const file of [codexHome,sharedHome,cwd,saved,git])fs.mkdirSync(file);
  const inputs=resolveCodexLaunchInputs({prepared:{codexHome,sharedHome},homeDir:root,env:{},
    parsedArgs:{directories:[],images:[]},effectiveInputs:{cwd,project_cwds:[saved],
      reads:[path.join(saved,"AGENTS.md"),path.join(root,"selected-skill")],writes:[path.join(saved,"nested")],database_roots:[sharedHome]},
    spawnSyncImpl:(command,args,options)=>options.cwd===saved?{status:0,stdout:`${saved}\n${git}\n`}:{status:1}});
  assert(inputs.writes.includes(saved)); assert(inputs.writes.includes(git));
  assert(!inputs.writes.includes(root)); assert(!inputs.reads.includes(root));
  assert(!inputs.writes.includes(path.join(saved,"nested")));
  assert(!inputs.reads.includes(path.join(saved,"AGENTS.md")));
  assert(inputs.reads.includes(path.join(root,"selected-skill")));
});

test("Linux native MCP gets only the selected existing D-Bus socket, not its directory", { skip: process.platform !== "linux" }, async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-bus-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const socket = path.join(root, "session-bus");
  const server = net.createServer(); server.listen(socket); await once(server, "listening");
  t.after(() => new Promise(resolve => server.close(resolve)));
  const options = { prepared: { sharedHome, codexHome }, homeDir: root,
    env: { DBUS_SESSION_BUS_ADDRESS: `unix:path=${encodeURIComponent(socket)},guid=synthetic` },
    effectiveInputs: { cwd, reads: [], writes: [], database_roots: [sharedHome] }, parsedArgs: { cwd, images: [], directories: [], config: [] },
    spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.ok(inputs.writes.includes(fs.realpathSync(socket)));
  assert.equal(inputs.writes.includes(root), false);
  options.env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${root}`;
  assert.equal(resolveCodexLaunchInputs(options).writes.includes(root), false);
});

// Issue #30: posix_spawnp starts a file the vendor may not read and still
// reports failure, so the next PATH match starts as well.
test("Mac Codex may read its PATH folders and their linked executables, never home or AIM state", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home"), base = path.join(home, ".aimgr"), accountRoot = path.join(base, "accounts", "a");
  const codexHome = path.join(accountRoot, "homes", "h"), sharedHome = path.join(home, ".codex"), cwd = path.join(root, "project");
  const bin = path.join(home, ".local", "bin"), cellar = path.join(root, "cellar", "tool", "1.0", "bin"), plain = path.join(root, "plain");
  const leaky = path.join(root, "leaky"), lexical = path.join(root, "lexical");
  for (const dir of [codexHome, sharedHome, cwd, bin, cellar, plain, leaky]) fs.mkdirSync(dir, { recursive: true });
  const executable = file => { fs.writeFileSync(file, "#!/bin/sh\n"); fs.chmodSync(file, 0o755); return file; };
  executable(path.join(bin, "git"));
  const linked = executable(path.join(cellar, "node"));
  fs.symlinkSync(linked, path.join(bin, "node"));
  fs.symlinkSync(path.join(bin, "git"), path.join(bin, "git-alias"));
  fs.writeFileSync(path.join(cellar, "README"), ""); fs.symlinkSync(path.join(cellar, "README"), path.join(bin, "readme"));
  fs.symlinkSync(path.join(root, "missing"), path.join(bin, "dangling"));
  fs.symlinkSync(cellar, path.join(bin, "directory"));
  executable(path.join(plain, "tool"));
  fs.symlinkSync(plain, lexical);
  // A folder whose executable link leads into AIM state stays unreadable as a whole.
  fs.symlinkSync(executable(path.join(accountRoot, "helper")), path.join(leaky, "helper"));
  executable(path.join(leaky, "other"));
  fs.writeFileSync(path.join(root, "not-a-folder"), "");
  const env = { HOME: home, PATH: ["", "relative/bin", "~/bin", bin, path.join(root, "absent"), path.join(root, "not-a-folder"),
    lexical, plain, home, root, "/", base, path.join(accountRoot, "homes"), path.join(sharedHome), leaky].join(":") };
  const options = { prepared: { base, accountRoot, codexHome, sharedHome }, homeDir: home, env, platform: "darwin",
    parsedArgs: { directories: [], images: [] }, effectiveInputs: { cwd, reads: [], writes: [], database_roots: [] },
    spawnSyncImpl: () => ({ status: 1 }) };
  const inputs = resolveCodexLaunchInputs(options);
  assert.deepEqual(inputs.reads.sort(), [bin, linked, plain].sort(), "only the folders and the executable a link leads to");
  assert.equal(inputs.writes.some(file => [bin, plain, cellar].includes(file)), false, "PATH grants are read-only");
  assert.equal(resolveCodexLaunchInputs({ ...options, platform: "linux" }).reads.length, 0);
  assert.equal(resolveCodexLaunchInputs({ ...options, env: { HOME: home } }).reads.length, 0);
});

test("PATH grants that would overflow the Mac launch policy leave that folder as it was", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-budget-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "private"), sharedHome = path.join(root, "shared"), cwd = path.join(root, "project");
  const crowded = path.join(root, "homebrew", "bin"), small = path.join(root, "small");
  for (const dir of [codexHome, sharedHome, cwd, crowded, small]) fs.mkdirSync(dir, { recursive: true });
  const deep = "package".repeat(8);
  for (let i = 0; i < 400; i++) {
    const target = path.join(root, "Cellar", `${deep}-${i}`, "1.0.0", "bin", `tool-${i}`);
    fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, ""); fs.chmodSync(target, 0o755);
    fs.symlinkSync(target, path.join(crowded, `tool-${i}`));
  }
  fs.writeFileSync(path.join(small, "git"), ""); fs.chmodSync(path.join(small, "git"), 0o755);
  const inputs = resolveCodexLaunchInputs({ prepared: { codexHome, sharedHome }, homeDir: path.join(root, "home"),
    env: { PATH: `${crowded}:${small}` }, platform: "darwin", parsedArgs: { directories: [], images: [] },
    effectiveInputs: { cwd, reads: [], writes: [], database_roots: [] }, spawnSyncImpl: () => ({ status: 1 }) });
  assert.deepEqual(inputs.reads, [small], "a folder never gets read access without its link targets");
});

test("a PATH folder inside another granted one still has its link targets granted", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-path-nested-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const codexHome = path.join(root, "private"), sharedHome = path.join(root, "shared"), cwd = path.join(root, "project");
  const outer = path.join(root, "tools"), inner = path.join(outer, "bin"), elsewhere = path.join(root, "elsewhere");
  for (const dir of [codexHome, sharedHome, cwd, inner, elsewhere]) fs.mkdirSync(dir, { recursive: true });
  const target = path.join(elsewhere, "node");
  fs.writeFileSync(target, ""); fs.chmodSync(target, 0o755); fs.symlinkSync(target, path.join(inner, "node"));
  const options = { prepared: { codexHome, sharedHome }, homeDir: path.join(root, "home"), platform: "darwin",
    parsedArgs: { directories: [], images: [] }, effectiveInputs: { cwd, reads: [], writes: [], database_roots: [] },
    spawnSyncImpl: () => ({ status: 1 }) };
  for (const PATH of [`${outer}:${inner}`, `${inner}:${outer}`]) {
    assert.deepEqual(resolveCodexLaunchInputs({ ...options, env: { PATH } }).reads.sort(), [target, outer].sort(), PATH);
  }
});
