export const FETCH_JSON_MAX_RESPONSE_BYTES = 2 * 1024 * 1024;

function responseSizeError() {
  const error = new Error("JSON response exceeded the safe size limit.");
  error.name = "ResponseSizeError";
  return error;
}

async function readResponseJson(response, { controller, maxResponseBytes }) {
  const contentLength = Number(response?.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxResponseBytes) {
    controller.abort();
    throw responseSizeError();
  }

  const body = response?.body;
  if (!body || typeof body.getReader !== "function") {
    return await response.json();
  }

  const reader = body.getReader();
  const chunks = [];
  let totalBytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
      totalBytes += chunk.byteLength;
      if (totalBytes > maxResponseBytes) {
        controller.abort();
        try {
          await reader.cancel();
        } catch {
          // The abort may already have closed the response stream.
        }
        throw responseSizeError();
      }
      chunks.push(chunk);
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The stream may already be detached after an abort.
    }
  }

  const bytes = new Uint8Array(totalBytes);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

function responseWithBufferedJson(response, { value, error }) {
  return new Proxy(response, {
    get(target, property) {
      if (property === "json") {
        return async () => {
          if (error) throw error;
          return value;
        };
      }
      const targetValue = Reflect.get(target, property, target);
      return typeof targetValue === "function" ? targetValue.bind(target) : targetValue;
    },
  });
}

export function createFetchJsonWithTimeout({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
  maxResponseBytes = FETCH_JSON_MAX_RESPONSE_BYTES,
} = {}) {
  return (url, init, timeoutMs) =>
    fetchJsonWithTimeout(url, init, timeoutMs, {
      fetchImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
      maxResponseBytes,
    });
}

export async function fetchJsonWithTimeout(
  url,
  init = {},
  timeoutMs = 8000,
  {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    setTimeoutImpl = setTimeout,
    clearTimeoutImpl = clearTimeout,
    maxResponseBytes = FETCH_JSON_MAX_RESPONSE_BYTES,
  } = {},
) {
  const boundedTimeoutMs = Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.round(timeoutMs) : 8_000;
  const boundedResponseBytes = Number.isFinite(maxResponseBytes) && maxResponseBytes > 0
    ? Math.min(Math.round(maxResponseBytes), FETCH_JSON_MAX_RESPONSE_BYTES)
    : FETCH_JSON_MAX_RESPONSE_BYTES;
  const controller = new AbortController();
  const timeout = setTimeoutImpl(() => controller.abort(), boundedTimeoutMs);
  try {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available in this runtime.");
    }
    const inheritedSignal = init?.signal;
    const signal = inheritedSignal && typeof AbortSignal.any === "function"
      ? AbortSignal.any([controller.signal, inheritedSignal])
      : controller.signal;
    if (inheritedSignal?.aborted) controller.abort(inheritedSignal.reason);
    const response = await fetchImpl(url, { ...init, signal });
    let jsonValue;
    let jsonError = null;
    try {
      jsonValue = await readResponseJson(response, { controller, maxResponseBytes: boundedResponseBytes });
    } catch (error) {
      if (controller.signal.aborted || error?.name === "ResponseSizeError") throw error;
      jsonError = error;
    }
    return responseWithBufferedJson(response, { value: jsonValue, error: jsonError });
  } finally {
    clearTimeoutImpl(timeout);
  }
}
