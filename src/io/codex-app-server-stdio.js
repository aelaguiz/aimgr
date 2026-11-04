import { createInterface } from "node:readline";
import { prepareCodexSettingsRequest, settleCodexSettingsRequest } from "./codex-settings-intents.js";

const idKey = id => JSON.stringify([typeof id, id]);
function send(stream, line, signal) {
  return new Promise((resolve, reject) => {
    const closed = () => finish(Object.assign(new Error("Codex stdio destination closed."), { code: "ERR_STREAM_PREMATURE_CLOSE" }));
    const finish = error => {
      stream.removeListener("error", finish); stream.removeListener("close", closed);
      signal.removeEventListener("abort", closed);
      error ? reject(error) : resolve();
    };
    if (stream.destroyed || stream.writableEnded || signal.aborted) return closed();
    stream.once("error", finish); stream.once("close", closed);
    signal.addEventListener("abort", closed, { once: true });
    try { stream.write(line + "\n", finish); } catch (error) { finish(error); }
  });
}
function decode(line) { try { return JSON.parse(line); } catch { return null; } }

/** Invocation-owned JSONL forwarding. No listener, synthetic responses,
 * additional RPCs or replay. Unrelated protocol messages pass unchanged. */
export function superviseCodexAppServerStdio({ input, output, child, entry, flush, onError = () => {} }) {
  const pending = new Map();
  const unresolved = [];
  const shutdown = new AbortController();
  const requests = createInterface({ input, crlfDelay: Infinity });
  const responses = createInterface({ input: child.stdout, crlfDelay: Infinity });
  let closed = false;
  const inputTask = (async () => {
    try {
      for await (const line of requests) {
        const original = decode(line);
        const prepared = prepareCodexSettingsRequest(original, entry);
        if (prepared.intent) {
          const key = idKey(original.id), queue = pending.get(key) ?? [];
          queue.push(prepared.intent); pending.set(key, queue);
        }
        await send(child.stdin, prepared.request !== original ? JSON.stringify(prepared.request) : line, shutdown.signal);
      }
    } finally { child.stdin.end(); }
  })();
  const outputTask = (async () => {
    try {
      for await (const line of responses) {
        const response = decode(line);
        if (response && !response.method && Object.hasOwn(response, "id")) {
          const key = idKey(response.id), queue = pending.get(key);
          if (queue?.length) {
            const intent = queue.shift(); if (!queue.length) pending.delete(key);
            try {
              settleCodexSettingsRequest(intent, response);
            } catch (error) { unresolved.push(intent); onError(error); }
            try { await flush(); } catch (error) { onError(error); }
          }
        }
        await send(output, line, shutdown.signal);
      }
    } finally { shutdown.abort(); requests.close(); }
  })();
  const finished = Promise.allSettled([inputTask, outputTask]).then(async results => {
    for (const intent of [...unresolved, ...[...pending.values()].flat()]) {
      try { settleCodexSettingsRequest(intent); } catch (error) { onError(error); }
    }
    pending.clear();
    for (const result of results) if (result.status === "rejected" && !["EPIPE", "ERR_STREAM_PREMATURE_CLOSE"].includes(result.reason?.code)) onError(result.reason);
    await flush();
  });
  finished.catch(onError); // Report now; close() still observes the same failure.
  // Handle child-stdin EPIPE before a backpressured write has installed drain.
  const stdinError = error => { if (error.code !== "EPIPE") onError(error); requests.close(); };
  const outputError = error => { if (error.code !== "EPIPE") onError(error); shutdown.abort(); requests.close(); responses.close(); };
  child.stdin.on("error", stdinError);
  output.on("error", outputError);
  return { finished, async close() {
    if (closed) return; closed = true;
    shutdown.abort();
    requests.close(); responses.close();
    await finished;
    child.stdin.removeListener("error", stdinError);
    output.removeListener("error", outputError);
  } };
}
