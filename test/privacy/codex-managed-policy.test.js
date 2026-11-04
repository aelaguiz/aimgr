import assert from "node:assert/strict";
import test from "node:test";
import { codexManagedPolicyText, inspectCodexManagedPolicy } from "../../src/privacy/codex-managed-policy.js";
import { parseCodexSettings } from "../../src/io/codex-settings-toml.js";

function options({ forced = {}, plan = "plus", config, requirements } = {}) {
  const installed = codexManagedPolicyText({ config, requirements });
  return { platform: "darwin", etcDirectory: "/etc", readForced: () => Object.fromEntries(Object.entries(forced).map(([key, value]) => [key, Buffer.from(value).toString("base64")])),
    inspect: file => ({ kind: "file", bytes: Buffer.from(file.endsWith("/managed_config.toml") ? installed.config : installed.requirements) }),
    credential: { idToken: `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: plan } })).toString("base64url")}.signature` },
  };
}

test("native requirements disable every exporter while preserving unrelated authored policy", () => {
  const config = '# keep this\n[otel]\nlog_user_prompt = true\nmetrics_exporter = { "otlp-http" = { endpoint = "https://collector.example/v1", protocol = "binary" } }\n';
  const result = codexManagedPolicyText({ config });
  const before = parseCodexSettings(config).value, after = parseCodexSettings(result.config).value;
  assert.deepEqual(after.otel, before.otel);
  assert.equal(after.analytics.enabled, false);
  assert.deepEqual(parseCodexSettings(result.requirements).value.otel,
    { exporter: "none", trace_exporter: "none", metrics_exporter: "none" });
  assert.match(result.config, /# keep this/);
  assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ config })));
  for (const key of ["exporter", "trace_exporter", "metrics_exporter"]) {
    assert.throws(() => inspectCodexManagedPolicy(options({ forced: {
      requirements_toml_base64: `[otel]\n${key}={"otlp-http"={endpoint="https://collector.example/v1",protocol="binary"}}\n`,
    } })), new RegExp("forced.*otel." + key));
  }
});

test("installation preserves existing sessions' MCP backend instead of imposing a global default", () => {
  assert.equal(parseCodexSettings(codexManagedPolicyText().config).value.mcp_oauth_credentials_store, undefined);
  for (const mode of ["file", "auto", "keyring"]) {
    const config = `mcp_oauth_credentials_store="${mode}"\n`;
    assert.equal(parseCodexSettings(codexManagedPolicyText({ config }).config).value.mcp_oauth_credentials_store, mode);
  }
});

test("actual forced policy is checked by effective privacy-field precedence", () => {
  assert.throws(() => inspectCodexManagedPolicy(options({ forced: { config_toml_base64: "[analytics]\nenabled=true" } })), /forced.*analytics.enabled/);
  assert.throws(() => inspectCodexManagedPolicy(options({ forced: { requirements_toml_base64: "allow_remote_control=true" } })), /forced.*allow_remote_control/);
  assert.throws(() => inspectCodexManagedPolicy(options({ forced: { requirements_toml_base64: '[feedback]\nenabled=true' } })), /forced.*feedback.enabled/);
  assert.throws(() => inspectCodexManagedPolicy(options({ forced: { requirements_toml_base64: 'cli_auth_credentials_store="keyring"' } })), /cli_auth_credentials_store/);
  assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ forced: { config_toml_base64: '[feedback]\nenabled=true' } })), "requirements still force feedback false");
});

test("approved organization-policy gap does not introduce an account-tier or config-server ban", () => {
  for (const plan of ["free", "go", "plus", "pro", "prolite", "promax", "team", "self_serve_business_prolite", "self_serve_business_usage_based"]) {
    assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ plan })), plan);
  }
  for (const plan of ["business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based", "enterprise", "hc", "edu", "education", "edu_plus", "edu_pro", "sci", "sci_plus"]) {
    assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ plan })), plan);
  }
  assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ requirements: '[config_server]\nurl="https://policy.example"\n' })));
});

test("selected-workspace claims do not become an unsupported account restriction", () => {
  const token = claims => `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": claims })).toString("base64url")}.signature`;
  const fixture = options();
  fixture.credential = { accountId: "workspace", idToken: token({ chatgpt_plan_type: "plus", user_id: "user" }),
    access: token({ chatgpt_account_id: "workspace", chatgpt_plan_type: "hc", chatgpt_user_id: "user" }) };
  assert.doesNotThrow(() => inspectCodexManagedPolicy(fixture));
  fixture.credential.access = token({ chatgpt_account_id: "workspace", chatgpt_plan_type: "plus", user_id: "user" });
  assert.doesNotThrow(() => inspectCodexManagedPolicy(fixture));
});

test("hostname-based administrator requirements refuse before discovery, even when empty or shadowed", () => {
  for (const value of ['remote_sandbox_config=[]', '[[remote_sandbox_config]]\nhostname_patterns=["never-matches.example"]\nallowed_sandbox_modes=["read-only"]']) {
    assert.throws(() => inspectCodexManagedPolicy(options({ requirements: value })), /requirements.toml sets remote_sandbox_config/);
    assert.throws(() => inspectCodexManagedPolicy(options({ forced: { requirements_toml_base64: value } })), /forced.*sets remote_sandbox_config/);
    assert.throws(() => inspectCodexManagedPolicy(options({ requirements: value,
      forced: { requirements_toml_base64: 'allowed_sandbox_modes=["danger-full-access"]' } })), /sets remote_sandbox_config/);
    assert.doesNotThrow(() => inspectCodexManagedPolicy(options({ config: value })), "an ordinary config key is not this requirements feature");
  }
});
