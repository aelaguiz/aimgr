import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { enrollAgyConnection, withAgyConnection } from "../../src/credentials/agy-local.js";
import { checkAgyNativeRouteConfiguration } from "../../src/network/agy-native-route.js";
import { includeAgyRoster, parseAgyStatusReport, readLocalAgyStatus } from "../../src/status/agy-view.js";

const mac = { platform: "darwin", arch: "arm64" };
const linux = { platform: "linux", arch: "x64" };
const work = { label: "work", status: "ready" };

function fixture(t) {
  const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "aim-agy-status-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, "home");
  fs.mkdirSync(home, { mode: 0o700 });
  const runtimeRoot = path.join(root, "runtime");
  const artifactSet = "a".repeat(64);
  const bundle = path.join(runtimeRoot, "artifacts", artifactSet);
  fs.mkdirSync(bundle, { recursive: true });
  fs.writeFileSync(path.join(runtimeRoot, "active.json"), JSON.stringify({ schema: 1, artifactSet }));
  fs.writeFileSync(path.join(bundle, "approval.json"), JSON.stringify({ privacyAbi: "agy-privacy-v2" }));
  for (const name of ["agy", "launcher", "policy.json"]) {
    fs.writeFileSync(path.join(bundle, name), "synthetic installation file");
  }
  const stateRoot = path.join(home, ".aimgr", "agy");
  const grantPath = (label) => path.join(stateRoot, label, "home", ".gemini", "antigravity-cli", "antigravity-oauth-token");
  const enroll = (label, profileRef) => enrollAgyConnection(home, label, (accountHome) => {
    const directory = path.join(accountHome, ".gemini", "antigravity-cli");
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    fs.writeFileSync(path.join(directory, "antigravity-oauth-token"), "private-grant-canary", { mode: 0o600 });
  }, { profileRef });
  return { home, stateRoot, bundle, runtimeRoot, grantPath, enroll };
}

test("Antigravity readiness distinguishes grant state, runtime presence, and unsupported platforms", async (t) => {
  const { home, stateRoot, runtimeRoot, bundle, grantPath, enroll } = fixture(t);
  for (const label of ["work", "signed-out", "unsafe"]) await enroll(label);
  fs.unlinkSync(grantPath("signed-out"));
  fs.chmodSync(grantPath("unsafe"), 0o644);
  const local = readLocalAgyStatus(home, { ...mac, runtimeRoot });
  const combined = includeAgyRoster(local, [{ label: "other-host" }, { label: "work" }]);
  assert.deepEqual(combined, {
    runtime: "supported", runtimeInstalled: true, localState: "available", connections: [
      { label: "other-host", status: "not-enrolled", availability: "not-enrolled" },
      { label: "signed-out", status: "needs-sign-in", availability: "needs-sign-in" },
      { label: "unsafe", status: "invalid-state", availability: "invalid-state" },
      { ...work, availability: "ready" },
    ],
  });
  assert.doesNotMatch(JSON.stringify(combined), /private-grant-canary|accountHome|artifactSet/);
  const label = "work";
  fs.writeFileSync(path.join(bundle, "approval.json"), JSON.stringify({ privacyAbi: "agy-privacy-v1" }));
  const legacy = readLocalAgyStatus(home, { ...mac, runtimeRoot, label });
  assert.equal(legacy.runtimeInstalled, false);
  assert.deepEqual(legacy.connections, [{ ...work, availability: "runtime-missing" }]);
  fs.writeFileSync(path.join(bundle, "approval.json"), JSON.stringify({ privacyAbi: "agy-privacy-v2" }));
  fs.unlinkSync(path.join(bundle, "launcher"));
  const missing = readLocalAgyStatus(home, { ...mac, runtimeRoot, label });
  assert.equal(missing.runtimeInstalled, false);
  assert.deepEqual(missing.connections, [{ ...work, availability: "runtime-missing" }]);
  const unsupported = readLocalAgyStatus(home, { platform: "darwin", arch: "x64", runtimeRoot, label });
  assert.deepEqual(unsupported, {
    runtime: "unsupported", localState: "available", connections: [{ ...work, availability: "unsupported" }],
  });
  assert.throws(() => readLocalAgyStatus(home, { ...mac, runtimeRoot, label: "work@example.test" }), /Use an Antigravity label/);
  fs.chmodSync(stateRoot, 0o755);
  const inaccessible = readLocalAgyStatus(home, { ...mac, runtimeRoot, label });
  assert.equal(inaccessible.localState, "unavailable");
  assert.deepEqual(inaccessible.connections, [{ label, status: "unknown", availability: "unknown" }]);
});

test("Antigravity status checks the real connection lock without refreshing or acquiring it", async (t) => {
  const { home, stateRoot, runtimeRoot, enroll } = fixture(t);
  await enroll("work");
  const options = { ...mac, runtimeRoot, label: "work" };
  const lockPath = path.join(stateRoot, "work.lock");
  await withAgyConnection(home, "work", () => {
    const before = fs.statSync(lockPath).mtimeMs;
    assert.deepEqual(readLocalAgyStatus(home, options).connections, [{ ...work, availability: "in-use" }]);
    assert.equal(fs.statSync(lockPath).mtimeMs, before);
  });
  assert.deepEqual(readLocalAgyStatus(home, options).connections, [{ ...work, availability: "ready" }]);
  assert.equal(fs.existsSync(lockPath), false);
  fs.mkdirSync(lockPath);
  const stale = new Date(Date.now() - 60_000);
  fs.utimesSync(lockPath, stale, stale);
  assert.deepEqual(readLocalAgyStatus(home, options).connections, [{ ...work, availability: "ready" }]);
  assert.equal(fs.existsSync(lockPath), true);
});

test("Antigravity status shares route configuration validation and leaves reachability unverified", async (t) => {
  const { home, runtimeRoot, enroll } = fixture(t);
  await enroll("work", "private-route");
  const profile = { socksHost: "127.0.0.1", socksPort: 1080, expectedExits: ["192.0.2.3"] };
  const config = {
    agyProxyAssignments: { work: "private-route" },
    agyProxyProfiles: { "private-route": profile },
  };
  const connections = (platform, opts) => readLocalAgyStatus(home, { ...platform, runtimeRoot, config, ...opts }).connections;
  assert.deepEqual(connections(mac), [{ ...work, availability: "ready", route: "unverified" }]);
  assert.deepEqual(connections(mac, { config: { ...config, agyProxyAssignments: { work: "different-route" } } }), [{ ...work, availability: "route-error" }]);
  assert.deepEqual(connections(mac, { config: { ...config, agyProxyProfiles: undefined } }), [{ ...work, availability: "route-error" }]);

  const metadata = (readFileSync) => ({ checkRoute: (options) => checkAgyNativeRouteConfiguration(options, { readFileSync }) });
  assert.deepEqual(connections(linux, metadata(() => { throw new Error("private route path"); })), [{ ...work, availability: "route-error" }]);
  assert.deepEqual(connections(linux, metadata(() => JSON.stringify(profile))), [{ ...work, availability: "route-error" }]);
  assert.deepEqual(connections(linux, metadata((file) => {
    assert.equal(file, "/opt/aimgr-claude-proxy/private-route.json");
    return JSON.stringify({ ...profile, denyDatagrams: true });
  })), [{ ...work, availability: "ready", route: "unverified" }]);
});

test("Antigravity cluster parsing accepts older reports and projects only safe status fields", () => {
  const legacy = { runtime: "supported", localState: "available", connections: [work] };
  assert.deepEqual(parseAgyStatusReport(legacy), legacy);
  const expanded = {
    ...legacy,
    runtimeInstalled: true,
    runtimeRoot: "/private/runtime",
    connections: [{
      ...work, availability: "ready", route: "unverified", email: "secret@example.test",
      accountHome: "/private/token-home", observation: { account: "secret@example.test" },
    }],
  };
  assert.deepEqual(parseAgyStatusReport(expanded), {
    ...legacy, runtimeInstalled: true, connections: [{ ...work, availability: "ready", route: "unverified" }],
  });
  assert.equal(parseAgyStatusReport({ ...legacy, connections: [{ ...work, availability: "secret@example.test" }] }), null);
  assert.equal(parseAgyStatusReport({ ...legacy, connections: [work, work] }), null);
});
