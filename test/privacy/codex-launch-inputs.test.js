import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { resolveCodexLaunchInputs, codexPrivacyEnvironment } from "../../src/privacy/codex-launch-inputs.js";

test("only the native effective inventory grants configured paths", t => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "codex-inputs-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const sharedHome = path.join(root, "shared"), codexHome = path.join(root, "private"), cwd = path.join(root, "project");
  for (const dir of [sharedHome, codexHome, cwd]) fs.mkdirSync(dir);
  const view = path.join(root, "view.toml"), selected = path.join(root, "selected-input");
  fs.writeFileSync(view, ""); fs.symlinkSync(view, path.join(codexHome, "config.toml"));
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
  assert.throws(() => resolveCodexLaunchInputs({ ...options, effectiveInputs: undefined }), /native input inventory/);
});

test("selected account cannot be replaced by inherited vendor auth or originator variables", () => {
  const env = { PATH: "/tools", HOME: "/home/user", TERM: "xterm-256color", CODEX_ACCESS_TOKEN: "synthetic-token",
    CODEX_API_KEY: "synthetic-key", OPENAI_API_KEY: "synthetic-key", CODEX_INTERNAL_ORIGINATOR_OVERRIDE: "private-device",
    TERM_PROGRAM_VERSION: "private-version", VTE_VERSION: "private-version", TOOL_INPUT: "keep" };
  const result = codexPrivacyEnvironment({ env, prepared: { codexHome: "/private/codex", sharedHome: "/shared/codex" },
    artifact: { command: "/approved/codex", artifactSet: "fixture" }, scratch: "/scratch" });
  for (const key of ["CODEX_ACCESS_TOKEN", "CODEX_API_KEY", "CODEX_INTERNAL_ORIGINATOR_OVERRIDE", "TERM_PROGRAM_VERSION", "VTE_VERSION"]) assert.equal(result[key], undefined);
  assert.equal(result.OPENAI_API_KEY, env.OPENAI_API_KEY, "ordinary SDK tools retain their independent API credential");
  assert.equal(result.TOOL_INPUT, "keep"); assert.equal(result.TERM, env.TERM);
  assert.equal(result.HOME, env.HOME); assert.equal(result.CODEX_HOME, "/private/codex");
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
