#!/usr/bin/env node
// Actual official client against a loopback model, using only disposable data.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import zlib from "node:zlib";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";

assert(fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST") && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync("/opt/aimgr-state-audit/codex-m1-fixtures/work-directories-");
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC", "base64");
const results = [];
for (const protectedLaunch of [false, true]) {
  const name = protectedLaunch ? "protected" : "stock";
  const homeDir = path.join(root, name), shared = path.join(homeDir, ".codex");
  const cwd = path.join(homeDir, "workspace/current");
  fs.mkdirSync(shared, { recursive: true }); fs.mkdirSync(cwd, { recursive: true });
  const temporary = fs.mkdtempSync(`/tmp/aim-work-files-${name}-`);
  const screenshot = path.join(homeDir, process.platform === "linux" ? "Pictures/Screenshots" : "Screen captures"), extra = path.join(root, `${name}-extra-work`);
  const areas = [path.join(homeDir, "workspace/sibling project"), temporary, path.join(homeDir, "Downloads"), screenshot, extra];
  const macTemporary = process.platform === "darwin" ? fs.mkdtempSync(path.join(
    spawnSync("/usr/bin/getconf", ["DARWIN_USER_TEMP_DIR"], { encoding: "utf8" }).stdout.trim(), "aim-screenshot-thumbnail-")) : null;
  if (macTemporary) areas.push(macTemporary);
  writeAimgrConfig({ homeDir, config: { codexWorkingDirectories: [extra] } });
  if (process.platform === "darwin") {
    const prefs = path.join(homeDir, "Library/Preferences/com.apple.screencapture.plist");
    fs.mkdirSync(path.dirname(prefs), { recursive: true });
    fs.writeFileSync(prefs, `<?xml version="1.0"?><plist version="1.0"><dict><key>location</key><string>${screenshot}</string></dict></plist>`);
  }
  const privateImage = path.join(homeDir, "Private/personal.png");
  const otherAccount = path.join(homeDir, ".aimgr/accounts/openai-codex/another-account/private.png");
  const selected = path.join(root, `${name}-outside/selected.png`), neighbor = path.join(path.dirname(selected), "neighbor.png");
  for (const file of [privateImage, otherAccount, selected, neighbor]) {
    fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png);
  }
  const alias = path.join(cwd, "outside-link.png"); fs.symlinkSync(privateImage, alias);
  const images = areas.map(area => path.join(area, "created after launch/image.png"));
  const labels = ["sibling-workspace", "tmp", "downloads", "screenshots", "extra-directory", ...(macTemporary ? ["mac-temporary-screenshot"] : []), "explicit-file", "private-file", "other-account", "outside-symlink", "unselected-sibling"];
  const paths = [...images, selected, privateImage, otherAccount, alias, neighbor];
  const requests = [];
  const server = http.createServer(async (req, res) => {
    if (req.method === "GET") { res.writeHead(200, { "content-type": "application/json" }); res.end('{"models":[]}'); return; }
    try {
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      const body = JSON.parse(bytes.toString()); requests.push(body);
      // The first model request proves vendor startup completed before these
      // sibling folders, images and output files first exist.
      if (requests.length === 1) for (const file of images) {
        fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, png);
      }
      const index = requests.length - 1;
      let item;
      if (index < paths.length) item = { type: "function_call", call_id: labels[index], name: "view_image", arguments: JSON.stringify({ path: paths[index] }) };
      else if (index === paths.length) {
        const files = areas.map(area => path.join(area, "created after launch/written.txt"));
        const script = `from pathlib import Path; [Path(p).write_text("SYNTHETIC_WORK_WRITE\\n") for p in ${JSON.stringify(files)}]`;
        item = { type: "function_call", call_id: "write-work-files", name: "exec_command",
          arguments: JSON.stringify({ cmd: "/usr/bin/python3 -c '" + script.replaceAll("'", "'\\''") + "'", yield_time_ms: 1000, max_output_tokens: 200 }) };
      }
      else item = { type: "message", role: "assistant", id: "done", content: [{ type: "output_text", text: "Synthetic work directory checks finished." }] };
      const id = `response-${requests.length}`;
      const events = [{ type: "response.created", response: { id } }, { type: "response.output_item.done", item },
        { type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } }];
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  fs.writeFileSync(path.join(shared, "config.toml"), `model="gpt-5.4"\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\n[model_providers.fixture]\nname="Fixture"\nbase_url="http://127.0.0.1:${server.address().port}"\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
  const env = { HOME: homeDir, CODEX_HOME: shared, PATH: "/opt/aimgr-state-audit/node/bin:/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" };
  const args = ["exec", "--image", selected, "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Use the synthetic work files."];
  let invocation, child, timer;
  const stdout = [], stderr = [];
  try {
    if (protectedLaunch) {
      const prepared = { ...prepareCodexAccountState({ homeDir, env, environment: readCodexEnvironment(), accountId: "api-provider:deepseek", label: "fixture" }), keyBacked: true };
      invocation = await prepareCodexNativeInvocation({ prepared, homeDir, cwd, env, args });
    }
    child = spawn(invocation?.command ?? "/opt/aimgr-state-audit/bin/codex", invocation?.args ?? args,
      { cwd, env: invocation?.env ?? env, stdio: ["ignore", "pipe", "pipe", ...(invocation ? [invocation.environmentFd] : [])], detached: true });
    invocation?.closeEnvironment(); child.stdout.on("data", chunk => stdout.push(chunk)); child.stderr.on("data", chunk => stderr.push(chunk));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 60000);
    const [code, signal] = await once(child, "close"); clearTimeout(timer);
    fs.writeFileSync(path.join(root, `${name}-stdout.log`), Buffer.concat(stdout));
    fs.writeFileSync(path.join(root, `${name}-stderr.log`), Buffer.concat(stderr));
    const outputs = new Map(requests.flatMap(request => request.input ?? [])
      .filter(item => ["function_call_output", "custom_tool_call_output"].includes(item.type)).map(item => [item.call_id, item.output]));
    fs.writeFileSync(path.join(root, `${name}-tool-results.json`), JSON.stringify([...outputs], null, 2));
    assert.equal(code, 0, `${name} failed; see ${root}`); assert.equal(signal, null);
    const checks = [];
    for (let index = 0; index < labels.length; index++) {
      const output = outputs.get(labels[index]); assert.notEqual(output, undefined, `missing ${labels[index]}`);
      const text = JSON.stringify(output), allowed = !protectedLaunch || index < images.length + 1;
      if (allowed) assert.match(text, /input_image|data:image\//, `${name} ${labels[index]} did not return an image: ${text}`);
      else { assert.match(text, /[Pp]ermission denied|[Oo]peration not permitted/, `${labels[index]} denial missing: ${text}`); assert.doesNotMatch(text, /data:image\//); }
      checks.push({ operation: labels[index], result: allowed ? "image returned" : "read denied" });
    }
    for (const area of areas) assert.equal(fs.readFileSync(path.join(area, "created after launch/written.txt"), "utf8"), "SYNTHETIC_WORK_WRITE\n");
    assert(outputs.has("write-work-files"), "actual shell tool response required");
    const row = { launch: name, exitCode: code, checks, shellWrittenFiles: areas.length, createdAfterStartup: true };
    results.push(row); console.log(JSON.stringify(row));
  } finally {
    clearTimeout(timer);
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await invocation?.close(); fs.rmSync(temporary, { recursive: true, force: true });
    if (macTemporary) fs.rmSync(macTemporary, { recursive: true, force: true });
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
}
fs.writeFileSync(path.join(root, "results.json"), JSON.stringify(results, null, 2));
console.log(`PASS stock/protected native work directories; evidence: ${root}`);
