import test from "node:test";
import assert from "node:assert/strict";
import { fetchJsonWithTimeout } from "../../src/io/fetch.js";

test("fetchJsonWithTimeout keeps the deadline active through response-body consumption", async () => {
  const fetchImpl = async (_url, { signal }) => new Response(new ReadableStream({
    start(controller) {
      signal.addEventListener("abort", () => {
        const error = new Error("aborted");
        error.name = "AbortError";
        controller.error(error);
      }, { once: true });
    },
  }), { status: 200 });

  await assert.rejects(
    fetchJsonWithTimeout("https://example.test/stalled", {}, 20, { fetchImpl }),
    (error) => {
      assert.equal(error.name, "AbortError");
      return true;
    },
  );
});

test("fetchJsonWithTimeout rejects oversized bodies before returning a JSON response", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ payload: "x".repeat(128) }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

  await assert.rejects(
    fetchJsonWithTimeout("https://example.test/large", {}, 1_000, {
      fetchImpl,
      maxResponseBytes: 32,
    }),
    (error) => {
      assert.equal(error.name, "ResponseSizeError");
      return true;
    },
  );
});

test("fetchJsonWithTimeout returns buffered JSON without a second body read", async () => {
  const fetchImpl = async () => new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
  const response = await fetchJsonWithTimeout("https://example.test/ok", {}, 1_000, { fetchImpl });

  assert.equal(response.ok, true);
  assert.deepEqual(await response.json(), { ok: true });
  assert.deepEqual(await response.json(), { ok: true });
});
