import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough, Writable } from "node:stream";
import { superviseCodexAppServerStdio } from "../../src/io/codex-app-server-stdio.js";
import { codexSettingsView, reconcileCodexSettings } from "../../src/io/codex-settings.js";

async function fixture(t, output = new PassThrough(), nativeStdin) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-stdio-"));
  const source = path.join(root, "config.toml"); fs.writeFileSync(source, "");
  const entry = codexSettingsView({ base: path.join(root, "aim"), source, home: root });
  await reconcileCodexSettings(entry);
  const input = new PassThrough(), nativeInput = [], received = [], errors = [];
  const child = { stdin: nativeStdin ?? new Writable({ write(chunk, _encoding, callback) { nativeInput.push(chunk.toString()); callback(); } }), stdout: new PassThrough() };
  if (output instanceof PassThrough) output.on("data", chunk => received.push(chunk.toString()));
  const owner = superviseCodexAppServerStdio({ input, output, child, entry, flush: () => reconcileCodexSettings(entry), onError: error => errors.push(error) });
  t.after(async () => {
    if (fs.existsSync(path.join(entry.directory, "intents"))) fs.chmodSync(path.join(entry.directory, "intents"), 0o700);
    await owner.close(); input.destroy(); output.destroy(); child.stdin.destroy(); child.stdout.destroy();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { input, output, child, owner, entry, nativeInput, received, errors };
}
const turn = () => new Promise(resolve => setImmediate(resolve));
async function observed(predicate) {
  const deadline = Date.now() + 2000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("stdio observation did not arrive");
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}
async function bounded(promise) {
  let timer;
  try { return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("stdio shutdown did not finish")), 2000); })]); }
  finally { clearTimeout(timer); }
}

test("stdio forwards native response envelopes, notifications and server requests unchanged", async t => {
  const f = await fixture(t);
  const request = ' { "id": 1, "method": "config/read", "params": {} }';
  f.input.write(request + "\n"); await turn();
  assert.equal(f.nativeInput.join(""), request + "\n");
  const messages = [' { "id":1, "result":{"config":{}} }', '{"method":"notice","params":{}}', '{"id":"1","method":"server/request","params":{}}'];
  f.child.stdout.end(messages.join("\n") + "\n"); f.input.end();
  await bounded(f.owner.finished);
  assert.equal(f.received.join(""), messages.join("\n") + "\n"); assert.equal(f.errors.length, 0);
});

test("private intent settlement failure cannot swallow native responses", async t => {
  assert.notEqual(process.getuid?.(), 0);
  const f = await fixture(t);
  f.input.write(JSON.stringify({ id: 1, method: "config/value/write", params: { keyPath: "model_instructions_file", value: "./a.md", mergeStrategy: "replace" } }) + "\n");
  await turn();
  const directory = path.join(f.entry.directory, "intents"); fs.chmodSync(directory, 0o500);
  const response = '{"id":1,"result":{"status":"ok","version":"native-v1"}}';
  f.child.stdout.write(response + '\n{"id":2,"result":{"unrelated":true}}\n');
  await observed(() => f.received.join("").includes("unrelated"));
  assert.match(f.received.join(""), /native-v1/);
  assert.match(f.received.join(""), /unrelated/);
  assert.ok(f.errors.length > 0);
  fs.chmodSync(directory, 0o700); f.input.end(); f.child.stdout.end();
  await bounded(f.owner.finished);
});

test("destination closure settles a backpressured write without waiting for drain", async t => {
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { entered(); } });
  const f = await fixture(t, output);
  f.child.stdout.write('{"method":"notification"}\n');
  await writing; output.destroy(); f.child.stdout.end();
  await bounded(f.owner.finished);
});

test("an answered request cannot capture a reused ID after intent settlement fails", async t => {
  assert.notEqual(process.getuid?.(), 0);
  const f = await fixture(t);
  const write = value => f.input.write(JSON.stringify({ id: 7, method: "config/value/write", params: {
    keyPath: "model_instructions_file", value, mergeStrategy: "replace",
  } }) + "\n");
  write("./first.md"); await turn();
  const directory = path.join(f.entry.directory, "intents");
  fs.chmodSync(directory, 0o500);
  f.child.stdout.write('{"id":7,"result":{"status":"ok","version":"first"}}\n');
  await observed(() => f.received.join("").includes("first"));
  assert.match(f.received.join(""), /first/);
  assert.ok(f.errors.length > 0);
  fs.chmodSync(directory, 0o700);
  write("./second.md"); await turn();
  const second = JSON.parse(f.nativeInput.at(-1)).params.value;
  fs.writeFileSync(f.entry.view, `model_instructions_file = ${JSON.stringify(second)}\n`);
  f.child.stdout.write('{"id":7,"result":{"status":"ok","version":"second"}}\n');
  await observed(() => f.received.join("").includes("second"));
  f.input.end(); f.child.stdout.end(); await bounded(f.owner.finished);
  assert.match(fs.readFileSync(f.entry.origin, "utf8"), /"?model_instructions_file"? = "\.\/second\.md"/);
  const retained = fs.readdirSync(directory).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(fs.readFileSync(path.join(directory, name), "utf8")));
  assert.equal(retained.length, 1);
  assert.equal(retained[0].outcome, "uncertain");
});

test("output closure releases native stdin when both destinations are backpressured", async t => {
  let inputEntered, outputEntered;
  const writingInput = new Promise(resolve => { inputEntered = resolve; });
  const writingOutput = new Promise(resolve => { outputEntered = resolve; });
  const nativeStdin = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { inputEntered(); } });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { outputEntered(); } });
  const f = await fixture(t, output, nativeStdin);
  f.input.write('{"id":1,"method":"config/read","params":{}}\n');
  f.child.stdout.write('{"method":"notification"}\n');
  await Promise.all([writingInput, writingOutput]);
  output.destroy();
  await bounded(f.owner.finished);
});

test("explicit owner shutdown releases an outstanding output write", async t => {
  let entered;
  const writing = new Promise(resolve => { entered = resolve; });
  const output = new Writable({ highWaterMark: 1, write(_chunk, _encoding, _callback) { entered(); } });
  const f = await fixture(t, output);
  f.child.stdout.write('{"method":"notification"}\n');
  await writing;
  await bounded(f.owner.close());
});
