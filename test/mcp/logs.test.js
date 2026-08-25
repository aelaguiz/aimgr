import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  AIM_MCP_MAX_TAIL_LINES,
  buildAimLogMap,
  statLogFile,
  tailLog,
} from "../../src/mcp/logs.js";
import { mkTempHome } from "../helpers/files.js";

function writeLines(filePath, count, prefix = "line") {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const body = Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`).join("\n");
  fs.writeFileSync(filePath, `${body}\n`, "utf8");
  return filePath;
}

function tempLogMap() {
  const home = mkTempHome();
  const logMap = {
    "codex-watch": {
      out: path.join(home, "codex-watch.out.log"),
      err: path.join(home, "codex-watch.err.log"),
    },
  };
  return { home, logMap };
}

test("a named log returns both the out and err tails with freshness facts", () => {
  const { home, logMap } = tempLogMap();
  writeLines(logMap["codex-watch"].out, 500, "out");
  writeLines(logMap["codex-watch"].err, 3, "err");

  const tail = tailLog({ name: "codex-watch", lines: 10 }, { homeDir: home, logMap });

  assert.equal(tail.name, "codex-watch");
  assert.equal(tail.files.length, 2);
  const [out, err] = tail.files;
  assert.equal(out.stream, "out");
  assert.equal(out.present, true);
  assert.equal(out.lineCount, 10);
  assert.equal(out.text.split("\n")[0], "out-491");
  assert.equal(out.text.split("\n").at(-1), "out-500");
  assert.ok(out.sizeBytes > 0);
  assert.ok(out.bytesRead > 0);
  assert.match(out.mtime, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof out.ageSeconds, "number");
  assert.equal(err.stream, "err");
  assert.equal(err.lineCount, 3);
});

test("the line request is capped and an explicit path reads exactly that file", () => {
  const { home, logMap } = tempLogMap();
  const target = writeLines(path.join(home, "other.log"), 4_000, "row");

  const capped = tailLog({ path: target, lines: 999_999 }, { homeDir: home, logMap });
  assert.equal(capped.lines, AIM_MCP_MAX_TAIL_LINES);
  assert.equal(capped.files.length, 1);
  assert.equal(capped.files[0].stream, "file");
  assert.equal(capped.files[0].lineCount, AIM_MCP_MAX_TAIL_LINES);
  assert.equal(capped.files[0].text.split("\n")[0], "row-2001");

  const defaulted = tailLog({ path: target }, { homeDir: home, logMap });
  assert.equal(defaulted.files[0].lineCount, 200);
});

test("a missing log is a fact, not an error", () => {
  const { home, logMap } = tempLogMap();

  const tail = tailLog({ name: "codex-watch" }, { homeDir: home, logMap });
  assert.deepEqual(tail.files.map((file) => file.present), [false, false]);
  assert.equal(tail.files[0].path, logMap["codex-watch"].out);
  assert.equal(statLogFile(path.join(home, "nope.log")).present, false);
});

test("bad tail requests explain the valid shape", () => {
  const { home, logMap } = tempLogMap();
  const deps = { homeDir: home, logMap };

  assert.throws(() => tailLog({}, deps), /Pass a log name or an absolute path.*codex-watch/s);
  assert.throws(() => tailLog({ name: "nope" }, deps), /Unknown log name: nope/);
  assert.throws(() => tailLog({ path: "relative.log" }, deps), /path must be absolute/);
  assert.throws(() => tailLog({ name: "codex-watch", path: "/tmp/x.log" }, deps), /not both/);
  assert.throws(() => tailLog({ name: "codex-watch", lines: 0 }, deps), /positive integer/);
});

test("the default log map points at the fixed pool paths", () => {
  const map = buildAimLogMap({ homeDir: "/Users/example" });

  assert.equal(map["auth-maintainer"].out, "/Users/example/.aimgr/logs/auth-maintainer.out.log");
  assert.equal(map["auth-maintainer"].err, "/Users/example/.aimgr/logs/auth-maintainer.err.log");
  assert.equal(map["codex-watch"].out, "/tmp/agents_host_aim_codex_watch.out.log");
  assert.equal(map["hermes-watch"].err, "/tmp/agents_host_aim_hermes_watch.err.log");
  assert.equal(map["mcp-serve"].out, "/Users/example/.aimgr/logs/mcp-serve.out.log");
});
