import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectClaudeAdministratorPath } from "./claude-artifacts.js";
import { claudeManagedSources, CLAUDE_PROVIDER_SWITCHES } from "./claude-provider-admission.js";
import { ClaudePrivacySettingsError, claudeCriticalSettings } from "./claude-settings.js";
import { resolveClaudeTlsReadPaths } from "./claude-tls-inputs.js";

const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
const fail = () => { throw new ClaudePrivacySettingsError("machine-managed Claude settings are unreadable, mutable, dynamic, or conflict with this account's privacy controls"); };
// Native typed booleans are not generic truthiness. A token/path containing
// "false" is still a token/path; it must never use this conversion (T08/T09).
const enabled = value => ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
const nonempty = value => value !== undefined && value !== null && String(value).length > 0;
function merge(later, earlier = {}) {
  const result = structuredClone(earlier);
  for (const [key, value] of Object.entries(later)) {
    if (["__proto__", "constructor", "prototype"].includes(key)) fail();
    result[key] = object(value) && object(result[key]) ? merge(value, result[key]) : structuredClone(value);
  }
  return result;
}

function environment(tiers) {
  const result = {};
  for (const settings of tiers) {
    if (settings.env !== undefined && !object(settings.env)) fail();
    // Native coerces env values to strings. Admit primitive values here;
    // object/array/null coercion is deliberately outside this small checker.
    // Its union is case-insensitive: higher tiers win even for an empty value.
    const values = new Map();
    for (const [key, raw] of Object.entries(settings.env ?? {})) {
      if (!["string", "number", "boolean"].includes(typeof raw)) fail();
      const name = key.toUpperCase();
      if (!values.has(name) || key === name) values.set(name, String(raw));
    }
    for (const [key, value] of values) if (!(key in result)) result[key] = value;
  }
  delete result.CLAUDE_CODE_DISABLE_ADMIN_ENV_UNION;
  return result;
}

function assertStaticPayloads(source, platform, protectedAccount, candidates) {
  const helpers = source.policyHelpers;
  if (source.policyHelper != null || (helpers !== undefined && !object(helpers))) fail();
  if (!helpers) return;
  const selected = helpers[platform === "darwin" ? "macos" : "linux"];
  if (selected != null && (!object(selected) || selected.path != null || selected.script != null)) fail();
  // No copied tolerant-schema or tier ranking. Every potentially selected
  // base and serving fallback must keep the critical invariant. Native doctor
  // still validates the selected map's off-platform payload schemas.
  for (const payload of [selected?.defaultSettings, helpers.default]) {
    if (payload == null) continue;
    if (!object(payload)) fail();
    candidates.push(payload);
  }
}

function assertControls(settings, protectedAccount, providerEnvironment = {}) {
  if (settings.disableRemoteControl !== undefined && settings.disableRemoteControl !== true) fail();
  // Even a matching org pin makes individual Pro/Max remote-policy eligible.
  // A later static replacement cannot undo eligibility memoized during init.
  if (settings.forceLoginOrgUUID !== undefined || nonempty(settings.apiKeyHelper)
    || settings.forceLoginGatewayUrl != null
    || (settings.forceLoginMethod !== undefined && settings.forceLoginMethod !== "claudeai")) fail();
  const env = settings.env ?? {};
  for (const [key, required] of Object.entries(claudeCriticalSettings({ protectedAccount }).env)) {
    if (env[key] !== undefined && (required === "" ? nonempty(env[key]) : !enabled(env[key]))) fail();
  }
  for (const [key, required] of Object.entries(providerEnvironment)) {
    // Custom headers are fixed below managed policy. Immutable administrator
    // headers retain their native higher precedence; they need only pass the
    // competing-auth check below, not equal a lower-tier session value.
    if (env[key] === undefined || CLAUDE_PROVIDER_SWITCHES.includes(key) || key === "ANTHROPIC_CUSTOM_HEADERS") continue;
    if (required === "" ? nonempty(env[key]) : env[key] !== required) fail();
  }
  for (const key of CLAUDE_PROVIDER_SWITCHES) if (enabled(env[key])) fail();
  for (const key of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN",
    "ANTHROPIC_PROFILE", "ANTHROPIC_CONFIG_DIR", "ANTHROPIC_BASE_URL", "CLAUDE_CODE_API_BASE_URL",
    "CLAUDE_CODE_CUSTOM_OAUTH_URL", "CLAUDE_CODE_PROCESS_WRAPPER", "ANTHROPIC_UNIX_SOCKET"]) {
    if (nonempty(env[key])) fail();
  }
  if (nonempty(env.ANTHROPIC_FEDERATION_RULE_ID) && nonempty(env.ANTHROPIC_ORGANIZATION_ID)) fail();
  if ((env.ANTHROPIC_CUSTOM_HEADERS ?? "").split("\n").some(line => /^(authorization|x-api-key)\s*:/i.test(line.trimStart()))) fail();
}

/** Read immutable native sources and check only privacy/provider semantics.
 * T08/T09: this receipt MUST be followed by one isolated native doctor reading
 * these actual sources and the exact snapshot. The approved native build
 * reports flag-overlay parse errors independently of managed-policy selection;
 * the checker rejects those diagnostics even when Remote Control is disabled.
 * Raw policy values never enter errors or returned receipts.
 */
export function inspectClaudeManagedPolicy({
  protectedAccount, providerEnvironment = {},
  cwd = process.cwd(), userHomeDir = os.homedir(),
  platform = process.platform, username = os.userInfo().username,
  fsImpl = fs, inspectPath = inspectClaudeAdministratorPath, execFileSyncImpl = execFileSync,
} = {}) {
  const sources = claudeManagedSources({ platform, username });
  const checked = new Set(), grants = new Set();
  let count = 0;
  const inspect = (file, readBytes = true) => {
    const item = inspectPath(file, { fsImpl, readBytes });
    checked.add(file);
    if (item?.resolvedPath) grants.add(item.resolvedPath);
    return item;
  };
  const json = item => {
    if (item === null) return null;
    if (item.kind !== "file") fail();
    const source = item.bytes.toString("utf8").replace(/^\uFEFF/, "");
    const value = source.trim() ? JSON.parse(source) : {};
    if (!object(value)) fail();
    count++;
    return value;
  };
  try {
    const directory = inspect(sources.directory);
    if (directory && directory.kind !== "directory") fail();
    let files = json(inspect(path.join(sources.directory, "managed-settings.json")));
    const dropins = path.join(sources.directory, "managed-settings.d");
    const folder = inspect(dropins);
    if (folder && folder.kind !== "directory") fail();
    if (folder) {
      const entries = fsImpl.readdirSync(dropins, { withFileTypes: true });
      const names = entries.filter(item => !item.name.startsWith(".") && item.name.endsWith(".json")
        && (item.isFile() || item.isSymbolicLink())).map(item => item.name).sort();
      for (const name of names) files = merge(json(inspect(path.join(dropins, name))), files ?? {});
    }
    let mdm = null;
    for (const preference of sources.preferences) {
      const item = inspect(preference, false);
      if (!item) continue;
      if (item.kind !== "file") fail();
      const result = execFileSyncImpl("/usr/bin/plutil", ["-convert", "json", "-o", "-", preference], {
        encoding: "utf8", timeout: 5000, maxBuffer: 2 * 1024 * 1024,
        env: { PATH: "/usr/bin:/bin", LANG: "C" }, stdio: ["ignore", "pipe", "pipe"],
      });
      const value = JSON.parse(result);
      if (!object(value)) fail();
      count++;
      // A successfully converted user plist shadows the device plist even
      // when empty. Inspect the latter's replacement permissions but do not
      // parse it as an active second native source.
      if (mdm === null) mdm = value;
      for (const rest of sources.preferences.slice(sources.preferences.indexOf(preference) + 1)) inspect(rest, false);
      break;
    }
    // Native can downgrade malformed sources before selecting a tier, and
    // static replacement can hide an old unrelated diagnostic. Do not guess
    // quality from raw JSON: every candidate must satisfy the invariant.
    // This conservative check can refuse a conflicting value that native would
    // shadow. That compatibility limit is recorded in the plan, not disguised
    // as exact support for every managed-policy precedence arrangement.
    const sourcesToCheck = [mdm, files].filter(value => value !== null);
    const candidates = [...sourcesToCheck];
    for (const source of sourcesToCheck) assertStaticPayloads(source, platform, protectedAccount, candidates);
    const federation = new Set();
    for (const source of candidates) {
      assertControls({ ...source, env: environment([source]) }, protectedAccount, providerEnvironment);
      // Case variants can apply separately on POSIX even though native policy
      // selection unions keys case-insensitively. Check each critical variant.
      for (const [key, value] of Object.entries(source.env ?? {})) {
        assertControls({ env: { [key.toUpperCase()]: String(value) } }, protectedAccount, providerEnvironment);
        // Native merges env across managed tiers and static policies. Each
        // half alone is inert, but their union can select a different auth
        // provider. Preserve the invariant across every admitted candidate.
        if (["ANTHROPIC_FEDERATION_RULE_ID", "ANTHROPIC_ORGANIZATION_ID"].includes(key.toUpperCase())
          && String(value).trim()) federation.add(key.toUpperCase());
      }
    }
    if (federation.size === 2) fail();
    return Object.freeze({ checkedPaths: Object.freeze([...checked]), resolvedReadPaths: Object.freeze([...grants]),
      tlsReadPaths: Object.freeze(protectedAccount ? resolveClaudeTlsReadPaths({
        environments: candidates.map(source => environment([source])), cwd, userHomeDir,
      }) : []),
      sourceCount: count, requiresNativePolicyValidation: count > 0 });
  } catch { fail(); }
}
