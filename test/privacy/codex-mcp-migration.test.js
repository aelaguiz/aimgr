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

test("ordinary configured names preserve repeated and reserved prefixes without aliasing", () => {
  const names = ["docs", "local:docs", "local:local:docs", "executor:x", "ema-idp:x", "local:executor:x"];
  const keys = names.map(name => codexMcpKey(name, server.url));
  assert.equal(new Set(keys).size, names.length);
  for (const [index, name] of names.entries()) {
    assert.equal(keys[index].split("|")[0], name);
    const identity = { name, url: server.url, environment_id: "local" };
    const spellings = name === "docs" ? [name] : [name, "local:" + name];
    for (const spelling of spellings) {
      const original = { ...entry, server_name: spelling, access_token: "SYNTHETIC_" + name };
      const [converted] = decodeCodexMcpFile(JSON.stringify({ [keys[index]]: original }), [identity]);
      assert.equal(converted.key, keys[index]);
      assert.equal(converted.serverName, name);
      assert.equal(converted.token.server_name, spelling);
      assert.equal(converted.token.token_response.access_token, original.access_token);
      if (name !== "docs") assert.throws(() => decodeCodexMcpFile(JSON.stringify({ [keys[0]]: original }), [identity]), /owner/);
    }
  }
});

test("managed namespaces and nonlocal environments cannot become ordinary identities", () => {
  const managed = { ...entry, server_name: "ema-idp:x" };
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ "ema-idp:x|managed-home-digest": managed }), [{ name: managed.server_name, url: server.url }]), /owner/);
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ "executor:x:managed-digest": { ...entry, server_name: "executor:x", executor_owned: true } }), [{ name: "executor:x", url: server.url }]));
  assert.throws(() => decodeCodexMcpFile(JSON.stringify({ legacy: entry }), [{ ...server, environment_id: "remote" }]));
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
    const result = codexMcpKeyring({ operation: "insert-if-absent", server_name: server.name, url: server.url, value }, {
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
