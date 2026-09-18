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
  forEachRolloutLine,
  generateUuidV7,
  isUuidV7,
  planThreadCopy,
  remapIdValue,
  remapUuidsInText,
  resolveBlobPolicy,
  scanThreadRollout,
  verifyCopiedRollout,
} from "../../src/targets/codex-thread-copy.js";
import { resolveRolloutForThreadId } from "../../src/targets/codex-rollout.js";

const THREAD = "01a0b222-95ce-7fa3-96d8-680acb15cbcc";
const OTHER_THREAD = "01a0b222-95ce-7fa3-96d8-680acb15cbc1";
const TURN = "01a0b222-96ae-7241-8dfc-c8c63bebf91b";
const SHORT_ID = "msg_00f3a1";
const WINDOW_A = "01a0b222-95ce-7fa3-96d8-680acb15cb01";
const WINDOW_B = "01a0b222-95ce-7fa3-96d8-680acb15cb02";
const WINDOW_C = "01a0b222-95ce-7fa3-96d8-680acb15cb03";
const NOW = Date.parse("2026-09-18T12:00:00.000Z");

function rolloutLines({ includeSpawnEvent = false, includeSpawnItem = false, contentMention = false, compacted = false } = {}) {
  const lines = [
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
      timestamp: "2026-09-17T10:00:02.500Z",
      ordinal: 3,
      type: "response_item",
      payload: {
        type: "message",
        id: SHORT_ID,
        role: "assistant",
        content: [{ type: "output_text", text: "short id message" }],
        internal_chat_message_metadata_passthrough: { turn_id: TURN },
      },
    },
    {
      timestamp: "2026-09-17T10:00:03.000Z",
      ordinal: 4,
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
      ordinal: 5,
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
      ordinal: 6,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: THREAD,
        turn_id: TURN,
        item: { id: SHORT_ID, type: "message" },
      },
    },
    {
      timestamp: "2026-09-17T10:00:06.000Z",
      ordinal: 7,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: THREAD,
        turn_id: TURN,
        item: { type: includeSpawnItem ? "SubAgentActivity" : "mcp_tool_call", id: "call_child" },
      },
    },
    {
      // Real rollouts carry locally minted `exec-<uuid>` item ids in item_completed events.
      timestamp: "2026-09-17T10:00:06.250Z",
      ordinal: 8,
      type: "event_msg",
      payload: {
        type: "item_completed",
        thread_id: THREAD,
        turn_id: TURN,
        item: { type: "exec", id: "exec-b52731f6-4935-4c58-b3c6-0396441973b1" },
      },
    },
    {
      // Positional ids like `item-1` are not identifying and must survive untouched.
      timestamp: "2026-09-17T10:00:06.500Z",
      ordinal: 9,
      type: "event_msg",
      payload: { type: "item_completed", thread_id: THREAD, turn_id: TURN, item: { type: "message", id: "item-1" } },
    },
    ...(includeSpawnEvent
      ? [{
          timestamp: "2026-09-17T10:00:06.500Z",
          ordinal: 8,
          type: "event_msg",
          payload: { type: "sub_agent_activity", agent_thread_id: OTHER_THREAD, thread_id: THREAD },
        }]
      : []),
    {
      timestamp: "2026-09-17T10:00:07.000Z",
      ordinal: 10,
      type: "token_usage_record",
      payload: {
        session_id: THREAD,
        thread_id: THREAD,
        turn_id: TURN,
        root_turn_id: TURN,
        response_id: "resp_abc123def456",
        usage: { input_tokens: 1, output_tokens: 2 },
        turn_token_usage: { input_tokens: 1, output_tokens: 2 },
        thread_token_usage: { input_tokens: 1, output_tokens: 2 },
      },
    },
    ...(compacted
      ? [{
          timestamp: "2026-09-17T10:00:08.000Z",
          ordinal: 11,
          type: "compacted",
          payload: {
            message: "",
            replacement_history: [
              {
                type: "message",
                id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c222",
                role: "developer",
                content: [{ type: "input_text", text: "project instructions" }],
                internal_chat_message_metadata_passthrough: { turn_id: TURN, create_time: 1789695007.5 },
              },
              {
                type: "compaction",
                id: "cmp_085e491022de5600016aac9421ad3487d193d5a151e24a2780",
                encrypted_content: "ENCRYPTED_COMPACTION_BLOB",
              },
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
              root_turn_id: TURN,
              response_id: "resp_abc123def456",
              usage: { input_tokens: 1, output_tokens: 2 },
              turn_token_usage: { input_tokens: 1, output_tokens: 2 },
              thread_token_usage: { input_tokens: 1, output_tokens: 2 },
            },
          },
        }]
      : []),
  ];
  return lines;
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
  return { home, codexHome: path.join(home, ".codex"), sourcePath, options };
}

function planAndScan({ codexHome, options = {}, nowMs = NOW }) {
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs, randomBytesImpl: () => Buffer.alloc(10, 3) });
  const scan = scanThreadRollout({ plan });
  return { plan, scan };
}

test("generateUuidV7 emits monotonic version-7 identifiers", () => {
  const first = generateUuidV7({ nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 1) });
  const second = generateUuidV7({ nowMs: NOW + 5, randomBytesImpl: () => Buffer.alloc(10, 2) });
  assert.equal(isUuidV7(first), true);
  assert.equal(isUuidV7(second), true);
  assert.ok(second > first);
  assert.equal(isUuidV7("01a0b222-95ce-4fa3-96d8-680acb15cbcc"), false);
});

test("remapIdValue keeps the prefix and the suffix shape, including short ids", () => {
  const bytes = () => Buffer.alloc(24, 7);
  const uuid = remapIdValue("msg_01a0b222-95ce-7fa3-96d8-680acb15c111", { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(uuid, /^msg_[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const short = remapIdValue(SHORT_ID, { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(short, /^msg_[0-9a-f]{6}$/);
  assert.notEqual(short, SHORT_ID);
  const sourceHex = "086c64c19dfa8c6e016aac9421ad3487d193d5a151e24a2780";
  const long = remapIdValue(`rs_${sourceHex}`, { nowMs: NOW, randomBytesImpl: bytes });
  assert.equal(long.length, `rs_${sourceHex}`.length);
  assert.notEqual(long, `rs_${sourceHex}`);
  const call = remapIdValue("call_S3eqf9BvKhZ1SmhvyUCoUvIV", { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(call, /^call_[A-Za-z0-9]{24}$/);
  const bare = remapIdValue(WINDOW_A, { nowMs: NOW, randomBytesImpl: bytes });
  assert.equal(isUuidV7(bare), true);
  assert.equal(remapIdValue("plainword", { nowMs: NOW }), null, "no separator means no remap");
  const dashed = remapIdValue("exec-b52731f6-4935-4c58-b3c6-0396441973b1", { nowMs: NOW, randomBytesImpl: bytes });
  assert.match(dashed, /^exec-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});

test("scan collects every retired identifier, including short and bare ids", () => {
  const { codexHome } = setup();
  const { scan } = planAndScan({ codexHome });
  assert.equal(scan.threadId, THREAD);
  assert.equal(scan.sessionId, THREAD);
  const ids = new Set(scan.ids.map((id) => String(id).toLowerCase()));
  assert.ok(ids.has(TURN), "turn id");
  assert.ok(ids.has(SHORT_ID), "short prefixed id");
  assert.ok(ids.has(WINDOW_A), "header window id");
  assert.equal(ids.has(WINDOW_B), false, "window ids only arrive with a compacted record");
  assert.ok(ids.has("msg_01a0b222-95ce-7fa3-96d8-680acb15c111"));
  assert.ok(ids.has("ctc_086c64c19dfa8c6e016aac9428b8c087d18418b4f13d8efb1e"));
  assert.ok(ids.has("call_s3eqf9bvkhz1smhvyucouviv"));
  assert.ok(ids.has("resp_abc123def456"), "response id collected so it can be blanked");
  assert.ok(ids.has("exec-b52731f6-4935-4c58-b3c6-0396441973b1"), "dash-separated local id");
  assert.equal(ids.has("item-1"), false, "positional ids are not retired");
  assert.ok(ids.has(OTHER_THREAD), "lineage pointer collected");
  assert.equal(scan.createTimes, 2);
  assert.equal(scan.encryptedBlobs, 2);
  assert.equal(scan.compactedLines, 0);
  assert.deepEqual(scan.agentItemTypes.filter((type) => type === "SubAgentActivity"), []);
});

test("copy retires ids, blanks response_id, and keeps the transcript decodable", () => {
  const { codexHome } = setup();
  const { plan, scan } = planAndScan({ codexHome });
  const map = buildRewriteMap({ scan, newId: plan.newId, nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 4) });
  const copy = copyThreadRollout({ plan, scan, map, nowMs: NOW });
  assert.equal(fs.existsSync(plan.targetPath), true);
  assert.equal(copy.dropped, 1, "the reasoning line is dropped");
  assert.equal(copy.sourceGrew, false);

  const written = fs.readFileSync(plan.targetPath, "utf8").trim().split("\n").map((line) => JSON.parse(line));
  const header = written[0];
  assert.equal(header.payload.id, plan.newId);
  assert.equal(header.payload.session_id, plan.newId);
  for (const key of ["forked_from_id", "forked_from_ordinal_exclusive", "parent_thread_id", "history_base"]) {
    assert.equal(header.payload[key], undefined, key);
  }
  assert.equal(isUuidV7(header.payload.context_window.window_id), true);
  assert.notEqual(header.payload.context_window.window_id, WINDOW_A);
  assert.deepEqual(written.map((line) => line.ordinal), written.map((_, index) => index));

  const serialized = JSON.stringify(written);
  assert.equal(serialized.includes(THREAD), false);
  assert.equal(serialized.includes(TURN), false);
  assert.equal(serialized.includes(SHORT_ID), false);
  assert.equal(serialized.includes("ENCRYPTED_REASONING_BLOB"), false);
  assert.equal(serialized.includes("ENCRYPTED_ARGS"), false);
  assert.equal(serialized.includes("create_time"), false);
  assert.equal(serialized.includes("compaction_response_id"), false);
  assert.equal(written.some((line) => line.payload?.type === "reasoning"), false);

  // `TokenUsageRecord.response_id` is a required String: the key stays, blanked.
  const usage = written.find((line) => line.type === "token_usage_record");
  assert.equal(typeof usage.payload.response_id, "string");
  assert.equal(usage.payload.response_id, "");
  assert.equal(usage.payload.thread_id, plan.newId);
  assert.equal(usage.payload.root_turn_id, usage.payload.turn_id);

  const shortMessage = written.find((line) => line.type === "response_item" && line.payload.role === "assistant");
  assert.match(shortMessage.payload.id, /^msg_[0-9a-f]{6}$/);
  assert.notEqual(shortMessage.payload.id, SHORT_ID);

  // Real-world `exec-<uuid>` item ids must be remapped, and positional ids left alone.
  const execItem = written.find((line) => line.type === "event_msg" && line.payload.item?.type === "exec");
  assert.match(execItem.payload.item.id, /^exec-[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  const positional = written.find((line) => line.type === "event_msg" && line.payload.item?.id === "item-1");
  assert.equal(positional.payload.item.id, "item-1");

  const toolCall = written.find((line) => line.type === "response_item" && line.payload.type === "custom_tool_call");
  assert.match(toolCall.payload.call_id, /^call_/);
  assert.equal(toolCall.payload.input, "echo hi");

  assert.equal(header.timestamp, new Date(NOW).toISOString());
  assert.equal(written[1].timestamp, "2026-09-17T10:00:01.000Z");
});

test("blob policy: reasoning dropped and compaction kept by default, each overridable", () => {
  assert.deepEqual(resolveBlobPolicy(), { dropReasoning: true, dropCompaction: false });
  assert.deepEqual(resolveBlobPolicy({ keepReasoning: true }), { dropReasoning: false, dropCompaction: false });
  assert.deepEqual(resolveBlobPolicy({ dropCompaction: true }), { dropReasoning: true, dropCompaction: true });
  assert.deepEqual(resolveBlobPolicy({ dropServerBlobs: false }), { dropReasoning: false, dropCompaction: false });
});

test("compacted sources copy by default with the memory blob intact; --drop-compaction removes it", () => {
  const { codexHome } = setup({ compacted: true });
  const { plan, scan } = planAndScan({ codexHome });
  assert.equal(scan.compactedLines, 1);
  assert.equal(scan.reasoningItems, 1);
  assert.equal(scan.compactionItems, 1);

  // Default: compaction blob kept (memory survives), reasoning dropped, everything else retired.
  const map = buildRewriteMap({ scan, newId: plan.newId, nowMs: NOW });
  const copy = copyThreadRollout({ plan, scan, map, nowMs: NOW });
  assert.equal(copy.keptCompactions, 1);
  assert.equal(copy.droppedReasoning, 1);
  const text = fs.readFileSync(plan.targetPath, "utf8");
  assert.equal(text.includes("ENCRYPTED_COMPACTION_BLOB"), true, "the memory blob survives");
  assert.equal(text.includes("ENCRYPTED_REASONING_BLOB"), false, "reasoning blobs are dropped");
  assert.equal(text.includes("ENCRYPTED_ARGS"), false, "encrypted_function_args is dropped with reasoning");
  assert.equal(text.includes("cmp_085e491022de5600016a"), true, "the blob-bearing item keeps its own id");
  assert.equal(text.includes("create_time"), false, "create_time is stripped even next to a kept blob");
  assert.equal(text.includes(THREAD), false);
  assert.equal(text.includes(TURN), false, "turn ids are retired inside replacement_history too");
  assert.equal(text.includes("resp_compaction999"), false);
  const verification = verifyCopiedRollout({ plan, scan });
  assert.deepEqual(verification.failures, []);
  assert.ok(verification.blobMentions.every((hit) => /\/(id|call_id)$/.test(hit.path)), "only the blob item's own id is tolerated");

  // --drop-compaction: the compaction blob goes away too.
  const lossPlan = planAndScan({ codexHome }).plan;
  const lossMap = buildRewriteMap({ scan, newId: lossPlan.newId, nowMs: NOW });
  copyThreadRollout({ plan: { ...lossPlan, targetPath: `${lossPlan.targetPath}.loss` }, scan, map: lossMap, nowMs: NOW, dropCompaction: true });
  const lossText = fs.readFileSync(`${lossPlan.targetPath}.loss`, "utf8");
  assert.equal(lossText.includes("ENCRYPTED_COMPACTION_BLOB"), false);
  assert.equal(lossText.includes("cmp_085e491022de5600016a"), false);
  assert.equal(lossText.includes(THREAD), false);

  // --keep-reasoning: reasoning items stay, with their own id but retired turn id.
  const keepPlan = planAndScan({ codexHome }).plan;
  const keepMap = buildRewriteMap({ scan, newId: keepPlan.newId, nowMs: NOW });
  copyThreadRollout({ plan: { ...keepPlan, targetPath: `${keepPlan.targetPath}.keep` }, scan, map: keepMap, nowMs: NOW, keepReasoning: true });
  const keepText = fs.readFileSync(`${keepPlan.targetPath}.keep`, "utf8");
  assert.equal(keepText.includes("ENCRYPTED_REASONING_BLOB"), true);
  assert.equal(keepText.includes("ENCRYPTED_ARGS"), true);
  assert.equal(keepText.includes("rs_086c64c19dfa8c6e016aac9421ad3487d193d5a151e24a2780"), true, "kept reasoning keeps its own id");
  assert.equal(keepText.includes(TURN), false, "but not the old turn id");
  assert.equal(keepText.includes(THREAD), false);
  const keptVerification = verifyCopiedRollout({ plan: { ...keepPlan, targetPath: `${keepPlan.targetPath}.keep` }, scan, keepReasoning: true });
  assert.deepEqual(keptVerification.failures, []);
});

test("threads that spawned subagents are copied with every child id retired, even inside text", () => {
  const { codexHome, sourcePath } = setup({ includeSpawnEvent: true, includeSpawnItem: true });
  const stateChild = "01a0b222-95ce-7fa3-96d8-680acb15cbc9";
  fs.appendFileSync(sourcePath, `${JSON.stringify({
    timestamp: "2026-09-17T10:00:09.000Z",
    ordinal: 11,
    type: "response_item",
    payload: {
      type: "message",
      id: "msg_01a0b222-95ce-7fa3-96d8-680acb15c444",
      role: "assistant",
      content: [{ type: "output_text", text: `spawned ${OTHER_THREAD} and ${stateChild}; see call_S3eqf9BvKhZ1SmhvyUCoUvIV` }],
      internal_chat_message_metadata_passthrough: { turn_id: TURN },
    },
  })}\n`);
  const plan = planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 3) });
  const scan = scanThreadRollout({ plan, extraIds: [stateChild, THREAD] });
  assert.deepEqual([...scan.childThreadIds].sort(), [OTHER_THREAD, stateChild].sort());
  assert.ok(scan.agentItemTypes.includes("SubAgentActivity"), "subagent items are inventoried, not refused");
  const copy = copyThreadRollout({ plan, scan, nowMs: NOW });
  assert.ok(copy.lines > 0);
  const text = fs.readFileSync(plan.targetPath, "utf8");
  assert.equal(text.includes(OTHER_THREAD), false, "child id from the file is retired");
  assert.equal(text.includes(stateChild), false, "child id from the state DB is retired, even inside prose");
  assert.equal(text.includes(THREAD), false);
  const verification = verifyCopiedRollout({ plan, scan });
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.contentMentions.filter((hit) => hit.id === stateChild || hit.id === OTHER_THREAD).length, 0);
  assert.equal(verification.contentMentions.some((hit) => hit.id === "call_s3eqf9bvkhz1smhvyucouviv"), true, "non-UUID ids inside prose are reported, not rewritten");
});

test("remapUuidsInText rewrites only retired UUIDs inside longer strings", () => {
  const map = new Map([[THREAD, "new-id"]]);
  assert.equal(remapUuidsInText(`resume ${THREAD} then ${OTHER_THREAD}`, map), `resume new-id then ${OTHER_THREAD}`);
  assert.equal(remapUuidsInText("short", map), "short");
  assert.equal(remapUuidsInText(THREAD.toUpperCase(), map), "new-id");
});

test("forEachRolloutLine streams across chunk boundaries and honours the byte limit", () => {
  const { sourcePath } = setup();
  const whole = fs.readFileSync(sourcePath, "utf8").split("\n").filter(Boolean);
  for (const chunkBytes of [1, 7, 64, 1024]) {
    const seen = [];
    const { bytesRead } = forEachRolloutLine(sourcePath, (line) => seen.push(line), { chunkBytes });
    assert.deepEqual(seen, whole, `chunk ${chunkBytes}`);
    assert.equal(bytesRead, fs.statSync(sourcePath).size);
  }
  const firstLineBytes = Buffer.byteLength(`${whole[0]}\n`);
  const limited = [];
  forEachRolloutLine(sourcePath, (line) => limited.push(line), { chunkBytes: 5, limitBytes: firstLineBytes });
  assert.deepEqual(limited, [whole[0]]);
});

test("the streaming copy matches the in-memory result at tiny chunk sizes", () => {
  const { codexHome } = setup({ compacted: true });
  const { plan, scan } = planAndScan({ codexHome });
  const tiny = scanThreadRollout({ plan, chunkBytes: 3 });
  assert.deepEqual(tiny.ids.sort(), scan.ids.sort());
  assert.equal(tiny.lineCount, scan.lineCount);
  const map = buildRewriteMap({ scan, newId: plan.newId, nowMs: NOW, randomBytesImpl: () => Buffer.alloc(10, 4) });
  // The header's context window id is freshly random on every copy; compare everything else.
  const normalized = (text) => text.split("\n").filter(Boolean).map((line, index) => {
    if (index !== 0) return line;
    const header = JSON.parse(line);
    delete header.payload.context_window;
    return JSON.stringify(header);
  });
  copyThreadRollout({ plan, scan, map, nowMs: NOW, chunkBytes: 3 });
  const streamed = normalized(fs.readFileSync(plan.targetPath, "utf8"));
  fs.rmSync(plan.targetPath);
  copyThreadRollout({ plan, scan, map, nowMs: NOW });
  assert.deepEqual(normalized(fs.readFileSync(plan.targetPath, "utf8")), streamed);
  assert.deepEqual(verifyCopiedRollout({ plan, scan, chunkBytes: 3 }).failures, []);
});

test("verify passes on a scrubbed copy and separates content mentions from residue", () => {
  const { codexHome } = setup({ contentMention: true });
  const { plan, scan } = planAndScan({ codexHome });
  copyThreadRollout({ plan, scan, nowMs: NOW });
  const verification = verifyCopiedRollout({ plan, scan });
  assert.deepEqual(verification.failures, []);
  assert.equal(verification.ok, true);
  assert.equal(verification.contentMentions.length, 0, "a UUID inside prose is rewritten, not just reported");
  const text = fs.readFileSync(plan.targetPath, "utf8");
  assert.equal(text.includes(`resume ${plan.newId} later`), true);
});

test("verify fails on identifier residue, surviving blobs, and kept create_time", () => {
  const { codexHome } = setup();
  const { plan, scan } = planAndScan({ codexHome });
  copyThreadRollout({ plan, scan, nowMs: NOW });

  fs.appendFileSync(
    plan.targetPath,
    `${JSON.stringify({ timestamp: "2026-09-18T07:00:01.000Z", ordinal: 99, type: "event_msg", payload: { type: "item_completed", thread_id: THREAD } })}\n`,
  );
  const residue = verifyCopiedRollout({ plan, scan });
  assert.equal(residue.ok, false);
  assert.ok(residue.failures.some((failure) => failure.check === "identifier-residue"));
  assert.ok(residue.failures.some((failure) => failure.check === "ordinals"));

  fs.rmSync(plan.targetPath, { force: true });
  copyThreadRollout({ plan, scan, nowMs: NOW, dropServerBlobs: false });
  const kept = verifyCopiedRollout({ plan, scan, dropServerBlobs: false });
  assert.equal(kept.failures.some((failure) => failure.check === "encrypted-blob"), false);
  assert.ok(kept.blobMentions.length > 0, "kept blob items are reported, not failed");
});

test("a live source is copied as a consistent snapshot and reported", () => {
  const { codexHome, sourcePath } = setup();
  const { plan, scan } = planAndScan({ codexHome });
  const extra = { timestamp: "2026-09-17T10:01:00.000Z", ordinal: 99, type: "response_item", payload: { type: "message", id: "msg_extra01", role: "user", content: [{ type: "input_text", text: "appended later" }] } };
  fs.appendFileSync(sourcePath, `${JSON.stringify(extra)}\n`);
  const copy = copyThreadRollout({ plan, scan, nowMs: NOW });
  assert.equal(copy.sourceGrew, true);
  const text = fs.readFileSync(plan.targetPath, "utf8");
  assert.equal(text.includes("appended later"), false);
});

test("plan refuses lineage segments, subagent sources, and oversized rollouts", () => {
  const { codexHome } = setup();
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
  assert.throws(() => planThreadCopy({ codexHome, sourceId: THREAD, nowMs: NOW, maxCopyMb: 0.000001 }), /above the/);
  assert.throws(() => planThreadCopy({ codexHome, sourceId: "not-a-uuid", nowMs: NOW }), /Not a Codex thread id/);
  assert.throws(() => planThreadCopy({ codexHome, sourceId: OTHER_THREAD, nowMs: NOW }), /No rollout found/);
});

test("readRolloutMeta reads only the header, and the resolver reports a stale state-DB path", () => {
  const { codexHome } = setup();
  const found = resolveRolloutForThreadId({ codexHome, threadId: THREAD });
  assert.equal(found.status, "found");
  assert.equal(found.source, "filename");
  assert.equal(found.meta.historyMode, "paginated");

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
  assert.equal(ensureCodexProfileAnalyticsDisabled({ codexHome }).changed, true);
  assert.match(fs.readFileSync(profilePath, "utf8"), /\[analytics\]\nenabled = false/);
  assert.equal(analyticsDisabledInProfile({ codexHome }), true);
  assert.equal(ensureCodexProfileAnalyticsDisabled({ codexHome }).changed, false);

  fs.writeFileSync(profilePath, "[analytics]\nenabled = true\n", "utf8");
  assert.equal(analyticsDisabledInProfile({ codexHome }), false);
  ensureCodexProfileAnalyticsDisabled({ codexHome });
  assert.equal(analyticsDisabledInProfile({ codexHome }), true);
  assert.equal((fs.readFileSync(profilePath, "utf8").match(/enabled = false/g) ?? []).length, 1);
});

test("carryThreadGoal mints a fresh goal id and skips threads without a goal", () => {
  const { codexHome } = setup();
  fs.writeFileSync(path.join(codexHome, "goals_1.sqlite"), "", "utf8");
  const calls = [];
  const carried = carryThreadGoal({
    codexHome,
    sourceId: THREAD,
    newId: OTHER_THREAD,
    nowMs: NOW,
    spawnSyncImpl: (command, args) => {
      calls.push({ command, args });
      return { status: 0, stdout: "1\n", stderr: "" };
    },
  });
  assert.equal(carried.carried, true);
  assert.equal(isUuidV7(carried.goalId), true);
  assert.match(calls[0].args[1], /insert or replace into thread_goals/);
  assert.match(calls[0].args[1], new RegExp(`where thread_id = '${THREAD}'`));

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
