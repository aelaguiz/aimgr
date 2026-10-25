import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPrimeSessionObserver, readPrimeLatestTurn } from "../../src/targets/prime-sessions.js";
import { mkTempHome } from "../helpers/files.js";

test("Prime routine observation reads unchanged history once and follows appended turns and replacement", () => {
  const file = path.join(mkTempHome(), "session.jsonl");
  const user = { type: "message", id: "u1", parentId: null, message: { role: "user", content: "Continue" } };
  fs.writeFileSync(file, `${JSON.stringify(user)}\n`);
  let reads = 0;
  const read = createPrimeSessionObserver(file, (p) => { reads += 1; return readPrimeLatestTurn(p); });
  for (let i = 0; i < 20; i += 1) assert.equal(read().userText, "Continue");
  assert.equal(reads, 1);
  fs.appendFileSync(file, `${JSON.stringify({ type: "message", id: "a1", parentId: "u1",
    message: { role: "assistant", content: "Done", stopReason: "stop" } })}\n`);
  assert.equal(read().assistant.stopReason, "stop");
  assert.equal(reads, 2);
  fs.writeFileSync(`${file}.replacement`, `${JSON.stringify({ ...user, message: { role: "user", content: "New task" } })}\n`);
  fs.renameSync(`${file}.replacement`, file);
  assert.equal(read().userText, "New task");
  assert.equal(reads, 3);
  fs.writeFileSync(file, "");
  assert.equal(read().userText, null);
  assert.equal(reads, 4);
});

test("Prime observation retries failed reads and preserves active branch selection", () => {
  const file = path.join(mkTempHome(), "session.jsonl");
  const record = (id, parentId, content) => JSON.stringify({ type: "message", id, parentId, message: { role: "user", content } });
  fs.writeFileSync(file, `${record("first", null, "First")}\n${record("abandoned", "first", "Other branch")}\n${record("active", "first", "Active branch")}\n{"partial":`);
  let attempts = 0;
  const read = createPrimeSessionObserver(file, (p) => {
    attempts += 1;
    if (attempts === 1) throw new Error("transient read error");
    return readPrimeLatestTurn(p);
  });
  assert.throws(read, /transient read error/);
  assert.equal(read().userText, "Active branch");
  assert.equal(attempts, 2);
});
