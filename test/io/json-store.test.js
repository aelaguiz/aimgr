import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeJsonFileWithBackup } from "../../src/io/json-store.js";

test("backed-up JSON writes remain complete when another writer finishes during the write", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-json-write-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "local-state.json");
  const first = { writer: "first", value: "short" };
  const second = { writer: "second", value: "long".repeat(1000) };
  fs.writeFileSync(filePath, JSON.stringify({ writer: "initial" }));
  const originalWrite = fs.writeFileSync.bind(fs);
  let interleaved = false;
  t.mock.method(fs, "writeFileSync", (target, data, options) => {
    if (interleaved || data !== `${JSON.stringify(first, null, 2)}\n`) {
      return originalWrite(target, data, options);
    }
    interleaved = true;
    const fd = fs.openSync(target, "w", options?.mode ?? 0o666);
    try {
      execFileSync(process.execPath, [
        "--input-type=module", "-e",
        `import { writeJsonFileWithBackup } from ${JSON.stringify(new URL("../../src/io/json-store.js", import.meta.url).href)};
         writeJsonFileWithBackup(process.argv[1], JSON.parse(process.argv[2]));`,
        filePath, JSON.stringify(second),
      ], { timeout: 5000 });
      return originalWrite(fd, data, options);
    } finally {
      fs.closeSync(fd);
    }
  });

  writeJsonFileWithBackup(filePath, first);

  assert.equal(interleaved, true);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), first);
});

test("backed-up JSON writes retain the previous contents and existing file permissions", (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "aimgr-json-backup-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const filePath = path.join(dir, "local-state.json");
  const previous = `${JSON.stringify({ value: "before" })}\n`;
  fs.writeFileSync(filePath, previous, { mode: 0o600 });

  writeJsonFileWithBackup(filePath, { value: "after" });

  const backups = fs.readdirSync(dir).filter(name => name.startsWith("local-state.json.bak."));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(dir, backups[0]), "utf8"), previous);
  assert.deepEqual(JSON.parse(fs.readFileSync(filePath, "utf8")), { value: "after" });
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600);
});
