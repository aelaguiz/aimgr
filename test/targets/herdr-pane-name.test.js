import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { keepHerdrPaneName } from "../../src/targets/herdr-pane-name.js";

const PANE = { HERDR_SOCKET_PATH: "/tmp/herdr-test.sock", HERDR_PANE_ID: "w3:p8" };

// A Herdr pane whose agent and its name the test sets; renames are recorded and refused
// when `taken` names a name live elsewhere.
function fakeHerdr() {
  const herdr = { agent: null, name: null, taken: new Set(), renames: [] };
  herdr.execFile = (_bin, args, _opts, done) => {
    const [verb, pane, name] = args.slice(1);
    if (pane !== PANE.HERDR_PANE_ID || !herdr.agent) {
      done(new Error("exit 1"), JSON.stringify({ error: { code: "agent_not_found" } }));
      return;
    }
    if (verb === "rename") {
      herdr.renames.push(name);
      if (herdr.taken.has(name)) {
        done(new Error("exit 1"), JSON.stringify({ error: { code: "agent_name_taken" } }));
        return;
      }
      herdr.name = name;
    }
    done(null, JSON.stringify({ result: { agent: { pane_id: pane, agent: herdr.agent, ...(herdr.name ? { name: herdr.name } : {}) } } }));
  };
  return herdr;
}

function clock() {
  const c = { now: 0, queue: [] };
  c.setTimeout = (fn, ms) => { const t = { fn, at: c.now + ms }; c.queue.push(t); return t; };
  c.clearTimeout = (t) => { c.queue = c.queue.filter((x) => x !== t); };
  c.next = async () => {
    const t = c.queue.shift();
    if (!t) return false;
    c.now = t.at;
    await t.fn();
    return true;
  };
  return c;
}

function start(home, herdr, c, overrides = {}) {
  return keepHerdrPaneName({ env: PANE, homeDir: home, cwd: "/pods/lessons/writer", kind: "claude",
    execFileImpl: herdr.execFile, setTimeoutImpl: c.setTimeout, clearTimeoutImpl: c.clearTimeout,
    nowImpl: () => c.now, ...overrides });
}

test("a resume in the pane gives back the name the pane's last session carried", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-herdr-name-"));
  const herdr = fakeHerdr();
  const c = clock();
  herdr.agent = "claude";
  herdr.name = "lessons-writer";
  const first = start(home, herdr, c);
  assert.equal(first.note, null);
  await c.next();                       // the minute's look notes the name
  first.stop();

  herdr.name = null;                    // the session exits; Herdr clears its name
  herdr.agent = null;
  const again = start(home, herdr, c, { giveBack: true });
  assert.match(again.note, /lessons-writer/);
  await c.next();                       // Herdr has not seen the new session yet
  assert.deepEqual(herdr.renames, []);
  herdr.agent = "claude";
  await c.next();
  assert.deepEqual(herdr.renames, ["lessons-writer"]);
  assert.equal(herdr.name, "lessons-writer");
  again.stop();
});

test("it never guesses: another folder, another pane, or a name already set gets nothing", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-herdr-name-"));
  const herdr = fakeHerdr();
  const c = clock();
  herdr.agent = "claude";
  herdr.name = "lessons-writer";
  const first = start(home, herdr, c);
  await c.next();
  first.stop();
  herdr.name = null;

  const elsewhere = start(home, herdr, c, { giveBack: true, cwd: "/pods/lessons/editor" });
  assert.equal(elsewhere.note, null);
  elsewhere.stop();
  const otherPane = start(home, herdr, c, { giveBack: true, env: { ...PANE, HERDR_PANE_ID: "w3:p9" } });
  assert.equal(otherPane.note, null);
  otherPane.stop();
  const outside = start(home, herdr, c, { giveBack: true, env: {} });
  assert.equal(outside.note, null);
  outside.stop();

  herdr.name = "lessons-writer-2";      // something named the new session first
  const named = start(home, herdr, c, { giveBack: true });
  await c.next();
  assert.deepEqual(herdr.renames, []);
  named.stop();
});

test("a name Herdr refuses is tried until the deadline, then dropped, and the launch carries on", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "aim-herdr-name-"));
  const herdr = fakeHerdr();
  const c = clock();
  herdr.agent = "claude";
  herdr.name = "lessons-writer";
  const first = start(home, herdr, c);
  await c.next();
  first.stop();
  herdr.name = null;
  herdr.taken.add("lessons-writer");

  const again = start(home, herdr, c, { giveBack: true });
  while (c.now < 200_000 && await c.next());   // the deadline is two minutes after the resume, at 180 s
  assert.ok(herdr.renames.length > 1);
  const tries = herdr.renames.length;
  await c.next();                       // past the deadline it only looks, once a minute
  assert.equal(herdr.renames.length, tries);
  assert.equal(herdr.name, null);
  again.stop();
  assert.equal(c.queue.length, 0);
});
