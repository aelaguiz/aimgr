import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectCodexAdministratorPath } from "./codex-artifacts.js";
import { parseCodexSettings, updateCodexSettings } from "../io/codex-settings-toml.js";
import { decodeJwtPayload } from "../credentials/jwt.js";

const managedChanges = [{ keys: ["analytics", "enabled"], value: false }, { keys: ["feedback", "enabled"], value: false }];
const requirementChanges = [{ keys: ["cli_auth_credentials_store"], value: "file" },
  { keys: ["allow_remote_control"], value: false }, { keys: ["check_for_update_on_startup"], value: false },
  { keys: ["feedback", "enabled"], value: false }];
export function codexManagedPolicyText({ config = "", requirements = "" } = {}) {
  return { config: updateCodexSettings(config, managedChanges), requirements: updateCodexSettings(requirements, requirementChanges) };
}

function valueAt(value, keys) { return keys.reduce((current, key) => current?.[key], value); }
function parsePolicy(text, source) {
  try { return parseCodexSettings(text).value; }
  catch { throw new Error(`Codex was not started: mandatory policy is invalid in ${source}.`); }
}

export function inspectCodexManagedPolicy({ artifact, credential, platform = process.platform,
  inspect = inspectCodexAdministratorPath, readForced = () => JSON.parse(execFileSync(artifact.managedPreferences, [], {
    encoding: "utf8", env: { PATH: "/usr/bin:/bin" }, timeout: 5000, maxBuffer: 5 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
  })), etcDirectory = fs.realpathSync("/etc") } = {}) {
  const files = ["managed_config.toml", "requirements.toml"].map(name => path.join(etcDirectory, "codex", name));
  const documents = files.map(file => {
    const input = inspect(file);
    if (input?.kind !== "file") throw new Error(`Codex was not started: required privacy policy ${file} is missing. Install the reviewed Codex privacy policy.`);
    return { source: file, value: parsePolicy(input.bytes.toString("utf8"), file) };
  });
  const forced = platform === "darwin" ? readForced() : {};
  for (const key of ["config_toml_base64", "requirements_toml_base64"]) {
    const source = `forced com.openai.codex ${key}`;
    const encoded = forced[key];
    if (encoded !== undefined && (typeof encoded !== "string" || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded))) throw new Error(`Codex was not started: ${source} is not valid base64.`);
    documents.push({ source, value: encoded === undefined ? {} : parsePolicy(Buffer.from(encoded, "base64").toString("utf8"), source) });
  }
  const [config, requirements, mdmConfig, mdmRequirements] = documents;
  for (const [changes, lower, higher] of [[managedChanges.slice(0, 1), config, mdmConfig], [requirementChanges, requirements, mdmRequirements]]) {
    for (const { keys, value } of changes) {
      const source = valueAt(higher.value, keys) === undefined ? lower : higher;
      if (valueAt(source.value, keys) !== value) throw new Error(`Codex was not started: ${source.source} conflicts with required ${keys.join(".")}=${JSON.stringify(value)}.`);
    }
  }
  // The native remote-policy loader can replace local requirements later,
  // without consulting AIM. A cache preflight cannot admit those future bytes.
  // Match actual native eligibility; ordinary personal plans do not load it.
  const claims = decodeJwtPayload(credential?.idToken)?.["https://api.openai.com/auth"];
  const accessClaims = decodeJwtPayload(credential?.access)?.["https://api.openai.com/auth"];
  const selectedClaims = credential?.accountId !== claims?.chatgpt_account_id
    && accessClaims?.chatgpt_account_id === credential?.accountId
    && (accessClaims?.chatgpt_user_id ?? accessClaims?.user_id) === (claims?.chatgpt_user_id ?? claims?.user_id) ? accessClaims : claims;
  const plan = selectedClaims?.chatgpt_plan_type;
  const remotePlan = ["business", "ent26", "enterprise_cbp_automation", "enterprise_cbp_usage_based",
    "enterprise", "hc", "edu", "education", "edu_plus", "edu_pro", "sci", "sci_plus"].includes(plan);
  const configServer = valueAt(mdmRequirements.value, ["config_server"]) ?? valueAt(requirements.value, ["config_server"]);
  if (remotePlan || configServer) throw new Error("Codex was not started: this account can receive remote managed requirements that this approved build cannot bind to the privacy policy. Its remote policy needs a reviewed enforcement mechanism.");
  return { files, documents };
}

export function validateCodexExporters(documents) {
  for (const { source, file, value } of documents) for (const key of ["exporter", "trace_exporter", "metrics_exporter"]) {
    const exporter = value?.otel?.[key];
    // Statsig's metrics form is controlled by native analytics consent. It is
    // not a supported independent logs/traces collector.
    if (exporter === "statsig" && key !== "metrics_exporter") throw new Error(`Codex was not started: ${source ?? file} selects a provider telemetry exporter.`);
    const endpoint = exporter?.["otlp-http"]?.endpoint ?? exporter?.["otlp-grpc"]?.endpoint;
    if (typeof endpoint !== "string") continue;
    let host; try { host = new URL(endpoint).hostname.toLowerCase().replace(/\.$/, ""); } catch { continue; } // Native validates malformed endpoints.
    if (["openai.com", "chatgpt.com"].some(domain => host === domain || host.endsWith(`.${domain}`))) {
      throw new Error(`Codex was not started: ${source ?? file} selects a known provider telemetry destination in otel.${key}.`);
    }
  }
}
