#!/usr/bin/env node
// Exact official client, synthetic model server, and synthetic account only.
// Linux uses the offsite loopback-only namespace; the rented Mac retains its
// independent outbound deny policy. Every service here terminates locally.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import https from "node:https";
import zlib from "node:zlib";
import { createHash } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { WebSocketServer } from "ws";
import { Agent, fetch as fixtureFetch } from "undici";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin, maintainLocalCodexCredential, logoutLocalCodexCredential, readLocalCodexCredential } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { main } from "../src/cli/main.js";
import { writeAimgrConfig } from "../src/config/aimgr-config.js";
import { connectRedisStore, importCredentialsSnapshot } from "../src/coordination/redis-store.js";
import { FakeRedisClient } from "../test/helpers/fake-redis.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
assert.ok(["linux", "darwin"].includes(process.platform));
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "exec-"));
const grantEnvironment = process.argv.includes("--environment-proof") ? process.env.AIMGR_SYNTHETIC_ENVIRONMENT : "";
assert.ok(["", "A", "B"].includes(grantEnvironment));
const initialRefresh = "SYNTHETIC_REFRESH" + (grantEnvironment ? "_" + grantEnvironment : "");
const rotatedRefresh = "SYNTHETIC_ROTATED_REFRESH" + (grantEnvironment ? "_" + grantEnvironment : "");
const certificate = path.join(root, "loopback-cert.pem"), certificateKey = path.join(root, "loopback-key.pem");
const authority = path.join(root, "authority.pem"), authorityKey = path.join(root, "authority-key.pem");
const authorityConfig = path.join(root, "authority.cnf");
const requestFile = path.join(root, "loopback.csr"), extensions = path.join(root, "loopback.ext");
const openssl = args => execFileSync("openssl", args, { stdio: "ignore" });
fs.writeFileSync(authorityConfig, "[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic AIM test authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n");
openssl(["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-config", authorityConfig,
  "-keyout", authorityKey, "-out", authority]);
openssl(["req", "-new", "-newkey", "rsa:2048", "-nodes", "-subj", "/CN=127.0.0.1",
  "-keyout", certificateKey, "-out", requestFile]);
fs.writeFileSync(extensions, "basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n");
openssl(["x509", "-req", "-in", requestFile, "-CA", authority, "-CAkey", authorityKey, "-set_serial", "1",
  "-days", "1", "-extfile", extensions, "-out", certificate]);
openssl(["verify", "-CAfile", authority, "-purpose", "sslserver", certificate]);
const privateFile = path.join(root, "ordinary-tool-input.txt");
const canary = "SYNTHETIC_ORDINARY_TOOL_ACCESS";
fs.writeFileSync(privateFile, canary, { mode: 0o600 });
const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const versionProbe = process.platform === "darwin" ? ["sw_vers", "-productVersion"] : ["lsb_release", "-rs"];
const chromePhase = process.argv.includes("--chrome");
const chrome = chromePhase && (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/opt/google/chrome/chrome"].find(file => fs.existsSync(file)));
if (chromePhase) assert.ok(chrome && fs.existsSync(chrome), "Stock Chrome is required for this phase");
let toolScript = `import json,os,pathlib,platform,subprocess,tempfile; print(json.dumps({"canary":pathlib.Path(${JSON.stringify(privateFile)}).read_text(),"release":platform.release(),"os_version":subprocess.check_output(${JSON.stringify(versionProbe)},text=True).strip(),"sdk_key":os.environ["OPENAI_API_KEY"]})); pathlib.Path("tool-output.txt").write_text("tool write succeeded")`;
if (chromePhase) {
  const chromeArgs = [chrome, "--headless", "--no-first-run", "--no-default-browser-check", "--disable-background-networking",
    "--disable-component-update", "--disable-crash-reporter", "--proxy-server=http://127.0.0.1:9", "--proxy-bypass-list=<-loopback>"];
  // A fresh synthetic profile and dead loopback proxy; Chrome's sandbox remains enabled.
  toolScript += `; profile=tempfile.mkdtemp(prefix="chrome-",dir=str(pathlib.Path.cwd())); result=subprocess.run(${JSON.stringify(chromeArgs)}+["--user-data-dir="+profile,"--dump-dom","data:text/html,<title>AIM_TOOL_ACCESS_OK</title>"],capture_output=True,text=True,timeout=25); assert result.returncode==0,(result.returncode,result.stderr); assert "AIM_TOOL_ACCESS_OK" in result.stdout; print("AIM_TOOL_ACCESS_OK")`;
}
const command = "/usr/bin/python3 -c " + shellQuote(toolScript);
const created = id => ({ type: "response.created", response: { id } });
const completed = id => ({ type: "response.completed", response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } });
const done = item => ({ type: "response.output_item.done", item });

async function coordinateOtherAccount({ homeDir, env, environment, options, token, claims, prepared, root }) {
  const otherId = options.accountId + "-B";
  const otherClaims = { ...claims, "https://api.openai.com/auth": { ...claims["https://api.openai.com/auth"], chatgpt_account_id: otherId } };
  const otherToken = `synthetic.${Buffer.from(JSON.stringify(otherClaims)).toString("base64url")}.signature`;
  const otherOptions = { homeDir, env, environment, accountId: otherId, label: "b" };
  saveLocalCodexLogin(otherOptions, { access: otherToken, idToken: otherToken, refresh: "SYNTHETIC_OTHER_REFRESH", accountId: otherId });
  const other = prepareCodexAccountState(otherOptions);
  const client = new FakeRedisClient(), keyPrefix = "synthetic:isolation:";
  writeAimgrConfig({ homeDir, config: { redis: { url: "redis://synthetic.invalid:6379", keyPrefix } } });
  const store = await connectRedisStore({ client, keyPrefix });
  await importCredentialsSnapshot(store, { credentials: [["a", options.accountId], ["b", otherId]].map(([label, accountId]) => ({
    provider: "openai-codex", label, identity: { accountId }, policy: { pool: { enabled: true } }, health: { status: "ready", reason: null },
    credential: { accountId, access: "SYNTHETIC_FOREIGN_ACCESS", refresh: "SYNTHETIC_FOREIGN_REFRESH", expiresAt: new Date(Date.now() + 3600_000).toISOString() },
  })) }, { updatedBy: "synthetic", observedAt: new Date().toISOString() });
  const authFile = path.join(prepared.accountRoot, "auth.json"), originalAuth = fs.readFileSync(authFile);
  const observations = [], usage = [];
  const command = async args => {
    const output = [], errors = []; let code = 0;
    await main([...args, "--home", homeDir], { env,
      connectRedisStoreImpl: () => connectRedisStore({ client, keyPrefix }),
      stdout: { write: text => output.push(text) }, stderr: { write: text => errors.push(text) }, setExitCode: value => { code = value; },
      fetchJsonWithTimeoutImpl: async (url, request) => {
        assert.equal(url, "https://chatgpt.com/backend-api/wham/usage");
        const id = request.headers["ChatGPT-Account-Id"];
        assert.ok([options.accountId, otherId].includes(id));
        assert.equal(request.headers.Authorization, "Bearer " + (id === options.accountId ? token : otherToken));
        usage.push({ accountId: id, localAuthority: true });
        return { ok: true, status: 200, json: async () => ({ plan_type: "plus", rate_limit: { allowed: true,
          primary_window: { used_percent: 1, limit_window_seconds: 18000, reset_at: Math.floor(Date.now() / 1000) + 3600 } } }) };
      } });
    observations.push({ args, code, output: output.join(""), errors: errors.join("") });
    assert.equal(code, 0, "Actual AIM coordination command succeeds: " + args.join(" "));
    assert.deepEqual(fs.readFileSync(authFile), originalAuth, "other account operations leave A's local grant unchanged");
    return output.join("");
  };
  return {
    async select(stage) {
      const selected = JSON.parse(await command(["codex", "use", "b"]));
      assert.equal(selected.activated.receipt.accountId, otherId);
      assert.equal(selected.activated.prepared.codexHome, other.codexHome);
      observations.push({ stage });
    },
    async duringTurn() {
      await command(["codex", "watch", "--once"]);
      await command(["status", "--json"]);
      await command(["auth", "maintain"]);
      await command(["codex", "logout", "b"]);
      assert.equal(readLocalCodexCredential(otherOptions).credential, null);
      const shared = await Promise.all(["a", "b"].map(label => client.get(store.keys.credential({ provider: "openai-codex", label }))));
      for (const row of shared) { assert.ok(!row.includes(token)); assert.ok(!row.includes(otherToken)); }
      fs.writeFileSync(path.join(root, path.basename(path.dirname(homeDir)) + "-coordination.private.json"), JSON.stringify({ observations, usage }, null, 2));
    },
  };
}

async function run(protectedLaunch, alias = false, builtin = null) {
  const replacedLogin = ["relogin", "logout"].includes(builtin);
  const lockProbe = builtin === "native-lock";
  const race = ["native-first", "aim-first"].includes(builtin) || replacedLogin || lockProbe;
  const needsRefresh = builtin === "refresh" || race;
  const name = (protectedLaunch ? "protected" : "control") + (alias ? "-alias" : "") + (builtin ? "-builtin-" + builtin : "");
  const homeDir = path.join(root, name, "home"), cwd = path.join(root, name, "project");
  fs.mkdirSync(path.join(homeDir, ".codex"), { recursive: true, mode: 0o700 }); fs.mkdirSync(cwd);
  const requests = [], errors = [], output = [], metadataRequests = [];
  let serverError, asyncError, refreshes = 0, rejectedInitialAuth = 0, aimTask, raceController;
  let releaseAim, releaseNative, aimEntered, nativeEntered;
  const aimGate = new Promise(resolve => { releaseAim = resolve; });
  const nativeGate = new Promise(resolve => { releaseNative = resolve; });
  const aimWaiting = new Promise(resolve => { aimEntered = resolve; });
  const nativeWaiting = new Promise(resolve => { nativeEntered = resolve; });
  const observe = pending => pending.catch(error => { asyncError ??= error; aimEntered(); releaseAim(); releaseNative(); });
  const dispatcher = new Agent({ connect: { ca: fs.readFileSync(authority) } });
  let coordination;
  const frames = async (req, body, transport) => {
    if (body.generate === false) return [created("synthetic-prewarm"), completed("synthetic-prewarm")];
    requests.push({ headers: req.headers, url: req.url, body, transport });
    assert.equal(req.url, "/responses");
    const number = requests.length;
    assert.ok(number <= 2, "Unexpected model retry or extra turn");
    if (number === 1) await coordination?.duringTurn();
    const items = number === 1 ? [done({ type: "function_call", call_id: "synthetic-call", name: "exec_command",
      arguments: JSON.stringify({ cmd: command, yield_time_ms: chromePhase ? 30000 : 1000, max_output_tokens: chromePhase ? 2500 : 500 }) })]
      : [done({ type: "message", role: "assistant", id: "synthetic-message", content: [{ type: "output_text", text: "Synthetic task complete." }] })];
    return [created(`synthetic-${number}`), ...items, completed(`synthetic-${number}`)];
  };
  const handler = async (req, res) => {
    try {
      if (req.method === "GET") metadataRequests.push({ url: req.url, headers: req.headers });
      if (req.method === "GET" && req.url.startsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{"models":[]}'); return;
      }
      if (req.method === "GET" && req.url === "/api/codex/settings/user") {
        res.writeHead(200, { "content-type": "application/json" }); res.end('{}'); return;
      }
      if (req.method === "GET" && req.url === "/api/codex/accounts/check") {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ accounts: [{ id: accountId, plan_type: "plus", structure: "personal",
          workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" }],
          account_ordering: [accountId], default_account_id: accountId })); return;
      }
      if (req.method === "GET" && /^\/ps\/plugins\/(installed|list)\?/.test(req.url)) {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ plugins: [], pagination: { next_page_token: null } })); return;
      }
      if (req.method === "GET") {
        // Optional services outside this model fixture have ordinary HTTP
        // absence semantics. Keep every request in the private evidence.
        metadataRequests.at(-1).notFound = true;
        res.writeHead(404, { "content-type": "application/json" }); res.end('{"error":"not_found"}'); return;
      }
      const chunks = []; for await (const chunk of req) chunks.push(chunk);
      let bytes = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
      else if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
      const fromAim = req.headers["content-type"]?.includes("application/x-www-form-urlencoded");
      const body = fromAim ? Object.fromEntries(new URLSearchParams(bytes.toString())) : JSON.parse(bytes.toString());
      if (needsRefresh && req.url === "/oauth/token") {
        assert.equal(body.grant_type, "refresh_token");
        assert.equal(body.refresh_token, initialRefresh);
        refreshes++;
        if (!race) assert.equal(refreshes, 1, "single-use primary refresh token is exchanged once");
        else {
          assert.ok(refreshes <= 2, "the CAS fixture has exactly two successful in-flight responses");
          if (fromAim) { aimEntered(); if (builtin === "native-first") await aimGate; }
          else { nativeEntered(); if (builtin !== "native-first") await nativeGate; }
        }
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ access_token: fromAim ? aimToken : rotatedToken, id_token: fromAim ? aimToken : rotatedToken,
          refresh_token: fromAim ? "SYNTHETIC_AIM_REFRESH" : rotatedRefresh })); return;
      }
      if (needsRefresh && req.url === "/responses" && req.headers.authorization === "Bearer " + token) {
        // Native first reloads storage after a 401, then refreshes after the
        // unchanged bearer is refused again. Never accept the reload retry.
        assert.ok(++rejectedInitialAuth <= 3, "bounded native unauthorized recovery");
        res.writeHead(401, { "content-type": "application/json" }); res.end('{"error":{"message":"synthetic expired access"}}'); return;
      }
      const events = await frames(req, body, "http");
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
      res.end(events
        .map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""));
    } catch (error) {
      serverError = new Error(`Synthetic ${req.method} ${req.url}: ${error.message}`);
      res.writeHead(500); res.end("synthetic fixture error");
    }
  };
  const server = builtin ? https.createServer({ key: fs.readFileSync(certificateKey), cert: fs.readFileSync(certificate) }, handler)
    : http.createServer(handler);
  const websockets = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    if (builtin !== "websocket") {
      socket.end("HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n"); return;
    }
    websockets.handleUpgrade(req, socket, head, ws => {
      ws.on("message", async bytes => {
        try { for (const event of await frames(req, JSON.parse(bytes.toString()), "websocket")) ws.send(JSON.stringify(event)); }
        catch (error) { serverError = error; ws.close(); }
      });
    });
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = `${builtin ? "https" : "http"}://127.0.0.1:${server.address().port}`;
  fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"), `model="gpt-5.4"\nmodel_provider="fixture"\n[features]\napps=false\ncode_mode=false\nunified_exec=true\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(address)}\nwire_api="responses"\nrequest_max_retries=0\nstream_max_retries=0\n`);
  if (builtin) fs.writeFileSync(path.join(homeDir, ".codex", "config.toml"),
    `model="gpt-6.1-sol"\nopenai_base_url=${JSON.stringify(address)}\nchatgpt_base_url=${JSON.stringify(address)}\n[features]\napps=false\ncode_mode=false\nunified_exec=true\n`);
  const env = { HOME: homeDir, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color",
    OPENAI_API_KEY: "SYNTHETIC_INDEPENDENT_SDK_KEY", CODEX_CA_CERTIFICATE: authority };
  if (alias) {
    const bin = path.join(homeDir, "bin"), libexec = path.join(homeDir, "libexec");
    fs.mkdirSync(bin); fs.mkdirSync(libexec);
    fs.copyFileSync("/usr/bin/" + versionProbe[0], path.join(libexec, "distribution-info"));
    fs.chmodSync(path.join(libexec, "distribution-info"), 0o700);
    fs.symlinkSync(path.join(libexec, "distribution-info"), path.join(bin, versionProbe[0]));
    env.PATH = bin + ":" + env.PATH;
  }
  const environment = readCodexEnvironment(), accountId = `synthetic-${name}`;
  const claims = { exp: Math.floor(Date.now() / 1000) + 3600, ...(grantEnvironment ? { synthetic_environment: grantEnvironment } : {}), "https://api.openai.com/auth": {
    chatgpt_account_id: accountId, chatgpt_plan_type: "plus", chatgpt_user_id: "synthetic-user",
  } };
  const token = `synthetic.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.signature`;
  const rotatedToken = `synthetic.${Buffer.from(JSON.stringify({ ...claims, synthetic_rotation: 1 })).toString("base64url")}.signature`;
  const aimToken = `synthetic.${Buffer.from(JSON.stringify({ ...claims, synthetic_rotation: "aim" })).toString("base64url")}.signature`;
  const expectedToken = needsRefresh ? rotatedToken : token;
  if (needsRefresh) env.CODEX_REFRESH_TOKEN_URL_OVERRIDE = address + "/oauth/token";
  const foreignAuth = JSON.stringify({ OPENAI_API_KEY: "SYNTHETIC_FOREIGN_DESKTOP_KEY" });
  fs.writeFileSync(path.join(homeDir, ".codex/auth.json"), foreignAuth, { mode: 0o600 });
  const options = { homeDir, env, environment, accountId, label: name };
  saveLocalCodexLogin(options, { access: token, idToken: token, refresh: initialRefresh, accountId });
  const defaultPrepared = prepareCodexAccountState(options);
  if (process.argv.includes("--custom-auth-lock")) {
    assert.ok(lockProbe);
    env.CODEX_HOME = path.join(homeDir, "relative settings 日本語");
    fs.mkdirSync(env.CODEX_HOME);
    fs.copyFileSync(path.join(homeDir, ".codex/config.toml"), path.join(env.CODEX_HOME, "config.toml"));
  }
  const prepared = env.CODEX_HOME ? prepareCodexAccountState(options) : defaultPrepared;
  if (process.argv.includes("--custom-auth-lock")) {
    assert.notEqual(prepared.codexHome, defaultPrepared.codexHome);
    assert.equal(prepared.accountRoot, defaultPrepared.accountRoot);
    assert.equal(fs.statSync(path.join(prepared.codexHome, "auth.lock")).ino,
      fs.statSync(path.join(defaultPrepared.codexHome, "auth.lock")).ino);
  }
  if (process.argv.includes("--account-isolation")) {
    coordination = await coordinateOtherAccount({ homeDir, env, environment, options, token, claims, prepared, root });
    await coordination.select("after-selected-account-preparation");
  }
  const initialOwner = JSON.parse(readLocalCodexCredential(options).raw).tokens.login_owner_id;
  assert.ok(initialOwner);
  const refreshAim = () => maintainLocalCodexCredential(options, { refreshBeforeMs: Infinity,
    fetchJsonWithTimeoutImpl: async (url, request) => {
      assert.equal(url, "https://auth.openai.com/oauth/token");
      return fixtureFetch(address + "/oauth/token", { ...request, dispatcher, signal: AbortSignal.timeout(25_000) });
    } });
  const args = ["exec", "--json", "--dangerously-bypass-approvals-and-sandbox", "--skip-git-repo-check", "Perform the synthetic tool check."];
  let invocation, child, childDone, timer, lockHolder, lockHolderDone, kernelWaitObserved = false;
  try {
    invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin", "codex"), homeDir, cwd, env, args });
    await coordination?.select("after-native-preparation-before-spawn");
    if (builtin === "native-first") { aimTask = observe(refreshAim()); await aimWaiting; if (asyncError) throw asyncError; }
    child = spawn(protectedLaunch ? invocation.command : path.join(base, "bin", "codex"), protectedLaunch ? invocation.args : args, {
      cwd: invocation.cwd, env: protectedLaunch ? invocation.env : { ...invocation.environment,
        ...(chromePhase ? { TMPDIR: os.tmpdir() } : {}) }, detached: true,
      stdio: ["ignore", "pipe", "pipe", ...(protectedLaunch ? [invocation.environmentFd] : [])] });
    childDone = once(child, "close");
    invocation.closeEnvironment?.();
    if (race && builtin !== "native-first") raceController = observe((async () => {
      const started = await Promise.race([nativeWaiting.then(() => true), childDone.then(() => false)]);
      if (started) try {
        if (builtin === "aim-first") {
          const result = await refreshAim();
          assert.equal(result.status, "ready");
          assert.equal(result.credential.access, aimToken);
          const stored = JSON.parse(readLocalCodexCredential(options).raw);
          assert.equal(stored.tokens.access_token, aimToken);
          assert.equal(stored.tokens.refresh_token, "SYNTHETIC_AIM_REFRESH");
          assert.equal(stored.tokens.login_owner_id, initialOwner);
        } else if (builtin === "relogin") {
          const next = saveLocalCodexLogin(options, { access: aimToken, idToken: aimToken,
            refresh: "SYNTHETIC_NEW_LOGIN_REFRESH", accountId });
          assert.notEqual(JSON.parse(next.raw).tokens.login_owner_id, initialOwner);
        } else if (builtin === "logout") {
          assert.ok(logoutLocalCodexCredential(options).committed);
        } else if (lockProbe) {
          const lock = path.join(prepared.accountRoot, "auth.lock"), inode = fs.statSync(lock).ino;
          lockHolder = spawn("/usr/bin/python3", ["-I", "-c",
            "import fcntl,sys; f=open(sys.argv[1],'r+'); fcntl.flock(f,fcntl.LOCK_EX); print('held',flush=True); sys.stdin.read()", lock],
            { env, stdio: ["pipe", "pipe", "pipe"] });
          lockHolderDone = once(lockHolder, "close");
          assert.equal((await once(lockHolder.stdout, "data"))[0].toString().trim(), "held");
          releaseNative();
          if (process.platform === "linux") {
            const deadline = Date.now() + 5000;
            while (Date.now() < deadline && !kernelWaitObserved) {
              kernelWaitObserved = fs.readFileSync("/proc/locks", "utf8").split("\n").some(line =>
                line.includes("-> FLOCK") && line.split(/\s+/)[6]?.endsWith(":" + inode));
              if (!kernelWaitObserved) await delay(25);
            }
            assert.ok(kernelWaitObserved, "actual native refresh must wait on the canonical flock inode");
          } else await delay(500);
          assert.equal(JSON.parse(readLocalCodexCredential(options).raw).tokens.access_token, token);
          assert.equal(requests.length, 0, "native cannot continue before its credential commit");
          lockHolder.stdin.end(); await lockHolderDone;
          assert.equal(fs.statSync(lock).ino, inode);
        }
      } finally { releaseNative(); lockHolder?.stdin.end(); }
    })());
    child.stdout.on("data", bytes => output.push(bytes)); child.stderr.on("data", bytes => errors.push(bytes));
    timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 40_000);
    const [code, signal] = await childDone;
    clearTimeout(timer);
    releaseAim(); await aimTask; await raceController;
    if (asyncError) throw asyncError;
    fs.writeFileSync(path.join(root, `${name}-requests.json`), JSON.stringify(requests, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-metadata.json`), JSON.stringify(metadataRequests, null, 2), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stdout.log`), Buffer.concat(output), { mode: 0o600 });
    fs.writeFileSync(path.join(root, `${name}-stderr.log`), Buffer.concat(errors), { mode: 0o600 });
    if (serverError) throw serverError;
    if (replacedLogin) {
      assert.notEqual(code, 0, "old native refresh must fail across a login boundary");
      assert.equal(signal, null);
      assert.equal(refreshes, 1);
      assert.equal(requests.length, 0);
      const current = readLocalCodexCredential(options);
      if (builtin === "relogin") {
        assert.equal(current.credential.access, aimToken);
        assert.equal(current.credential.refresh, "SYNTHETIC_NEW_LOGIN_REFRESH");
        assert.notEqual(JSON.parse(current.raw).tokens.login_owner_id, initialOwner);
      } else {
        assert.equal(current.status, "login_required");
        assert.equal(current.raw, null);
      }
      assert.equal(fs.readFileSync(path.join(homeDir, ".codex/auth.json"), "utf8"), foreignAuth);
      return { name, staleNativeRefreshRefused: true, primaryRefreshes: refreshes };
    }
    assert.equal(code, 0, `${name} exit=${code}, signal=${signal}; private evidence ${root}`);
    assert.equal(requests.length, 2);
    if (builtin) for (const request of requests) {
      assert.equal(request.transport, builtin === "websocket" ? "websocket" : "http");
      assert.equal(request.headers.authorization, "Bearer " + expectedToken, "native file auth wins over the independent SDK key");
      assert.equal(request.headers["chatgpt-account-id"], accountId);
      assert.equal(request.body.client_metadata["x-codex-installation-id"], prepared.installationId);
      assert.equal(JSON.parse(request.body.client_metadata["x-codex-turn-metadata"]).installation_id, prepared.installationId);
    }
    const toolOutput = requests[1].body.input.filter(item => item.type === "function_call_output");
    assert.match(JSON.stringify(toolOutput), new RegExp(canary));
    assert.ok(JSON.stringify(toolOutput).includes(env.OPENAI_API_KEY), "ordinary SDK tools retain their key");
    assert.ok(JSON.stringify(toolOutput).includes(os.release()), "ordinary tool retains actual uname");
    if (chromePhase) assert.match(JSON.stringify(toolOutput), /AIM_TOOL_ACCESS_OK/, "ordinary native shell launches stock Chrome with its sandbox enabled");
    assert.equal(fs.readFileSync(path.join(cwd, "tool-output.txt"), "utf8"), "tool write succeeded");
    assert.equal(fs.readFileSync(path.join(homeDir, ".codex/auth.json"), "utf8"), foreignAuth);
    if (needsRefresh) {
      assert.ok(rejectedInitialAuth); assert.equal(refreshes, race && !lockProbe ? 2 : 1);
      const auth = JSON.parse(fs.readFileSync(path.join(prepared.accountRoot, "auth.json"), "utf8"));
      assert.equal(auth.tokens.access_token, expectedToken);
      assert.equal(auth.tokens.refresh_token, rotatedRefresh);
      assert.equal(auth.tokens.login_owner_id, initialOwner);
    }
    return { name, modelRequests: requests.length, ordinaryFileAccess: true, ordinaryUname: true, ordinarySdkKey: true,
      installationId: prepared.installationId, primaryRefreshes: refreshes, kernelWaitObserved,
      ...(chromePhase ? { chromeRenderedWithSandbox: true } : {}),
      ...(coordination ? { coordinationBeforeAndDuringNativeTurn: true } : {}),
      ...(grantEnvironment ? { accountId, environmentId: environment.binding, grantEnvironment,
        localAuthPath: path.join(prepared.accountRoot, "auth.json"),
        localAuthSha256: createHash("sha256").update(fs.readFileSync(path.join(prepared.accountRoot, "auth.json"))).digest("hex"),
        bearerSha256: createHash("sha256").update(expectedToken).digest("hex") } : {}),
      optionalEndpointsNotProvided: metadataRequests.filter(r => r.notFound).map(r => r.url),
      userAgent: requests[0].headers["user-agent"] };
  } finally {
    clearTimeout(timer);
    releaseAim(); releaseNative();
    lockHolder?.stdin.end();
    if (child && child.exitCode === null && child.signalCode === null) { try { process.kill(-child.pid, "SIGKILL"); } catch {} }
    await Promise.allSettled([childDone, aimTask, raceController, lockHolderDone]);
    await invocation?.close?.();
    for (const socket of websockets.clients) socket.terminate();
    websockets.close(); server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
    await dispatcher.close();
  }
}

try {
  if (chromePhase) {
    const results = [await run(false), await run(true)];
    process.stdout.write(JSON.stringify({ fixture: root, results: results.map(row => ({ ...row, userAgent: undefined })) }) + "\n");
  } else if (process.argv.includes("--account-isolation")) {
    const results = [];
    for (const transport of ["http", "websocket"]) results.push(await run(true, false, transport));
    process.stdout.write(JSON.stringify({ fixture: root, results: results.map(row => ({ ...row, userAgent: undefined })) }) + "\n");
  } else if (process.argv.includes("--environment-proof")) {
    const result = await run(true, false, "refresh");
    const output = { fixture: root, result: { ...result, userAgent: undefined } };
    fs.writeFileSync(path.join(root, "environment-proof.private.json"), JSON.stringify(output, null, 2));
    process.stdout.write(JSON.stringify(output) + "\n");
  } else if (process.argv.includes("--custom-auth-lock")) {
    const result = await run(true, false, "native-lock");
    process.stdout.write(JSON.stringify({ fixture: root, customSettingsNativeAuthLock: true,
      result: { ...result, userAgent: undefined } }) + "\n");
  } else if (process.argv.includes("--auth-races")) {
    const results = [];
    // Both successful responses originate from the same snapshot, modeling
    // issuer overlap/grace. AIM keeps its byte CAS; native permits a later successful response
    // from the same login. This does not assert provider grace policy;
    // MCP's separate issuer fixture enforces single-use refresh tokens.
    for (const order of ["native-first", "aim-first", "relogin", "logout", "native-lock"]) results.push(await run(true, false, order));
    process.stdout.write(JSON.stringify({ fixture: root, results: results.map(row => ({ ...row, userAgent: undefined })) }) + "\n");
  } else if (process.argv.includes("--builtin-only")) {
    const results = [];
    for (const transport of ["http", "websocket", "refresh"]) results.push(await run(true, false, transport));
    assert.equal(new Set(results.map(row => row.installationId)).size, results.length);
    for (const row of results) assert.doesNotMatch(row.userAgent?.match(/\(([^;]+);/)?.[1], /\d+\.\d+/);
    process.stdout.write(JSON.stringify({ fixture: root, results: results.map(row => ({ ...row, userAgent: undefined })) }) + "\n");
  } else {
  const control = await run(false), controlAlias = await run(false, true), protectedResult = await run(true), alias = await run(true, true);
  const builtinHttp = process.argv.includes("--baseline-only") ? null : await run(true, false, "http");
  const builtinWebsocket = process.argv.includes("--baseline-only") ? null : await run(true, false, "websocket");
  if (builtinHttp) assert.notEqual(builtinHttp.installationId, builtinWebsocket.installationId);
  const osLabel = agent => agent?.match(/\(([^;]+);/)?.[1];
  assert.match(osLabel(control.userAgent), /\d+\.\d+/, "control observes the distribution version");
  assert.match(osLabel(controlAlias.userAgent), /\d+\.\d+/, "the unprotected alias remains a working version probe");
  assert.doesNotMatch(osLabel(protectedResult.userAgent), /\d+\.\d+/, "vendor header excludes the distribution version");
  assert.doesNotMatch(osLabel(alias.userAgent), /\d+\.\d+/, "a PATH alias cannot disclose the distribution version");
  for (const result of [builtinHttp, builtinWebsocket].filter(Boolean)) assert.doesNotMatch(osLabel(result.userAgent), /\d+\.\d+/);
  process.stdout.write(JSON.stringify({ fixture: root, control: { ...control, userAgent: undefined },
    controlAlias: { ...controlAlias, userAgent: undefined },
    protected: { ...protectedResult, userAgent: undefined }, alias: { ...alias, userAgent: undefined },
    builtinHttp: builtinHttp && { ...builtinHttp, userAgent: undefined }, builtinWebsocket: builtinWebsocket && { ...builtinWebsocket, userAgent: undefined },
    vendorReleaseRemoved: true }) + "\n");
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`); process.exitCode = 1;
}
