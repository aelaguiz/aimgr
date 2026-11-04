import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { codexSettingsView, reconcileCodexSettings, superviseCodexSettings } from "../../src/io/codex-settings.js";
import { parseCodexSettings } from "../../src/io/codex-settings-toml.js";

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-settings-"));
  t.after(() => {
    if (fs.existsSync(path.join(root, "authored"))) fs.chmodSync(path.join(root, "authored"), 0o700);
    fs.rmSync(root, { recursive: true, force: true });
  });
  const source = path.join(root, "authored", "config.toml");
  fs.mkdirSync(path.dirname(source));
  fs.writeFileSync(source, 'model="old"\n[skills]\nconfig=[{path="./skill",enabled=true}]\n');
  const entry = codexSettingsView({ base: path.join(root, "aim"), source, home: root });
  const read = file => parseCodexSettings(fs.readFileSync(file, "utf8")).value;
  return { root, source, entry, read };
}

test("two account links share native edits and retain authored relative paths", async t => {
  const { root, source, entry, read } = fixture(t);
  await reconcileCodexSettings(entry);
  for (const name of ["a", "b"]) {
    fs.mkdirSync(path.join(root, name));
    fs.symlinkSync(entry.view, path.join(root, name, "config.toml"));
  }
  const staged = entry.view + ".native";
  fs.writeFileSync(staged, fs.readFileSync(entry.view, "utf8").replace('enabled=true', 'enabled=false'));
  fs.renameSync(staged, fs.realpathSync(path.join(root, "a/config.toml")));
  await Promise.all([reconcileCodexSettings(entry), reconcileCodexSettings(entry)]);
  assert.equal(read(source).skills.config[0].enabled, false);
  assert.equal(read(source).skills.config[0].path, "./skill");
  assert.equal(read(path.join(root, "b/config.toml")).skills.config[0].enabled, false);
});

test("source-winning conflict keeps native alternative and emits one warning", async t => {
  const { source, entry, read } = fixture(t), warnings = [];
  await reconcileCodexSettings(entry);
  fs.writeFileSync(source, fs.readFileSync(source, "utf8").replace('"old"','"source"'));
  fs.writeFileSync(entry.view, fs.readFileSync(entry.view,"utf8").replace('"old"','"native"'));
  await reconcileCodexSettings(entry,{onWarning:w=>warnings.push(w)});
  await reconcileCodexSettings(entry,{onWarning:w=>warnings.push(w)});
  assert.equal(read(source).model,"source");
  assert.equal(read(entry.view).model,"source");
  assert.equal(warnings.length,1);
  assert.equal(read(warnings[0].recovery).model,"native");
});

for (const boundary of ["after-read", "before-source"]) test(`a writer at ${boundary} is retained and merged on recovery`, async t => {
  const { source, entry, read }=fixture(t);
  await reconcileCodexSettings(entry);
  fs.writeFileSync(entry.view,fs.readFileSync(entry.view,"utf8").replace('"old"','"native"'));
  let injected=false;
  const result=await reconcileCodexSettings(entry,{fault:point=>{
    if(point===boundary && !injected){ injected=true; fs.appendFileSync(source,'\n[unknown]\nkept="concurrent"\n'); }
  }});
  assert.equal(result.raced,true);
  await reconcileCodexSettings(entry);
  assert.equal(read(source).unknown.kept,"concurrent");
  assert.equal(read(source).model,"native");
});

test("a displaced authored same-key edit wins over the installed native candidate", async t => {
  const {source,entry,read}=fixture(t), warnings=[];
  await reconcileCodexSettings(entry);
  fs.writeFileSync(entry.view,fs.readFileSync(entry.view,"utf8").replace('"old"','"native"'));
  await reconcileCodexSettings(entry,{fault:point=>{
    if(point==='before-source') fs.writeFileSync(source,fs.readFileSync(source,"utf8").replace('"old"','"author"'));
  }});
  await reconcileCodexSettings(entry,{onWarning:w=>warnings.push(w)});
  assert.equal(read(source).model,"author");
  assert.equal(read(entry.view).model,"author");
  assert.ok(warnings.some(w=>read(w.recovery).model==='native'));
});

for (const boundary of ["journal","before-source","after-source","before-view","after-view","before-baseline","after-baseline"]) {
  test(`recovery after interruption at ${boundary} preserves edits`,async t=>{
    const {source,entry,read}=fixture(t);
    await reconcileCodexSettings(entry);
    fs.writeFileSync(entry.view,fs.readFileSync(entry.view,"utf8").replace('"old"','"native"'));
    fs.writeFileSync(source,fs.readFileSync(source,"utf8").replace('enabled=true','enabled=false'));
    await assert.rejects(reconcileCodexSettings(entry,{fault:point=>{if(point===boundary)throw new Error('synthetic interruption');}}));
    await reconcileCodexSettings(entry);
    assert.equal(read(source).model,'native');
    assert.equal(read(source).skills.config[0].enabled,false);
    assert.equal(read(entry.view).model,'native');
  });
}

test("late writes through an open displaced inode are recovered",async t=>{
  const {source,entry,read}=fixture(t);
  await reconcileCodexSettings(entry);
  const fd=fs.openSync(source,'r+');
  try {
    fs.writeFileSync(entry.view,fs.readFileSync(entry.view,"utf8").replace('"old"','"native"'));
    await reconcileCodexSettings(entry);
    fs.ftruncateSync(fd,0);
    fs.writeFileSync(fd,'model="old"\n[skills]\nconfig=[{path="./skill",enabled=true}]\n[late]\nkept=true\n');
  } finally {fs.closeSync(fd);}
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model,'native');
  assert.equal(read(source).late.kept,true);
});

test("invalid source is visible, deletion restores defaults and new content recovers",async t=>{
  const {source,entry,read}=fixture(t);
  await reconcileCodexSettings(entry);
  fs.writeFileSync(source,'model=[');
  assert.equal((await reconcileCodexSettings(entry)).valid,false);
  assert.equal(fs.readFileSync(entry.view,'utf8'),'model=[');
  fs.unlinkSync(source);
  await reconcileCodexSettings(entry);
  assert.deepEqual(read(entry.view),{});
  fs.writeFileSync(source,'model="repaired"');
  await reconcileCodexSettings(entry);
  assert.equal(read(entry.view).model,'repaired');
});

test("invocation supervisor flushes native edits and closes its watchers",async t=>{
  const {source,entry,read}=fixture(t);
  const owner=await superviseCodexSettings([entry]);
  fs.writeFileSync(entry.view,fs.readFileSync(entry.view,'utf8').replace('"old"','"native"'));
  await owner.close();
  assert.equal(read(source).model,'native');
  await owner.close();
});

test("the first repair of invalid input normalizes relative paths",async t=>{
  const {source,entry,read}=fixture(t);
  await reconcileCodexSettings(entry);
  fs.writeFileSync(source,'model=[');
  await reconcileCodexSettings(entry);
  fs.writeFileSync(source,'model_instructions_file="./repaired.md"\n');
  assert.equal((await reconcileCodexSettings(entry)).valid,true);
  assert.equal(read(entry.view).model_instructions_file,path.join(path.dirname(source),'repaired.md'));
  fs.writeFileSync(entry.view,'model=[');
  await reconcileCodexSettings(entry);
  assert.equal(read(entry.view).model_instructions_file,path.join(path.dirname(source),'repaired.md'));
});

test("read-only sources can refresh and become writable again",async t=>{
  assert.notEqual(process.getuid?.(),0,'permission coverage requires an ordinary user');
  const {source,entry,read}=fixture(t);
  t.after(()=>{ if(fs.existsSync(path.dirname(source))) fs.chmodSync(path.dirname(source),0o700); });
  fs.chmodSync(path.dirname(source),0o500);
  assert.equal((await reconcileCodexSettings(entry)).writable,false);
  fs.writeFileSync(source,'model="changed"\n');
  await reconcileCodexSettings(entry);
  assert.equal(read(entry.view).model,'changed');
  fs.chmodSync(path.dirname(source),0o700);
  fs.writeFileSync(source,'model="writable"\n');
  assert.equal((await reconcileCodexSettings(entry)).writable,true);
  assert.equal(read(entry.view).model,'writable');
});

test("idle reconciliation does not rewrite its durable records",async t=>{
  const {entry}=fixture(t);
  await reconcileCodexSettings(entry);
  const before=fs.statSync(entry.record,{bigint:true});
  await reconcileCodexSettings(entry);
  const after=fs.statSync(entry.record,{bigint:true});
  assert.equal(after.ino,before.ino);
  assert.equal(after.mtimeNs,before.mtimeNs);
  assert.equal(fs.existsSync(entry.journal),false);
});

test("failed flush does not prevent close from writing back a native edit", async t => {
  const { source, entry, read } = fixture(t);
  let fail = false;
  const owner = await superviseCodexSettings([entry], { fault: point => {
    if (fail && point === "after-read") { fail = false; throw new Error("synthetic failure"); }
  } });
  fs.writeFileSync(entry.view, fs.readFileSync(entry.view, "utf8").replace('"old"', '"native"'));
  fail = true;
  await assert.rejects(owner.flush(), /synthetic failure/);
  await owner.close();
  assert.equal(read(source).model, "native");
});

test("write/search-only source directories preserve native replacement and durable recovery", async t => {
  assert.notEqual(process.getuid?.(), 0);
  const { source, entry, read } = fixture(t);
  t.after(() => { if (fs.existsSync(path.dirname(source))) fs.chmodSync(path.dirname(source), 0o700); });
  fs.chmodSync(path.dirname(source), 0o300);
  const owner = await superviseCodexSettings([entry]);
  fs.writeFileSync(entry.view, fs.readFileSync(entry.view, "utf8").replace('"old"', '"native"'));
  await owner.close();
  assert.equal(read(source).model, "native");
  const record = JSON.parse(fs.readFileSync(entry.record));
  assert.ok(record.preservedCopies.some(file => read(file).model === "native"));
  // A different source after restart wins; the unsynced candidate stays private.
  fs.writeFileSync(source, 'model="after-restart"\n');
  await reconcileCodexSettings(entry);
  assert.equal(read(source).model, "after-restart");
  assert.ok(record.preservedCopies.some(file => read(file).model === "native"));
});

test("loss of directory-list permission after staging retains the published source candidate", async t => {
  const { source, entry, read } = fixture(t);
  await reconcileCodexSettings(entry);
  fs.writeFileSync(entry.view, fs.readFileSync(entry.view, "utf8").replace('"old"', '"native"'));
  await reconcileCodexSettings(entry, { fault: point => { if (point === "before-source") fs.chmodSync(path.dirname(source), 0o300); } });
  assert.equal(read(source).model, "native");
  const state = JSON.parse(fs.readFileSync(entry.record));
  assert.ok(state.preservedCopies.some(file => read(file).model === "native"));
});
