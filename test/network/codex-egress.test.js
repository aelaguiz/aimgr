import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { FETCH_JSON_MAX_RESPONSE_BYTES } from "../../src/io/fetch.js";
import { acquireClaudeAssignmentLock } from "../../src/network/claude-offline-binding.js";
import { acquireCodexAssignmentLock, resolveCodexRoute, readCodexOfflineBinding,
  invalidateCodexOfflineBinding, withCodexAccountTransport, CodexRouteError } from "../../src/network/codex-egress.js";

function fixture(t) {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-route-"));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, label: "same", accountId: "synthetic-a", environment: { binding: "a".repeat(64) },
    record: { label: "same", accountId: "synthetic-a", version: 1, policy: {} },
    profiles: { shared: { socksHost: "127.0.0.1", socksPort: 1086, httpPort: 2086, expectedExits: ["192.0.2.1"] } } };
}

test("Codex optional routing remembers enrollment and refuses stale or foreign metadata", t => {
  const options = fixture(t);
  assert.equal(resolveCodexRoute(options), null);
  options.record.policy.egress = { profileRef: "shared" };
  const profile = resolveCodexRoute(options);
  assert.equal(profile.exitCheckUrl, "https://1.1.1.1/cdn-cgi/trace");
  assert.equal(profile.provider, "openai-codex");
  assert.equal(profile.httpPort, 2086);
  assert.equal(readCodexOfflineBinding(options).accountId, "synthetic-a");
  assert.equal(resolveCodexRoute({ ...options, record: undefined, offline: true }).profileRef, "shared");
  assert.throws(() => resolveCodexRoute({ ...options, record: { ...options.record, policy: {} } }), CodexRouteError);
  assert.throws(() => resolveCodexRoute({ ...options, record: { ...options.record, accountId: "synthetic-b" } }), /invalid account/);
  invalidateCodexOfflineBinding(options, 2);
  assert.throws(() => resolveCodexRoute(options), /invalid proxy assignment/);
  assert.throws(() => resolveCodexRoute({ ...options, offline: true }), /invalid proxy assignment/);
  options.record.version = 2;
  assert.equal(resolveCodexRoute(options).profileRef, "shared");
});

test("missing machine config cannot erase a Codex proxy enrollment", t => {
  const options = fixture(t);
  options.record.policy.egress = { profileRef: "shared" };
  assert.throws(() => resolveCodexRoute({ ...options, profiles: {} }), /proxy profile unavailable/);
  assert.equal(readCodexOfflineBinding(options).required, true);
  options.record.policy = {};
  assert.throws(() => resolveCodexRoute(options), /missing proxy assignment/);
  // Reusing a display label for a different underlying account cannot use A's binding.
  const other = { ...options, accountId: "synthetic-b", record: { ...options.record, accountId: "synthetic-b" } };
  assert.equal(readCodexOfflineBinding(other), null);
  assert.equal(resolveCodexRoute(other), null);
});

test("valid JSON primitives and malformed bindings cannot become direct routing", t => {
  const options = fixture(t);
  options.record.policy.egress = { profileRef: "shared" };
  resolveCodexRoute(options);
  const root = path.join(options.homeDir, ".aimgr", "codex-egress");
  const file = path.join(root, fs.readdirSync(root).find(name => name.endsWith(".json")));
  options.record.policy = {};
  for (const text of ["null", "false", "0", '\"\"', "[]", "{}", "{broken"]) {
    fs.writeFileSync(file, text);
    assert.throws(() => resolveCodexRoute(options), /invalid proxy assignment/);
  }
});

test("native assignment locks follow account and environment, not label or shared physical route", async t => {
  const a = fixture(t);
  const held = await acquireCodexAssignmentLock(a);
  t.after(() => held.release());
  await assert.rejects(acquireCodexAssignmentLock({ ...a, label: "alias" }, { exclusive: true }), { code: "AIMGR_CODEX_ASSIGNMENT_BUSY" });
  const b = await acquireCodexAssignmentLock({ ...a, accountId: "synthetic-b" }, { exclusive: true });
  await b.release();
  const env = await acquireCodexAssignmentLock({ ...a, environment: { binding: "b".repeat(64) } }, { exclusive: true });
  await env.release();
  const claude = await acquireClaudeAssignmentLock(a.homeDir, a.label, { exclusive: true });
  await claude.release();
  await held.release();
  const changed = await acquireCodexAssignmentLock(a, { exclusive: true });
  await changed.release();
});

test("HTTP operation holds assignment through response consumption and keeps application failures separate", async t => {
  const options = fixture(t);
  options.record.policy.egress = { profileRef: "shared" };
  let closed = false, requests = 0;
  const value = await withCodexAccountTransport(options, async fetch => {
    const response = await fetch("https://synthetic.invalid/usage", { headers: { Authorization: "SYNTHETIC" } });
    await assert.rejects(acquireCodexAssignmentLock(options, { exclusive: true }), { code: "AIMGR_CODEX_ASSIGNMENT_BUSY" });
    assert.equal(closed, false);
    assert.equal(response.status, 429);
    return response.json();
  }, { createTransport(profile) {
    assert.equal(profile.profileRef, "shared");
    return { async fetch(url, init) {
      requests++;
      assert.equal(init.redirect, "error");
      assert.ok(init.signal);
      return new Response('{"rateLimited":true}', { status: 429 });
    }, async close() { closed = true; } };
  } });
  assert.deepEqual(value, { rateLimited: true });
  assert.equal(requests, 1);
  assert.equal(closed, true);
  const changed = await acquireCodexAssignmentLock(options, { exclusive: true });
  await changed.release();
});

test("proxied HTTP keeps the existing streamed response size limit and releases its assignment", async t => {
  const options = fixture(t);
  options.record.policy.egress = { profileRef: "shared" };
  let cancelled = false, closed = false, checkedLock = false;
  await assert.rejects(withCodexAccountTransport(options, async fetch => {
    const response = await fetch("https://synthetic.invalid/usage");
    return response.json();
  }, { createTransport() {
    return { async fetch() {
      return new Response(new ReadableStream({ async pull(controller) {
        if (!checkedLock) {
          checkedLock = true;
          await assert.rejects(acquireCodexAssignmentLock(options, { exclusive: true }), { code: "AIMGR_CODEX_ASSIGNMENT_BUSY" });
        }
        controller.enqueue(new Uint8Array(FETCH_JSON_MAX_RESPONSE_BYTES / 2));
      }, cancel() { cancelled = true; } }));
    }, async close() { closed = true; } };
  } }), { name: "ResponseSizeError" });
  assert.equal(checkedLock, true);
  assert.equal(cancelled, true);
  assert.equal(closed, true);
  const changed = await acquireCodexAssignmentLock(options, { exclusive: true });
  await changed.release();
});
