import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { pickClaudeSession } from "../../src/cli/claude-session-picker.js";
import { runCli } from "../helpers/cli-runner.js";
import { mkTempHome } from "../helpers/files.js";

function session(index) {
  return {
    threadId: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
    transcriptPath: `/home/account/${index}.jsonl`, account: "pro5",
    cwd: "/home/workspace/project", lastUsedMs: 1_000_000 - index * 1000,
    description: `Task ${index}`, model: "claude-fable-5-1", effort: "xhigh",
  };
}

test("picker browses past 50, rejects undisplayed numbers, and pins the selected snapshot", async () => {
  const original = Array.from({ length: 55 }, (_, index) => session(index + 1));
  const answers = ["999", "n", "p", "n", "n", "n", "n", "n", "51"];
  let output = "";
  const limits = [];
  const picked = await pickClaudeSession({
    homeDir: "/home", nowMs: 1_000_000,
    stdin: { isTTY: true }, stdout: { isTTY: true, write: (text) => { output += text; } },
    listSessions: ({ limit }) => { limits.push(limit); return original.slice(0, limit); },
    promptLineImpl: async () => answers.shift(),
  });
  assert.equal(picked, original[50]);
  assert.deepEqual(limits, [50, 100]);
  assert.match(output, /Choose one of the displayed numbers/);
  assert.match(output, /51\. Task 51/);
  assert.match(output, /pro5 · ~\/workspace\/project/);
  assert.ok(output.indexOf("1. Task 1") < output.indexOf("2. Task 2"));
});

test("picker keeps selected identity when recency changes while choosing", async () => {
  const listed = [session(1), session(2)];
  let reads = 0;
  const picked = await pickClaudeSession({
    homeDir: "/home", stdin: { isTTY: true }, stdout: { isTTY: true, write() {} },
    listSessions: () => { reads += 1; return [...listed]; },
    promptLineImpl: async () => { listed.reverse(); return "1"; },
  });
  assert.equal(picked.threadId, session(1).threadId);
  assert.equal(reads, 1);
});

test("picker sanitizes terminal controls and cancels without account work", async () => {
  let output = "";
  const picked = await pickClaudeSession({
    homeDir: "/home", stdin: { isTTY: true }, stdout: { isTTY: true, write: (text) => { output += text; } },
    listSessions: () => [{ ...session(1), description: "\x1b[31mFix\nlogin\x1b[0m" }],
    promptLineImpl: async () => "q",
  });
  assert.equal(picked, null);
  assert.match(output, /Fix login/);
  assert.doesNotMatch(output, /\x1b/);
  assert.match(output, /Resume cancelled/);
  const empty = await runCli(["claude", "resume", "--home", mkTempHome()], {
    stdin: { isTTY: true }, stdout: { isTTY: true },
    connectRedisStoreImpl: () => { throw new Error("No credential work before choosing"); },
  });
  assert.match(empty, /No managed Claude sessions/);
});

test("no-selector resume refuses noninteractive or JSON input without starting anything", async () => {
  const home = mkTempHome();
  await assert.rejects(runCli(["claude", "resume", "--home", home], { stdin: { isTTY: false } }), /interactive terminal.*aim claude list/);
  await assert.rejects(runCli(["claude", "resume", "--json", "--home", home]), /aim claude list --json/);
});

test("EOF and Ctrl-C settle the terminal picker and release stdin listeners", { timeout: 2000 }, async () => {
  for (const input of ["\x04", "\x03"]) {
    const stdin = new PassThrough();
    stdin.isTTY = true;
    stdin.setRawMode = () => {};
    const stdout = new PassThrough();
    stdout.isTTY = true;
    let sent = false;
    stdout.on("data", (chunk) => {
      if (!sent && String(chunk).includes("Choose a session number")) {
        sent = true;
        setImmediate(() => stdin.write(input));
      }
    });
    const picked = await pickClaudeSession({ homeDir: "/home", stdin, stdout, listSessions: () => [session(1)] });
    assert.equal(picked, null);
    assert.equal(stdin.listenerCount("keypress"), 0);
    assert.equal(stdin.isPaused(), true);
    stdin.destroy(); stdout.destroy();
  }
});

test("picker skips metadata-only files so the first choice is an actual conversation", async () => {
  let output = "";
  const picked = await pickClaudeSession({
    homeDir: "/home", stdin: { isTTY: true }, stdout: { isTTY: true, write: (text) => { output += text; } },
    listSessions: () => [{ ...session(1), description: null, model: null, effort: null }, session(2)],
    promptLineImpl: async () => "1",
  });
  assert.equal(picked.threadId, session(2).threadId);
  assert.match(output, /1\. Task 2/);
  assert.doesNotMatch(output, /Untitled/);
});
