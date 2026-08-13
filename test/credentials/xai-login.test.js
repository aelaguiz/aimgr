import test from "node:test";
import assert from "node:assert/strict";
import {
  credentialsFromXaiTokenResponse,
  emailFromXaiTokenResponse,
  loginXaiDevice,
  refreshXaiCredential,
} from "../../src/credentials/xai-login.js";
import { resolveSupportedProviderFromInput } from "../../src/credentials/oauth.js";
import { normalizeProviderId } from "../../src/core/normalize.js";

function idTokenFor(email) {
  const payload = Buffer.from(JSON.stringify({ email }), "utf8").toString("base64url");
  return `aaa.${payload}.bbb`;
}

test("xai aliases resolve to the xai provider", () => {
  assert.equal(normalizeProviderId("grok"), "xai");
  assert.equal(resolveSupportedProviderFromInput("3"), "xai");
  assert.equal(resolveSupportedProviderFromInput("Grok"), "xai");
  assert.equal(resolveSupportedProviderFromInput("xai"), "xai");
});

test("xai token response keeps email and refresh", () => {
  const cred = credentialsFromXaiTokenResponse({
    access_token: "access-1",
    refresh_token: "refresh-1",
    expires_in: 3600,
    id_token: idTokenFor("Amir@Fun.Country"),
  });
  assert.equal(cred.access, "access-1");
  assert.equal(cred.refresh, "refresh-1");
  assert.equal(cred.emailAddress, "amir@fun.country");
  assert.equal(emailFromXaiTokenResponse({ id_token: idTokenFor("a@b.com") }), "a@b.com");
  assert.match(cred.expiresAt, /T/);
});

test("xai device login polls until approved and rejects email mismatch", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: String(init.body) });
    if (String(url).includes("/device/code")) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          device_code: "dev-1",
          user_code: "ABCD-EFGH",
          verification_uri: "https://accounts.x.ai/oauth2/device",
          verification_uri_complete: "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH",
          interval: 1,
          expires_in: 30,
        }),
      };
    }
    if (calls.filter((item) => String(item.url).includes("/token")).length < 2) {
      return {
        ok: false,
        status: 400,
        json: async () => ({ error: "authorization_pending" }),
      };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        access_token: "access-2",
        refresh_token: "refresh-2",
        expires_in: 120,
        id_token: idTokenFor("right@fun.country"),
      }),
    };
  };
  const opened = [];
  const cred = await loginXaiDevice({
    expectedEmail: "right@fun.country",
    fetchImpl,
    sleepImpl: async () => {},
    nowMsImpl: (() => {
      let t = 1_000;
      return () => {
        t += 1;
        return t;
      };
    })(),
    openUrlImpl: async (url) => opened.push(url),
    writeImpl: () => {},
  });
  assert.equal(cred.emailAddress, "right@fun.country");
  assert.equal(opened[0], "https://accounts.x.ai/oauth2/device?user_code=ABCD-EFGH");

  await assert.rejects(
    () => loginXaiDevice({
      expectedEmail: "wrong@fun.country",
      fetchImpl: async (url) => {
        if (String(url).includes("/device/code")) {
          return {
            ok: true,
            status: 200,
            json: async () => ({
              device_code: "dev-2",
              user_code: "ZZZZ-ZZZZ",
              verification_uri: "https://accounts.x.ai/oauth2/device",
              interval: 1,
              expires_in: 30,
            }),
          };
        }
        return {
          ok: true,
          status: 200,
          json: async () => ({
            access_token: "access-3",
            refresh_token: "refresh-3",
            expires_in: 120,
            id_token: idTokenFor("right@fun.country"),
          }),
        };
      },
      sleepImpl: async () => {},
      nowMsImpl: (() => {
        let t = 1_000;
        return () => {
          t += 1;
          return t;
        };
      })(),
      writeImpl: () => {},
    }),
    /identity_mismatch/,
  );
});

test("xai refresh invalid_grant is a reauth signal", async () => {
  await assert.rejects(
    () => refreshXaiCredential({
      refreshToken: "dead",
      fetchImpl: async () => ({
        ok: false,
        status: 400,
        json: async () => ({ error: "invalid_grant" }),
      }),
    }),
    (error) => error.code === "oauth_reauth_required",
  );
});
