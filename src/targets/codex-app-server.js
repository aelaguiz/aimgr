import { spawn } from "node:child_process";

function normalizeResultData(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.threads)) return result.threads;
  return [];
}

export function requestCodexAppServer(
  {
    codexBin = "codex",
    codexHome,
    env = {},
    method,
    params,
    timeoutMs = 8_000,
  },
  {
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  const requestMethod = String(method ?? "").trim();
  if (!requestMethod) {
    throw new Error("Missing Codex app-server method.");
  }

  return new Promise((resolve, reject) => {
    const childEnv = {
      ...process.env,
      ...env,
      ...(codexHome ? { CODEX_HOME: codexHome } : {}),
    };
    const child = spawnImpl(
      codexBin,
      ["app-server", "--listen", "stdio://", "--enable", "goals"],
      {
        env: childEnv,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let settled = false;
    let buffer = "";
    let stderr = "";
    let nextId = 0;
    const pending = new Map();

    const cleanup = () => {
      clearTimeoutImpl(timer);
      if (!child.killed && typeof child.kill === "function") {
        child.kill();
      }
    };

    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };

    const sendRequest = (requestMethod, requestParams) => {
      const id = ++nextId;
      const request = {
        jsonrpc: "2.0",
        id,
        method: requestMethod,
        ...(requestParams === undefined ? {} : { params: requestParams }),
      };
      return new Promise((requestResolve, requestReject) => {
        pending.set(id, { resolve: requestResolve, reject: requestReject });
        child.stdin.write(`${JSON.stringify(request)}\n`);
      });
    };

    const sendNotification = (notificationMethod, notificationParams) => {
      const notification = {
        jsonrpc: "2.0",
        method: notificationMethod,
        ...(notificationParams === undefined ? {} : { params: notificationParams }),
      };
      child.stdin.write(`${JSON.stringify(notification)}\n`);
    };

    const failPending = (err) => {
      for (const waiter of pending.values()) {
        waiter.reject(err);
      }
      pending.clear();
    };

    const timer = setTimeoutImpl(() => {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      const err = new Error(`Timed out waiting for Codex app-server ${requestMethod}${detail}`);
      failPending(err);
      settle(reject, err);
    }, timeoutMs);

    child.stderr?.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
      if (stderr.length > 20_000) {
        stderr = stderr.slice(stderr.length - 20_000);
      }
    });

    child.on?.("error", (err) => {
      failPending(err);
      settle(reject, err);
    });

    child.on?.("close", (code) => {
      if (settled) return;
      const err = new Error(
        `Codex app-server exited before ${requestMethod} completed with code ${code ?? 1}`,
      );
      failPending(err);
      settle(reject, err);
    });

    child.stdout.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newlineIndex).trim();
        buffer = buffer.slice(newlineIndex + 1);
        if (!line) continue;
        let message;
        try {
          message = JSON.parse(line);
        } catch {
          continue;
        }
        if (!message.id || !pending.has(message.id)) {
          continue;
        }
        const waiter = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          waiter.reject(new Error(String(message.error?.message ?? JSON.stringify(message.error))));
        } else {
          waiter.resolve(message.result);
        }
      }
    });

    (async () => {
      const init = await sendRequest("initialize", {
        clientInfo: {
          name: "aimgr_codex_tender",
          title: "AIMGR Codex Tender",
          version: "0.0.0",
        },
        capabilities: { experimentalApi: true },
      });
      if (!init) {
        throw new Error("Codex app-server initialize returned no result.");
      }
      sendNotification("initialized");
      const result = await sendRequest(requestMethod, params);
      settle(resolve, result);
    })().catch((err) => {
      failPending(err);
      settle(reject, err);
    });
  });
}

export async function listCodexThreads(options, deps) {
  const result = await requestCodexAppServer(
    {
      ...options,
      method: "thread/list",
      params: { limit: options?.limit ?? 20 },
    },
    deps,
  );
  return normalizeResultData(result);
}

export async function getCodexThreadGoal({ threadId, ...options }, deps) {
  const result = await requestCodexAppServer(
    {
      ...options,
      method: "thread/goal/get",
      params: { threadId },
    },
    deps,
  );
  return result?.goal ?? null;
}
