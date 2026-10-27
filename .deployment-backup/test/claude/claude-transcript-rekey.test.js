import test from "node:test";
import assert from "node:assert/strict";
import {
  rekeyClaudeTranscript,
  stripClaudeTranscriptThinkingBytes,
} from "../../src/targets/claude-transcript-rekey.js";

const SESSION = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ENTRY = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const TOOL = "toolu_01ReusedToolIdentifierAB";
const DOMAIN_ID = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";

test("Claude transcript rekey preserves tool relationships and rewrites structured references", () => {
  const records = [
    {
      type: "assistant", sessionId: SESSION, uuid: ENTRY, parentUuid: null,
      promptId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      requestId: "req_01SourceRequestIdentifierA",
      accountId: "acct_SourceAccountIdentifierAB",
      message: {
        id: "msg_01SourceMessageIdentifierA",
        content: [{ type: "tool_use", id: TOOL, name: "Read",
          input: { projectId: DOMAIN_ID, accountId: "acct_DomainResourceIdentifierAB" } }],
      },
      wireToolInputs: { [TOOL]: { path: "file.txt" } },
    },
    {
      type: "user", sessionId: SESSION, parentUuid: ENTRY,
      sourceToolAssistantUUID: ENTRY, sourceToolUseID: TOOL,
      message: { content: [{ type: "tool_result", tool_use_id: TOOL, content: "full prior output" }] },
    },
    { type: "custom-title", sessionId: SESSION,
      customTitle: "[fork from old/aaaaaaaa] [fork from older/bbbbbbbb] Useful title" },
  ];
  const result = rekeyClaudeTranscript(`${records.map(JSON.stringify).join("\n")}\n`);
  const rewritten = result.content.trim().split("\n").map(JSON.parse);
  for (const identifier of [SESSION, ENTRY, TOOL, "req_01SourceRequestIdentifierA",
    "msg_01SourceMessageIdentifierA", "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    "acct_SourceAccountIdentifierAB"]) {
    assert.equal(result.content.includes(identifier), false, `retained ${identifier}`);
  }
  assert.equal(rewritten[0].sessionId, result.stagedSessionId);
  assert.equal(rewritten[1].sessionId, result.stagedSessionId);
  assert.equal(rewritten[0].uuid, rewritten[1].parentUuid);
  assert.equal(rewritten[0].uuid, rewritten[1].sourceToolAssistantUUID);
  const newToolId = rewritten[0].message.content[0].id;
  assert.equal(newToolId, rewritten[1].message.content[0].tool_use_id);
  assert.equal(newToolId, rewritten[1].sourceToolUseID);
  assert.deepEqual(Object.keys(rewritten[0].wireToolInputs), [newToolId]);
  assert.equal(rewritten[0].message.content[0].input.projectId, DOMAIN_ID);
  assert.equal(rewritten[0].message.content[0].input.accountId, "acct_DomainResourceIdentifierAB");
  assert.equal(rewritten[1].message.content[0].content, "full prior output");
  assert.equal(rewritten[2].customTitle, "Useful title");
});

test("Claude transcript rekey strips account-bound thinking blocks but keeps every entry", () => {
  const THINKING = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const records = [
    { type: "user", sessionId: SESSION, uuid: ENTRY, parentUuid: null, message: { content: "go" } },
    {
      type: "assistant", sessionId: SESSION, uuid: THINKING, parentUuid: ENTRY,
      message: { id: "msg_01SourceMessageIdentifierA",
        content: [{ type: "thinking", thinking: "", signature: "CAQSgQYKEAgSGAI4AUIIdGhpbmtpbmc=" }] },
    },
    {
      type: "assistant", sessionId: SESSION, uuid: DOMAIN_ID, parentUuid: THINKING,
      message: { id: "msg_01SourceMessageIdentifierA", content: [
        { type: "redacted_thinking", data: "EmwKAhgBEgy3redactedPayload" },
        { type: "tool_use", id: TOOL, name: "Read", input: { path: "file.txt" } },
      ] },
    },
  ];
  const result = rekeyClaudeTranscript(`${records.map(JSON.stringify).join("\n")}\n`);
  const rewritten = result.content.trim().split("\n").map(JSON.parse);
  assert.equal(result.content.includes("signature"), false);
  assert.equal(result.content.includes("redactedPayload"), false);
  assert.equal(rewritten.length, 3);
  assert.deepEqual(rewritten[1].message.content, []);
  assert.equal(rewritten[1].parentUuid, rewritten[0].uuid);
  assert.equal(rewritten[2].parentUuid, rewritten[1].uuid);
  assert.deepEqual(rewritten[2].message.content.map((block) => block.type), ["tool_use"]);
  assert.equal(rewritten[0].message.content, "go");
});

test("Claude companion JSONL loses thinking blocks and keeps every other byte", () => {
  const thinkingLine = JSON.stringify({ type: "assistant",
    message: { content: [{ type: "thinking", thinking: "", signature: "SIGBLOB" },
      { type: "text", text: "Résumé 日本語" }] } });
  const plainLine = Buffer.concat([Buffer.from('{"type":"user","message":{"content":"thinking about '),
    Buffer.from([0xe2, 0xff]), Buffer.from('"}}')]);
  const malformed = Buffer.from('{"thinking": broken');
  const source = Buffer.concat([Buffer.from(`${thinkingLine}\n`), plainLine, Buffer.from("\n"),
    malformed, Buffer.from("\n")]);

  const stripped = stripClaudeTranscriptThinkingBytes(source);
  const lines = stripped.toString("latin1").split("\n").map((line) => Buffer.from(line, "latin1"));
  assert.equal(stripped.includes(Buffer.from("SIGBLOB")), false);
  assert.deepEqual(JSON.parse(lines[0].toString("utf8")).message.content,
    [{ type: "text", text: "Résumé 日本語" }]);
  assert.deepEqual(lines[1], plainLine);
  assert.deepEqual(lines[2], malformed);
  const untouched = Buffer.from(`${JSON.stringify({ type: "user", message: { content: "hi" } })}\n`);
  assert.equal(stripClaudeTranscriptThinkingBytes(untouched), untouched);
});

test("Claude transcript rekey drops only an incomplete final JSONL record", () => {
  const valid = JSON.stringify({ type: "user", sessionId: SESSION, message: { content: "keep" } });
  const result = rekeyClaudeTranscript(`${valid}\n{incomplete\n`);
  assert.equal(result.content.trim().split("\n").length, 1);
  assert.match(result.content, /keep/);
  assert.throws(
    () => rekeyClaudeTranscript(`${valid}\n{broken\n${valid}\n`),
    /malformed JSONL at line 2/,
  );
});

test("Claude transcript rekey rejects inconsistent source session IDs", () => {
  const other = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  assert.throws(
    () => rekeyClaudeTranscript([
      JSON.stringify({ type: "user", sessionId: SESSION }),
      JSON.stringify({ type: "assistant", sessionId: other }),
    ].join("\n")),
    /one consistent session ID/,
  );
});
