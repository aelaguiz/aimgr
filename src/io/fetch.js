export function createFetchJsonWithTimeout({
  fetchImpl = globalThis.fetch?.bind(globalThis),
  setTimeoutImpl = setTimeout,
  clearTimeoutImpl = clearTimeout,
} = {}) {
  return (url, init, timeoutMs) =>
    fetchJsonWithTimeout(url, init, timeoutMs, {
      fetchImpl,
      setTimeoutImpl,
      clearTimeoutImpl,
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
  } = {},
) {
  const controller = new AbortController();
  const timeout = setTimeoutImpl(() => controller.abort(), timeoutMs);
  try {
    if (typeof fetchImpl !== "function") {
      throw new Error("fetch is not available in this runtime.");
    }
    return await fetchImpl(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeoutImpl(timeout);
  }
}
