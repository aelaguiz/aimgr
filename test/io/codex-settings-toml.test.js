import test from "node:test";
import assert from "node:assert/strict";
import { parseCodexSettings, projectCodexSettings, mergeCodexSettings, codexConfigKeySegments, normalizeCodexSettingsValue } from "../../src/io/codex-settings-toml.js";

const options = { source: "/fixture/shared/config.toml", home: "/fixture/user" };
const read = text => parseCodexSettings(text).value;
const project = text => projectCodexSettings(text, options);
const reconcile = (baseSource, source, view) => mergeCodexSettings({ baseSource, baseView: project(baseSource), source, view, origin: options.source, home: options.home });

test("source-origin paths normalize before layering; native text/defaults remain native", () => {
  const source = `# untouched\nmodel_instructions_file = "../notes.md"\nlog_dir = ""\nsqlite_home = "~/db"\nunknown_path = "../private"\n[skills]\nconfig = [{ path="./review", enabled=true }]\n[mcp_servers.local]\ncommand="./run"\ncwd="./project"\n[model_providers.local.auth]\ncommand="./token"\n`;
  const value = read(project(source));
  assert.equal(value.model_instructions_file, "/fixture/notes.md");
  assert.equal(value.log_dir, "/fixture/shared");
  assert.equal(value.sqlite_home, "/fixture/user/db");
  assert.equal(value.skills.config[0].path, "/fixture/shared/review");
  assert.equal(value.mcp_servers.local.cwd, "./project");
  assert.equal(value.unknown_path, "../private");
  assert.equal(value.model_providers.local.auth.cwd, undefined);
  assert.ok(project(source).startsWith("# untouched\n"));
});

test("all retained typed families preserve arrays, profile origins and unknown fields", () => {
  const source = `model_catalog_json="./models.json"\nexperimental_compact_prompt_file="compact"\njs_repl_node_path="~/node"\njs_repl_node_module_dirs=["."]\n[agents."review.one"]\nconfig_file="../../roles/review.toml"\n[[skills.config]]\npath="./one"\nenabled=true\n[[skills.config]]\npath="../two"\nenabled=false\n[sandbox_workspace_write]\nwritable_roots=[".","/absolute"]\n[profiles.work]\nmodel_instructions_file="./profile.md"\n[model_providers.local.auth]\ncommand="token"\ncwd="./auth"\n[otel.exporter.otlp-http.tls]\nca-certificate="./ca.pem"\n`;
  const v=read(project(source));
  assert.equal(v.agents["review.one"].config_file,"/roles/review.toml");
  assert.equal(v.skills.config[1].path,"/fixture/two");
  assert.equal(v.profiles.work.model_instructions_file,"/fixture/shared/profile.md");
  assert.equal(v.model_providers.local.auth.cwd,"/fixture/shared/auth");
  assert.equal(v.otel.exporter["otlp-http"].tls["ca-certificate"],"/fixture/shared/ca.pem");
  assert.equal(project(project(source)),project(source));
});

test("native skill toggles and model edits persist without changing relative targets", () => {
  const base = `# keep\nmodel="old"\n[skills]\nconfig=[{path='./one', enabled=true}] # skill note\n`;
  const result = reconcile(base,base,project(base).replace('"old"','"new"').replace('enabled=true','enabled=false'));
  assert.equal(read(result.source).skills.config[0].path,"./one");
  assert.equal(read(result.source).skills.config[0].enabled,false);
  assert.equal(read(result.source).model,"new");
  assert.ok(result.source.includes("# skill note"));
  assert.ok(result.source.includes("# keep"));
  assert.deepEqual(result.conflicts,[]);
});

test("independent source/view edits merge and same-key/array conflicts preserve source", () => {
  const base='model="old"\nmodel_reasoning_effort="high"\n[skills]\nconfig=[{path="./one",enabled=true}]\n';
  const source=base.replace('"high"','"xhigh"');
  const view=project(base).replace('"old"','"new"');
  const merged=reconcile(base,source,view);
  assert.equal(read(merged.source).model,'new');
  assert.equal(read(merged.source).model_reasoning_effort,'xhigh');
  const conflict=reconcile(base,base.replace('"old"','"source"'),view);
  assert.equal(read(conflict.source).model,'source');
  assert.deepEqual(conflict.conflicts,[["model"]]);
  const arrays=reconcile(base,base.replace('./one','./two'),project(base).replace('enabled=true','enabled=false'));
  assert.equal(read(arrays.source).skills.config[0].path,'./two');
  assert.deepEqual(arrays.conflicts,[["skills","config"]]);
});

test("native additions/deletions preserve surrounding tables and author syntax", () => {
  const base='model="old"\n[skills]\nconfig=[{path="./one",enabled=true}]\n[unknown]\nkeep="yes"\n';
  const view=project(base).replace('model="old"','model_reasoning_effort="xhigh"').replace('[skills]','[skills]\nextra="new"');
  const result=reconcile(base,base,view);
  assert.equal(read(result.source).model,undefined);
  assert.equal(read(result.source).model_reasoning_effort,'xhigh');
  assert.equal(read(result.source).skills.extra,'new');
  assert.equal(read(result.source).unknown.keep,'yes');
  assert.equal(read(result.source).skills.config[0].path,'./one');
});

test("RPC key grammar and ancestor payloads normalize only typed leaves", () => {
  assert.deepEqual(codexConfigKeySegments('agents."review.one".config_file'),['agents','review.one','config_file']);
  assert.throws(()=>codexConfigKeySegments('agents.re"view.path'));
  const result=normalizeCodexSettingsValue({config:[{path:'./one',enabled:false}]},['skills'],options);
  assert.deepEqual(result,{config:[{path:'/fixture/shared/one',enabled:false}]});
  assert.equal(normalizeCodexSettingsValue(null,['model_instructions_file'],options),null);
});

test("malformed input is not silently replaced by valid defaults",()=>{
  assert.throws(()=>project('model = ['));
  assert.equal(project(''),'');
});

test("native skill edits retain unknown scalar types, exact integers and comments inside arrays",()=>{
  const base='[skills]\nconfig=[\n# this skill matters\n{path="./one",enabled=true, precise=9007199254740993, floating=1.0, day=2026-11-03, time=12:01:02.123456789}\n]\n';
  const result=reconcile(base,base,project(base).replace('enabled=true','enabled=false'));
  assert.equal(result.source,base.replace('enabled=true','enabled=false'));
  const changedInteger=reconcile(base,base,project(base).replace('9007199254740993','9007199254740992'));
  assert.ok(changedInteger.source.includes('precise=9007199254740992'));
  const changedType=reconcile(base,base,project(base).replace('floating=1.0','floating=1'));
  assert.ok(changedType.source.includes('floating=1,'));
});

test("array-of-table edits keep source layout and inner comments",()=>{
  const base='[[skills.config]]\n# Keep my note\npath="./one"\nenabled=true\nunknown=1.0\n';
  assert.equal(reconcile(base,base,project(base).replace('enabled=true','enabled=false')).source,base.replace('enabled=true','enabled=false'));
});

test("native-created nested tables remain editable block tables across merges", () => {
  const base = 'model="old"\n[features]\nhooks=false\n';
  const native = base + '\n[tui]\nscreen_reader_detection_done=true\n[tui.model_availability_nux]\n"gpt-6.1-sol"=1\n';
  const first = reconcile(base, base, native);
  assert.deepEqual(read(first.source).tui, { screen_reader_detection_done: true, model_availability_nux: { "gpt-6.1-sol": 1 } });
  assert.match(first.source, /\["tui"\]/);
  assert.match(first.source, /\["tui"\."model_availability_nux"\]/);
  const second = reconcile(first.source, first.source, first.view.replace('"gpt-6.1-sol" = 1', '"gpt-6.1-sol" = 2'));
  assert.equal(read(second.source).tui.model_availability_nux["gpt-6.1-sol"], 2);
  assert.equal(read(second.source).features.hooks, false);
  const authoredInline = 'tui={screen_reader_detection_done=true}\n';
  const inlineResult = reconcile(authoredInline, authoredInline, authoredInline.replace('true', 'false'));
  assert.equal(inlineResult.source, authoredInline.replace('true', 'false'));
  const empty = reconcile(base, base, base + '\n[tui]\n');
  assert.deepEqual(read(empty.source).tui, {});
  assert.match(empty.source, /\["tui"\]/);
});
