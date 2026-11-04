import assert from "node:assert/strict";
import test from "node:test";
import { PassThrough } from "node:stream";
import { prepareCodexNativeInputs } from "../../src/privacy/codex-native-inputs.js";
import { codexArguments } from "../../src/privacy/codex-arguments.js";

const secret = "SYNTHETIC_INPUT_SECRET";
const artifact = { configState: "/approved/config-state", artifactSet: "a".repeat(64) };
const valid = () => ({ schema: 1, source_revision: "6ff1e1ca3b30fc8b914720681fcf5fe62e95f856",
  cwd: "/work", reads: ["/inputs/instructions"], writes: ["/work"], database_roots: ["/state"],
  database_files: ["/state/state.sqlite"], exporters_disabled: true,
  analytics_disabled: true, feedback_disabled: true, updates_disabled: true, initialized: true });
const options = () => ({ artifact, prepared: { codexHome: "/account" }, parsedArgs: {
  cwd: "/work", profile: "selected", command: "exec", config: [`model_provider.secret=${secret}`],
  harness: { model: "explicit-model", additional_writable_roots: ["/extra"] },
  strictConfig: true, ignoreUserConfig: true, ignoreRules: true },
  env: { PATH: "/usr/bin", SDK_KEY: secret, LD_PRELOAD: "/bad.so", DYLD_INSERT_LIBRARIES: "/bad.dylib",
    GLIBC_TUNABLES: "bad", LD_LIBRARY_PATH: "/bad", DBUS_SESSION_BUS_ADDRESS: "unix:path=/bus" },
  managed: { forced: { config_toml_base64: "c3ludGhldGlj" } } });

function transport(reply, inspect = () => {}) {
  return (command, args, execution) => {
    let input = "";
    const stdin = new PassThrough();
    stdin.on("data", bytes => input += bytes);
    const promise = new Promise((resolve, reject) => stdin.on("finish", () => {
      try {
        inspect({ command, args, execution, request: JSON.parse(input) });
        if (reply instanceof Error) reject(reply);
        else resolve({ stdout: typeof reply === "string" ? reply : JSON.stringify(reply), stderr: secret });
      } catch (error) { reject(error); }
    }));
    promise.child = { stdin };
    return promise;
  };
}

test("native preparation keeps config in a private pipe and removes only helper loader injection", async () => {
  const input = options();
  let observed;
  const result = await prepareCodexNativeInputs({ ...input, executeImpl: transport(valid(), value => observed = value) });
  assert.equal(result.initialized, true);
  assert.equal(observed.command, artifact.configState);
  assert.deepEqual(observed.args, []);
  assert.equal(observed.request.config[0], `model_provider.secret=${secret}`);
  assert.equal(observed.request.strict_config, true);
  assert.equal(observed.request.ignore_user_config, true);
  assert.equal(observed.request.ignore_rules, true);
  assert.equal(observed.request.headless, true);
  assert.equal(observed.request.forced_requirements, "");
  assert.equal(observed.execution.env.SDK_KEY, secret);
  assert.equal(observed.execution.env.DBUS_SESSION_BUS_ADDRESS, "unix:path=/bus");
  for (const key of ["LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "GLIBC_TUNABLES"]) {
    assert.equal(Object.hasOwn(observed.execution.env, key), false);
    assert.equal(Object.hasOwn(input.env, key), true, "ordinary tools retain their separate environment");
  }
});

test("native failure diagnostics never expose config, output or child errors", async () => {
  for (const response of [new Error(secret), secret, JSON.stringify({ secret })]) {
    await assert.rejects(prepareCodexNativeInputs({ ...options(), executeImpl: transport(response) }),
      error => !error.message.includes(secret) && !error.cause);
  }
});

test("input inventory rejects malformed paths, incomplete initialization and policy changes", async () => {
  const mutations = [v => v.reads.push("relative"), v => v.database_files.push(null),
    v => v.project_cwds = ["relative"], v => v.cwd = "relative", v => v.initialized = false,
    v => v.schema++, v => v.source_revision = "wrong", v => v.analytics_disabled = false,
    v => v.feedback_disabled = false, v => v.updates_disabled = false,
    v => v.exporters_disabled = false, v => delete v.exporters_disabled,
    v => v.exporters_disabled = "true"];
  for (const mutate of mutations) {
    const response = valid(); mutate(response);
    await assert.rejects(prepareCodexNativeInputs({ ...options(), executeImpl: transport(response) }));
  }
});

test("read-only inventory requires no initialized marker and does not turn TUI flags into exec flags", async () => {
  const input = options(); input.parsedArgs.command = "resume";
  const response = valid(); response.initialized = false;
  let request;
  await prepareCodexNativeInputs({ ...input, operation: "inputs", executeImpl: transport(response, v => request = v.request) });
  assert.equal(request.operation, "inputs");
  assert.equal(request.headless, false);
  assert.equal(request.ignore_user_config, false);
  assert.equal(request.ignore_rules, false);
});

test("saved TUI selection preserves last-prompt grammar and does not add headless restoration", async () => {
  for (const command of ["resume", "fork"]) {
    for (const args of [[command, "--last", "/compact synthetic"], [command, "synthetic-name"], [command, "--all"]]) {
      const input = options(); input.parsedArgs = codexArguments(args, {cwd:"/work"});
      let request;
      await prepareCodexNativeInputs({...input,executeImpl:transport(valid(),v=>request=v.request)});
      assert.equal(request.saved.selector, args.includes("--last") || args.includes("--all") ? null : "synthetic-name");
      assert.equal(request.saved.fork,command==="fork");
      assert.equal(request.saved.last,args.includes("--last"));
      assert.equal(request.saved.explicit_cwd,false);
    }
  }
  const input=options(); input.parsedArgs=codexArguments(["exec","resume","--last"],{cwd:"/work"});
  await prepareCodexNativeInputs({...input,executeImpl:transport(valid(),v=>assert.equal(v.request.saved,null))});
});
