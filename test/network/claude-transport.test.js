import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import net from "node:net";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeAccountTransport, createClaudeTransport, checkClaudeRouteExit } from "../../src/network/claude-transport.js";
import { normalizeCredentialRecord } from "../../src/coordination/records.js";
import { buildCoordinationView } from "../../src/coordination/snapshot.js";
import { normalizeEgressPolicy, resolveClaudeEgressProfile } from "../../src/network/claude-egress-policy.js";
import { listen, startSocks } from "./socks-fixture.js";
import { fetchClaudeUsageSnapshot } from "../../src/pool/usage.js";
import { fetchJsonWithTimeout } from "../../src/io/fetch.js";
import { buildAnthropicClaudeCredential } from "../helpers/claude.js";
import { collectClaudeRedisAccountUsageStatus, selectClaudeAccountForSession } from "../../src/status/claude-redis-view.js";
import { buildStableIdentityForCredential } from "../../src/coordination/login-publish.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";

test("usage and automatic selection distinguish hung SOCKS from a healthy route with a stalled origin", async t => {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-usage-deadline-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  let partial = false;
  const origin = http.createServer((req, res) => {
    if (req.url === "/exit") { res.end(JSON.stringify({ ip: req.socket.remoteAddress })); return; }
    if (partial) { res.writeHead(200); res.write('{"five_hour":'); }
  });
  const port = await listen(origin);
  const healthy = await startSocks({ sourceAddress: "127.0.0.2", destinations: { "usage.test": port } });
  const sockets = new Set();
  const hung = net.createServer(socket => { sockets.add(socket); socket.on("close", () => sockets.delete(socket)); });
  const hungPort = await listen(hung);
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise(resolve => hung.close(resolve));
    await healthy.stop(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  });
  const credential = buildAnthropicClaudeCredential();
  const record = normalizeCredentialRecord({ provider: "anthropic", label: "a", credential,
    identity: buildStableIdentityForCredential("anthropic", credential),
    policy: { egress: { profileRef: "a" }, expect: { email: credential.nativeClaudeBundle.oauthAccount.emailAddress } },
    version: 1 });
  let socksPort = healthy.port;
  const configure = () => writeAimgrConfig({ homeDir, config: {
    claudeProxyProfiles: { a: { socksPort, expectedExits: ["127.0.0.2"] } },
  } });
  configure();
  const fetchUsage = args => fetchClaudeUsageSnapshot({ ...args, homeDir, timeoutMs: 500,
    profiles: { a: { socksPort, expectedExits: ["127.0.0.2"] } },
    createClaudeAccountTransportImpl: params => createClaudeAccountTransport({ ...params,
      checkRouteExitImpl: (profile, opts) => checkClaudeRouteExit({ ...profile, exitCheckUrl: "http://usage.test/exit" }, opts) }),
    fetchJsonWithTimeoutImpl: (_url, init, timeout, options) => fetchJsonWithTimeout("http://usage.test/usage", init, timeout, options),
  });
  for (partial of [false, true]) {
    await assert.rejects(fetchUsage({ record }), error => error.name === "AbortError" && error.code !== "proxy_unavailable");
  }
  const status = () => collectClaudeRedisAccountUsageStatus({ homeDir, records: [record], fresh: true,
    fetchClaudeUsageSnapshotImpl: fetchUsage });
  const ordinary = await status();
  assert.equal(ordinary.accounts[0].errorKind, "timeout");
  assert.doesNotThrow(() => selectClaudeAccountForSession(ordinary, { preset: "sonnet" }));
  socksPort = hungPort;
  configure();
  await assert.rejects(fetchUsage({ record }), { code: "proxy_unavailable" });
  // A new cache avoids the normal provider backoff from the ordinary timeout.
  const failed = await collectClaudeRedisAccountUsageStatus({ homeDir, records: [record], fresh: true,
    cachePath: path.join(homeDir, "hung-status.json"), fetchClaudeUsageSnapshotImpl: fetchUsage });
  assert.throws(() => selectClaudeAccountForSession(failed, { preset: "sonnet" }), { code: "proxy_unavailable" });
});

test("usage preserves a tunnel failure after headers instead of reporting malformed JSON", async (t) => {
  let mode = "malformed", status = 200, stopTunnel;
  const origin = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    if (req.url === "/exit") { res.end(JSON.stringify({ ip: req.socket.remoteAddress })); return; }
    res.writeHead(status);
    if (mode === "malformed") { res.end("not-json"); return; }
    res.write('{"five_hour":');
    setTimeout(() => { void stopTunnel(); }, 30);
  });
  const port = await listen(origin);
  const socks = await startSocks({ sourceAddress: "127.0.0.2", destinations: { "usage.test": port } });
  stopTunnel = () => socks.stop();
  t.after(async () => { await socks.stop(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); });
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-partial-usage-"));
  t.after(() => fs.rm(homeDir, { recursive: true, force: true }));
  const options = {
    homeDir,
    label: "a",
    state: { accounts: { a: { provider: "anthropic", egress: { profileRef: "a" } } }, credentials: { anthropic: { a: buildAnthropicClaudeCredential({ access: "synthetic-a" }) } } },
    profiles: { a: { socksPort: socks.port, expectedExits: ["127.0.0.2"] } },
    createClaudeAccountTransportImpl: params => createClaudeAccountTransport({ ...params, checkRouteExitImpl: (profile, opts) => checkClaudeRouteExit({ ...profile, exitCheckUrl: "http://usage.test/exit" }, opts) }),
    fetchJsonWithTimeoutImpl: (_url, init, timeout, options) => fetchJsonWithTimeout("http://usage.test/usage", init, timeout, options),
  };
  assert.equal((await fetchClaudeUsageSnapshot(options)).status, "malformed");
  status = 401;
  assert.equal((await fetchClaudeUsageSnapshot(options)).status, 401);
  status = 200; mode = "partial";
  await assert.rejects(fetchClaudeUsageSnapshot(options), { code: "proxy_unavailable" });
});

test("assignment survives Redis normalization and state projection without machine data", () => {
  const record = normalizeCredentialRecord({ provider: "anthropic", label: "a", policy: {
    egress: { profileRef: " Proxy5 ", password: "must-not-copy", chrome: { cdpPort: 9355 } },
  } });
  assert.deepEqual(record.policy.egress, { profileRef: "proxy5" });
  const state = buildCoordinationView({ credentials: [record] });
  assert.deepEqual(state.accounts.a.egress, record.policy.egress);
  assert.throws(() => normalizeEgressPolicy({ profileRef: "direct" }), { code: "invalid_proxy_assignment" });
  assert.throws(() => resolveClaudeEgressProfile({ label: "a", account: {}, profiles: {} }), { code: "missing_proxy_assignment" });
  assert.throws(() => resolveClaudeEgressProfile({ label: "a", account: state.accounts.a, profiles: {} }), { code: "proxy_profile_unavailable" });
});

test("concurrent A1/A2/B requests, remote DNS, streaming, outage and explicit recovery", async (t) => {
  const seen = [];
  const origin = http.createServer((req, res) => {
    seen.push({ path: req.url, source: req.socket.remoteAddress, token: req.headers.authorization });
    if (req.url === "/redirect") { res.writeHead(302, { location: "http://other.test/final" }); res.end(); return; }
    if (req.url === "/stream") { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n"); return; }
    if (req.url.startsWith("/origin-error/")) { res.writeHead(Number(req.url.split("/").at(-1))); res.end("origin error"); return; }
    res.setHeader("content-type", "application/json");
    res.write('{"ip":"' + req.socket.remoteAddress + '","source":"');
    setTimeout(() => res.end(`${req.socket.remoteAddress}"}`), 10);
  });
  const port = await listen(origin);
  t.after(() => new Promise((resolve) => { origin.closeAllConnections(); origin.close(resolve); }));
  const destinations = { "model.test": port, "other.test": port };
  let a = await startSocks({ sourceAddress: "127.0.0.2", destinations });
  const b = await startSocks({ sourceAddress: "127.0.0.3", destinations });
  t.after(async () => { await a.stop(); await b.stop(); });
  const state = { accounts: { a: { provider: "anthropic", egress: { profileRef: "a" } }, b: { provider: "anthropic", egress: { profileRef: "b" } } }, credentials: { anthropic: { a: { access: "token-a" }, b: { access: "token-b" } } } };
  const profiles = { a: { socksPort: a.port, expectedExits: ["127.0.0.2"] }, b: { socksPort: b.port, expectedExits: ["127.0.0.3"] } };
  const operation = (label) => createClaudeAccountTransport({ label, state, profiles, timeoutMs: 1000, healthIntervalMs: 50, checkRouteExitImpl: (profile, options) => checkClaudeRouteExit({ ...profile, exitCheckUrl: "http://model.test/health" }, options) });
  const a1 = operation("a"), a2 = operation("a"), b1 = operation("b");
  t.after(async () => { await Promise.all([a1.close(), a2.close(), b1.close()]); });
  const request = async (op, pathname = "/") => {
    const res = await op.fetch(`http://model.test${pathname}`, { headers: { authorization: `Bearer ${op.credential.access}` } });
    return await res.json();
  };
  const values = await Promise.all([request(a1), request(a2), request(b1)]);
  assert.deepEqual(values.map((v) => v.source), ["127.0.0.2", "127.0.0.2", "127.0.0.3"]);
  assert.equal(a.receipts.every((r) => r.host === "model.test"), true);
  assert.ok(a.receipts.every(r => r.port === 80), "default HTTP URLs connect to port 80, never port zero");
  await request(a1, "/redirect");
  assert.equal(seen.find((r) => r.path === "/final").token, undefined, "cross-origin redirect strips authorization");
  for (const status of [401, 429, 503]) {
    const errorResponse = await a1.fetch(`http://model.test/origin-error/${status}`);
    assert.equal(errorResponse.status, status);
    await errorResponse.text();
    assert.equal(a1.failure, null, "ordinary API errors do not terminate the route");
  }
  await request(a1);
  const stream = await a1.fetch("http://model.test/stream");
  const reader = stream.body.getReader();
  assert.ok((await reader.read()).value.length > 0);
  const checksBeforeStall = seen.filter(r => r.path === "/health").length;
  await delay(180);
  assert.ok(seen.filter(r => r.path === "/health").length > checksBeforeStall);
  assert.equal(a1.failure, null, "an idle model stream is allowed while the route remains healthy");
  const oldPort = a.port;
  await a.stop();
  await assert.rejects(reader.read(), { code: "proxy_unavailable" });
  await assert.rejects(request(a1), { code: "proxy_unavailable" });
  assert.equal((await request(b1)).source, "127.0.0.3");
  a = await startSocks({ sourceAddress: "127.0.0.2", destinations, port: oldPort });
  await assert.rejects(request(a1), { code: "proxy_unavailable" });
  await assert.rejects(request(a2), { code: "proxy_unavailable" });
  assert.equal(a1.failure.code, "proxy_unavailable");
  assert.equal(a.receipts.length, 0, "failed operation does not reopen after tunnel repair");
  const wrong = createClaudeAccountTransport({ label: "a", state, profiles: { ...profiles, a: { ...profiles.a, expectedExits: ["127.0.0.3"] } }, timeoutMs: 300, checkRouteExitImpl: (profile, options) => checkClaudeRouteExit({ ...profile, exitCheckUrl: "http://model.test/health" }, options) });
  try { await assert.rejects(request(wrong, "/wrong-exit"), { code: "proxy_exit_mismatch" }); }
  finally { await wrong.close(); }
  assert.equal(seen.some((r) => r.path === "/wrong-exit"), false);
  const resumed = operation("a");
  try { assert.equal((await request(resumed)).source, "127.0.0.2"); }
  finally { await resumed.close(); }
});

test("SOCKS receives standard HTTPS and explicit custom destination ports", async (t) => {
  const origin = http.createServer((_req, res) => res.end("synthetic"));
  const port = await listen(origin);
  const socks = await startSocks({ destinations: { "ports.test": port } });
  const transport = createClaudeTransport({ socksHost: "127.0.0.1", socksPort: socks.port }, { isProbe: true, timeoutMs: 500 });
  t.after(async () => {
    await transport.close(); await socks.stop();
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  });
  // This HTTP-only origin deliberately cannot complete TLS, but the SOCKS
  // receipt must still show the real default HTTPS destination port.
  await assert.rejects(transport.fetch("https://ports.test/"));
  assert.equal(socks.receipts.at(-1).port, 443);
  assert.equal(await (await transport.fetch("http://ports.test:12345/")).text(), "synthetic");
  assert.equal(socks.receipts.at(-1).port, 12345);
});

test("request cancellation interrupts the initial route check without poisoning another request", async (t) => {
  const socks = await startSocks({ sourceAddress: "127.0.0.2", destinations: {} });
  t.after(() => socks.stop());
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const transport = createClaudeTransport({ socksHost: "127.0.0.1", socksPort: socks.port }, { checkRouteExitImpl: () => pending });
  t.after(() => transport.close());
  const controller = new AbortController();
  const reason = new Error("caller canceled");
  const request = transport.fetch("http://model.test", { signal: controller.signal });
  controller.abort(reason);
  await assert.rejects(request, error => error === reason);
  assert.equal(transport.failure, null);
  release();
});
