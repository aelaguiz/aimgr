import assert from "node:assert/strict";
import test from "node:test";
import { inspectClaudeManagedPolicy } from "../../src/privacy/claude-managed-policy.js";

const policy = value => ({ kind: "file", bytes: Buffer.from(JSON.stringify(value)) });
function inspect(records = {}, options = {}) {
  const seen = [];
  const result = inspectClaudeManagedPolicy({ protectedAccount: true, platform: "linux", organizationUuid: "fixture-org",
    inspectPath(file) { seen.push(file); return records[file] ?? null; },
    fsImpl: { readdirSync: () => ["b.json", "ignored.txt", "a.json", ".backup.json", "folder.json"].map(name => ({ name, isFile: () => name !== "folder.json", isSymbolicLink: () => false })) }, ...options });
  return { result, seen };
}

test("absent machine policy still inspects the fixed files and drop-in parent", () => {
  const { result, seen } = inspect();
  assert.equal(result.sourceCount, 0);
  assert.deepEqual(seen, ["/etc/claude-code", "/etc/claude-code/managed-settings.json", "/etc/claude-code/managed-settings.d"]);
});

test("safe managed policy preserves unrelated fields and sorted native drop-ins", () => {
  const { result, seen } = inspect({
    "/etc/claude-code": { kind: "directory" },
    "/etc/claude-code/managed-settings.json": policy({ disableRemoteControl: true, permissions: { allow: ["Read"] } }),
    "/etc/claude-code/managed-settings.d": { kind: "directory" },
    "/etc/claude-code/managed-settings.d/a.json": policy({ env: { DISABLE_GROWTHBOOK: "1" } }),
    "/etc/claude-code/managed-settings.d/b.json": policy({ forceLoginMethod: "claudeai" }),
  });
  assert.equal(result.sourceCount, 3);
  assert.deepEqual(seen.slice(-2), ["/etc/claude-code/managed-settings.d/a.json", "/etc/claude-code/managed-settings.d/b.json"]);
});

test("admitted managed TLS inputs include external files and static fallback paths", () => {
  const file = "/etc/claude-code/managed-settings.json";
  const value = { env: { NODE_EXTRA_CA_CERTS: "/opt/company/ca.pem", CLAUDE_CODE_CLIENT_CERT: "certs/client.pem" },
    policyHelpers: { linux: { defaultSettings: { env: { CLAUDE_CODE_CLIENT_KEY: "~/certs/key.pem", SSL_CERT_DIR: "/certs/a:/certs/b" } } } } };
  const records = { [file]: policy(value) };
  const { result } = inspect(records, { cwd: "/work", userHomeDir: "/home/synthetic" });
  assert.deepEqual(new Set(result.tlsReadPaths), new Set(["/opt/company/ca.pem", "/work/certs/client.pem", "/home/synthetic/certs/key.pem", "/certs/a", "/certs/b"]));
  assert.deepEqual(inspect(records, { protectedAccount: false, cwd: "/work", userHomeDir: "/home/synthetic" }).result.tlsReadPaths, result.tlsReadPaths);
});

test("higher-precedence privacy, provider and dynamic-policy conflicts refuse without contents", () => {
  const cases = [
    { disableRemoteControl: false }, { env: { DISABLE_GROWTHBOOK: "0" } }, { env: { DISABLE_UPDATES: "" } },
    { env: { DISABLE_TELEMETRY: "0" } }, { env: { ENABLE_BETA_TRACING_DETAILED: "1" } }, { policyHelper: "private-command" }, { policyHelpers: [] },
    { apiKeyHelper: "private-command" }, { forceLoginMethod: "console" }, { forceLoginOrgUUID: "other" }, { forceLoginOrgUUID: "fixture-org" },
    { forceLoginGatewayUrl: "private-endpoint" }, { env: { CLAUDE_CODE_USE_VERTEX: "1" } },
    { env: { ANTHROPIC_CONFIG_DIR: "private-profile" } }, { env: { CLAUDE_CODE_OAUTH_TOKEN: "private-secret" } },
    { env: [] },
  ];
  for (const value of cases) assert.throws(() => inspect({ "/etc/claude-code/managed-settings.json": policy(value) }), error => {
    assert.equal(error.code, "AIMGR_CLAUDE_PRIVACY_SETTINGS");
    assert.doesNotMatch(error.message, /private-command|private-endpoint|private-secret|private-profile/);
    return true;
  });
});

test("all account modes refuse exporter opt-ins while accepting native false controls", () => {
  const file = "/etc/claude-code/managed-settings.json";
  for (const protectedAccount of [false, true]) {
    for (const value of [false, 0, "false", "0", "off"]) {
      assert.doesNotThrow(() => inspect({ [file]: policy({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: value,
        OTEL_TRACES_EXPORTER: "otlp", OTEL_SDK_DISABLED: "false" } }) }, { protectedAccount }));
    }
    for (const value of [true, 1, "true", "1", "unexpected"]) {
      assert.throws(() => inspect({ [file]: policy({ env: { CLAUDE_CODE_ENABLE_TELEMETRY: value } }) }, { protectedAccount }));
    }
    assert.throws(() => inspect({ [file]: policy({ env: { DISABLE_TELEMETRY: "0", DISABLE_ERROR_REPORTING: "0" } }) }, { protectedAccount }));
  }
});

test("immutable harmless managed headers retain precedence over the session pin", () => {
  const file = "/etc/claude-code/managed-settings.json";
  const options = { providerEnvironment: { ANTHROPIC_CUSTOM_HEADERS: "X-Lower: session" } };
  assert.doesNotThrow(() => inspect({ [file]: policy({ env: { ANTHROPIC_CUSTOM_HEADERS: "X-Managed: retained" } }) }, options));
  assert.throws(() => inspect({ [file]: policy({ env: { ANTHROPIC_CUSTOM_HEADERS: "Authorization: synthetic" } }) }, options));
});

test("all account identifier pins require empty values", () => {
  const file = "/etc/claude-code/managed-settings.json";
  for (const key of ["HOSTNAME", "TERMINATOR_UUID", "TILIX_ID", "GNOME_TERMINAL_SERVICE"]) {
    assert.doesNotThrow(() => inspect({ [file]: policy({ env: { [key]: "" } }) }));
    for (const value of ["private-identifier", "0", "true"]) {
      assert.throws(() => inspect({ [file]: policy({ env: { [key]: value } }) }));
      assert.throws(() => inspect({ [file]: policy({ env: { [key]: value } }) }, { protectedAccount: false }));
    }
  }
});

test("permissions and malformed policy failures are never treated as absent", () => {
  assert.throws(() => inspect({}, { inspectPath() { throw Object.assign(new Error("private-path"), { code: "EACCES" }); } }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.throws(() => inspect({ "/etc/claude-code/managed-settings.json": { kind: "file", bytes: Buffer.from("bad private data") } }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});

test("Mac preferences use actual OS user and bounded plutil after immutable inspection", () => {
  const file = "/Library/Managed Preferences/native-user/com.anthropic.claudecode.plist";
  let calls = 0;
  const { result } = inspect({ [file]: policy({}) }, { platform: "darwin", username: "native-user",
    execFileSyncImpl(command, args, options) {
      calls++;
      assert.equal(command, "/usr/bin/plutil");
      assert.deepEqual(args, ["-convert", "json", "-o", "-", file]);
      assert.equal(options.timeout, 5000);
      return '{"disableRemoteControl":true}';
    } });
  assert.equal(calls, 1);
  assert.equal(result.sourceCount, 1);
  assert.ok(result.checkedPaths.includes("/Library/Managed Preferences/com.anthropic.claudecode.plist"));
});

test("typed booleans and primitive env coercion match native; tokens remain literal", () => {
  const file = "/etc/claude-code/managed-settings.json";
  for (const value of [1, true, " yes ", "ON"]) {
    assert.doesNotThrow(() => inspect({ [file]: policy({ env: { DISABLE_GROWTHBOOK: value } }) }));
  }
  for (const value of ["false", "0"]) {
    assert.throws(() => inspect({ [file]: policy({ env: { ANTHROPIC_AUTH_TOKEN: value } }) }));
  }
  assert.doesNotThrow(() => inspect({ [file]: policy({ env: { CLAUDE_CODE_USE_VERTEX: "something" } }) }));
  assert.throws(() => inspect({ [file]: policy({ env: { ANTHROPIC_FEDERATION_RULE_ID: "rule", ANTHROPIC_ORGANIZATION_ID: "org" } }) }));
  assert.throws(() => inspect({ [file]: policy({ env: { ANTHROPIC_CUSTOM_HEADERS: "Harmless: yes\nAuthorization: secret" } }) }));
  assert.throws(() => inspect({ [file]: policy({ env: { DISABLE_GROWTHBOOK: "1", disable_growthbook: "0" } }) }));
});

test("safe static-only policies remain usable and cannot repair an unsafe base", () => {
  const file = "/etc/claude-code/managed-settings.json";
  const safe = { disableRemoteControl: true, env: { DISABLE_GROWTHBOOK: "1" } };
  assert.doesNotThrow(() => inspect({ [file]: policy({ policyHelpers: { linux: { defaultSettings: safe } } }) }));
  assert.throws(() => inspect({ [file]: policy({ forceLoginOrgUUID: "fixture-org", policyHelpers: { default: safe } }) }));
  assert.throws(() => inspect({ [file]: policy({ policyHelpers: { linux: { path: "/usr/bin/true", defaultSettings: safe } } }) }));
  assert.throws(() => inspect({ [file]: policy({ policyHelpers: { default: { env: { DISABLE_GROWTHBOOK: "0" } } } }) }));
});

test("the first successfully converted Mac plist shadows device values even when empty", () => {
  const user = "/Library/Managed Preferences/native-user/com.anthropic.claudecode.plist";
  const device = "/Library/Managed Preferences/com.anthropic.claudecode.plist";
  let calls = 0;
  const { result } = inspect({ [user]: policy({}), [device]: policy({}) }, {
    platform: "darwin", username: "native-user",
    execFileSyncImpl(command, args) { calls++; assert.equal(args.at(-1), user); return "{}"; },
  });
  assert.equal(calls, 1);
  assert.equal(result.sourceCount, 1);
  assert.ok(result.checkedPaths.includes(device));
});

test("federation halves across file, MDM and static candidates cannot select another provider", () => {
  const rule = { env: { ANTHROPIC_FEDERATION_RULE_ID: "rule" } };
  const org = { env: { ANTHROPIC_ORGANIZATION_ID: "org" } };
  assert.throws(() => inspect({
    "/Library/Application Support/ClaudeCode/managed-settings.json": policy(org),
    "/Library/Managed Preferences/native-user/com.anthropic.claudecode.plist": policy(rule),
  }, { platform: "darwin", username: "native-user", execFileSyncImpl: () => JSON.stringify(rule) }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.throws(() => inspect({ "/etc/claude-code/managed-settings.json": policy({ ...rule,
    policyHelpers: { linux: { defaultSettings: org } } }) }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
  assert.throws(() => inspect({ "/etc/claude-code/managed-settings.json": policy({ policyHelpers: {
    default: { env: { DISABLE_GROWTHBOOK: "1", disable_growthbook: "0" } },
  } }) }), { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
});


test("all accounts reject managed sources which reenable detached sessions", () => {
  for (const protectedAccount of [false, true]) {
    for (const value of [{ disableAgentView: false }, { disableAgentView: "true" },
      { env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: "0" } },
      { env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: "1", claude_code_disable_agent_view: "0" } },
      { policyHelpers: { default: { disableAgentView: false } } }]) {
      assert.throws(() => inspect({ "/etc/claude-code/managed-settings.json": policy(value) }, { protectedAccount }),
        { code: "AIMGR_CLAUDE_PRIVACY_SETTINGS" });
    }
    assert.doesNotThrow(() => inspect({ "/etc/claude-code/managed-settings.json": policy({ disableAgentView: true,
      env: { CLAUDE_CODE_DISABLE_AGENT_VIEW: "1" } }) }, { protectedAccount }));
  }
});
