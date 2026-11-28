import { createInterface } from "node:readline";
import { isObject } from "../core/normalize.js";

const requestTimeoutMs = 30_000;
const promptTimeoutMs = 15 * 60_000;

class AcpError extends Error {}

const cancelledPermission = { outcome: { outcome: "cancelled" } };

function terminalText(text) {
  return text.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

function toolTitle(toolCall) {
  const title = typeof toolCall?.title === "string" ? terminalText(toolCall.title).replace(/\s+/g, " ").trim() : "";
  return title.slice(0, 500) || "Antigravity tool";
}

function startTerminal({ input, output, label, sessionId, cwd, submit, cancel, selectModel }) {
  const terminal = createInterface({ input, output, prompt: "agy> " });
  const permissions = [];
  let active;
  let cancelling = false;
  let closed = false;

  function showPermission() {
    const next = permissions[0];
    if (next) output.write(next.title + "\nAllow once? [y/N] ");
  }

  function clearPermissions() {
    for (const { reply } of permissions.splice(0)) reply(cancelledPermission);
  }

  function cancelTurn() {
    if (active !== "prompt" || cancelling) return;
    cancelling = true;
    clearPermissions();
    cancel();
  }

  const done = new Promise(resolve => {
    terminal.once("close", () => {
      closed = true;
      cancelTurn();
      resolve();
    });
  });
  terminal.on("SIGINT", () => {
    if (active === "prompt" && !cancelling) cancelTurn();
    else terminal.close();
  });
  terminal.on("line", line => {
    const text = terminalText(line);
    const value = text.trim();
    if (value === "/exit" || value === "/quit") {
      terminal.close();
      return;
    }
    if (permissions.length) {
      const answer = value.toLowerCase();
      if (["y", "yes", "n", "no", ""].includes(answer)) {
        const { allow, deny, reply } = permissions.shift();
        const selection = answer.startsWith("y") ? allow : deny;
        reply(selection ? { outcome: { outcome: "selected", optionId: selection } } : cancelledPermission);
      }
      showPermission();
      return;
    }
    if (active) {
      if (value) output.write("Antigravity is still working. Wait for the prompt or press Ctrl+C.\n");
      return;
    }
    const model = /^\/model(?:\s+(.*))?$/.exec(value);
    // ACP can dispatch slash prompts as commands. Only expose the local
    // terminal controls so the provider session cannot change authentication.
    if (!value || (!model && value.startsWith("/"))) {
      if (value) output.write("Enter a message, use /model for available models, or use /exit to quit.\n");
      terminal.prompt();
      return;
    }
    active = model ? "model" : "prompt";
    const result = model ? selectModel(model[1]) : submit(text);
    result.catch(error => {
      if (!closed) output.write(error instanceof AcpError ? error.message + "\n" : "Antigravity could not finish this turn.\n");
    }).finally(() => {
      clearPermissions();
      active = undefined;
      cancelling = false;
      if (!closed) terminal.prompt();
    });
  });

  output.write("Antigravity (" + label + ") in " + terminalText(cwd) + "\n");
  output.write("Conversation " + terminalText(sessionId) + ". /model lists models. Ctrl+C cancels a turn. /exit closes the chat.\n");
  terminal.prompt();
  return {
    done,
    close: () => terminal.close(),
    permission(params, reply) {
      if (closed || active !== "prompt" || cancelling || params?.sessionId !== sessionId || !Array.isArray(params.options)) {
        reply(cancelledPermission);
        return;
      }
      const { allow_once: allow, reject_once: deny } = Object.fromEntries(params.options
        .filter(option => typeof option?.optionId === "string" && ["allow_once", "reject_once"].includes(option.kind))
        .map(option => [option.kind, option.optionId]));
      if (!allow) {
        reply(cancelledPermission);
        return;
      }
      permissions.push({ allow, deny, reply, title: toolTitle(params.toolCall) });
      if (permissions.length === 1) showPermission();
    },
  };
}

export async function runAgyAcp(child, {
  operation, label, sessionId, cwd, args = [], stdin = process.stdin,
  stdout = process.stdout, stderr = process.stderr, signalChild = signal => child.kill(signal),
}) {
  const interactive = operation === "interactive" || (operation === "resume" && args.length === 0);
  let pending;
  let failure;
  let nextId = 1;
  let lastOutputCharacter;
  let terminal;
  let configOptions;
  let closed = false;
  let completed = false;

  function settle(error, result) {
    if (!pending) return;
    const { timer, resolve, reject } = pending;
    pending = undefined;
    clearTimeout(timer);
    if (error) reject(error);
    else resolve(result);
  }

  function fail(message) {
    failure ??= new AcpError(message);
    settle(failure);
    terminal?.close();
  }

  const disconnected = () => fail("Antigravity closed its session protocol before replying.");
  const malformed = () => fail("Antigravity sent an invalid session protocol message.");
  const closedPromise = new Promise(resolve => {
    child.once("close", () => {
      closed = true;
      disconnected();
      resolve();
    });
  });
  child.once("error", disconnected);
  child.stdin.on("error", disconnected);
  child.stderr.on("error", disconnected);
  // The native process can write authentication details to stderr. Drain it
  // without copying any of that output into AIM's result.
  child.stderr.resume();
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity });
  lines.on("error", disconnected);
  lines.on("close", disconnected);

  function send(payload) {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...payload })}\n`);
  }

  function finishOutput() {
    if (lastOutputCharacter && lastOutputCharacter !== "\n") stdout.write("\n");
    lastOutputCharacter = undefined;
  }

  lines.on("line", line => {
    if (failure || !line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      malformed();
      return;
    }
    if (!isObject(message) || message.jsonrpc !== "2.0") {
      malformed();
      return;
    }
    if (typeof message.method === "string") {
      if (Object.hasOwn(message, "id")) {
        if (message.method === "session/request_permission") {
          const reply = result => { if (!failure) send({ id: message.id, result }); };
          if (terminal) {
            finishOutput();
            terminal.permission(message.params, reply);
          } else reply(cancelledPermission);
        } else {
          send({ id: message.id, error: { code: -32601, message: "Method not supported" } });
        }
      } else if (message.method === "session/update") {
        const { sessionId: updateId, update } = message.params ?? {};
        if (updateId !== sessionId) return;
        if (interactive && update?.sessionUpdate === "config_option_update" && Array.isArray(update.configOptions)) {
          configOptions = update.configOptions;
        }
        if (pending?.method !== "session/prompt") return;
        const content = update?.content;
        if (update?.sessionUpdate === "agent_message_chunk" && content?.type === "text" && typeof content.text === "string") {
          const text = interactive ? terminalText(content.text) : content.text;
          if (!text) return;
          stdout.write(text);
          lastOutputCharacter = text.at(-1);
        } else if (interactive && update?.sessionUpdate === "tool_call") {
          finishOutput();
          stderr.write("Tool: " + toolTitle(update) + "\n");
        }
      }
      return;
    }
    if (!pending || message.id !== pending.id) return;
    if (Object.hasOwn(message, "error")) {
      const error = interactive && message.error?.code === -32000
        ? "Antigravity requires a current Google sign-in for this connection."
        : `Antigravity rejected ${pending.method}.`;
      settle(new AcpError(error));
    } else if (!isObject(message.result)) {
      malformed();
    } else {
      settle(undefined, message.result);
    }
  });

  function request(method, params, timeout = requestTimeoutMs) {
    if (failure) return Promise.reject(failure);
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(() => fail(`Antigravity timed out during ${method}.`), timeout);
      pending = { id, method, timer, resolve, reject };
      send({ id, method, params });
    });
  }

  async function prompt(text) {
    try {
      const result = await request("session/prompt", { sessionId, prompt: [{ type: "text", text }] }, promptTimeoutMs);
      if (result.stopReason !== "end_turn" && !(interactive && result.stopReason === "cancelled")) {
        throw new AcpError("Antigravity stopped before completing the prompt.");
      }
    } finally {
      if (interactive) finishOutput();
    }
  }

  async function selectModel(value) {
    const config = configOptions?.find(option => option?.id === "model" && option.type === "select");
    const options = Array.isArray(config?.options) ? config.options : [];
    const models = options.flatMap(option => Array.isArray(option?.options) ? option.options : [option])
      .filter(option => typeof option?.value === "string" && typeof option.name === "string");
    if (!models.length) throw new AcpError("Antigravity did not offer model selection for this session.");
    if (!value) {
      for (const model of models) {
        stderr.write("  " + terminalText(model.name) + " [" + terminalText(model.value) + "]"
          + (model.value === config.currentValue ? " (current)" : "") + "\n");
      }
      stderr.write("Enter /model followed by the model name or ID.\n");
      return;
    }
    const selected = models.find(model => model.value === value || model.name.toLowerCase() === value.toLowerCase());
    if (!selected) throw new AcpError("Antigravity did not list that model. Use /model to see the available models.");
    const result = await request("session/set_config_option", { sessionId, configId: config.id, value: selected.value });
    if (!Array.isArray(result.configOptions) || !result.configOptions.some(option => (
      option?.id === config.id && option.currentValue === selected.value
    ))) throw new AcpError("Antigravity did not confirm the requested model.");
    configOptions = result.configOptions;
    stderr.write("Model: " + terminalText(selected.name) + "\n");
  }

  async function listsRequestedSession() {
    const deadline = Date.now() + requestTimeoutMs;
    const cursors = new Set();
    let cursor;
    for (;;) {
      const timeout = deadline - Date.now();
      if (timeout <= 0) throw new AcpError("Antigravity timed out listing this workspace's sessions.");
      const { sessions, nextCursor } = await request("session/list", { cwd, cursor }, timeout);
      if (!Array.isArray(sessions)) throw new AcpError("Antigravity returned an invalid session list.");
      if (sessions.some(entry => entry?.sessionId === sessionId && entry.cwd === cwd)) return true;
      if (nextCursor == null) return false;
      if (typeof nextCursor !== "string" || !nextCursor || cursors.has(nextCursor)) {
        throw new AcpError("Antigravity returned an invalid session list cursor.");
      }
      cursors.add(nextCursor);
      cursor = nextCursor;
    }
  }

  try {
    if (!interactive && operation !== "resume" && operation !== "logout") throw new AcpError("Unsupported Antigravity operation.");
    const printPrefix = "--print=";
    const [printArg] = args;
    if (operation === "resume") {
      if (typeof sessionId !== "string" || !sessionId || typeof cwd !== "string" || !cwd) {
        throw new AcpError("Antigravity resume requires a session ID and working directory.");
      }
      if (!interactive && (args.length !== 1 || !printArg.startsWith(printPrefix) || printArg.length === printPrefix.length)) {
        throw new AcpError("Antigravity resume requires one --print prompt.");
      }
    }
    const initialized = await request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    if (initialized.protocolVersion !== 1) throw new AcpError("Antigravity did not negotiate session protocol version 1.");
    if (operation === "logout") {
      if (!isObject(initialized.agentCapabilities?.auth?.logout)) throw new AcpError("Antigravity does not offer native logout.");
      const result = await request("logout", {});
      if (Object.keys(result).length) throw new AcpError("Antigravity did not confirm native logout.");
    } else if (operation === "resume") {
      if (!isObject(initialized.agentCapabilities?.sessionCapabilities?.resume)) {
        throw new AcpError("Antigravity does not offer native session resume.");
      }
      if (!await listsRequestedSession()) {
        throw new AcpError("Antigravity could not find the session in this account and working directory.");
      }
      const resumed = await request("session/resume", { sessionId, cwd, mcpServers: [] });
      if (resumed.sessionId !== sessionId) throw new AcpError("Antigravity did not confirm the requested session.");
      if (Array.isArray(resumed.configOptions)) configOptions = resumed.configOptions;
      if (!interactive) await prompt(printArg.slice(printPrefix.length));
    } else {
      const created = await request("session/new", { cwd, mcpServers: [] });
      sessionId = created.sessionId;
      if (typeof sessionId !== "string" || !sessionId) throw new AcpError("Antigravity did not create a session.");
      if (Array.isArray(created.configOptions)) configOptions = created.configOptions;
    }
    if (interactive) {
      terminal = startTerminal({ input: stdin, output: stderr, label, sessionId, cwd, submit: prompt, selectModel,
        cancel: () => { if (!failure) send({ method: "session/cancel", params: { sessionId } }); } });
      await terminal.done;
      if (failure) throw failure;
    }
    completed = true;
    return { exitCode: 0 };
  } catch (error) {
    stderr.write(`${error instanceof AcpError ? error.message : "Antigravity session protocol failed."}\n`);
    return { exitCode: 1 };
  } finally {
    finishOutput();
    terminal?.close();
    lines.close();
    settle(new AcpError("Antigravity session closed."));
    child.stdin.end();
    if (!closed) {
      if (!completed) signalChild("SIGTERM");
      let forceExit;
      await Promise.race([closedPromise, new Promise(resolve => {
        forceExit = setTimeout(() => {
          signalChild("SIGKILL");
          resolve();
        }, 1000);
      })]);
      clearTimeout(forceExit);
    }
    child.stdin.destroy();
    child.stdout.destroy();
    child.stderr.destroy();
  }
}
