#!/usr/bin/env node
// Differential settings checks against the unchanged native app-server.
// Synthetic files/accounts only; Linux requires the isolated loopback namespace.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import http from "node:http";
import zlib from "node:zlib";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createInterface } from "node:readline";
import { PassThrough } from "node:stream";
import { createHash } from "node:crypto";
import lockfile from "proper-lockfile";
import { setTimeout as delay } from "node:timers/promises";
import { readCodexEnvironment } from "../src/privacy/codex-environment.js";
import { saveLocalCodexLogin } from "../src/credentials/codex-local.js";
import { prepareCodexAccountState } from "../src/privacy/codex-account-state.js";
import { prepareCodexNativeInvocation } from "../src/privacy/codex-native-invocation.js";
import { superviseCodexAppServerStdio } from "../src/io/codex-app-server-stdio.js";
import { parseCodexSettings, codexSourcePath } from "../src/io/codex-settings-toml.js";

const base = "/opt/aimgr-state-audit";
assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")) && process.getuid() !== 0);
if (process.platform === "linux") assert.deepEqual(Object.keys(os.networkInterfaces()), ["lo"]);
const root = fs.mkdtempSync(path.join(base, "codex-m1-fixtures", "settings-"));
const homeDir = path.join(root, "home"), shared = path.join(homeDir, "shared settings 日本語"), cwd = path.join(root, "project");
const environment = readCodexEnvironment();
for (const dir of [shared, cwd]) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
const source = path.join(shared, "config.toml");
const env = { HOME: homeDir, CODEX_HOME: shared, PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", TERM: "xterm-256color" };
const owners = [], protocol = [], serviceRequests = [], modelRequests = [], modelCounts = new Map();
const read = file => parseCodexSettings(fs.readFileSync(file, "utf8")).value;
const put = (file, text) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, { mode: 0o600 }); };
const atomic = text => { put(source + ".replacement", text); fs.renameSync(source + ".replacement", source); };
async function until(check, label, timeout = 15_000) {
  const end = Date.now() + timeout;
  do { if (await check()) return; await delay(40); } while (Date.now() < end);
  throw new Error("Timed out: " + label);
}
const service = http.createServer(async (req, res) => {
  serviceRequests.push({ method: req.method, url: req.url });
  if (req.method === "POST" && req.url === "/responses") {
    const chunks = []; for await (const bytes of req) chunks.push(bytes);
    let bytes = Buffer.concat(chunks);
    if (req.headers["content-encoding"] === "gzip") bytes = zlib.gunzipSync(bytes);
    if (req.headers["content-encoding"] === "zstd") bytes = zlib.zstdDecompressSync(bytes);
    const body = JSON.parse(bytes.toString()); modelRequests.push(body);
    const response = { id: "synthetic-settings-" + modelRequests.length, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } };
    const frames = [{ type: "response.created", response }];
    if (body.generate !== false && body.text?.format?.name !== "codex_output_schema") {
      const thread = body.client_metadata?.thread_id, count = modelCounts.get(thread) ?? 0; modelCounts.set(thread, count + 1);
      const item = count % 2 === 0 ? { type: "function_call", call_id: "settings-tool-" + modelRequests.length, name: "exec_command",
        arguments: JSON.stringify({ cmd: "cat ordinary.txt", login: false, max_output_tokens: 100 }) }
        : { type: "message", role: "assistant", id: response.id, content: [{ type: "output_text", text: "SYNTHETIC_SETTINGS_TURN_COMPLETE" }] };
      frames.push({ type: "response.output_item.done", item });
    }
    frames.push({ type: "response.completed", response });
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.end(frames.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join("")); return;
  }
  const data = req.url.startsWith("/models") ? { models: [] }
    : req.url === "/api/codex/settings/user" ? {}
    : req.url === "/api/codex/accounts/check" ? { accounts: ["A", "B"].map(id => ({ id: "synthetic-settings-" + id,
      plan_type: "plus", structure: "personal", workspace_backend_origin: "NO_CONSTRAINT", account_routing_override: "NO_CONSTRAINT" })),
      account_ordering: ["synthetic-settings-A", "synthetic-settings-B"], default_account_id: "synthetic-settings-A" } : null;
  res.writeHead(data ? 200 : 404, { "content-type": "application/json" }); res.end(JSON.stringify(data ?? { error: "not_found" }));
});
service.listen(0, "127.0.0.1"); await once(service, "listening");
const address = `http://127.0.0.1:${service.address().port}`;
const initial = () => `# Authored comment survives native writes.\nmodel="gpt-6.1-sol"\nmodel_reasoning_effort="high"\nmodel_provider="fixture"\nchatgpt_base_url=${JSON.stringify(address)}\nunknown_setting="keep me"\n[features]\napps=false\ncode_mode=false\n[model_providers.fixture]\nname="Fixture"\nbase_url=${JSON.stringify(address)}\nwire_api="responses"\n`;
for (const id of ["A", "B"]) {
  const accountId = "synthetic-settings-" + id;
  const token = "synthetic." + Buffer.from(JSON.stringify({ exp: Math.floor(Date.now() / 1000) + 3600,
    "https://api.openai.com/auth": { chatgpt_account_id: accountId, chatgpt_plan_type: "plus" } })).toString("base64url") + ".signature";
  saveLocalCodexLogin({ homeDir, env, environment, accountId, label: id }, { access: token, idToken: token,
    refresh: "SYNTHETIC_SETTINGS_REFRESH_" + id, accountId });
}

async function launch(name, { protectedLaunch = true, settingsHome = shared, profile, config = [], gateReply } = {}) {
  const actualEnv = { ...env, CODEX_HOME: settingsHome }, id = name.includes("B") ? "B" : "A";
  const args = [...(profile ? ["-p", profile] : []), ...config.flatMap(value => ["-c", value]), "app-server", "--listen", "stdio://"];
  const errors = [], warnings = [], notifications = [], replies = new Map();
  let invocation;
  if (protectedLaunch) {
    const prepared = prepareCodexAccountState({ homeDir, env: actualEnv, environment, accountId: "synthetic-settings-" + id, label: id });
    invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin/codex"), homeDir, cwd,
      env: actualEnv, args, ownedAppServer: true, onWarning: value => warnings.push(value), onError: value => errors.push(String(value)) });
  }
  const child = spawn(invocation?.command ?? path.join(base, "bin/codex"), invocation?.args ?? args,
    { cwd, env: invocation?.env ?? actualEnv, stdio: invocation ? ["pipe", "pipe", "pipe", invocation.environmentFd, invocation.assignmentFd] : ["pipe", "pipe", "pipe"], detached: true });
  invocation?.closeEnvironment();
  const input = new PassThrough(), output = new PassThrough();
  let transport, gated;
  if (gateReply) {
    const stdout = new PassThrough(), nativeLines = createInterface({ input: child.stdout });
    gated = { stdin: child.stdin, stdout };
    (async () => {
      try { for await (const line of nativeLines) if (await gateReply(JSON.parse(line)) !== false) stdout.write(line + "\n"); }
      finally { stdout.end(); }
    })().catch(error => { errors.push(error.message); stdout.destroy(error); });
  }
  if (invocation) transport = superviseCodexAppServerStdio({ input, output, child: gated ?? child, entry: invocation.entries.at(-1),
    flush: invocation.flushSettings, onError: error => errors.push("adapter: " + error.message) });
  else { input.pipe(child.stdin); child.stdout.pipe(output); }
  child.stderr.on("data", b => errors.push(b.toString()));
  let nextId = 0, closed = false;
  const lines = createInterface({ input: output });
  lines.on("line", line => {
    const value = JSON.parse(line); protocol.push({ owner: name, response: value });
    if (Object.hasOwn(value, "id") && !value.method) { replies.get(value.id)?.(value); replies.delete(value.id); }
    else notifications.push(value);
  });
  const owner = { name, child, invocation, errors, warnings, notifications,
    rpc(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => { replies.delete(id); reject(new Error(`${name}: timed out on ${method}`)); }, 30_000);
        replies.set(id, value => { clearTimeout(timer); resolve(value); });
        input.write(JSON.stringify({ id, method, params }) + "\n");
      });
    },
    async close() {
      if (closed) return; closed = true;
      input.end();
      if (child.exitCode === null && child.signalCode === null) {
        const timeout = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 5000);
        await once(child, "close"); clearTimeout(timeout);
      }
      await transport?.close(); await invocation?.close(); lines.close();
      for (const resolve of replies.values()) resolve({ transportClosed: true }); replies.clear();
      put(path.join(root, name + ".stderr.log"), errors.join("\n"));
    },
  };
  owners.push(owner);
  const init = await owner.rpc("initialize", { clientInfo: { name: "aim_settings_fixture", version: "1" }, capabilities: { experimentalApi: true } });
  assert.ok(init.result, JSON.stringify(init));
  input.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
  return owner;
}
async function config(owner) {
  const response = await owner.rpc("config/read", { includeLayers: true, cwd });
  assert.ok(response.result, JSON.stringify(response)); return response.result;
}
const ok = response => assert.ok(["ok", "okOverridden"].includes(response.result?.status), JSON.stringify(response));
function leaves(value, keys = [], out = new Map()) {
  if (typeof value === "string" && codexSourcePath(keys)) out.set(JSON.stringify(keys), value);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) leaves(item, [...keys, Array.isArray(value) ? Number(key) : key], out);
  return out;
}

try {
  const phase = process.argv[2] ?? "--edits";
  if (phase === "--paths") {
    put(path.join(shared, "instructions.md"), "SYNTHETIC_SELECTED_INSTRUCTIONS");
    put(path.join(root, "compact.md"), "SYNTHETIC_COMPACT");
    put(path.join(shared, "models.json"), JSON.stringify({ models: [{ slug: "gpt-6.1-sol", display_name: "Synthetic model",
      supported_reasoning_levels: [{ effort: "high", description: "Synthetic" }], shell_type: "shell_command",
      visibility: "list", supported_in_api: true, priority: 1, support_verbosity: false,
      model_messages: { instructions_template: "SYNTHETIC_MODEL_INSTRUCTIONS" },
      truncation_policy: { mode: "tokens", limit: 10000 }, experimental_supported_tools: [] }] }));
    put(path.join(shared, "roles", "review.toml"), 'model_instructions_file="../instructions.md"\n[agents.inner]\ndescription="Synthetic inner role"\nconfig_file="./inner.toml"\n');
    put(path.join(shared, "roles", "inner.toml"), 'model_reasoning_effort="high"\n');
    fs.mkdirSync(path.join(homeDir, "modules"));
    for (const name of ["one", "spaced 日本語", "symlink-target"]) put(path.join(shared, "skills", name, "SKILL.md"), `---\nname: synthetic-${name.replace(/[^a-z]/g, "-")}\ndescription: Synthetic skill\n---\nSYNTHETIC_SKILL\n`);
    fs.symlinkSync(path.join(shared, "skills", "symlink-target"), path.join(shared, "skills", "alias"));
    const paths = `model_instructions_file="instructions.md"\nsqlite_home="~/db"\nlog_dir="./logs"\nmodel_catalog_json="./models.json"\nexperimental_compact_prompt_file="../../compact.md"\njs_repl_node_path="/usr/local/bin/node"\njs_repl_node_module_dirs=["~/modules"]\n`;
    const skills = '[skills]\nconfig=[{path="./skills/one",enabled=true},{path="./skills/spaced 日本語",enabled=false},{path="./skills/alias",enabled=false},{path="./missing",enabled=false},{path="",enabled=false},{path=".",enabled=false},{path="./",enabled=false},{path="..",enabled=false},{path="~",enabled=false}]\n';
    const extras = '[agents."review.one"]\ndescription="Synthetic review role"\nconfig_file="./roles/review.toml"\n[model_providers.unselected]\nname="Unselected"\nbase_url="http://127.0.0.1:1"\nwire_api="responses"\n[model_providers.unselected.auth]\ncommand="/usr/bin/true"\ncwd="../"\n[mcp_servers.disabled]\ncommand="./unchanged-command"\ncwd="./unchanged-cwd"\nenabled=false\n[sandbox_workspace_write]\nwritable_roots=["."]\n';
    const legacy = '[profiles.legacy]\nmodel_instructions_file="./instructions.md"\nmodel_catalog_json="./models.json"\nexperimental_compact_prompt_file="../../compact.md"\njs_repl_node_path="/usr/local/bin/node"\njs_repl_node_module_dirs=["~/modules"]\n';
    put(source, paths + initial() + skills + extras + legacy);
    const baseline = await launch("baseline-base", { protectedLaunch: false });
    const expected = await config(baseline);
    for (const id of ["A", "B"]) {
      const owner = await launch(id + "-base");
      const actual = await config(owner);
      assert.deepEqual(leaves(actual.config), leaves(expected.config), "native typed paths match shared-home baseline");
      assert.deepEqual(actual.config.mcp_servers, expected.config.mcp_servers, "MCP text is not source-path translated");
      assert.equal(actual.config.model_reasoning_effort, expected.config.model_reasoning_effort);
      assert.equal(actual.config.unknown_setting, expected.config.unknown_setting);
      assert.equal(read(source).unknown_setting, "keep me");
      await owner.close();
    }
    await baseline.close();
    console.log(JSON.stringify({ fixture: root, nativePathBaselineAndAccounts: true, manifestLeaves: leaves(read(source)).size, baseAndLegacyTypedLeaves: true }));
  } else if (["--precedence", "--aliases"].includes(phase)) {
    fs.mkdirSync(path.join(cwd, ".git"));
    for (const [file, text] of [[path.join(shared, "base.md"), "SYNTHETIC_BASE"],
      [path.join(cwd, ".codex", "project.md"), "SYNTHETIC_PROJECT"], [path.join(cwd, "cli.md"), "SYNTHETIC_CLI"]]) put(file, text);
    put(path.join(cwd, ".codex", "config.toml"), 'model_instructions_file="./project.md"\nmodel_reasoning_effort="low"\n');
    const compare = async (label, options, target, effort) => {
      const baseline = await launch("baseline-" + label, { ...options, protectedLaunch: false });
      const expected = await config(baseline);
      assert.equal(expected.config.model_instructions_file, target);
      assert.equal(expected.config.model_reasoning_effort, effort);
      for (const id of ["A", "B"]) {
        const owner = await launch(id + "-" + label, options), actual = await config(owner);
        assert.deepEqual(leaves(actual.config), leaves(expected.config), label + ": native selected paths match");
        assert.equal(actual.config.model_reasoning_effort, effort);
        const canonical = fs.realpathSync(target);
        assert.ok([...owner.invocation.inputs.reads, ...owner.invocation.inputs.writes].some(grant => canonical === grant || canonical.startsWith(grant + path.sep)),
          label + ": selected native input is within finite startup reads");
        const selectedLayers = result => result.layers.filter(layer => layer.name.type === "project").map(layer => ({
          config: layer.config, disabled: layer.disabledReason != null,
        }));
        assert.deepEqual(selectedLayers(actual), selectedLayers(expected));
        await owner.close();
      }
      await baseline.close();
    };
    const authored = trust => 'model_instructions_file="./base.md"\n' + initial()
      + `[projects.${JSON.stringify(cwd)}]\ntrust_level=${JSON.stringify(trust)}\n`;
    put(source, authored("trusted"));
    if (phase === "--precedence") {
    await compare("trusted", {}, path.join(cwd, ".codex/project.md"), "low");
    await compare("cli", { config: ['model_instructions_file="./cli.md"', 'model_reasoning_effort="medium"'] }, path.join(cwd, "cli.md"), "medium");
    atomic(authored("untrusted"));
    await compare("untrusted", {}, path.join(shared, "base.md"), "high");
    }
    fs.unlinkSync(path.join(cwd, ".codex/config.toml"));
    for (const name of ["alias one", "alias 日本語"]) {
      const alias = path.join(homeDir, name); fs.symlinkSync(shared, alias);
      await compare(name, { settingsHome: alias }, path.join(shared, "base.md"), "high");
    }
    console.log(JSON.stringify({ fixture: root, ...(phase === "--precedence" ? { nativeTrustedProjectAndCliPrecedence: true, untrustedProjectIgnored: true } : {}), lexicalSourceAliases: 2, finiteSelectedInputGrants: true }));
  } else if (phase === "--profiles") {
    put(source, 'model_instructions_file="./base.md"\n' + initial());
    put(path.join(shared, "base.md"), "SYNTHETIC_BASE_INSTRUCTIONS");
    const selectedFile = path.join(shared, "named-only.md"), selectedConfig = path.join(shared, "named.config.toml");
    put(selectedFile, "SYNTHETIC_NAMED_INSTRUCTIONS");
    put(selectedConfig, 'model_instructions_file="./named-only.md"\nmodel_reasoning_effort="medium"\n');
    const run = async (label, protectedLaunch, profile) => {
      const args = [...(profile ? ["-p", profile] : []), "debug", "prompt-input", "SYNTHETIC_PROFILE_PROBE"];
      let invocation;
      try {
        if (protectedLaunch) {
          const accountId = "synthetic-settings-" + (label.startsWith("B") ? "B" : "A");
          const prepared = prepareCodexAccountState({ homeDir, env, environment, accountId, label });
          invocation = await prepareCodexNativeInvocation({ prepared, command: path.join(base, "bin/codex"), homeDir, cwd, env, args });
          if (profile) {
            assert.ok(invocation.inputs.reads.includes(selectedFile), "native helper grants named instruction target");
            assert.equal(invocation.entries.at(-1).origin, selectedConfig);
          }
        }
        const child = spawn(invocation?.command ?? path.join(base, "bin/codex"), invocation?.args ?? args,
          { cwd, env: invocation?.env ?? env, stdio: invocation ? ["ignore", "pipe", "pipe", invocation.environmentFd, invocation.assignmentFd] : ["ignore", "pipe", "pipe"], detached: true });
        invocation?.closeEnvironment();
        let stdout = "", stderr = "";
        child.stdout.on("data", bytes => stdout += bytes); child.stderr.on("data", bytes => stderr += bytes);
        const timer = setTimeout(() => { try { process.kill(-child.pid, "SIGKILL"); } catch {} }, 30_000);
        const [code, signal] = await once(child, "close"); clearTimeout(timer);
        put(path.join(root, label + ".prompt.private.json"), stdout); put(path.join(root, label + ".stderr.log"), stderr);
        assert.equal(signal, null, label + ": native command must not time out");
        return { code, stderr };
      } catch (error) {
        if (error.code === "ERR_ASSERTION") throw error;
        return { code: 125, stderr: error.message };
      } finally { await invocation?.close(); }
    };
    for (const [label, protectedLaunch] of [["baseline-valid", false], ["A-valid", true], ["B-valid", true]]) {
      const result = await run(label, protectedLaunch, "named"); assert.equal(result.code, 0, result.stderr);
    }
    put(selectedFile, "");
    const empty = await run("baseline-empty", false, "named");
    assert.notEqual(empty.code, 0); assert.ok(empty.stderr.includes(selectedFile) && empty.stderr.includes("empty"));
    assert.notEqual((await run("A-empty", true, "named")).code, 0);
    put(selectedFile, "SYNTHETIC_NAMED_INSTRUCTIONS");
    atomic('profile="legacy"\n' + initial() + '[profiles.legacy]\nmodel_instructions_file="./base.md"\n');
    const legacy = await run("baseline-legacy-selector", false);
    assert.notEqual(legacy.code, 0); assert.ok(legacy.stderr.includes("legacy"));
    assert.notEqual((await run("A-legacy-selector", true)).code, 0);
    console.log(JSON.stringify({ fixture: root, nativeNamedProfileAndRelativeRead: true,
      namedOnlyMissingContentRefused: true, finiteNamedInputGrant: true, unsupportedLegacySelectorParity: true }));
  } else if (phase === "--edits") {
    for (const name of ["one", "two"]) put(path.join(shared, "skills", name, "SKILL.md"), `---\nname: ${name}\ndescription: Synthetic skill\n---\nSYNTHETIC_${name}\n`);
    // New path values point inside the already granted project, so immediate
    // native reload does not depend on the accepted new-session path limit.
    put(path.join(cwd, "instructions.md"), "SYNTHETIC_SELECTED_INSTRUCTIONS");
    put(path.join(cwd, "roles", "review.toml"), 'model_reasoning_effort="high"\n');
    put(source, initial() + '[skills]\nconfig=[{path="./skills/one",enabled=true},{path="./skills/two",enabled=false}]\n');
    const a = await launch("A"), b = await launch("B");
    const original = fs.readFileSync(source, "utf8");
    atomic(original.replace('model_reasoning_effort="high"', 'model_reasoning_effort="medium"'));
    await until(async () => (await config(a)).config.model_reasoning_effort === "medium", "atomic replacement reaches A without manual flush");
    assert.equal((await config(b)).config.model_reasoning_effort, "medium");
    ok(await a.rpc("config/batchWrite", { reloadUserConfig: true, edits: [
      { keyPath: 'agents."review.one"', mergeStrategy: "upsert", value: { config_file: "../../project/roles/review.toml", description: "relative role" } },
      { keyPath: "skills", mergeStrategy: "upsert", value: { config: [{ path: "./skills/two", enabled: true }, { path: "./skills/one", enabled: false }] } },
      { keyPath: "model_instructions_file", mergeStrategy: "replace", value: "../../project/instructions.md" },
      { keyPath: "model_reasoning_effort", mergeStrategy: "replace", value: "high" },
    ] }));
    let native = (await config(a)).config, authored = read(source);
    assert.equal(native.agents["review.one"].config_file, path.join(cwd, "roles/review.toml"));
    assert.equal(native.skills.config[0].path, path.join(shared, "skills/two"));
    assert.equal(native.skills.config[0].enabled, true);
    assert.equal(authored.skills.config[0].path, "./skills/two");
    assert.equal(authored.agents["review.one"].config_file, "../../project/roles/review.toml");
    assert.equal(authored.model_instructions_file, "../../project/instructions.md");
    const beforeRejected = fs.readFileSync(source, "utf8");
    for (const [params, code] of [
      [{ keyPath: "model_instructions_file", value: "./must-not-persist.md", expectedVersion: "stale" }, "configVersionConflict"],
      [{ keyPath: "model_reasoning_effort", value: { invalid: true } }, "configValidationError"],
    ]) {
      const result = await a.rpc("config/value/write", { mergeStrategy: "replace", ...params });
      assert.equal(result.error?.data?.config_write_error_code, code, JSON.stringify(result));
      assert.equal(fs.readFileSync(source, "utf8"), beforeRejected);
    }
    ok(await a.rpc("config/value/write", { keyPath: "model_instructions_file", value: null, mergeStrategy: "replace" }));
    await until(() => read(source).model_instructions_file === undefined, "native path deletion reaches authored source");
    const disabled = await a.rpc("skills/config/write", { path: path.join(shared, "skills/two"), enabled: false });
    assert.ok(disabled.result, JSON.stringify(disabled));
    await until(() => read(source).skills.config.find(item => item.path === "./skills/two")?.enabled === false, "native dedicated skill writer reaches source");
    assert.equal((await config(b)).config.skills.config.find(item => item.path === path.join(shared, "skills/two"))?.enabled, false);
    assert.ok(fs.readFileSync(source, "utf8").includes("# Authored comment survives native writes."));
    assert.equal(read(source).unknown_setting, "keep me");
    await a.close(); await b.close();
    const fresh = await launch("B-fresh");
    assert.equal((await config(fresh)).config.model_reasoning_effort, "high");
    assert.equal((await config(fresh)).config.skills.config[0].path, path.join(shared, "skills/two"));
    console.log(JSON.stringify({ fixture: root, atomicExternalReplacement: true, ancestorAndArrayWrite: true,
      addDeleteRelativePath: true, versionAndTypedRejection: true, nativeDedicatedSkillWrite: true, secondAccountAndRestart: true }));
  } else if (["--runtime", "--runtime-baseline"].includes(phase)) {
    const instruction = path.join(shared, "instructions.md"), skill = path.join(shared, "skills", "one", "SKILL.md");
    put(instruction, "SYNTHETIC_INSTRUCTION_VERSION_ONE");
    const skillText = version => `---\nname: settings-proof\ndescription: Synthetic settings content test\n---\nSYNTHETIC_SKILL_VERSION_${version}\n`;
    put(skill, skillText("ONE")); put(path.join(cwd, "ordinary.txt"), "SYNTHETIC_SETTINGS_SHELL_PROOF");
    put(source, 'model_instructions_file="./instructions.md"\ndefault_permissions=":read-only"\n' + initial()
      + '[skills]\nconfig=[{path="./skills/one",enabled=true}]\n');
    const protectedLaunch = phase !== "--runtime-baseline";
    const a = await launch("A", { protectedLaunch }), b = await launch("B", { protectedLaunch });
    const start = async owner => {
      const response = await owner.rpc("thread/start", { cwd, approvalPolicy: "never" });
      assert.ok(response.result, JSON.stringify(response)); return response.result;
    };
    const turn = async (owner, thread, label) => {
      const first = modelRequests.length;
      const response = await owner.rpc("turn/start", { threadId: thread.thread.id,
        input: [{ type: "text", text: "SETTINGS_RUNTIME:" + label, text_elements: [] }, { type: "skill", name: "settings-proof", path: skill }] });
      assert.ok(response.result, JSON.stringify(response));
      await until(() => owner.notifications.some(value => value.method === "turn/completed" && value.params.turn.id === response.result.turn.id), "native settings tool turn", 30_000);
      const completion = owner.notifications.find(value => value.method === "turn/completed" && value.params.turn.id === response.result.turn.id);
      assert.equal(completion.params.turn.status, "completed", JSON.stringify(completion));
      assert.ok(owner.notifications.some(value => value.method === "item/completed" && value.params.turnId === response.result.turn.id
        && value.params.item.type === "commandExecution" && value.params.item.exitCode === 0
        && value.params.item.aggregatedOutput.includes("SYNTHETIC_SETTINGS_SHELL_PROOF")), "ordinary shell succeeded with selected permissions");
      return modelRequests.slice(first).filter(body => body.generate !== false);
    };
    const original = await start(a); assert.equal(original.sandbox.type, "readOnly");
    const first = await turn(a, original, "first");
    assert.ok(JSON.stringify(first).includes("SYNTHETIC_INSTRUCTION_VERSION_ONE"));
    assert.ok(JSON.stringify(first).includes("SYNTHETIC_SKILL_VERSION_ONE"));
    put(instruction, "SYNTHETIC_INSTRUCTION_VERSION_TWO"); put(skill, skillText("TWO"));
    ok(await a.rpc("config/batchWrite", { reloadUserConfig: true, edits: [
      { keyPath: "model", value: "synthetic-settings-second", mergeStrategy: "replace" },
      { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" },
      { keyPath: "default_permissions", value: ":workspace", mergeStrategy: "replace" },
    ] }));
    await until(() => read(source).model === "synthetic-settings-second", "native model default persisted");
    const next = await start(b);
    assert.equal(next.model, "synthetic-settings-second"); assert.equal(next.reasoningEffort, "medium");
    assert.equal(next.sandbox.type, "workspaceWrite");
    const changed = await turn(b, next, "updated-files");
    assert.ok(JSON.stringify(changed).includes("SYNTHETIC_INSTRUCTION_VERSION_TWO"));
    assert.ok(JSON.stringify(changed).includes("SYNTHETIC_SKILL_VERSION_TWO"));
    const updated = await b.rpc("thread/settings/update", { threadId: next.thread.id, permissions: ":read-only" });
    assert.ok(updated.result, JSON.stringify(updated));
    await turn(b, next, "thread-permissions-changed");
    assert.equal(read(source).default_permissions, ":workspace", "thread permission changes do not rewrite shared defaults");
    assert.equal(read(source).skills.config[0].path, "./skills/one");
    assert.equal(read(source).model_instructions_file, "./instructions.md");
    assert.equal(read(source).unknown_setting, "keep me");
    console.log(JSON.stringify({ fixture: root, protectedLaunch, nativeModelEffortAndPermissionDefaults: true,
      existingInstructionAndSkillContentEdits: true, liveThreadPermissionsAndContinuedTool: true, accounts: 2 }));
  } else if (phase === "--first-use") {
    put(source, initial()); put(path.join(cwd, "ordinary.txt"), "SYNTHETIC_FIRST_USE_SHELL");
    for (const folder of [homeDir, cwd]) {
      fs.mkdirSync(path.join(folder, ".agents"), { recursive: true });
      fs.symlinkSync(path.join(root, "not-installed"), path.join(folder, ".agents/skills"));
    }
    const optionalRoles = path.join(shared, "agents");
    fs.rmdirSync(optionalRoles); fs.symlinkSync(path.join(root, "not-installed-roles"), optionalRoles);
    const a = await launch("A"), b = await launch("B");
    const instruction = path.join(shared, "AGENTS.md"), override = path.join(shared, "AGENTS.override.md");
    assert.equal(fs.existsSync(instruction), false); assert.equal(fs.existsSync(override), false);
    const turn = async (owner, present, absent) => {
      const started = await owner.rpc("thread/start", { cwd, approvalPolicy: "never" });
      assert.ok(started.result, JSON.stringify(started));
      const first = modelRequests.length;
      const response = await owner.rpc("turn/start", { threadId: started.result.thread.id,
        input: [{ type: "text", text: "Complete the synthetic first-use check.", text_elements: [] }] });
      assert.ok(response.result, JSON.stringify(response));
      await until(() => owner.notifications.some(value => value.method === "turn/completed" && value.params.turn.id === response.result.turn.id), "first-use native turn", 30_000);
      const completed = owner.notifications.find(value => value.method === "turn/completed" && value.params.turn.id === response.result.turn.id);
      assert.equal(completed.params.turn.status, "completed", JSON.stringify(completed));
      const sent = JSON.stringify(modelRequests.slice(first));
      for (const marker of present) assert.ok(sent.includes(marker), "native request includes " + marker);
      for (const marker of absent) assert.ok(!sent.includes(marker), "native request excludes " + marker);
    };
    const normal = "SYNTHETIC_GLOBAL_NORMAL", preferred = "SYNTHETIC_GLOBAL_OVERRIDE";
    await turn(a, [], [normal, preferred]);
    assert.ok(fs.existsSync(path.join(shared, "skills/.system")), "native first-use system skills are installed in the shared tree");
    for (const owner of [a, b]) assert.equal(fs.realpathSync(path.join(owner.invocation.prepared.codexHome, "skills")), fs.realpathSync(path.join(shared, "skills")));
    put(instruction, normal); await turn(a, [normal], [preferred]);
    put(override, preferred); await turn(b, [preferred], [normal]);
    fs.unlinkSync(override); await turn(a, [normal], [preferred]);
    fs.unlinkSync(instruction); await turn(b, [], [normal, preferred]);
    await a.close(); await b.close();
    put(instruction, normal); fs.symlinkSync(path.join(root, "not-created.md"), override);
    const reopened = await launch("A-reopened");
    assert.ok((await config(reopened)).config);
    await turn(reopened, [normal], [preferred]);
    console.log(JSON.stringify({ fixture: root, nativeSystemSkillsSharedFromFirstUse: true,
      laterGlobalInstructionsVisibleToExistingOwners: true, missingOverridePreservesFallback: true,
      removedInstructionsDisappear: true, subsequentLaunchSucceeded: true, danglingOptionalInputsPreserveNativeFallback: true }));
  } else if (phase === "--races") {
    put(source, initial());
    for (const name of ["native", "later"]) put(path.join(cwd, name + ".md"), "SYNTHETIC_" + name);
    let intercept;
    const a = await launch("A", { gateReply: value => intercept ? intercept(value) : true }), b = await launch("B");
    const lock = () => lockfile.lock(path.join(a.invocation.prepared.base, "codex-settings", "source-"
      + createHash("sha256").update(fs.realpathSync(source)).digest("hex")), { realpath: false, retries: { retries: 30, minTimeout: 10, maxTimeout: 100 } });
    const writeAtBarrier = async (edits, external) => {
      const release = await lock();
      let reached, proceed;
      const held = new Promise(resolve => reached = resolve), continueReply = new Promise(resolve => proceed = resolve);
      intercept = async value => {
        if (value.result?.status) { reached(value); await continueReply; }
        return true;
      };
      try {
        const reply = a.rpc("config/batchWrite", { edits });
        ok(await held); external(); await release(); proceed(); ok(await reply);
      } finally { intercept = null; proceed(); await release().catch(() => {}); }
    };
    await writeAtBarrier([{ keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" }],
      () => atomic(fs.readFileSync(source, "utf8").replace('model="gpt-6.1-sol"', 'model="gpt-6.1-sol"\nmodel_verbosity="low"')));
    await until(() => read(source).model_reasoning_effort === "medium" && read(source).model_verbosity === "low", "independent native and external edits merge");
    assert.equal((await config(b)).config.model_reasoning_effort, "medium");
    const warningsBefore = a.warnings.length + b.warnings.length;
    await writeAtBarrier([{ keyPath: "model_reasoning_effort", value: "low", mergeStrategy: "replace" }],
      () => atomic(fs.readFileSync(source, "utf8").replace(/model_reasoning_effort\s*=\s*"medium"/, 'model_reasoning_effort="high"')));
    await until(() => a.warnings.length + b.warnings.length === warningsBefore + 1, "one source-winning conflict warning");
    assert.equal(read(source).model_reasoning_effort, "high");
    const warning = [...a.warnings, ...b.warnings].at(-1);
    assert.equal(read(warning.recovery).model_reasoning_effort, "low");
    assert.equal((await config(a)).config.model_reasoning_effort, "high");
    assert.equal((await config(b)).config.model_reasoning_effort, "high");
    // Hold the actual native reply before the AIM adapter can consume it.
    // The native file write has completed; the source lock holds watchers.
    const release = await lock();
    let reached, drop;
    const held = new Promise(resolve => reached = resolve), dropped = new Promise(resolve => drop = resolve);
    intercept = async value => { if (value.result?.status) { reached(value); await dropped; return false; } return true; };
    const reply = a.rpc("config/value/write", { keyPath: "model_instructions_file", value: "../../project/native.md", mergeStrategy: "replace" });
    try {
      ok(await held);
      assert.equal(read(a.invocation.entries[0].view).model_instructions_file, path.join(cwd, "native.md"));
      atomic('model_instructions_file="../../project/later.md"\n' + fs.readFileSync(source, "utf8"));
      process.kill(-a.child.pid, "SIGKILL"); drop(); await release();
      await a.close(); assert.equal((await reply).transportClosed, true);
    } finally { drop(); await release().catch(() => {}); intercept = null; }
    const intents = path.join(a.invocation.entries[0].directory, "intents");
    const records = fs.readdirSync(intents).filter(name => name.endsWith(".json")).map(name => JSON.parse(fs.readFileSync(path.join(intents, name), "utf8")));
    assert.equal(records.length, 1); assert.equal(records[0].outcome, "uncertain");
    assert.equal(read(source).model_instructions_file, "../../project/later.md");
    const fresh = await launch("A-recovered");
    assert.equal((await config(fresh)).config.model_instructions_file, path.join(cwd, "later.md"));
    assert.equal((await config(b)).config.model_instructions_file, path.join(cwd, "later.md"));
    assert.equal(read(source).model_instructions_file, "../../project/later.md");
    console.log(JSON.stringify({ fixture: root, nativeIndependentMerge: true, sourceWinningConflictAndRecovery: true,
      nativeReplyLostAfterWrite: true, uncertainIntentRetainedWithoutReplay: true, siblingAndRestartContinued: true }));
  } else if (phase === "--initial-readonly") {
    // Only settings are initially nonreplaceable. Native's unrelated runtime
    // state still needs a writable home before its first initialization.
    const authored = path.join(homeDir, "authored settings"), target = path.join(authored, "config.toml");
    put(target, initial()); fs.symlinkSync(target, source);
    fs.chmodSync(authored, 0o500);
    try {
      const baseline = await launch("baseline", { protectedLaunch: false }), a = await launch("A");
      assert.equal(fs.statSync(path.dirname(a.invocation.entries[0].view)).mode & 0o777, 0o500);
      const write = owner => owner.rpc("config/value/write", { keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace" });
      for (const owner of [baseline, a]) assert.ok((await write(owner)).error, owner.name + ": initial read-only source rejects native save");
      assert.equal(read(source).model_reasoning_effort, "high");
      fs.chmodSync(authored, 0o700);
      await until(() => (fs.statSync(path.dirname(a.invocation.entries[0].view)).mode & 0o777) === 0o700, "same view becomes writable after source permission repair");
      ok(await write(a));
      await until(() => read(source).model_reasoning_effort === "medium", "same protected owner saves after repair");
      ok(await baseline.rpc("config/value/write", { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "replace" }));
      await until(async () => (await config(a)).config.model_reasoning_effort === "high", "baseline save still reaches protected owner");
      console.log(JSON.stringify({ fixture: root, readOnlyAtLaunchNativeParity: true, sameOwnerSaveAfterRepair: true }));
    } finally { fs.chmodSync(authored, 0o700); }
  } else if (phase === "--repair") {
    put(source, initial());
    put(path.join(cwd, "instructions.md"), "SYNTHETIC_REPAIRED_INSTRUCTIONS");
    const siblingHome = path.join(homeDir, "independent settings");
    put(path.join(siblingHome, "config.toml"), initial());
    const baseline = await launch("baseline", { protectedLaunch: false }), a = await launch("A"), b = await launch("B"),
      sibling = await launch("B-independent", { settingsHome: siblingHome });
    const readRequest = owner => owner.rpc("config/read", { includeLayers: true, cwd });
    const compareFailure = async label => {
      const expected = await readRequest(baseline); assert.ok(expected.error, label + ": native baseline must reject");
      await until(async () => (await readRequest(a)).error, label + ": protected owner follows native read failure", 5000);
      assert.ok((await readRequest(b)).error);
      assert.equal((await config(sibling)).config.model, "gpt-6.1-sol");
    };
    try {
      atomic('model=[\n'); await compareFailure("malformed TOML");
      atomic('model_reasoning_effort={invalid=true}\n'); await compareFailure("invalid native type");
      fs.unlinkSync(source);
      await until(async () => (await readRequest(a)).result?.config?.model == null, "removed source restores missing-file defaults");
      assert.equal((await config(baseline)).config.model ?? null, (await config(a)).config.model ?? null);
      atomic('model_instructions_file="../../project/instructions.md"\n' + initial());
      await until(async () => (await readRequest(a)).result?.config?.model_instructions_file === path.join(cwd, "instructions.md"), "valid repair restores relative path resolution");
      assert.equal((await config(baseline)).config.model_instructions_file, (await config(a)).config.model_instructions_file);
      fs.chmodSync(source, 0o000); await compareFailure("unreadable authored file");
      for (const owner of [baseline, a]) assert.ok((await owner.rpc("config/value/write", {
        keyPath: "model_reasoning_effort", value: "medium", mergeStrategy: "replace",
      })).error, "unreadable source cannot be replaced through a native settings write");
      fs.chmodSync(source, 0o600);
      atomic('model_instructions_file="../../project/instructions.md"\n' + initial().replace('model_reasoning_effort="high"', 'model_reasoning_effort="medium"'));
      await until(async () => (await readRequest(a)).result?.config?.model_reasoning_effort === "medium", "repaired contents replace stale native values");
      fs.chmodSync(shared, 0o500);
      await until(() => (fs.statSync(path.dirname(a.invocation.entries[0].view)).mode & 0o777) === 0o500, "unwritable authored parent also prevents native view replacement");
      for (const owner of [baseline, a]) {
        const response = await owner.rpc("config/value/write", { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "replace" });
        assert.ok(response.error, owner.name + ": write to unwritable parent must fail");
      }
      assert.equal(read(source).model_reasoning_effort, "medium");
      fs.chmodSync(shared, 0o700);
      await until(() => (fs.statSync(path.dirname(a.invocation.entries[0].view)).mode & 0o777) === 0o700, "parent write permissions recover");
      ok(await a.rpc("config/value/write", { keyPath: "model_reasoning_effort", value: "high", mergeStrategy: "replace" }));
      await until(() => read(source).model_reasoning_effort === "high", "native saves work after permission repair");
      assert.equal((await config(b)).config.model_reasoning_effort, "high");
      console.log(JSON.stringify({ fixture: root, nativeMalformedTypedAndMissingParity: true, unreadableFileParity: true,
        writableParentParity: true, repairedNativeWrite: true, unrelatedSiblingContinued: true }));
    } finally { fs.chmodSync(shared, 0o700); if (fs.existsSync(source)) fs.chmodSync(source, 0o600); }
  } else throw new Error("Unknown settings fixture phase: " + phase);
} finally {
  for (const owner of owners.toReversed()) await owner.close();
  for (const owner of owners) put(path.join(root, owner.name + ".stderr.private.txt"), owner.errors.join("\n"));
  put(path.join(root, "protocol.private.json"), JSON.stringify(protocol, null, 2));
  put(path.join(root, "service.private.json"), JSON.stringify(serviceRequests, null, 2));
  put(path.join(root, "models.private.json"), JSON.stringify(modelRequests, null, 2));
  service.closeAllConnections(); await new Promise(resolve => service.close(resolve));
}
