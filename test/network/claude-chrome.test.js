import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import net from "node:net";
import { getCACertificates, setDefaultCACertificates } from "node:tls";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { closeClaudeLoginTabs, connectCdp, validateClaudeChrome } from "../../src/browser/claude-cdp.js";
import { listen } from "./socks-fixture.js";
import { writeAimgrConfig } from "../../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../../src/coordination/redis-store.js";
import { resolveAimgrClaudeLabelHomeDir } from "../../src/io/paths.js";
import { runCli } from "../helpers/cli-runner.js";
import { FakeRedisClient } from "../helpers/fake-redis.js";

test("existing separate Chrome instances keep account routes/state and fail on tunnel loss", { skip: process.env.AIMGR_TEST_CHROME !== "1", timeout: 90000 }, async (t) => {
  assert.ok(["linux", "darwin"].includes(process.platform));
  const mac = process.platform === "darwin";
  if (mac) assert.equal(os.homedir(), "/Users/ec2-user", "Mac runtime testing is rental-only");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-chrome-test-"));
  const children = [];
  const controls = [];
  const arrivals = [];
  const managed = [];
  let units = [];
  const exec = promisify(execFile);
  const keyPath = path.join(root, "synthetic.key");
  const certPath = path.join(root, "synthetic.crt");
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
    "-keyout", keyPath, "-out", certPath, "-subj", "/CN=claude.ai", "-addext", "subjectAltName=DNS:claude.ai,DNS:claude.com,DNS:api.ipify.org"]);
  const cert = await fs.readFile(certPath);
  const originalCAs = getCACertificates("default");
  setDefaultCACertificates([...originalCAs, cert.toString()]);
  t.after(() => setDefaultCACertificates(originalCAs));
  const spki = createHash("sha256").update(new X509Certificate(cert).publicKey.export({ type: "spki", format: "der" })).digest("base64");
  const handler = (req, res) => {
    arrivals.push({ source: req.socket.remoteAddress, path: req.url, cookie: req.headers.cookie });
    if (req.url === "/exit" || req.headers.host === "api.ipify.org") { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: req.socket.remoteAddress })); return; }
    if (req.url === "/redirect") { res.writeHead(302, { location: "/login" }); res.end(); return; }
    res.setHeader("content-type", "text/html");
    res.setHeader("set-cookie", `account=${req.socket.remoteAddress}; Path=/`);
    res.end(`<body>${req.socket.remoteAddress}</body>`);
  };
  const origin = http.createServer(handler);
  const tlsOrigin = https.createServer({ key: await fs.readFile(keyPath), cert }, handler);
  const originPort = await listen(origin);
  const tlsPort = await listen(tlsOrigin);

  const addresses = mac ? ["127.0.0.2", "127.0.0.3", "198.18.0.13"] : ["198.18.0.13"];
  for (const ip of addresses) await exec("sudo", mac ? ["ifconfig", "lo0", "alias", ip, "up"] : ["ip", "address", "add", `${ip}/32`, "dev", "lo"]);
  const destinations = { "login.mock.test": originPort, "198.18.0.13": originPort, "claude.ai": tlsPort, "claude.com": tlsPort, "api.ipify.org": tlsPort };
  const startProxy = async (sourceAddress, port = 0) => {
    const script = `import { startSocks } from ${JSON.stringify(new URL("./socks-fixture.js", import.meta.url).href)}; const proxy = await startSocks(${JSON.stringify({ sourceAddress, destinations, port })}); console.log(proxy.port);`;
    const child = spawn(process.execPath, ["--input-type=module", "-e", script], { stdio: ["ignore", "pipe", "inherit"] });
    const bound = Number((await once(child.stdout, "data"))[0].toString().trim());
    return { port: bound, async stop() { if (child.exitCode !== null || child.signalCode !== null) return; const done = once(child, "exit"); child.kill(); await done; } };
  };
  let a = await startProxy("127.0.0.2");
  const b = await startProxy("127.0.0.3");
  t.after(async () => {
    if (mac) for (const unit of units) await exec("sudo", ["launchctl", "bootout", `system/com.aimgr.claude-proxy.${unit}`]).catch(() => {});
    else if (units.length) await exec("sudo", ["systemctl", "stop", ...units]);
    await Promise.all(managed);
    for (const cdp of controls) cdp.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit");
        child.kill();
        const timer = setTimeout(() => child.kill("SIGKILL"), 2000);
        await exited;
        clearTimeout(timer);
      }
    }
    await a.stop(); await b.stop();
    for (const ip of addresses) await exec("sudo", mac ? ["ifconfig", "lo0", "-alias", ip] : ["ip", "address", "del", `${ip}/32`, "dev", "lo"]);
    for (const server of [origin, tlsOrigin]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
    await fs.rm(root, { recursive: true, force: true });
  });
  const launch = async (label, socks) => {
    const reserve = net.createServer();
    const cdpPort = await listen(reserve);
    await new Promise((resolve) => reserve.close(resolve));
    const userDataDir = path.join(root, label);
    const proxy = `socks5://127.0.0.1:${socks.port}`;
    await fs.mkdir(path.join(userDataDir, "Default"), { recursive: true });
    await fs.writeFile(path.join(userDataDir, "Default", "Preferences"), JSON.stringify({
      proxy: { mode: "fixed_servers", server: proxy, bypass_list: "" },
      webrtc: { ip_handling_policy: "disable_non_proxied_udp", multiple_routes_enabled: false, nonproxied_udp_enabled: false },
      dns_prefetching: { enabled: false }, net: { network_prediction_options: 2 },
    }));
    const child = spawn(process.env.AIMGR_TEST_CHROME_BIN ?? "google-chrome", [
      `--ignore-certificate-errors-spki-list=${spki}`, "--headless=new", `--user-data-dir=${userDataDir}`,
      `--proxy-server=${proxy}`, "--host-resolver-rules=MAP * ~NOTFOUND , EXCLUDE 127.0.0.1",
      "--force-webrtc-ip-handling-policy=disable_non_proxied_udp", "--disable-quic", "--disable-sync",
      "--no-first-run", "--no-default-browser-check", `--remote-debugging-port=${cdpPort}`, "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr.on("data", (part) => { stderr = (stderr + part).slice(-4000); });
    children.push(child);
    let version;
    for (let attempt = 0; attempt < 60; attempt++) {
      if (child.exitCode !== null) throw new Error(`Chrome exited: ${stderr}`);
      try { version = await (await fetch(`http://127.0.0.1:${cdpPort}/json/version`)).json(); break; }
      catch { await delay(100); }
    }
    assert.ok(version, `Chrome CDP did not start: ${stderr}`);
    const profile = { label, profileRef: `${mac ? "mac" : "login"}_${label}`, socksHost: "127.0.0.1", socksPort: socks.port, expectedExits: [label === "a" ? "127.0.0.2" : "127.0.0.3"], exitCheckUrl: `http://198.18.0.13:${originPort}/exit`, chrome: { userDataDir, cdpPort } };
    await validateClaudeChrome(profile);
    const cdp = await connectCdp(version.webSocketDebuggerUrl);
    controls.push(cdp);
    const receiptPath = path.join(root, `${label}-login-tabs.jsonl`);
    await exec(process.execPath, [fileURLToPath(new URL("../../scripts/claude-login-browser.mjs", import.meta.url)), "https://claude.ai/redirect"], {
      env: { ...process.env, AIMGR_CLAUDE_LOGIN_PROFILE: JSON.stringify(profile), AIMGR_CLAUDE_LOGIN_TABS: receiptPath },
    });
    const { targetId } = JSON.parse((await fs.readFile(receiptPath, "utf8")).trim());
    const { sessionId } = await cdp.call("Target.attachToTarget", { targetId, flatten: true });
    const navigate = async (pathname) => {
      const result = await cdp.call("Page.navigate", { url: `https://claude.ai${pathname}` }, sessionId);
      if (result.errorText) return { error: result.errorText };
      for (let attempt = 0; attempt < 60; attempt++) {
        const body = await cdp.call("Runtime.evaluate", { expression: "document.body?.innerText", returnByValue: true }, sessionId);
        const text = body.result?.value;
        if (text?.includes("127.0.0.")) return { text };
        await delay(50);
      }
      throw new Error("Synthetic login page did not load");
    };
    return { profile, navigate, cdp, targetId, receiptPath, endpoint: version.webSocketDebuggerUrl };
  };
  const [chromeA, chromeB] = await Promise.all([launch("a", a), launch("b", b)]);
  const [firstA, firstB] = await Promise.all([chromeA.navigate("/redirect"), chromeB.navigate("/redirect")]);
  assert.equal(firstA.text, "127.0.0.2");
  assert.equal(firstB.text, "127.0.0.3");
  await assert.rejects(validateClaudeChrome({ ...chromeA.profile, chrome: chromeB.profile.chrome }), { code: "chrome_binding_mismatch" });
  await chromeA.navigate("/again");
  assert.ok(arrivals.some((r) => r.source === "127.0.0.2" && r.cookie?.includes("account=127.0.0.2")));
  for (const source of ["127.0.0.2", "127.0.0.3"]) {
    assert.ok(arrivals.find(r => r.path === "/redirect" && r.source === source)?.cookie?.includes(
      "anthropic-consent-preferences=" + encodeURIComponent(JSON.stringify({ analytics: false, marketing: false })),
    ), "the browser's existing telemetry opt-out precedes its first login request");
  }
  assert.ok(arrivals.some(r => r.path === "/redirect" && r.source === "127.0.0.2"));
  assert.ok(arrivals.some(r => r.path === "/redirect" && r.source === "127.0.0.3"));
  // Exercise actual AIM login, its native wrapper and BROWSER cleanup together.
  // Only the Claude executable and credential store are synthetic here.
  const home = path.join(root, "managed-home");
  const client = new FakeRedisClient();
  const keyPrefix = "aimgr:browser-native-login";
  const profiles = Object.fromEntries([chromeA, chromeB].map(chrome => [chrome.profile.profileRef, chrome.profile]));
  writeAimgrConfig({ homeDir: home, config: { redis: { url: "redis://fake:6379", keyPrefix }, claudeProxyProfiles: profiles } });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: ["a", "b"].map(label => ({
    provider: "anthropic", label, identity: {}, credential: {},
    policy: { expect: { email: `${label}@example.test` }, egress: { profileRef: `${mac ? "mac" : "login"}_${label}` } },
    health: { status: "candidate", reason: "credential_missing" },
  })) }, { updatedBy: "synthetic-login-test" });
  const manifestPath = path.join(root, "native-manifest.json");
  await fs.writeFile(manifestPath, JSON.stringify({ user: process.env.USER, profiles: Object.fromEntries(
    Object.entries(profiles).map(([name, profile], index) => [name, { ...profile, ...(mac
      ? { gid: 64084 + index, interface: `utun${84 + index}`, subnetIndex: 84 + index }
      : { redirectPort: 15088 + index }) }]),
  ) }));
  units = Object.keys(profiles).map(name => mac ? name : `aimgr-claude-proxy-${name}.service`);
  await exec("sudo", ["bash", fileURLToPath(new URL(`../../scripts/install-claude-proxy-${mac ? "macos" : "linux"}.sh`, import.meta.url)), manifestPath]);
  const loginFixture = path.join(root, "synthetic-claude-login.mjs");
  const finish = path.join(root, "finish-login");
  // The actual 2.1.316 client starts OAuth at claude.com, then redirects to
  // claude.ai. Account routing must not depend on a hardcoded login hostname.
  await fs.writeFile(loginFixture, `#!${process.execPath}\nimport { spawnSync } from "node:child_process"; import fs from "node:fs"; const p = JSON.parse(process.env.AIMGR_CLAUDE_LOGIN_PROFILE); const child = spawnSync(process.execPath, [process.env.BROWSER, "https://claude.com/managed-login-" + p.label], { stdio: "inherit" }); if (child.status !== 0) process.exit(1); setInterval(() => { if (fs.existsSync(${JSON.stringify(finish)})) process.exit(1); }, 50);`, { mode: 0o700 });
  const resolver = () => loginFixture;
  resolver.prepareClaudeCliLaunchImpl = options => options;
  managed.push(...["a", "b"].map(label => runCli(["login", label, "--home", home], {
    env: { ...process.env, NODE_EXTRA_CA_CERTS: certPath }, resolveExecutableOnPathImpl: resolver,
    connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
  }).then(() => null, error => { t.diagnostic(`managed ${label}: ${error.message}`); return error; })));
  const managedReceipt = label => path.join(resolveAimgrClaudeLabelHomeDir({ homeDir: home, label }), ".login-staging", "login-tabs.jsonl");
  let loginTargets;
  for (let n = 0; n < 100; n++) {
    try { loginTargets = await Promise.all(["a", "b"].map(async label => JSON.parse((await fs.readFile(managedReceipt(label), "utf8")).trim()))); if (arrivals.some(r => r.path === "/managed-login-a") && arrivals.some(r => r.path === "/managed-login-b")) break; } catch {}
    await delay(50);
  }
  assert.equal(loginTargets?.length, 2);
  assert.ok(arrivals.some(r => r.path === "/managed-login-a" && r.source === "127.0.0.2"));
  assert.ok(arrivals.some(r => r.path === "/managed-login-b" && r.source === "127.0.0.3"));
  const receiptPath = chromeA.receiptPath;
  const oldPort = a.port;
  await a.stop();
  const failed = await chromeA.navigate("/after-tunnel-loss");
  assert.match(failed.error, /PROXY_CONNECTION_FAILED|SOCKS_CONNECTION_FAILED/);
  assert.equal(arrivals.filter(row => row.path === "/after-tunnel-loss").length, 0, "failed navigation produces no origin request; B health checks may continue");
  assert.equal((await chromeB.navigate("/still-works")).text, "127.0.0.3");
  a = await startProxy("127.0.0.2", oldPort);
  assert.match((await managed[0]).message, /cancelled or failed/);
  const liveA = await chromeA.cdp.call("Target.getTargets");
  const liveB = await chromeB.cdp.call("Target.getTargets");
  assert.equal(liveA.targetInfos.some(target => target.targetId === loginTargets[0].targetId), false, "actual failed login closes its own tab despite rapid repair");
  assert.ok(liveA.targetInfos.some(target => target.targetId === chromeA.targetId), "unrelated A tab remains open");
  assert.ok(liveB.targetInfos.some(target => target.targetId === loginTargets[1].targetId), "healthy B login remains open");
  const attempts = arrivals.filter(r => r.path === "/managed-login-a").length;
  await delay(400);
  assert.equal(arrivals.filter(r => r.path === "/managed-login-a").length, attempts, "failed sign-in is not automatically replayed");
  await fs.writeFile(finish, "done");
  assert.match((await managed[1]).message, /cancelled or failed/);
  await closeClaudeLoginTabs(receiptPath);
  const targets = await chromeA.cdp.call("Target.getTargets");
  assert.equal(targets.targetInfos.some((target) => target.targetId === chromeA.targetId), false, "failed login tab stays closed after the tunnel returns");
  assert.equal((await chromeB.navigate("/after-repair")).text, "127.0.0.3");
  assert.ok(arrivals.every(row => ["127.0.0.2", "127.0.0.3"].includes(row.source)), "no browser request reaches the origin directly");
});
