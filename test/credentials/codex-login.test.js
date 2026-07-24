import test from "node:test";
import assert from "node:assert/strict";
import {
  CodexRefreshInvalidGrantError,
  refreshCodexWithoutBrowser,
} from "../../src/credentials/codex-login.js";
import { makeFakeJwt } from "../helpers/files.js";

const NOW_MS = Date.parse("2026-07-24T12:00:00.000Z");

function accessToken(accountId = "acct_boss") {
  return makeFakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: accountId,
    },
  });
}

test("refreshCodexWithoutBrowser performs one bounded refresh grant and returns a same-account credential", async () => {
  const calls = [];
  const refreshed = await refreshCodexWithoutBrowser({
    credential: {
      refresh: "REFRESH_OLD",
      accountId: "acct_boss",
    },
    nowMs: NOW_MS,
    fetchJsonWithTimeoutImpl: async (url, init, timeoutMs) => {
      calls.push({ url, init, timeoutMs });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          access_token: accessToken(),
          refresh_token: "REFRESH_NEW",
          expires_in: 3600,
        }),
      };
    },
  });

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://auth.openai.com/oauth/token");
  assert.equal(calls[0].init.method, "POST");
  assert.equal(calls[0].init.headers["Content-Type"], "application/x-www-form-urlencoded");
  assert.equal(calls[0].timeoutMs, 8_000);
  assert.deepEqual(
    Object.fromEntries(new URLSearchParams(calls[0].init.body)),
    {
      grant_type: "refresh_token",
      refresh_token: "REFRESH_OLD",
      client_id: "app_EMoamEEZ73f0CkXaXp7hrann",
    },
  );
  assert.equal(refreshed.accountId, "acct_boss");
  assert.equal(refreshed.refresh, "REFRESH_NEW");
  assert.equal(refreshed.expiresAt, "2026-07-24T13:00:00.000Z");
  assert.equal(refreshed.idToken, refreshed.access);
});

test("refreshCodexWithoutBrowser classifies only exact invalid_grant as terminal", async () => {
  await assert.rejects(
    refreshCodexWithoutBrowser({
      credential: {
        refresh: "REFRESH_OLD",
        accountId: "acct_boss",
      },
      fetchJsonWithTimeoutImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    }),
    CodexRefreshInvalidGrantError,
  );
});

test("refreshCodexWithoutBrowser leaves network failures transient", async () => {
  const networkError = new Error("network unavailable");
  await assert.rejects(
    refreshCodexWithoutBrowser({
      credential: {
        refresh: "REFRESH_OLD",
        accountId: "acct_boss",
      },
      fetchJsonWithTimeoutImpl: async () => {
        throw networkError;
      },
    }),
    (error) => error === networkError && !(error instanceof CodexRefreshInvalidGrantError),
  );
});
