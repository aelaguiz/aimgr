import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import net from "node:net";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { createClaudeTransport } from "../../src/network/claude-transport.js";
import { listen } from "./socks-fixture.js";

test("actual OpenSSH preserves origin errors and stops the operation on tunnel loss", {
  skip: process.env.AIMGR_TEST_SSH !== "1", timeout: 30000,
}, async (t) => {
  assert.equal(process.platform, "linux");
  const exec = promisify(execFile);
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "aimgr-ssh-test-"));
  const key = path.join(root, "key");
  const authorized = path.join(os.homedir(), ".ssh", "authorized_keys");
  const children = [];
  const transports = [];
  let addedLine;
  const origin = http.createServer((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ip: "127.0.0.1", path: req.url }));
  });
  t.after(async () => {
    for (const transport of transports) await transport.close();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, "exit"); child.kill(); await exited;
      }
    }
    if (addedLine) {
      const contents = await fs.readFile(authorized, "utf8");
      await fs.writeFile(authorized, contents.split("\n").filter(line => line !== addedLine).join("\n"), { mode: 0o600 });
    }
    origin.closeAllConnections();
    await new Promise(resolve => origin.close(resolve));
    await fs.rm(root, { recursive: true, force: true });
  });
  const originPort = await listen(origin);
  const reserve = net.createServer();
  const socksPort = await listen(reserve);
  await new Promise(resolve => reserve.close(resolve));
  await exec("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
  const pubkey = (await fs.readFile(`${key}.pub`, "utf8")).trim();
  addedLine = `restrict,port-forwarding ${pubkey}`;
  await fs.appendFile(authorized, `\n${addedLine}\n`, { mode: 0o600 });
  const hostKey = (await fs.readFile("/etc/ssh/ssh_host_ed25519_key.pub", "utf8")).trim();
  const knownHosts = path.join(root, "known_hosts");
  await fs.writeFile(knownHosts, `127.0.0.1 ${hostKey}\n`);
  const start = async () => {
    const child = spawn("ssh", ["-N", "-D", `127.0.0.1:${socksPort}`, "-i", key,
      "-oIdentitiesOnly=yes", "-oForwardAgent=no", "-oBatchMode=yes", "-oExitOnForwardFailure=yes",
      "-oStrictHostKeyChecking=yes", `-oUserKnownHostsFile=${knownHosts}`, "127.0.0.1"],
    { stdio: ["ignore", "ignore", "pipe"], env: { ...process.env, SSH_AUTH_SOCK: "" } });
    children.push(child);
    let error = "";
    child.stderr.on("data", chunk => { error += chunk; });
    for (let n = 0; n < 100; n++) {
      assert.equal(child.exitCode, null, error);
      const ready = await new Promise(resolve => {
        const socket = net.connect(socksPort, "127.0.0.1");
        socket.once("connect", () => { socket.destroy(); resolve(true); });
        socket.once("error", () => resolve(false));
      });
      if (ready) return child;
      await delay(25);
    }
    throw new Error(`SSH SOCKS listener did not start: ${error}`);
  };
  const profile = { label: "ssh-test", profileRef: "ssh-test", socksHost: "127.0.0.1", socksPort,
    expectedExits: ["127.0.0.1"], exitCheckUrl: `http://127.0.0.1:${originPort}/exit` };
  const create = () => {
    const transport = createClaudeTransport(profile, { timeoutMs: 2000, healthIntervalMs: 50 });
    transports.push(transport);
    return transport;
  };
  const ssh = await start();
  const transport = create();
  assert.equal((await transport.fetch(profile.exitCheckUrl)).status, 200);
  const unused = net.createServer();
  const refusedPort = await listen(unused);
  await new Promise(resolve => unused.close(resolve));
  await assert.rejects(transport.fetch(`http://127.0.0.1:${refusedPort}/origin-refused`));
  assert.equal(transport.failure, null, "origin refusal must not disable a healthy proxy");
  assert.equal((await transport.fetch(profile.exitCheckUrl)).status, 200);
  ssh.kill("SIGSTOP");
  t.after(() => { try { ssh.kill("SIGCONT"); } catch {} });
  const deadline = Date.now() + 5000;
  while (!transport.failure && Date.now() < deadline) await delay(25);
  assert.equal(transport.failure?.code, "proxy_unavailable", "hung SSH is detected while idle");
  ssh.kill("SIGCONT");
  await assert.rejects(transport.fetch(profile.exitCheckUrl), { code: "proxy_unavailable" });
  const recovered = create();
  assert.equal((await recovered.fetch(profile.exitCheckUrl)).status, 200);
  const exited = once(ssh, "exit"); ssh.kill(); await exited;
  await start();
  await assert.rejects(recovered.fetch(profile.exitCheckUrl), { code: "proxy_unavailable" });
  assert.equal((await create().fetch(profile.exitCheckUrl)).status, 200);
});
