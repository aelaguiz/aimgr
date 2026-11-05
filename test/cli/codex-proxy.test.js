import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { localCodexRecords } from "../../src/coordination/codex-runtime.js";
import { handleCodex } from "../../src/cli/commands/codex.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore } from "../../src/coordination/redis-store.js";
import { ensureCodexAccountMetadata, readCodexAccountMetadata, setCodexAccountEgress } from "../../src/coordination/codex-metadata.js";
import { readLocalCodexCredential, saveLocalCodexLogin } from "../../src/credentials/codex-local.js";
import { acquireCodexAssignmentLock, readCodexOfflineBinding, writeCodexOfflineBinding } from "../../src/network/codex-egress.js";
import { resolveCodexBrowserProfile } from "../../src/browser/codex-cdp.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";
import { CODEX_TEST_ENVIRONMENT as environment } from "../helpers/codex-local.js";

test("Codex proxy assignment excludes only that account and never fetches or republishes primary grants", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-cli-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const client = new FakeRedisClient();
  const store = await connectRedisStore({ client, keyPrefix: "codex-proxy-cli:" });
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fixture", keyPrefix: store.keyPrefix },
    codexProxyProfiles: { shared: { socksPort: 1086, httpPort: 2086, expectedExits: ["192.0.2.1"] },
      other: { socksPort: 1087, httpPort: 2087, expectedExits: ["192.0.2.2"] } } } });
  for (const label of ["a", "b"]) await ensureCodexAccountMetadata(store, { label, accountId: `synthetic-${label}` });
  const key = store.keys.credential({ provider: "openai-codex", label: "a" });
  const record = JSON.parse(client.values.get(key));
  record.credential = { access: "FOREIGN_MUST_NOT_LEAVE_REDIS", refresh: "FOREIGN_REFRESH" };
  client.values.set(key, JSON.stringify(record));
  const original = client.eval.bind(client);
  client.eval = async (...args) => {
    const result = await original(...args);
    assert.equal(JSON.stringify(result).includes("FOREIGN"), false);
    return result;
  };
  const context = { homeDir, env: {}, opts: {}, stdout: { write() {} },
    readCodexEnvironmentImpl: () => environment, connectRedisStoreImpl: async () => store };
  const invoke = (label, profile) => handleCodex({ ...context, positional: ["codex", "proxy", "set", label, profile] });
  await invoke("a", "shared");
  await invoke("b", "shared");
  const b = await acquireCodexAssignmentLock({ homeDir, accountId: "synthetic-b", label: "b", environment });
  try { await invoke("a", "other"); } finally { await b.release(); }
  const aOptions = { homeDir, accountId: "synthetic-a", label: "a", environment };
  const a = await acquireCodexAssignmentLock(aOptions);
  try { await assert.rejects(invoke("a", "shared"), { code: "AIMGR_CODEX_ASSIGNMENT_BUSY" }); }
  finally { await a.release(); }
  assert.equal(readCodexOfflineBinding(aOptions).egress.profileRef, "other");
  const after = JSON.parse(client.values.get(key));
  assert.deepEqual(after.credential, record.credential);
  assert.equal((await readCodexAccountMetadata(store)).find(item => item.label === "a").policy.egress.profileRef, "other");
});

for (const scenario of ["first", "existing", "conflicting-option", "busy", "metadata-conflict", "route-failure", "wrong-account", "remembered-newer", "remembered-invalidated"]) {
  test(`headless Codex proxy login: ${scenario}`, async t => {
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-proxy-login-"));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    const client = new FakeRedisClient(), store = await connectRedisStore({ client, keyPrefix: "codex-proxy-login:" });
    // The existing physical route can be shared without duplicating configuration.
    writeAimgrConfig({ homeDir, config: { redis: { url: "redis://fixture", keyPrefix: store.keyPrefix },
      claudeProxyProfiles: { shared: { socksPort: 1086, httpPort: 2086, expectedExits: ["192.0.2.1"] } } } });
    const existing = ["existing", "conflicting-option", "wrong-account"].includes(scenario);
    if (existing) await ensureCodexAccountMetadata(store, { label: "a", accountId: "synthetic-a", egress: { profileRef: "shared" } });
    const options = { homeDir, label: "a", accountId: "synthetic-a", environment };
    const remembered = scenario.startsWith("remembered-") ? { required: true, version: 9,
      ...(scenario === "remembered-invalidated" ? { invalidated: true } : { egress: { profileRef: "shared" } }) } : null;
    if (remembered) writeCodexOfflineBinding(options, remembered);
    const originalBinding = readCodexOfflineBinding(options);
    const held = scenario === "busy" ? await acquireCodexAssignmentLock(options) : null;
    t.after(() => held?.release());
    const events = [], order = [], input = new PassThrough();
    t.after(() => input.destroy());
    let exchanges = 0, closed = false, code = 0;
    const token = `synthetic.${Buffer.from(JSON.stringify({ exp: 4102444800,
      "https://api.openai.com/auth": { chatgpt_account_id: scenario === "wrong-account" ? "foreign" : "synthetic-a" } })).toString("base64url")}.signature`;
    await handleCodex({ positional: ["codex", "login", "a"], homeDir, env: {},
      opts: { manualCallbackStdio: true, ...(!existing || scenario === "conflicting-option" ? { codexLoginProxy: scenario === "conflicting-option" ? "other" : "shared" } : {}) },
      stdin: input, signal: AbortSignal.timeout(5000), readCodexEnvironmentImpl: () => environment,
      connectRedisStoreImpl: async () => store, setExitCode: value => { code = value; },
      validateCodexChromeImpl: () => { throw new Error("The VM must never inspect a local Chrome profile"); },
      createCodexAccountTransportImpl: profile => {
        assert.equal(profile.profileRef, "shared");
        return { async check() { order.push("route"); if (scenario === "route-failure") throw new Error("synthetic route failure"); },
          async fetch(url) {
            assert.equal(url, "https://auth.openai.com/oauth/token"); exchanges++; order.push("exchange");
            if (scenario === "metadata-conflict") await ensureCodexAccountMetadata(store, { label: "a", accountId: "synthetic-a", egress: { profileRef: "other" } });
            return Response.json({ access_token: token, id_token: token, refresh_token: "SYNTHETIC_LOCAL_REFRESH", expires_in: 3600 });
          }, async close() { closed = true; } };
      },
      stdout: { write(line) {
        const event = JSON.parse(line); events.push(event);
        if (event.type === "auth_url") {
          order.push("url");
          const callback = new URL("http://localhost:1455/auth/callback");
          callback.search = new URLSearchParams({ code: "SYNTHETIC_CODE", state: new URL(event.url).searchParams.get("state") });
          setImmediate(() => input.write(JSON.stringify({ callbackUrl: callback.href }) + "\n"));
        }
      } },
    });
    const success = ["first", "existing"].includes(scenario);
    assert.equal(code, success ? 0 : 1, JSON.stringify(events));
    assert.equal(Boolean(readLocalCodexCredential(options).credential), success);
    if (scenario === "conflicting-option") { assert.equal(events.some(x => x.type === "auth_url"), false); assert.equal(exchanges, 0); }
    else {
      assert.equal(closed, true);
      assert.equal(order[0], "route");
      if (scenario === "route-failure") { assert.equal(events.some(x => x.type === "auth_url"), false); assert.equal(exchanges, 0); }
      else { assert.deepEqual(order, ["route", "url", "exchange"]); assert.equal(exchanges, 1); }
    }
    if (success) {
      assert.equal(readCodexOfflineBinding(options).egress.profileRef, "shared");
      assert.equal((await readCodexAccountMetadata(store))[0].policy.egress.profileRef, "shared");
    }
    if (remembered) {
      assert.deepEqual(readCodexOfflineBinding(options), originalBinding);
      assert.deepEqual(await readCodexAccountMetadata(store), []);
    }
  });
}

test("original browser profile requires no Codex HTTP inbound on the browser host", () => {
  const profile = resolveCodexBrowserProfile({ label: "a", egress: { profileRef: "shared" }, profiles: {
    shared: { socksPort: 1086, expectedExits: ["192.0.2.1"], chrome: { cdpPort: 9356, userDataDir: "/synthetic/original-browser" } },
  } });
  assert.equal(profile.httpPort, undefined);
  assert.equal(profile.chrome.cdpPort, 9356);
  assert.equal(profile.socksPort, 1086);
});


test("an assignment change cannot turn an existing local login into a reauthorization request", async t => {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-assignment-race-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const client = new FakeRedisClient(), store = await connectRedisStore({ client, keyPrefix: "codex-assignment-race:" });
  await ensureCodexAccountMetadata(store, { label: "a", accountId: "synthetic-a" });
  const options = { homeDir, label: "a", accountId: "synthetic-a", environment };
  const token = `synthetic.${Buffer.from(JSON.stringify({ exp: 4102444800,
    "https://api.openai.com/auth": { chatgpt_account_id: "synthetic-a" } })).toString("base64url")}.signature`;
  saveLocalCodexLogin(options, { access: token, idToken: token, refresh: "SYNTHETIC_LOCAL_REFRESH", accountId: "synthetic-a" });
  const lock = await acquireCodexAssignmentLock(options, { exclusive: true });
  try {
    const [record] = await localCodexRecords({ store, homeDir, environment, maintain: true });
    assert.equal(record.credential.access, token);
    assert.equal(record.policy.reauth.required, false);
    assert.equal(record.routeError.code, "assignment_busy");
    assert.equal(record.health.reason, "route_unavailable");
  } finally { await lock.release(); }
});
