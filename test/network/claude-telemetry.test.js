import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { nativeProxyEnvironment } from "../../src/network/claude-native-route.js";
import { listen, startSocks } from "./socks-fixture.js";

// Synthetic credentials/content only. TLS terminates at this mock, never at a
// real provider. Normal certificate validation trusts this fixture's CA.
test("native telemetry positive control and opt-out preserve functional requests", {
  skip: process.env.AIMGR_TEST_TELEMETRY !== "1", timeout: 120000,
}, async (t) => {
  assert.equal(process.platform, "linux");
  const exec = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-telemetry-"));
  const helper = fileURLToPath(new URL("../../native/claude/linux_proxy.py", import.meta.url));
  const certPath = path.join(root, "mock.crt");
  const keyPath = path.join(root, "mock.key");
  const hosts = ["api.anthropic.com", "http-intake.logs.us5.datadoghq.com", "statsig.anthropic.com"];
  const marker = `# aimgr-synthetic-telemetry-${process.pid}`;
  const receipts = [];
  let mode = "positive";
  let socks;
  let tlsOrigin;
  let origin;
  t.after(async () => {
    await exec("sudo", ["systemctl", "stop", "aimgr-claude-proxy-telemetry_mock.service"]).catch(() => {});
    if (socks) await socks.stop();
    for (const server of [origin, tlsOrigin].filter(Boolean)) {
      server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    }
    // Remove only this fixture's lines; preserve concurrent host edits.
    await exec("sudo", ["sed", "-i", `/${marker}/d`, "/etc/hosts"]);
    for (const address of ["198.18.0.11", "198.18.0.12"]) await exec("sudo", ["ip", "address", "del", `${address}/32`, "dev", "lo"]).catch(() => {});
    await fs.rm(root, { recursive: true, force: true });
  });
  await exec("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-keyout", keyPath,
    "-out", certPath, "-subj", "/CN=api.anthropic.com", "-addext", `subjectAltName=${hosts.map(h => `DNS:${h}`).join(",")}`]);
  tlsOrigin = https.createServer({ key: await fs.readFile(keyPath), cert: await fs.readFile(certPath) }, async (req, res) => {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    receipts.push({ mode, host: req.headers.host, path: req.url, source: req.socket.remoteAddress });
    if (req.url.startsWith("/v1/messages")) {
      const body = JSON.parse(raw);
      const message = { id: "msg_telemetry", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } };
      const events = [
        { type: "message_start", message },
        { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
        { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "TELEMETRY_MOCK_DONE" } },
        { type: "content_block_stop", index: 0 },
        { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 5 } },
        { type: "message_stop" },
      ];
      if (body.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
        res.end();
      } else {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ ...message, content: [{ type: "text", text: "TELEMETRY_MOCK_DONE" }], stop_reason: "end_turn" }));
      }
    } else {
      res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ success: true }));
    }
  });
  const tlsPort = await listen(tlsOrigin);
  origin = http.createServer((req, res) => { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ ip: req.socket.remoteAddress })); });
  const originPort = await listen(origin, "0.0.0.0");
  socks = await startSocks({ sourceAddress: "127.0.0.2", destinations: { "198.18.0.11": tlsPort, "198.18.0.12": originPort } });
  for (const address of ["198.18.0.11", "198.18.0.12"]) await exec("sudo", ["ip", "address", "add", `${address}/32`, "dev", "lo"]);
  const hostsPatch = path.join(root, "hosts-patch");
  await fs.writeFile(hostsPatch, `198.18.0.11 ${hosts.join(" ")} ${marker}\n`);
  await exec("sudo", ["sh", "-c", 'cat "$1" >> /etc/hosts', "sh", hostsPatch]);
  const manifest = path.join(root, "manifest.json");
  await fs.writeFile(manifest, JSON.stringify({ user: process.env.USER, profiles: {
    telemetry_mock: { socksPort: socks.port, redirectPort: 15087, expectedExits: ["127.0.0.2"], exitCheckUrl: `http://198.18.0.12:${originPort}/exit` },
  } }));
  await exec("sudo", ["bash", fileURLToPath(new URL("../../scripts/install-claude-proxy-linux.sh", import.meta.url)), manifest]);
  for (mode of ["positive", "opt-out"]) {
    const home = path.join(root, mode);
    await fs.mkdir(home);
    const env = { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
      ANTHROPIC_API_KEY: "sk-ant-api03-synthetic-telemetry-fixture", NODE_EXTRA_CA_CERTS: certPath, API_TIMEOUT_MS: "5000" };
    for (const key of ["DISABLE_TELEMETRY", "DISABLE_ERROR_REPORTING", "DO_NOT_TRACK", "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC", "ANTHROPIC_BASE_URL", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) delete env[key];
    const result = await exec("python3", [helper, "run", "telemetry_mock", JSON.stringify({ socksHost: "127.0.0.1", socksPort: socks.port, expectedExits: ["127.0.0.2"] }), "--", process.env.AIMGR_TEST_CLAUDE_BIN,
      "-p", "Reply with the synthetic marker.", "--model", "claude-sonnet-4-6", "--dangerously-skip-permissions", "--output-format", "json"],
    { env: mode === "positive" ? env : nativeProxyEnvironment(env), cwd: home, timeout: 45000, maxBuffer: 128 * 1024 });
    assert.match(result.stdout, /TELEMETRY_MOCK_DONE/);
  }
  t.diagnostic(JSON.stringify({ receipts }));
  for (const mode of ["positive", "opt-out"]) assert.ok(receipts.some(r => r.mode === mode && r.path.startsWith("/v1/messages")));
  assert.ok(receipts.some(r => r.mode === "positive" && r.path.includes("event_logging")), "the positive control must observe real client analytics");
  assert.equal(receipts.filter(r => r.mode === "opt-out" && (r.path.includes("event_logging") || r.host.includes("datadoghq"))).length, 0);
  assert.ok(receipts.every(r => r.source === "127.0.0.2"));
});
