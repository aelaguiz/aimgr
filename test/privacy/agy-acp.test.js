import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import test from "node:test";
import { runAgyAcp } from "../../src/privacy/agy-acp.js";

const cwd = "/admitted/workspace";
const sessionId = "verified-session";
const prompt = "Follow up in this session\nwith a second line.";
const initialize = {
  protocolVersion: 1,
  agentCapabilities: { sessionCapabilities: { resume: {} }, auth: { logout: {} } },
  authMethods: [{ id: "fixture-private-auth-method" }],
};

function mockAgy(responses) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
  });
  const requests = [];
  const killed = [];
  const input = createInterface({ input: child.stdin });
  const close = () => {
    child.stdout.end();
    child.stderr.end();
    child.emit("close");
  };
  input.once("close", close);
  child.kill = signal => killed.push(signal ?? "SIGTERM");
  const send = message => child.stdout.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  input.on("line", line => {
    const message = JSON.parse(line);
    requests.push(message);
    const response = responses[message.method ?? "clientReply"];
    if (typeof response === "function") response({ message, send, close, child });
    else if (message.method) send({ id: message.id, ...(response ?? { error: { code: -32601, message: "unexpected method" } }) });
  });
  let output = "";
  let error = "";
  const run = options => runAgyAcp(child, {
    operation: "resume", sessionId, cwd, args: [`--print=${prompt}`],
    stdout: { write: chunk => { output += chunk; } },
    stderr: { write: chunk => { error += chunk; } },
    ...options,
  });
  return { run, requests, killed, output: () => output, error: () => error };
}

function update(id, text) {
  return {
    method: "session/update",
    params: { sessionId: id, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } },
  };
}

test("resumes an exact listed session and emits only its new assistant text", async () => {
  const agent = mockAgy({
    initialize: { result: initialize },
    "session/list": { result: { sessions: [{ sessionId, cwd }] } },
    "session/resume": ({ message, send, child }) => {
      child.stderr.write("fixture-private-native-diagnostic\n");
      send(update(sessionId, "History must stay out of stdout."));
      send({ id: message.id, result: { sessionId } });
    },
    "session/prompt": ({ message, send }) => {
      send(update("other-session", "Other session must stay out of stdout."));
      send(update(sessionId, "Session "));
      send({ id: "permission", method: "session/request_permission", params: { sessionId } });
      send(update(sessionId, "continued."));
      send({ id: message.id, result: { stopReason: "end_turn" } });
    },
  });
  assert.deepEqual(await agent.run(), { exitCode: 0 });
  assert.deepEqual(agent.requests.map(({ method, params }) => ({ method, params })).filter(({ method }) => method), [
    { method: "initialize", params: { protocolVersion: 1, clientCapabilities: {} } },
    { method: "session/list", params: { cwd } },
    { method: "session/resume", params: { sessionId, cwd, mcpServers: [] } },
    { method: "session/prompt", params: { sessionId, prompt: [{ type: "text", text: prompt }] } },
  ]);
  assert.deepEqual(agent.requests.find(({ id }) => id === "permission"), {
    jsonrpc: "2.0", id: "permission", result: { outcome: { outcome: "cancelled" } },
  });
  assert.equal(agent.output(), "Session continued.\n");
  assert.equal(agent.error(), "");
  assert.deepEqual(agent.killed, []);
});

test("does not resume or prompt when the selected account and cwd do not list the ID", async () => {
  const agent = mockAgy({
    initialize: { result: initialize },
    "session/list": { result: { sessions: [{ sessionId, cwd: "/other/workspace" }, { sessionId: "other-session", cwd }] } },
  });
  assert.deepEqual(await agent.run(), { exitCode: 1 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize", "session/list"]);
  assert.equal(agent.output(), "");
  assert.match(agent.error(), /could not find the session/);
});

test("matches a later page without changing the workspace and rejects cursor cycles", async () => {
  for (const repeated of [false, true]) {
    const agent = mockAgy({
      initialize: { result: initialize },
      "session/list": ({ message, send }) => {
        assert.equal(message.params.cwd, cwd);
        const secondPage = message.params.cursor === "next-page";
        const result = secondPage && !repeated
          ? { sessions: [{ sessionId, cwd }] }
          : { sessions: [], nextCursor: "next-page" };
        send({ id: message.id, result });
      },
      "session/resume": { result: { sessionId } },
      "session/prompt": { result: { stopReason: "end_turn" } },
    });
    assert.deepEqual(await agent.run(), { exitCode: Number(repeated) });
    assert.deepEqual(agent.requests.map(({ method }) => method), repeated
      ? ["initialize", "session/list", "session/list"]
      : ["initialize", "session/list", "session/list", "session/resume", "session/prompt"]);
  }
});

test("does not prompt after a rejected resume or a wrong or missing returned session ID", async () => {
  for (const response of [
    { error: { code: -32603, message: "fixture-private-provider-error" } },
    { result: { sessionId: "other-session" } },
    { result: {} },
  ]) {
    const agent = mockAgy({
      initialize: { result: initialize },
      "session/list": { result: { sessions: [{ sessionId, cwd }] } },
      "session/resume": response,
    });
    assert.deepEqual(await agent.run(), { exitCode: 1 });
    assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize", "session/list", "session/resume"]);
    assert.equal(agent.output(), "");
    assert.doesNotMatch(agent.error(), /fixture-private/);
  }
});

test("uses the native logout request and accepts the pinned empty response", async () => {
  const agent = mockAgy({ initialize: { result: initialize }, logout: { result: {} } });
  assert.deepEqual(await agent.run({ operation: "logout" }), { exitCode: 0 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize", "logout"]);
  assert.deepEqual(agent.requests.at(-1).params, {});
  assert.equal(agent.output(), "");
  assert.equal(agent.error(), "");
});

test("fails an unconfirmed logout without printing native response details", async () => {
  const agent = mockAgy({ initialize: { result: initialize }, logout: { result: { result: "fixture-private-provider-result" } } });
  assert.deepEqual(await agent.run({ operation: "logout" }), { exitCode: 1 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize", "logout"]);
  assert.equal(agent.output(), "");
  assert.match(agent.error(), /did not confirm native logout/);
  assert.doesNotMatch(agent.error(), /fixture-private/);
});

test("fails logout when Antigravity does not advertise the native operation", async () => {
  const agent = mockAgy({ initialize: { result: { protocolVersion: 1, agentCapabilities: {} } } });
  assert.deepEqual(await agent.run({ operation: "logout" }), { exitCode: 1 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize"]);
  assert.equal(agent.output(), "");
  assert.match(agent.error(), /does not offer native logout/);
});

test("returns promptly when the native process exits before replying", async () => {
  const agent = mockAgy({ initialize: ({ close }) => close() });
  assert.deepEqual(await agent.run({ operation: "logout" }), { exitCode: 1 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize"]);
  assert.match(agent.error(), /closed its session protocol/);
});

test("opens a native session, lists and selects an offered model, and runs successive turns", async () => {
  const input = new PassThrough();
  const model = {
    id: "model", category: "model", type: "select", currentValue: "flash",
    options: [{ group: "gemini", options: [{ value: "flash", name: "Gemini Flash" }, { value: "pro", name: "Gemini Pro" }] }],
  };
  const agent = mockAgy({
    initialize: { result: initialize },
    "session/new": { result: { sessionId, configOptions: [model] } },
    "session/set_config_option": { result: { configOptions: [{ ...model, currentValue: "pro" }] } },
    "session/prompt": ({ message, send }) => {
      send(update("other-session", "private update from the wrong session"));
      send(update(sessionId, "Response to " + message.params.prompt[0].text));
      send({ id: message.id, result: { stopReason: "end_turn" } });
    },
  });
  const lines = ["/model", "/model Gemini Pro", " /logout", "/login", "one", "two", "/exit"];
  let terminal = "";
  assert.deepEqual(await agent.run({
    operation: "interactive", label: "fixture", args: [], stdin: input,
    stderr: { write(chunk) {
      terminal += chunk;
      if (chunk === "agy> ") setImmediate(() => input.write(lines.shift() + "\n"));
    } },
  }), { exitCode: 0 });
  assert.equal(agent.output(), "Response to one\nResponse to two\n");
  assert.match(terminal, /Antigravity \(fixture\) in \/admitted\/workspace/);
  assert.match(terminal, /Gemini Flash \[flash\] \(current\)/);
  assert.match(terminal, /Model: Gemini Pro/);
  assert.deepEqual(agent.requests.map(({ method }) => method),
    ["initialize", "session/new", "session/set_config_option", "session/prompt", "session/prompt"]);
  assert.deepEqual(agent.requests[1].params, { cwd, mcpServers: [] });
  assert.deepEqual(agent.requests[2].params, { sessionId, configId: "model", value: "pro" });
  assert.ok(agent.requests.slice(2).every(request => request.params.sessionId === sessionId));
});

test("interactive tools require a scoped operator choice and cannot use ambient client capabilities", async () => {
  const input = new PassThrough();
  const options = [
    { kind: "allow_always", optionId: "unsafe-default" },
    { kind: "allow_once", optionId: "allow" },
    { kind: "reject_once", optionId: "deny" },
  ];
  let promptId;
  const agent = mockAgy({
    initialize: { result: initialize },
    "session/new": { result: { sessionId } },
    "session/prompt": ({ message, send }) => {
      promptId = message.id;
      send({ id: "host-fs", method: "fs/read_text_file", params: { path: "/private" } });
      send({ id: "unrelated", method: "session/request_permission", params: { sessionId: "another-session", options } });
      send({ id: "tool", method: "session/request_permission", params: {
        sessionId, options, toolCall: { title: "\u001b[1mRead example.txt" },
      } });
    },
    clientReply: ({ message, send }) => {
      if (message.id === "tool") send({ id: promptId, result: { stopReason: "end_turn" } });
    },
  });
  let terminal = "";
  let next = "Read example.txt";
  assert.deepEqual(await agent.run({
    operation: "interactive", label: "fixture", args: [], stdin: input,
    stderr: { write(chunk) {
      terminal += chunk;
      if (chunk === "agy> ") {
        const line = next;
        next = "/exit";
        setImmediate(() => input.write(line + "\n"));
      }
      if (chunk.endsWith("Allow once? [y/N] ")) setImmediate(() => input.write("y\n"));
    } },
  }), { exitCode: 0 });
  assert.doesNotMatch(terminal, /\u001b/);
  assert.match(terminal, /Read example.txt\nAllow once/);
  const replies = agent.requests.filter(request => !request.method);
  assert.deepEqual(replies.map(({ id, result, error }) => [id, result?.outcome, error?.code]), [
    ["host-fs", undefined, -32601],
    ["unrelated", { outcome: "cancelled" }, undefined],
    ["tool", { outcome: "selected", optionId: "allow" }, undefined],
  ]);
});

test("a signed-out ACP server cannot ask the chat to authenticate", async () => {
  const agent = mockAgy({
    initialize: { result: initialize },
    "session/new": { error: { code: -32000, message: "private-native-login-info" } },
  });
  assert.deepEqual(await agent.run({ operation: "interactive", label: "fixture", args: [] }), { exitCode: 1 });
  assert.deepEqual(agent.requests.map(({ method }) => method), ["initialize", "session/new"]);
  assert.match(agent.error(), /requires a current Google sign-in/);
  assert.doesNotMatch(agent.error(), /private/);
});
