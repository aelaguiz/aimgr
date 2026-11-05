import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { codexProxyProfiles, readAimgrConfig } from "../config/aimgr-config.js";
import { normalizeEgressPolicy, resolveEgressProfile } from "./claude-egress-policy.js";
import { acquireAccountAssignmentLock } from "./assignment-lock.js";
import { CodexRouteError } from "./route-error.js";
import { createAccountTransport, checkAccountRouteExit } from "./claude-transport.js";
import { fetchJsonWithTimeout } from "../io/fetch.js";

export { CodexRouteError };
export const normalizeCodexEgress = value => normalizeEgressPolicy(value, { RouteError: CodexRouteError });

export function codexRouteRecord(state, label, accountId) {
  const account = state.accountsByProvider?.["openai-codex"]?.[label] ?? state.accounts?.[label];
  if (account?.provider !== "openai-codex" || (account.accountId && account.accountId !== accountId)) {
    throw new CodexRouteError("invalid_account", { label });
  }
  return { label, accountId, version: account.metadataVersion, policy: { egress: account.egress } };
}

function bindingPath({ homeDir, accountId, environment }) {
  if (!accountId || !/^[a-f0-9]{64}$/.test(environment?.binding ?? "")) throw new CodexRouteError("invalid_account");
  const key = createHash("sha256").update(`${environment.binding}\0${accountId}`).digest("hex");
  return path.join(homeDir, ".aimgr", "codex-egress", `${key}.json`);
}

export function readCodexOfflineBinding(options) {
  try {
    const value = JSON.parse(fs.readFileSync(bindingPath(options), "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value) || value.required !== true
      || value.provider !== "openai-codex" || value.accountId !== options.accountId
      || value.environmentId !== options.environment.binding
      || (value.invalidated !== undefined && value.invalidated !== true)
      || (value.version !== undefined && (!Number.isSafeInteger(value.version) || value.version < 1))
      || (!value.invalidated && (!value.version || !value.egress))) throw new Error("invalid binding");
    return value;
  }
  catch (error) { if (error.code === "ENOENT") return null; throw new CodexRouteError("invalid_proxy_assignment", { ...options, cause: error }); }
}

export function writeCodexOfflineBinding(options, value) {
  const file = bindingPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(staged, JSON.stringify({ ...value, provider: "openai-codex", accountId: options.accountId,
    environmentId: options.environment.binding, label: options.label }) + "\n", { mode: 0o600 });
  fs.renameSync(staged, file);
}

export function invalidateCodexOfflineBinding(options, minimumVersion) {
  writeCodexOfflineBinding(options, { required: true, invalidated: true, version: minimumVersion });
}

export function acquireCodexAssignmentLock(options, lockOptions) {
  return acquireAccountAssignmentLock(bindingPath(options), { ...lockOptions, label: options.label,
    client: "Codex", busyCode: "AIMGR_CODEX_ASSIGNMENT_BUSY" });
}

/** Call under the account's assignment lock for HTTP or native execution.
 * A stale snapshot cannot revive a locally changed or invalidated assignment. */
export function resolveCodexRoute({ homeDir, accountId, label, environment, record, offline = false,
  profiles = codexProxyProfiles(readAimgrConfig({ homeDir }).config) }) {
  const options = { homeDir, accountId, label, environment };
  const previous = readCodexOfflineBinding(options);
  if (previous && (previous.provider !== "openai-codex" || previous.accountId !== accountId
    || previous.environmentId !== environment.binding)) throw new CodexRouteError("invalid_proxy_assignment", { label });
  if (record && (record.accountId !== accountId || record.label !== label)) throw new CodexRouteError("invalid_account", { label });
  const egress = record?.policy?.egress;
  if (egress === undefined && !previous) return null;
  // Remember opt-in before resolving machine configuration. Missing config or
  // later cache loss must not turn an enrolled account into a direct account.
  if (!previous) invalidateCodexOfflineBinding(options);
  if (offline && (!previous || previous.invalidated)) throw new CodexRouteError("invalid_proxy_assignment", { label });
  if (!offline && (!record || !Number.isSafeInteger(record.version)
    || (previous?.version && record.version < previous.version))) throw new CodexRouteError("invalid_proxy_assignment", { label });
  const selected = offline ? previous.egress : egress;
  const profile = resolveCodexProxyProfile({ label, egress: selected, profiles });
  if (!offline) writeCodexOfflineBinding(options, { required: true, version: record.version,
    egress: normalizeCodexEgress(egress) });
  return profile;
}

export function resolveCodexProxyProfile({ label, egress, profiles }) {
  const profile = resolveEgressProfile({ label, account: { egress }, profiles, RouteError: CodexRouteError });
  const configured = profiles[profile.profileRef];
  if (!Number.isInteger(configured.httpPort) || configured.httpPort < 1 || configured.httpPort > 65535
    || configured.httpPort === profile.socksPort) throw new CodexRouteError("invalid_proxy_profile", profile);
  return Object.freeze({ ...profile, provider: "openai-codex", httpPort: configured.httpPort,
    exitCheckUrl: "https://1.1.1.1/cdn-cgi/trace", exitCheckFormat: "cloudflare-trace" });
}

export const checkCodexRouteExit = (profile, options) => checkAccountRouteExit(profile, { ...options, RouteError: CodexRouteError });

// First authorization has no underlying account identity to lock yet. Its
// explicit route still owns the complete exchange; identity is locked at commit.
export async function withCodexProxyTransport(profile, operation, {
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout, createTransport = createAccountTransport,
  signal, assertOwned = () => {},
} = {}) {
  if (!profile) return await operation(fetchJsonWithTimeoutImpl, null);
  const transport = createTransport(profile, { RouteError: CodexRouteError });
  try {
    const fetchAssigned = (input, init = {}, timeoutMs = 8000) => {
      assertOwned();
      const signals = [signal, init.signal].filter(Boolean);
      return fetchJsonWithTimeoutImpl(input, { ...init, ...(signals.length ? { signal: AbortSignal.any(signals) } : {}),
        redirect: init.redirect ?? "error" }, timeoutMs, { fetchImpl: transport.fetch });
    };
    const result = await operation(fetchAssigned, profile, () => transport.check());
    if (transport.failure) throw transport.failure;
    return result;
  } finally { await transport.close(); }
}

/** The callback consumes the complete response body before its transport and
 * assignment lock close. Never return an unconsumed response from this owner. */
export async function withCodexAccountTransport(options, operation, {
  fetchJsonWithTimeoutImpl = fetchJsonWithTimeout,
  createTransport = createAccountTransport,
} = {}) {
  const lock = await acquireCodexAssignmentLock(options);
  try {
    const profile = resolveCodexRoute(options);
    lock.assertOwned();
    return await withCodexProxyTransport(profile, operation, { fetchJsonWithTimeoutImpl, createTransport,
      signal: lock.signal, assertOwned: lock.assertOwned });
  } finally { await lock.release(); }
}
