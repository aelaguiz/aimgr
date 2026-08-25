import test from "node:test";
import assert from "node:assert/strict";
import { AIM_MCP_HTTP_PATH, startHttpServer } from "../../src/mcp/server.js";

const MCP_HEADERS = {
  "Content-Type": "application/json",
  Accept: "application/json, text/event-stream",
};

async function rpc(endpoint, method, params, id = 1) {
  const response = await fetch(endpoint, {
    method: "POST",
    headers: MCP_HEADERS,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, ...(params ? { params } : {}) }),
  });
  return { status: response.status, body: await response.json() };
}

function toolPayload(body) {
  return JSON.parse(body.result.content[0].text);
}

async function withServer(run) {
  const logLines = [];
  // Port 0 keeps the test off 7337 so a live `aim mcp serve` can stay running.
  const served = await startHttpServer({
    port: 0,
    bind: "127.0.0.1",
    logImpl: (line) => logLines.push(line),
  });
  const endpoint = `http://127.0.0.1:${served.port}${AIM_MCP_HTTP_PATH}`;
  try {
    await run({ endpoint, served, logLines });
  } finally {
    await served.close();
  }
}

test("the MCP server initializes and advertises exactly the three Phase 1 tools", async () => {
  await withServer(async ({ endpoint }) => {
    const initialize = await rpc(endpoint, "initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "aimgr-test", version: "1" },
    });
    assert.equal(initialize.status, 200);
    assert.equal(initialize.body.result.serverInfo.name, "aimgr");

    const list = await rpc(endpoint, "tools/list", undefined, 2);
    const tools = list.body.result.tools;
    assert.deepEqual(tools.map((tool) => tool.name).sort(), ["aim_exec", "aim_log_tail", "aim_machine_info"]);
    const exec = tools.find((tool) => tool.name === "aim_exec");
    assert.match(exec.description, /\["status","--json"\]/);
    assert.deepEqual(Object.keys(exec.inputSchema.properties).sort(), ["argv", "timeoutSec"]);
  });
});

test("aim_exec runs a real aim command and returns the raw envelope", async () => {
  await withServer(async ({ endpoint, logLines }) => {
    const call = await rpc(endpoint, "tools/call", {
      name: "aim_exec",
      arguments: { argv: ["help"] },
    }, 3);

    assert.equal(call.status, 200);
    assert.equal(call.body.result.isError, undefined);
    const payload = toolPayload(call.body);
    assert.deepEqual(payload.argv, ["help"]);
    assert.equal(payload.ok, true);
    assert.equal(payload.exitCode, 0);
    assert.equal(payload.truncated, false);
    assert.match(payload.stdout, /aim status \[--json\]/);
    assert.equal(typeof payload.durationMs, "number");
    assert.match(logLines.at(-1), /tool=aim_exec argv="help" ms=\d+ ok=true/);
  });
});

test("aim_exec refuses an interactive lane with the policy reason", async () => {
  await withServer(async ({ endpoint }) => {
    const call = await rpc(endpoint, "tools/call", {
      name: "aim_exec",
      arguments: { argv: ["prime", "run", "codex"] },
    }, 4);

    assert.equal(call.body.result.isError, true);
    const payload = toolPayload(call.body);
    assert.equal(payload.ok, false);
    assert.match(payload.error, /interactive TUI/);
  });
});

test("aim_log_tail reports a missing log as a fact through the tool envelope", async () => {
  await withServer(async ({ endpoint }) => {
    const call = await rpc(endpoint, "tools/call", {
      name: "aim_log_tail",
      arguments: { name: "mcp-serve", lines: 5 },
    }, 5);

    const payload = toolPayload(call.body);
    assert.equal(payload.name, "mcp-serve");
    assert.equal(payload.lines, 5);
    assert.deepEqual(payload.files.map((file) => file.stream), ["out", "err"]);

    const rejected = await rpc(endpoint, "tools/call", {
      name: "aim_log_tail",
      arguments: { path: "relative.log" },
    }, 6);
    assert.equal(rejected.body.result.isError, true);
    assert.match(toolPayload(rejected.body).error, /path must be absolute/);
  });
});

test("only POST /mcp is served", async () => {
  await withServer(async ({ endpoint, served }) => {
    const get = await fetch(endpoint);
    assert.equal(get.status, 405);
    assert.match((await get.json()).error.message, /Method not allowed/);

    const del = await fetch(endpoint, { method: "DELETE" });
    assert.equal(del.status, 405);

    const missing = await fetch(`http://127.0.0.1:${served.port}/other`, { method: "POST", headers: MCP_HEADERS, body: "{}" });
    assert.equal(missing.status, 404);
    assert.match((await missing.json()).error.message, /The MCP endpoint is \/mcp/);
  });
});
