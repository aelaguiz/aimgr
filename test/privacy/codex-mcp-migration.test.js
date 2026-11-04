import test from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { EventEmitter } from "node:events";
import { codexMcpKey, decodeCodexMcpFile, codexMcpTokensEqual, codexMcpKeyring } from "../../src/credentials/codex-mcp-migration.js";

const server = { name: "synthetic", url: "http://127.0.0.1:12345/mcp" };
const entry = { server_name: server.name, server_url: server.url, client_id: "synthetic-client",
  issuer: "http://127.0.0.1:12345", access_token: "SYNTHETIC_ACCESS", refresh_token: "SYNTHETIC_REFRESH",
  expires_at: 4102444800123, scopes: ["read", "write"] };

test("File conversion preserves complete ordinary OAuth identity and token metadata", () => {
  const [converted] = decodeCodexMcpFile(JSON.stringify({ legacy: entry }), [server]);
  assert.equal(converted.sourceKey, "legacy");
  assert.deepEqual(converted.token, { server_name: server.name, url: server.url, issuer: entry.issuer,
    client_id: entry.client_id, expires_at: entry.expires_at,
    token_response: { access_token: entry.access_token, token_type: "bearer", refresh_token: entry.refresh_token, scope: "read write" } });
  const withoutOptional = { ...entry }; delete withoutOptional.issuer; delete withoutOptional.refresh_token;
  delete withoutOptional.scopes; delete withoutOptional.expires_at;
  const [plain] = decodeCodexMcpFile(JSON.stringify({ legacy: withoutOptional }), [server]);
  assert.equal(plain.token.expires_at, null);
  assert.deepEqual(plain.token.token_response, { access_token: entry.access_token, token_type: "bearer" });
});

test("local: names require their own native key and cannot consume another escaped identity", () => {
  const escaped = { ...server, name: "local:" + server.name };
  assert.equal(codexMcpKey(escaped.name, escaped.url), codexMcpKey(server.name, server.url));
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ legacy: entry }), [escaped]), /owner/);
  const key = codexMcpKey(escaped.name, escaped.url);
  assert.equal(decodeCodexMcpFile(JSON.stringify({ [key]: entry }), [escaped])[0].key, key);
});

test("mixed, malformed, unconfigured and ambiguous stores are preserved by refusing conversion", () => {
  for (const override of [{ executor_owned: true }, { server_name: "executor:private" },
    { server_name: "ema-idp:private" }, { expires_at: Number.MAX_SAFE_INTEGER + 1 }, { scopes: "read" }, { refresh_token: 123 }]) {
    assert.throws(() => decodeCodexMcpFile(JSON.stringify({ a: { ...entry, ...override } }), [server]));
  }
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ a: entry }), []), /owner/);
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ z: entry, a: { ...entry, access_token: "DIFFERENT" } }), [server]), /owner/);
  for (const text of ["broken", "null", "[]", '{"a":null}']) assert.throws(() => decodeCodexMcpFile(text, [server]));
});

test("destination equivalence ignores only native-derived expires_in, never a different token or identity", () => {
  const [converted] = decodeCodexMcpFile(JSON.stringify({ a: entry }), [server]);
  const same = structuredClone(converted.token); same.token_response.expires_in = 60;
  assert.equal(codexMcpTokensEqual(converted.token, same), true);
  for (const mutate of [v => v.token_response.access_token = "OTHER", v => v.token_response.refresh_token = "OTHER",
    v => v.expires_at += 1000, v => v.client_id = "other", v => v.url = "http://elsewhere.invalid"]) {
    const different = structuredClone(same); mutate(different);
    assert.equal(codexMcpTokensEqual(converted.token, different), false);
  }
  assert.equal(codexMcpTokensEqual(null, null), false);
});

test("keyring transport keeps credential bytes off argv and diagnostics", async () => {
  for (const success of [true, false]) {
    let input = "";
    const value = JSON.stringify({ token_response: { access_token: "SYNTHETIC_SECRET" } });
    const result = codexMcpKeyring({ operation: "insert-if-absent", account: codexMcpKey(server.name, server.url), value }, {
      command: "/synthetic/helper", env: { DBUS_SESSION_BUS_ADDRESS: "synthetic-bus" },
      spawnImpl: (command, args, options) => {
        assert.deepEqual(args, []); assert.equal(command, "/synthetic/helper");
        assert.equal(JSON.stringify(options).includes("SYNTHETIC_SECRET"), false);
        const child = new EventEmitter(); child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.kill = () => {};
        child.stdin.on("data", bytes => input += bytes);
        child.stdin.on("finish", () => queueMicrotask(() => {
          child.stdout.write(success ? JSON.stringify({ inserted: true, value }) : "SYNTHETIC_SECRET malformed failure");
          child.emit("close", success ? 0 : 1);
        }));
        return child;
      },
    });
    if (success) assert.equal((await result).value, value);
    else await assert.rejects(result, error => !error.message.includes("SYNTHETIC_SECRET"));
    assert.equal(JSON.parse(input).value, value);
  }
});
