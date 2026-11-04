import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { inspectCodexAdministratorPath } from "./codex-artifacts.js";
import { parseCodexSettings, updateCodexSettings } from "../io/codex-settings-toml.js";

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

export function inspectCodexManagedPolicy({ artifact, platform = process.platform,
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
  // Even [] invokes the pinned loader's hostname discovery, before matching
  // or precedence. This organization-policy feature is outside the approved
  // privacy scope; do not inspect the actual host or silently ignore it.
  for (const document of [requirements, mdmRequirements]) {
    if (Object.hasOwn(document.value, "remote_sandbox_config")) {
      throw new Error(`Codex was not started: ${document.source} sets remote_sandbox_config. Hostname-based sandbox requirements are unavailable with AIM privacy.`);
    }
  }
  for (const [changes, lower, higher] of [[managedChanges.slice(0, 1), config, mdmConfig], [requirementChanges, requirements, mdmRequirements]]) {
    for (const { keys, value } of changes) {
      const source = valueAt(higher.value, keys) === undefined ? lower : higher;
      if (valueAt(source.value, keys) !== value) throw new Error(`Codex was not started: ${source.source} conflicts with required ${keys.join(".")}=${JSON.stringify(value)}.`);
    }
  }
  // Organization-supplied remote requirements are an explicitly accepted gap.
  // A plan snapshot cannot establish session-lifetime eligibility. Keep local
  // policy checks above; do not reject account tiers or patch native loading.
  return { files, documents, forced };
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
