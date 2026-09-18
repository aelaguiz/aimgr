import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { mkTempHome } from "../helpers/files.js";
import {
  analyticsDisabledInProfile,
  buildRewriteMap,
  carryThreadGoal,
  copyThreadRollout,
  ensureCodexProfileAnalyticsDisabled,
  generateUuidV7,
  isUuidV7,
  planThreadCopy,
  remapIdValue,
  scanThreadRollout,
  verifyCopiedRollout,
} from "../../src/targets/codex-thread-copy.js";
import { resolveRolloutForThreadId } from "../../src/targets/codex-rollout.js";

const THREAD = "01a0b222-95ce-7fa3-96d8-680acb15cbcc";
const OTHER_THREAD = "01a0b222-95ce-7fa3-96d8-680acb15cbc1";
const TURN = "01a0b222-96ae-7241-8dfc-c8c63bebf91b";
const WINDOW_A = "01a0b222-95ce-7fa3-96d8-680acb15cb01";
const WINDOW_B = "01a0b222-95ce-7fa3-96d8-680acb15cb02";
const WINDOW_C = "01a0b222-95ce-7fa3-96d8-680acb15cb03";
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function uuidList(...values) {
  return values;
}

function rolloutLines({ includeSpawnEvent = false, contentMention = false } = {}) {
  return [
    {
      timestamp: "2026-09-17T10:00:00.000Z",
      ordinal: 0,
      type: "session_meta",
      payload: {
        session_id: THREAD,
        id: THREAD,
        forked_from_id: OTHER_THREAD,
        forked_from_ordinal_exclusive: 12,
        timestamp: "2026-09-17T09:59:59.000Z",
        cwd: "/tmp/project",
        originator: "codex-tui",
        cli_version: "0.154.0-alpha.3",
        source: "cli",
        thread_source: "user",
        model_provider: "openai",
        history_mode: "paginated",
        base_instructions: { text: "You are Codex", provenance: { type: "model", model: "gpt-6-astra" } },
        context_window: { window_id: WINDOW_A },
      },
    },
    {
      timestamp: "2026-09-17T10:00:01.000Z",
      ordinal: 1,
      type: "turn_context",
      payload: { turn_id: TURN, root_turn_id: TURN, cwd: "/tmp/project", model: "gpt-6-astra" },
    },
    {
      timestamp: "2026-09-17T10:00:02.000Z",
      ordinal: 2,
      type: "response_item",
      payload: {
        type: "message",
        id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c111",
        role: "user",
        content: [{ type: "input_text", text: contentMention ? `resume ${THREAD} later` : "hello there" }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1789695001.5 },
      },
    },
    {
      timestamp: "2026-09-17T10:00:03.000Z",
      ordinal: 3,
      type: "response_item",
      payload: {
        type: "reasoning",
        id: "rs_086c64c19dfa8c6e016aac9421ad3487d193d5a151e24a2780",
        summary: [],
        encrypted_content: "ENCRYPTED_REASONING_BLOB",
        internal_chat_message_metadata_passthrough: { turn_id: TURN },
      },
    },
    {
      timestamp: "2026-09-17T10:00:04.000Z",
      ordinal: 4,
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "ctc_086c64c19dfa8c6e016aac9428b8c087d18418b4f13d8efb1e",
        status: "completed",
        call_id: "call_S3eqf9BvKhZ1SmhvyUCoUvIV",
        name: "exec",
        input: "echo hi",
        encrypted_function_args: "ENCRYPTED_ARGS",
        internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1789695004.5 },
      },
    },
    {
      timestamp: "2026-09-17T10:00:05.000Z",
      ordinal: 5,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: THREAD,
        turn_id: TURN,
        item: { id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c111", type: "message" },
      },
    },
    ...(includeSpawnEvent
      ? [{
          timestamp: "2026-09-17T10:00:06.000Z",
          ordinal: 6,
          type: "event_msg",
          payload: { type: "sub_agent_activity", agent_thread_id: OTHER_THREAD, thread_id: THREAD },
        }]
      : []),
    {
      timestamp: "2026-09-17T10:00:07.000Z",
      ordinal: 7,
      type: "token_usage_record",
      payload: {
        session_id: THREAD,
        thread_id: THREAD,
        turn_id: TURN,
        root_turn_id: TURN,
        response_id: "resp_abc123def456",
        turn_token_usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    {
      timestamp: "2026-09-17T10:00:08.000Z",
      ordinal: 8,
      type: "compacted",
      payload: {
        message: "summary of earlier work",
        replacement_history: [
          {
            type: "message",
            id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c222",
            role: "developer",
            content: [{ type: "input_text", text: "project instructions" }],
            internal_chat_message_metadata_passthrough: { turn_id: TURN },
          },
          { type: "compaction", encrypted_content: "ENCRYPTED_COMPACTION_BLOB" },
        ],
        window_number: 0,
        first_window_id: WINDOW_A,
        previous_window_id: WINDOW_B,
        window_id: WINDOW_C,
        compaction_response_id: "resp_compaction999",
        latest_token_usage_record: {
          session_id: THREAD,
          thread_id: THREAD,
          turn_id: TURN,
          response_id: "resp_abc123def456",
        },
      },
    },
  ];
}

function writeRollout({ home, threadId = THREAD, lines }) {
  const dir = path.join(home, ".codex", "sessions", "2026", "09", "17");
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `rollout-2026-09-17T10-00-00-${threadId}.jsonl`);
  fs.writeFileSync(file, `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`, "utf8");
  return file;
}

function setup(options = {}) {
  const home = mkTempHome();
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  const sourcePath = writeRollout({ home, lines: rolloutLines(options) });
  return { home, codexHome: path.join(home, ".codex"), sourcePath };
}

test("generateUuidV7 emits monotonic version-7 identifiers", () => {
  const first = generateUuidV7({ nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 1) });
  const second = generateUuidV7({ nowMs: NOW + 5, randomBytesImpl: () => Buffer.alloc(10, 2) });
  assert.equal(isUuidV7(first), true);
  assert.equal(isUuidV7(second), true);
  assert.equal(first[14], "7");
  assert.ok(second > first);
  assert.equal(isUuidV7("01a0b222-95ce-4fa3-96d8-680acb15cbcc"), false);
});

test("remapIdValue keeps the prefix and the suffix shape", () => {
  const bytes = () => Buffer.alloc(24, 7);
  const uuid = remapIdValue("msg_01a0b222-95ce-7fa3-96d8-680acb15c111", { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(uuid, /^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const sourceHex = "086c64c19dfa8c6e016aac9421ad3487d193d5a151e24a2780";
  const long = remapIdValue(`rs_${sourceHex}`, { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(long, /^rs_[0-9a-f]+$/);
  assert.equal(long.length, `rs_${sourceHex}`.length);
  assert.notEqual(long, `rs_${sourceHex}`);
  const call = remapIdValue("call_S3eqf9BvKhZ1SmhvyUCoUvIV", { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(call, /^call_[A-Za-z0-9]{24}$/);
  assert.equal(remapIdValue("no-underscore", { nowMs: NOW }), null);
});

test("scan collects every retired identifier and what the file carries", async () => {
  const { home, codexHome } = setup();
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW });
  const scan = await scanThreadRollout({ plan });
  assert.equal(scan.threadId, THREAD);
  assert.equal(scan.sessionId, THREAD);
  assert.deepEqual(scan.turnIds, [TURN]);
  assert.deepEqual(scan.windowIds, uuidList(WINDOW_A, WINDOW_B, WINDOW_C));
  assert.ok(scan.itemIds.includes("msg_01a0b222-95ce-7fa3-96d8-680acb15c111"));
  assert.ok(scan.itemIds.includes("ctc_086c64c19dfa8c6e016aac9428b8c087d18418b4f13d8efb1e"));
  assert.ok(scan.itemIds.includes("call_s3eqf9bvkhz1smhvyucouviv"));
  assert.deepEqual([...scan.responseIds].sort(), ["resp_abc123def456", "resp_compaction999"]);
  assert.equal(scan.createTimes, 2);
  assert.equal(scan.encryptedBlobs, 3);
  assert.equal(scan.droppedItemLines, 2);
  assert.equal(scan.lineTypes.compacted, 1);
  assert.equal(scan.subagentSpawnCount, 0);
  assert.ok(scan.lineCount === rolloutLines().length);
});

test("copy retires ids, drops server blobs, and keeps conversation content", async () => {
  const { home, codexHome } = setup();
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 3) });
  const scan = await scanThreadRollout({ plan });
  const map = buildRewriteMap({ scan, newId: plan.newId, nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 4) });
  const copy = await copyThreadRollout({ plan, scan, map, nowMs: NOW });
  assert.equal(fs.existsSync(plan.targetPath), true);
  assert.equal(path.basename(plan.targetPath), `rollout-2026-09-18T07-00-00-${plan.newId}.jsonl`);
  // One whole line is dropped (the reasoning item); the nested compaction marker
  // is dropped from its array inside the compacted record.
  assert.equal(copy.dropped, 1);
  assert.equal(copy.lines, rolloutLines().length - 1);

  const written = fs.readFileSync(plan.targetPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const header = written[0];
  assert.equal(header.type, "session_meta");
  assert.equal(header.ordinal, 0);
  assert.equal(header.payload.id, plan.newId);
  assert.equal(header.payload.session_id, plan.newId);
  assert.equal(header.payload.forked_from_id, undefined);
  assert.equal(header.payload.forked_from_ordinal_exclusive, undefined);
  assert.equal(header.payload.parent_thread_id, undefined);
  assert.equal(header.payload.history_base, undefined);
  assert.equal(header.payload.history_mode, "paginated");
  assert.equal(header.payload.base_instructions.text, "You are Codex");
  assert.equal(isUuidV7(header.payload.context_window.window_id), true);
  assert.notEqual(header.payload.context_window.window_id, WINDOW_A);
  assert.deepEqual(written.map((line) => line.ordinal), written.map((_, index) => index));

  const serialized = JSON.stringify(written);
  assert.equal(serialized.includes(THREAD), false);
  assert.equal(serialized.includes(TURN), false);
  assert.equal(serialized.includes("ENCRYPTED_REASONING_BLOB"), false);
  assert.equal(serialized.includes("ENCRYPTED_ARGS"), false);
  assert.equal(serialized.includes("ENCRYPTED_COMPACTION_BLOB"), false);
  assert.equal(serialized.includes("create_time"), false);
  assert.equal(serialized.includes("resp_abc123def456"), false);
  assert.equal(serialized.includes("compaction_response_id"), false);
  assert.equal(written.some((line) => line.payload?.type === "reasoning"), false);

  const messageItem = written.find((line) => line.type === "response_item" && line.payload.role === "user");
  assert.equal(messageItem.payload.content[0].text, "hello there");
  assert.match(messageItem.payload.id, /^msg_/);
  assert.notEqual(messageItem.payload.id, "msg_01a0b222-95ce-7fa3-96d8-680acb15c111");
  assert.equal(isUuidV7(messageItem.payload.internal_chat_message_metadata_passthrough.turn_id), true);

  const toolCall = written.find((line) => line.type === "response_item" && line.payload.type === "custom_tool_call");
  assert.match(toolCall.payload.call_id, /^call_/);
  assert.equal(toolCall.payload.input, "echo hi");

  const compacted = written.find((line) => line.type === "compacted");
  assert.equal(compacted.payload.message, "summary of earlier work");
  assert.equal(compacted.payload.replacement_history.length, 1);
  assert.equal(compacted.payload.replacement_history[0].content[0].text, "project instructions");
  assert.equal(compacted.payload.latest_token_usage_record.session_id, plan.newId);

  const usage = written.find((line) => line.type === "token_usage_record");
  assert.equal(usage.payload.thread_id, plan.newId);
  assert.equal(usage.payload.session_id, plan.newId);
  assert.equal(usage.payload.response_id, undefined);

  // Copied lines keep their own timestamps; only the new header is stamped now.
  assert.equal(header.timestamp, new Date(NOW).toISOString());
  assert.equal(written[1].timestamp, "2026-09-17T10:00:01.000Z");
});

test("verify passes on a scrubbed copy and reports content mentions separately", async () => {
  const { home, codexHome } = setup({ contentMention: true });
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW });
  const scan = await scanThreadRollout({ plan });
  await copyThreadRollout({ plan, scan, nowMs: NOW });
  const verification = verifyCopiedRollout({ plan, scan });
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true);
  assert.equal(verification.contentMentions.length, 1);
  assert.match(verification.contentMentions[0].path, /content/);
});

test("verify fails on identifier residue and on surviving server blobs", async () => {
  const { home, codexHome } = setup();
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW });
  const scan = await scanThreadRollout({ plan });
  await copyThreadRollout({ plan, scan, nowMs: NOW, dropServerBlobs: false });
  const verification = verifyCopiedRollout({ plan, scan, dropServerBlobs: false });
  assert.equal(verification.ok, true, "keeping blobs is allowed when asked for explicitly");

  fs.rmSync(plan.targetPath, { force: true });
  await copyThreadRollout({ plan, scan, nowMs: NOW });
  fs.appendFileSync(
    plan.targetPath,
    `${JSON.stringify({ timestamp: "2026-09-18T07:00:01.000Z", ordinal: 99, type: "event_msg", payload: { type: "item_completed", thread_id: THREAD } })}\n`,
  );
  const residue = verifyCopiedRollout({ plan, scan });
  assert.equal(residue.ok, false);
  assert.ok(residue.failures.some((failure) => failure.check === "identifier-residue"));
  assert.ok(residue.failures.some((failure) => failure.check === "ordinals"));
});

test("plan refuses lineage segments, subagent sources, and oversized rollouts", () => {
  const { home, codexHome } = setup();
  const sourcePath = path.join(codexHome, "sessions", "2026", "09", "17", `rollout-2026-09-17T10-00-00-${THREAD}.jsonl`);
  const original = fs.readFileSync(sourcePath, "utf8");
  const base = JSON.parse(original.split("\n")[0]);
  fs.writeFileSync(sourcePath, `${JSON.stringify({
    ...base,
    payload: { ...base.payload, history_base: { thread_id: OTHER_THREAD, end_ordinal_exclusive: 5, end_byte_offset: 100 } },
  })}\n`, "utf8");
  assert.throws(() => planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW }), /multi-segment/);

  fs.writeFileSync(sourcePath, `${JSON.stringify({
    ...base,
    payload: { ...base.payload, parent_thread_id: OTHER_THREAD, source: { subagent: { thread_spawn: { parent_thread_id: OTHER_THREAD } } } },
  })}\n`, "utf8");
  assert.throws(() => planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW }), /subagent/);

  fs.writeFileSync(sourcePath, original, "utf8");
  assert.throws(
    () => planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW, maxCopyMb: 0.000001 }),
    /above the/,
  );
  assert.throws(() => planThreadCopy({ codexHome, sourceId: "not-a-uuid", nowMs: NOW }), /Not a Codex thread id/);
  assert.throws(() => planThreadCopy({ codexHome, sourceId: OTHER_THREAD, nowMs: NOW }), /No rollout found/);
});

test("resolveRolloutForThreadId finds a rollout by filename and reports a stale state-DB path", () => {
  const { codexHome } = setup();
  const found = resolveRolloutForThreadId({ codexHome, threadId: THREAD });
  assert.equal(found.status, "found");
  assert.equal(found.source, "filename");

  fs.writeFileSync(path.join(codexHome, "state_5.sqlite"), "", "utf8");
  const stale = resolveRolloutForThreadId({
    codexHome,
    threadId: OTHER_THREAD,
    spawnSyncImpl: () => ({ status: 0, stdout: `/gone/rollout-${OTHER_THREAD}.jsonl\n` }),
  });
  assert.equal(stale.status, "missing");
  assert.match(stale.staleRolloutPath ?? "", /gone/);
});

test("ensureCodexProfileAnalyticsDisabled writes once and keeps existing keys", () => {
  const { codexHome } = setup();
  const profilePath = path.join(codexHome, "yolo.config.toml");
  fs.writeFileSync(profilePath, "model = \"gpt-6-astra\"\n\n[features]\ngoals = true\n", "utf8");
  const first = ensureCodexProfileAnalyticsDisabled({ codexHome });
  assert.equal(first.changed, true);
  const text = fs.readFileSync(profilePath, "utf8");
  assert.match(text, /model = "gpt-6-astra"/);
  assert.match(text, /\[analytics\]\nenabled = false/);
  assert.equal(analyticsDisabledInProfile({ codexHome }), true);
  assert.equal(ensureCodexProfileAnalyticsDisabled({ codexHome }).changed, false);

  fs.writeFileSync(profilePath, "[analytics]\nenabled = true\n", "utf8");
  assert.equal(analyticsDisabledInProfile({ codexHome }), false);
  ensureCodexProfileAnalyticsDisabled({ codexHome });
  assert.equal(analyticsDisabledInProfile({ codexHome }), true);
  assert.equal((fs.readFileSync(profilePath, "utf8").match(/enabled = false/g) ?? []).length, 1);

  fs.writeFileSync(profilePath, "[features]\ngoals = true\n\n[analytics]\n", "utf8");
  ensureCodexProfileAnalyticsDisabled({ codexHome });
  const inserted = fs.readFileSync(profilePath, "utf8");
  assert.match(inserted, /\[analytics\]\nenabled = false/);
  assert.equal(analyticsDisabledInProfile({ codexHome }), true);
  assert.equal((inserted.match(/enabled = false/g) ?? []).length, 1);
});

test("carryThreadGoal mints a fresh goal id and skips threads without a goal", () => {
  const { codexHome } = setup();
  fs.writeFileSync(path.join(codexHome, "goals_1.sqlite"), "", "utf8");
  const calls = [];
  const spawnSyncImpl = (command, args) => {
    calls.push({ command, args });
    return { status: 0, stdout: "1\n", stderr: "" };
  };
  const carried = carryThreadGoal({ codexHome, sourceId: THREAD, newId: OTHER_THREAD, nowMs: NOW, spawnSyncImpl });
  assert.equal(carried.carried, true);
  assert.equal(isUuidV7(carried.goalId), true);
  const sql = calls[0].args[1];
  assert.match(sql, /insert or replace into thread_goals/);
  assert.match(sql, new RegExp(`'${OTHER_THREAD}'`));
  assert.match(sql, new RegExp(`where thread_id = '${THREAD}'`));
  assert.match(sql, /pragma foreign_keys=off/);

  const empty = carryThreadGoal({
    codexHome,
    sourceId: THREAD,
    newId: OTHER_THREAD,
    nowMs: NOW,
    spawnSyncImpl: () => ({ status: 0, stdout: "0\n", stderr: "" }),
  });
  assert.equal(empty.carried, false);
  assert.equal(empty.reason, "no_goal");
});
