import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { readFileLines } from "../../src/io/file-lines.js";
import { mkTempHome } from "../helpers/files.js";

test("file lines preserve bytes across chunks, empty lines, CRLF, and unterminated records in both directions", () => {
  const file = path.join(mkTempHome(), "lines");
  for (const source of ["", "\n", "\n\n", "a\nb", "a\n\nb\n", "a\r\nb",
    `${"a".repeat(256 * 1024 - 1)}\n日本語\n${"é".repeat(400_000)}\ntail`]) {
    fs.writeFileSync(file, source);
    const expected = source.split("\n").filter((line) => line !== "");
    for (const reverse of [false, true]) {
      const actual = [...readFileLines(file, { reverse })].map((bytes) => bytes.toString("utf8")).filter(Boolean);
      assert.deepEqual(actual, reverse ? [...expected].reverse() : expected);
    }
  }
});

test("early termination of file line reading closes the descriptor", (t) => {
  const file = path.join(mkTempHome(), "lines");
  fs.writeFileSync(file, "first\nsecond\n");
  const close = fs.closeSync;
  const closed = [];
  t.mock.method(fs, "closeSync", (fd) => { closed.push(fd); return close(fd); });
  for (const reverse of [false, true]) {
    for (const line of readFileLines(file, { reverse })) { if (line.length) break; }
  }
  assert.equal(closed.length, 2);
});
