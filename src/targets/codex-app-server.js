import { spawn } from "node:child_process";
import net from "node:net";

function normalizeResultData(result) {
  if (Array.isArray(result?.data)) return result.data;
  if (Array.isArray(result?.threads)) return result.threads;
  return [];
}

function delay(ms, { setTimeoutImpl = setTimeout } = {}) {
  return new Promise((resolve) => setTimeoutImpl(resolve, ms));
}

function connectError(err) {
  return err instanceof Error ? err : new Error(String(err));
}

function appendStderr(stderr, chunk) {
  const next = `${stderr}${chunk.toString("utf8")}`;
  return next.length > 20_000 ? next.slice(next.length - 20_000) : next;
}

export function findAvailableTcpPort({ host = "127.0.0.1" } = {}) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref?.();
    server.on("error", reject);
    server.listen(0, host, () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : null;
      server.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        if (!port) {
          reject(new Error("Could not allocate a private Codex app-server port."));
          return;
        }
        resolve(port);
      });
    });
  });
}

export function createCodexAppServerWsClient(
  {
    remoteUrl,
    timeoutMs = 8_000,
    clientName = "aimgr_codex_tender",
    clientTitle = "AIMGR Codex Tender",
    clientVersion = "0.0.0",
  },
  {
    WebSocketImpl = globalThis.WebSocket,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
  } = {},
) {
  if (!WebSocketImpl) {
    throw new Error("WebSocket is not available in this Node runtime.");
  }
  const url = String(remoteUrl ?? "").trim();
  if (!url) {
    throw new Error("Missing Codex app-server remote URL.");
  }

  const ws = new WebSocketImpl(url);
  let opened = false;
  let closed = false;
  let initialized = false;
  let nextId = 0;
  const pending = new Map();

  const failPending = (err) => {
    for (const waiter of pending.values()) {
      clearTimeoutImpl(waiter.timer);
      waiter.reject(err);
    }
    pending.clear();
  };

  const waitForOpen = new Promise((resolve, reject) => {
    const timer = setTimeoutImpl(() => {
      reject(new Error(`Timed out connecting to Codex app-server at ${url}`));
    }, timeoutMs);

    ws.addEventListener("open", () => {
      opened = true;
      clearTimeoutImpl(timer);
      resolve();
    }, { once: true });

    ws.addEventListener("error", (event) => {
      clearTimeoutImpl(timer);
      reject(connectError(event?.error ?? `Failed to connect to Codex app-server at ${url}`));
    }, { once: true });
  });

  ws.addEventListener("message", (event) => {
    let message;
    try {
      message = JSON.parse(String(event.data ?? ""));
    } catch {
      return;
    }
    if (!message.id || !pending.has(message.id)) {
      return;
    }
    const waiter = pending.get(message.id);
    pending.delete(message.id);
    clearTimeoutImpl(waiter.timer);
    if (message.error) {
      waiter.reject(new Error(String(message.error?.message ?? JSON.stringify(message.error))));
      return;
    }
    waiter.resolve(message.result);
  });

  ws.addEventListener("close", () => {
    closed = true;
    failPending(new Error(`Codex app-server websocket closed: ${url}`));
  });

  const sendRequest = async (method, params) => {
    await waitForOpen;
    if (closed) {
      throw new Error(`Codex app-server websocket is closed: ${url}`);
    }
    const id = ++nextId;
    const request = {
      jsonrpc: "2.0",
      id,
      method,
      ...(params === undefined ? {} : { params }),
    };
    return new Promise((resolve, reject) => {
      const timer = setTimeoutImpl(() => {
        pending.delete(id);
        reject(new Error(`Timed out waiting for Codex app-server ${method}`));
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(request));
    });
  };

  const sendNotification = async (method, params) => {
    await waitForOpen;
    if (closed) {
      throw new Error(`Codex app-server websocket is closed: ${url}`);
    }
    const notification = {
      jsonrpc: "2.0",
      method,
      ...(params === undefined ? {} : { params }),
    };
    ws.send(JSON.stringify(notification));
  };

  const initialize = async () => {
    if (initialized) return;
    const init = await sendRequest("initialize", {
      clientInfo: {
        name: clientName,
        title: clientTitle,
        version: clientVersion,
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false,
      },
    });
    if (!init) {
      throw new Error("Codex app-server initialize returned no result.");
    }
    await sendNotification("initialized");
    initialized = true;
  };

  return {
    remoteUrl: url,
    async request(method, params) {
      await initialize();
      return sendRequest(method, params);
    },
    async listLoadedThreads({ limit = 20 } = {}) {
      const result = await this.request("thread/loaded/list", { limit });
      return normalizeResultData(result);
    },
    async readThread({ threadId }) {
      const result = await this.request("thread/read", { threadId, includeTurns: false });
      return result?.thread ?? null;
    },
    async getThreadGoal({ threadId }) {
      const result = await this.request("thread/goal/get", { threadId });
      return result?.goal ?? null;
    },
    close() {
      if (closed) return;
      closed = true;
      failPending(new Error(`Codex app-server websocket closed by AIMGR: ${url}`));
      if (opened && typeof ws.close === "function") {
        ws.close();
      }
    },
  };
}

export async function startPrivateCodexAppServer(
  {
    codexBin = "codex",
    codexHome,
    env = {},
    host = "127.0.0.1",
    timeoutMs = 8_000,
  },
  {
    spawnImpl = spawn,
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    findAvailableTcpPortImpl = findAvailableTcpPort,
    createClientImpl = createCodexAppServerWsClient,
  } = {},
) {
  const port = await findAvailableTcpPortImpl({ host });
  const remoteUrl = `ws://${host}:${port}`;
  const childEnv = {
    ...process.env,
    ...env,
    ...(codexHome ? { CODEX_HOME: codexHome } : {}),
  };
  const child = spawnImpl(
    codexBin,
    ["app-server", "--listen", remoteUrl, "--enable", "goals"],
    {
      env: childEnv,
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  let stderr = "";
  let exited = false;
  let exitCode = null;
  let client = null;

  child.stderr?.on("data", (chunk) => {
    stderr = appendStderr(stderr, chunk);
  });
  child.on?.("close", (code) => {
    exited = true;
    exitCode = code ?? 1;
  });

  const stop = () => {
    client?.close?.();
    client = null;
    if (!child.killed && !exited && typeof child.kill === "function") {
      child.kill();
    }
  };

  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    if (exited) {
      const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
      throw new Error(`Codex private app-server exited before it was ready with code ${exitCode}${detail}`);
    }
    try {
      client = createClientImpl({ remoteUrl, timeoutMs: Math.min(timeoutMs, 2_000) }, { setTimeoutImpl, clearTimeoutImpl });
      await client.request("thread/loaded/list", { limit: 1 });
      return { remoteUrl, client, stop, process: child };
    } catch (err) {
      lastError = err;
      client?.close?.();
      client = null;
      await delay(100, { setTimeoutImpl });
    }
  }

  stop();
  const detail = stderr.trim() ? `: ${stderr.trim()}` : "";
  const reason = lastError ? ` (${String(lastError?.message ?? lastError)})` : "";
  throw new Error(`Timed out waiting for Codex private app-server at ${remoteUrl}${reason}${detail}`);
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
