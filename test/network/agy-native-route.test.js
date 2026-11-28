import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { agyProfileRef, prepareAgyNativeRoute } from "../../src/network/agy-native-route.js";

const label = "pilot";
const artifact = { launcher: "/opt/aimgr-agy-runtime/artifacts/test/launcher" };
const args = ["v1", "run", "/account", "/project", "/scratch", "3", "0", "--", "--print=fixture"];
const profile = { socksPort: 11080, expectedExits: ["192.0.2.3"] };
const config = {
  agyProxyAssignments: { [label]: "test-route" },
  agyProxyProfiles: { "test-route": profile },
  claudeProxyProfiles: { "test-route": { socksPort: 11081, expectedExits: ["192.0.2.4"] } },
};
const routed = { config, label, profileRef: "test-route", artifact, args, platform: "linux" };
const unexpectedRoute = {
  prepareClaudeNativeRouteImpl: () => assert.fail("This connection must not reach the native route helper"),
  checkClaudeRouteExitImpl: () => assert.fail("This connection must not probe a SOCKS listener"),
};

test("Antigravity normalizes an explicit assignment and rejects malformed assignments", () => {
  assert.equal(agyProfileRef({}, label), undefined);
  assert.equal(agyProfileRef({ agyProxyAssignments: { other: "test-route" } }, label), undefined);
  assert.equal(agyProfileRef({ agyProxyAssignments: { [label]: " Test-Route " } }, label), "test-route");
  for (const assignments of [null, undefined, [], "test-route"]) {
    assert.throws(() => agyProfileRef({ agyProxyAssignments: assignments }, label), /Antigravity agyProxyAssignments/);
  }
  for (const assignment of [null, undefined, 123, "", "direct", "test-sing-box", "../test"]) {
    assert.throws(() => agyProfileRef({ agyProxyAssignments: { [label]: assignment } }, label), /Antigravity.*invalid proxy reference/);
  }
});

test("Antigravity without a proxy binding uses the admitted launcher directly", async () => {
  for (const platform of ["linux", "darwin"]) {
    const invocation = await prepareAgyNativeRoute({
      ...routed, platform, config: { agyProxyProfiles: config.agyProxyProfiles }, profileRef: undefined,
    }, unexpectedRoute);
    assert.deepEqual(invocation, { command: artifact.launcher, args });
  }
});

test("Antigravity uses its own proxy endpoint with the shared strict Linux launcher", async () => {
  const launch = { command: "/usr/bin/python3", args: ["route-fixture", "--", artifact.launcher, ...args] };
  const expected = { ...launch, proxyUrl: "socks5h://127.0.0.1:11080" };
  const deps = {
    ...unexpectedRoute,
    prepareClaudeNativeRouteImpl: async (route) => {
      assert.deepEqual(route, {
        profile: { label, profileRef: "test-route", socksHost: "127.0.0.1", ...profile, denyDatagrams: true },
        command: artifact.launcher,
        args,
        platform: "linux",
      });
      return launch;
    },
  };
  assert.deepEqual(await prepareAgyNativeRoute(routed, deps), expected);
  assert.deepEqual(await prepareAgyNativeRoute({
    ...routed, config: { agyProxyProfiles: config.agyProxyProfiles },
  }, deps), expected, "A remembered proxy remains in force when its assignment entry is absent");
});

test("Antigravity formats an IPv6 SOCKS URL and disallows the DNS port", async () => {
  const input = (socksPort) => ({
    ...routed, config: { ...config, agyProxyProfiles: { "test-route": { ...profile, socksHost: "::1", socksPort } } },
  });
  const invocation = await prepareAgyNativeRoute(input(11080), {
    ...unexpectedRoute,
    prepareClaudeNativeRouteImpl: ({ command, args }) => ({ command, args }),
  });
  assert.equal(invocation.proxyUrl, "socks5h://[::1]:11080");
  await assert.rejects(prepareAgyNativeRoute(input(53), unexpectedRoute), /Antigravity.*cannot use TCP port 53/);
});

test("Antigravity macOS checks the assigned IPv4 SOCKS exit and hands it to the admitted launcher", async () => {
  const probes = [];
  const invocation = await prepareAgyNativeRoute({ ...routed, platform: "darwin" }, {
    ...unexpectedRoute,
    checkClaudeRouteExitImpl: async (profile) => { probes.push(profile); },
  });
  assert.deepEqual(probes, [{ label, profileRef: "test-route", socksHost: "127.0.0.1", ...profile }]);
  assert.deepEqual(invocation, { command: artifact.launcher, args, proxyUrl: "socks5h://127.0.0.1:11080" });
  assert.equal(invocation.args, args);
});

test("Antigravity macOS rejects wrong listener addresses and failed exit checks", async () => {
  const mac = { ...routed, platform: "darwin" };
  await assert.rejects(prepareAgyNativeRoute({
    ...mac, config: { ...config, agyProxyProfiles: { "test-route": { ...profile, socksHost: "::1" } } },
  }, unexpectedRoute), /Antigravity.*requires a SOCKS listener at 127.0.0.1 on macOS/);
  await assert.rejects(prepareAgyNativeRoute({
    ...mac, config: { ...config, agyProxyProfiles: { "test-route": { ...profile, socksPort: 53 } } },
  }, unexpectedRoute), /Antigravity.*cannot use TCP port 53/);
  for (const code of ["proxy_unavailable", "proxy_exit_mismatch"]) {
    const cause = Object.assign(new Error("Shared route failure"), { code });
    await assert.rejects(prepareAgyNativeRoute(mac, {
      ...unexpectedRoute,
      checkClaudeRouteExitImpl: async () => { throw cause; },
    }), {
      message: /Antigravity proxy test-route for pilot could not be verified.*SOCKS tunnel and expected exit IPs/,
      cause,
    });
  }
});

test("Antigravity denies changed bindings, absent profiles and unsupported platforms", async () => {
  for (const profileRef of [undefined, "other-route"]) {
    await assert.rejects(prepareAgyNativeRoute({ ...routed, profileRef }, unexpectedRoute), /Antigravity.*different enrolled proxy binding/);
  }
  await assert.rejects(prepareAgyNativeRoute({
    ...routed, config: { ...config, agyProxyProfiles: {} },
  }, unexpectedRoute), /Antigravity.*valid agyProxyProfiles entry/);
  await assert.rejects(prepareAgyNativeRoute({
    ...routed, config: { ...config, agyProxyProfiles: { "test-route": { ...profile, socksHost: "192.0.2.1" } } },
  }, unexpectedRoute), /Antigravity.*valid agyProxyProfiles entry/);
  await assert.rejects(prepareAgyNativeRoute({
    ...routed, profileRef: "0", config: { agyProxyProfiles: [profile] },
  }, unexpectedRoute), /Antigravity.*valid agyProxyProfiles entry/);
  await assert.rejects(prepareAgyNativeRoute({ ...routed, platform: "win32" }, unexpectedRoute), /Antigravity.*Linux or macOS privacy runtime/);
  await assert.rejects(prepareAgyNativeRoute({
    ...routed, platform: "win32", config: {}, profileRef: undefined,
  }, unexpectedRoute), /Antigravity.*Linux or macOS privacy runtime/);
});

test("Antigravity strict nft rules block other TCP and UDP in a private network namespace", {
  skip: process.platform !== "linux" || process.env.AIMGR_TEST_AGY_NATIVE_ROUTE !== "1",
}, () => {
  const fixture = fileURLToPath(new URL("./agy-linux-route-fixture.py", import.meta.url));
  execFileSync("/usr/bin/unshare", ["--net", "--", "/usr/bin/python3", "-B", fixture], { stdio: "inherit", timeout: 15000 });
});

test("Antigravity reports an unavailable or mismatched native route without falling back", async () => {
  for (const code of ["native_proxy_unavailable", "native_proxy_mismatch", "proxy_unavailable", "proxy_exit_mismatch"]) {
    const cause = Object.assign(new Error("Shared route failure"), { code });
    await assert.rejects(prepareAgyNativeRoute(routed, {
      ...unexpectedRoute,
      prepareClaudeNativeRouteImpl: async () => { throw cause; },
    }), {
      message: /Antigravity proxy test-route for pilot could not be verified.*installed Linux route.*SOCKS tunnel/,
      cause,
    });
  }
});
