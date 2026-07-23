import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ANTHROPIC_PROVIDER, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { parseExpiresAtToMs, toIsoFromExpiresMs } from "../core/time.js";
import { buildAnthropicCredentialFingerprint, assertAnthropicCredentialShape } from "../credentials/anthropic.js";
import { assertCodexCredentialShape, buildCodexCredentialFingerprint, findCodexLabelByAccountId } from "../credentials/codex.js";
import { decodeJwtPayload, extractOpenAICodexAccountIdFromToken } from "../credentials/jwt.js";
import {
  buildClaudeCredentialSummaryFromBundle,
  readClaudeNativeBundle,
} from "../credentials/claude-bundle.js";
import { findAnthropicLabelByNativeClaudeBundle, getClaudeNativeBundleIdentity } from "../credentials/claude-native.js";
import { readJsonFile } from "../io/json-store.js";
import {
  resolveAimgrRedisMigrationDir,
  resolveAimgrStatePath,
  resolveCodexAuthFilePath,
  resolveManagedCodexHomeDir,
  resolveManagedClaudeDir,
  resolveHermesProfilesRoot,
  resolveOpenclawAuthStorePath,
} from "../io/paths.js";
import { importCredentialsSnapshot, readSnapshot } from "../coordination/redis-store.js";
import { readHermesAuthFile } from "../targets/hermes-auth.js";
import { readCodexAuthFile } from "../targets/codex-store.js";
import { discoverOpenclawAgentIdsWithAuthStores } from "../openclaw/stores.js";
import { loadAimgrStateFromJsonValue } from "../state/schema.js";

export const REDIS_MIGRATION_BUNDLE_VERSION = 1;
export const REDIS_MIGRATION_PLAN_VERSION = 1;
const LOCAL_STATE_BACKUP_LIMIT = 5;

function stableHash(value) {
  return crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function cloneJson(value) {
  return value === undefined ? undefined : structuredClone(value);
}

function readTextFileIfExists(filePath) {
  if (!fs.existsSync(filePath)) return { exists: false, path: filePath };
  try {
    return { exists: true, ok: true, path: filePath, text: fs.readFileSync(filePath, "utf8") };
  } catch (err) {
    return { exists: true, ok: false, path: filePath, error: String(err?.message ?? err) };
  }
}

function sourceReadSummary(read) {
  const { text: _text, ...summary } = read;
  return {
    ...summary,
    mtime: fileMtimeIso(read.path),
  };
}

function discoverLocalStateSnapshotPaths(primaryStatePath) {
  const dir = path.dirname(primaryStatePath);
  const primaryName = path.basename(primaryStatePath);
  if (!fs.existsSync(dir)) return fs.existsSync(primaryStatePath) ? [primaryStatePath] : [];

  const records = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    const filePath = path.join(dir, entry.name);
    let kind = null;
    if (entry.name === primaryName) {
      kind = "primary";
    } else if (/^secrets\.legacy-imported-redis-.*\.json$/.test(entry.name)) {
      kind = "local-import-snapshot";
    } else if (/^secrets\.json\.bak\./.test(entry.name)) {
      kind = "backup";
    }
    if (!kind) continue;
    records.push({
      path: filePath,
      kind,
      mtimeMs: fs.statSync(filePath).mtimeMs,
    });
  }

  const primary = records.filter((record) => record.kind === "primary");
  const localImports = records
    .filter((record) => record.kind === "local-import-snapshot")
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  const backups = records
    .filter((record) => record.kind === "backup")
    .sort((a, b) => b.mtimeMs - a.mtimeMs)
    .slice(0, LOCAL_STATE_BACKUP_LIMIT);

  return [...new Set([...primary, ...localImports, ...backups].map((record) => record.path))];
}

function fileMtimeIso(filePath) {
  try {
    return fs.statSync(filePath).mtime.toISOString();
  } catch {
    return null;
  }
}

function jwtExpiresAtIso(...tokens) {
  for (const token of tokens) {
    const claims = decodeJwtPayload(token);
    const exp = Number(claims?.exp);
    if (Number.isFinite(exp) && exp > 0) {
      return new Date(exp * 1000).toISOString();
    }
  }
  return null;
}

function normalizeSourceLabel(value, fallback) {
  try {
    return normalizeLabel(value);
  } catch {
    return normalizeLabel(fallback);
  }
}

function buildAccountPolicy(account = {}) {
  const source = isObject(account) ? account : {};
  return {
    expect: isObject(source.expect) ? cloneJson(source.expect) : {},
    reauth: isObject(source.reauth) ? cloneJson(source.reauth) : {},
    browser: isObject(source.browser) ? cloneJson(source.browser) : {},
    pool: isObject(source.pool) ? cloneJson(source.pool) : { enabled: true },
  };
}

function normalizeCodexIdentity(credential) {
  const accountId = typeof credential?.accountId === "string" ? credential.accountId.trim() : "";
  return accountId ? { accountId } : {};
}

function normalizeAnthropicIdentity(credential) {
  const bundleIdentity = getClaudeNativeBundleIdentity(credential);
  return {
    ...(bundleIdentity.accountUuid ? { accountUuid: bundleIdentity.accountUuid } : {}),
    ...(typeof credential?.emailAddress === "string" && credential.emailAddress.trim()
      ? { emailAddress: credential.emailAddress.trim().toLowerCase() }
      : {}),
    ...(typeof credential?.organizationUuid === "string" && credential.organizationUuid.trim()
      ? { organizationUuid: credential.organizationUuid.trim() }
      : {}),
  };
}

function identityKey(provider, identity) {
  if (provider === OPENAI_CODEX_PROVIDER) {
    return identity?.accountId ? `account:${identity.accountId}` : "";
  }
  if (provider === ANTHROPIC_PROVIDER) {
    if (identity?.accountUuid) return `account:${identity.accountUuid}`;
    if (identity?.emailAddress && identity?.organizationUuid) {
      return `email-org:${identity.emailAddress}:${identity.organizationUuid}`;
    }
    if (identity?.emailAddress) return `email:${identity.emailAddress}`;
  }
  return "";
}

function validateCredential({ provider, label, credential, nowMs }) {
  try {
    const normalizedProvider = normalizeProviderId(provider);
    let fingerprint;
    let identity;
    let expiresAt;
    if (normalizedProvider === OPENAI_CODEX_PROVIDER) {
      const checked = assertCodexCredentialShape({ label, credential, requireFresh: false });
      fingerprint = buildCodexCredentialFingerprint(checked);
      identity = normalizeCodexIdentity(checked);
      expiresAt = checked.expiresAt;
    } else if (normalizedProvider === ANTHROPIC_PROVIDER) {
      const checked = assertAnthropicCredentialShape({
        label,
        credential,
        requireFresh: false,
        requireClaudeNativeBundle: false,
      });
      fingerprint = buildAnthropicCredentialFingerprint(checked);
      identity = normalizeAnthropicIdentity(checked);
      expiresAt = checked.expiresAt;
    } else {
      throw new Error(`Unsupported provider=${provider}`);
    }
    const expiresMs = parseExpiresAtToMs(expiresAt);
    return {
      ok: true,
      fingerprint,
      identity,
      identityKey: identityKey(normalizedProvider, identity),
      expiresAt,
      fresh: Number.isFinite(expiresMs) && expiresMs > nowMs,
      errors: [],
    };
  } catch (err) {
    return {
      ok: false,
      fingerprint: null,
      identity: {},
      identityKey: "",
      expiresAt: null,
      fresh: false,
      errors: [String(err?.message ?? err)],
    };
  }
}

function buildCandidate({
  provider,
  label,
  source,
  sourceType,
  sourcePath,
  sourceMtime = null,
  credential,
  accountPolicy = {},
  authorityMeta = null,
  collectedAt,
  nowMs,
  detail = {},
}) {
  const normalizedProvider = normalizeProviderId(provider);
  const normalizedLabel = normalizeLabel(label);
  const validation = validateCredential({
    provider: normalizedProvider,
    label: normalizedLabel,
    credential,
    nowMs,
  });
  const id = stableHash({
    provider: normalizedProvider,
    label: normalizedLabel,
    sourceId: source.id,
    sourceType,
    sourcePath,
    fingerprint: validation.fingerprint,
    expiresAt: validation.expiresAt,
  }).slice(0, 24);
  return {
    id,
    provider: normalizedProvider,
    label: normalizedLabel,
    source: cloneJson(source),
    sourceType,
    sourcePath,
    sourceMtime,
    collectedAt,
    credential: cloneJson(credential),
    accountPolicy: buildAccountPolicy(accountPolicy),
    authorityMeta: isObject(authorityMeta) ? cloneJson(authorityMeta) : null,
    validation,
    detail,
  };
}

function accountPolicyForStateLabel(state, provider, label) {
  const account = isObject(state?.accounts?.[label]) ? state.accounts[label] : {};
  const accountProvider = normalizeProviderId(account?.provider || provider);
  if (accountProvider && accountProvider !== provider) return {};
  return buildAccountPolicy(account);
}

function authorityMetaForStateLabel(state, provider, label) {
  const meta =
    provider === OPENAI_CODEX_PROVIDER
      ? state?.imports?.authority?.codex?.labelsByName?.[label]
      : state?.imports?.authority?.anthropic?.labelsByName?.[label];
  return isObject(meta) ? cloneJson(meta) : null;
}

function collectStateCredentialCandidates({ state, statePath, source, collectedAt, nowMs }) {
  const candidates = [];
  const sourceMtime = fileMtimeIso(statePath);
  for (const provider of [OPENAI_CODEX_PROVIDER]) {
    const byLabel = isObject(state?.credentials?.[provider]) ? state.credentials[provider] : {};
    for (const [labelRaw, credential] of Object.entries(byLabel)) {
      if (!isObject(credential)) continue;
      let label;
      try {
        label = normalizeLabel(labelRaw);
      } catch {
        continue;
      }
      candidates.push(
        buildCandidate({
          provider,
          label,
          source,
          sourceType: "legacy-state",
          sourcePath: statePath,
          sourceMtime,
          credential,
          accountPolicy: accountPolicyForStateLabel(state, provider, label),
          authorityMeta: authorityMetaForStateLabel(state, provider, label),
          collectedAt,
          nowMs,
        }),
      );
    }
  }
  return candidates;
}

function findAnthropicLabelInState(state, nativeClaudeBundle) {
  try {
    return findAnthropicLabelByNativeClaudeBundle(state, { nativeClaudeBundle });
  } catch {
    return null;
  }
}

function collectCodexAuthCandidate({ state, homeDir, source, collectedAt, nowMs }) {
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env: {} });
  const readback = readCodexAuthFile({ codexHome });
  if (readback.ok !== true) return { source: readback, candidates: [] };
  const tokens = isObject(readback.json?.tokens) ? readback.json.tokens : {};
  const access = typeof tokens.access_token === "string" ? tokens.access_token.trim() : "";
  const refresh = typeof tokens.refresh_token === "string" ? tokens.refresh_token.trim() : "";
  const idToken = typeof tokens.id_token === "string" ? tokens.id_token.trim() : "";
  const accountId =
    typeof tokens.account_id === "string" && tokens.account_id.trim()
      ? tokens.account_id.trim()
      : extractOpenAICodexAccountIdFromToken(idToken || access);
  const expiresAt = jwtExpiresAtIso(idToken, access);
  if (!access || !refresh || !accountId || !expiresAt) return { source: readback, candidates: [] };
  const label = findCodexLabelByAccountId(state, accountId) ?? "codex-current";
  const credential = {
    access,
    refresh,
    idToken: idToken || access,
    accountId,
    expiresAt,
  };
  return {
    source: readback,
    candidates: [
      buildCandidate({
        provider: OPENAI_CODEX_PROVIDER,
        label,
        source,
        sourceType: "codex-auth-json",
        sourcePath: resolveCodexAuthFilePath(codexHome),
        sourceMtime: fileMtimeIso(resolveCodexAuthFilePath(codexHome)),
        credential,
        accountPolicy: accountPolicyForStateLabel(state, OPENAI_CODEX_PROVIDER, normalizeSourceLabel(label, "codex-current")),
        collectedAt,
        nowMs,
      }),
    ],
  };
}

function collectClaudeNativeCandidate({ state, homeDir, source, collectedAt, nowMs }) {
  const readback = readClaudeNativeBundle({ homeDir });
  if (!readback.exists || readback.ok !== true || !readback.nativeClaudeBundle) {
    return { source: readback, candidates: [] };
  }
  let credential;
  try {
    credential = deriveAnthropicCredentialFromClaudeBundle({
      existingCredential: {},
      nativeClaudeBundle: readback.nativeClaudeBundle,
    });
  } catch {
    return { source: readback, candidates: [] };
  }
  const summary = buildClaudeCredentialSummaryFromBundle(readback.nativeClaudeBundle);
  const label =
    findAnthropicLabelInState(state, readback.nativeClaudeBundle)
    ?? normalizeSourceLabel(summary?.emailAddress?.split("@")[0], "claude-current");
  return {
    source: readback,
    candidates: [
      buildCandidate({
        provider: ANTHROPIC_PROVIDER,
        label,
        source,
        sourceType: "claude-native",
        sourcePath: `${readback.credentialsPath},${readback.appStatePath}`,
        sourceMtime: fileMtimeIso(readback.credentialsPath) ?? fileMtimeIso(readback.appStatePath),
        credential,
        accountPolicy: accountPolicyForStateLabel(state, ANTHROPIC_PROVIDER, label),
        collectedAt,
        nowMs,
      }),
    ],
  };
}

function collectHermesCandidates({ state, homeDir, source, collectedAt, nowMs }) {
  const root = resolveHermesProfilesRoot(homeDir);
  const sources = [];
  const candidates = [];
  if (!fs.existsSync(root)) return { sources, candidates };
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const authPath = path.join(root, entry.name, "auth.json");
    const readback = readHermesAuthFile({ authPath });
    sources.push(readback);
    if (readback.ok !== true || !readback.accessToken || !readback.refreshToken) continue;
    const accountId = readback.accountId || extractOpenAICodexAccountIdFromToken(readback.accessToken);
    const expiresAt = jwtExpiresAtIso(readback.accessToken);
    if (!accountId || !expiresAt) continue;
    const label = findCodexLabelByAccountId(state, accountId) ?? normalizeSourceLabel(entry.name, "hermes-current");
    candidates.push(
      buildCandidate({
          provider: OPENAI_CODEX_PROVIDER,
          label,
          source,
        sourceType: "hermes-auth-json",
        sourcePath: authPath,
        sourceMtime: fileMtimeIso(authPath),
        credential: {
          access: readback.accessToken,
          refresh: readback.refreshToken,
          idToken: readback.accessToken,
          accountId,
          expiresAt,
        },
        accountPolicy: accountPolicyForStateLabel(state, OPENAI_CODEX_PROVIDER, label),
        collectedAt,
        nowMs,
        detail: { hermesHome: entry.name },
      }),
    );
  }
  return { sources, candidates };
}

function parseOpenclawProfileId(profileId) {
  const raw = String(profileId ?? "").trim();
  const delimiter = raw.indexOf(":");
  if (delimiter <= 0) return null;
  try {
    return {
      provider: normalizeProviderId(raw.slice(0, delimiter)),
      label: normalizeLabel(raw.slice(delimiter + 1)),
    };
  } catch {
    return null;
  }
}

function collectOpenclawCandidates({ state, homeDir, source, collectedAt, nowMs }) {
  const sources = [];
  const candidates = [];
  for (const agentId of discoverOpenclawAgentIdsWithAuthStores(homeDir)) {
    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const raw = readTextFileIfExists(storePath);
    sources.push(raw);
    if (raw.ok !== true) continue;
    let parsed;
    try {
      parsed = JSON.parse(raw.text);
    } catch {
      continue;
    }
    const profiles = isObject(parsed?.profiles) ? parsed.profiles : {};
    for (const [profileId, profile] of Object.entries(profiles)) {
      if (!isObject(profile) || String(profile.type ?? "").trim() !== "oauth") continue;
      const parsedProfile = parseOpenclawProfileId(profileId);
      const provider = normalizeProviderId(profile.provider || parsedProfile?.provider);
      if (provider !== OPENAI_CODEX_PROVIDER) continue;
      const label = parsedProfile?.label;
      if (!label) continue;
      const access = typeof profile.access === "string" ? profile.access.trim() : "";
      const refresh = typeof profile.refresh === "string" ? profile.refresh.trim() : "";
      const expiresAt = toIsoFromExpiresMs(Number(profile.expires));
      if (!access || !refresh || !expiresAt) continue;
      const credential =
        provider === OPENAI_CODEX_PROVIDER
          ? {
              access,
              refresh,
              idToken: access,
              accountId:
                typeof profile.accountId === "string" && profile.accountId.trim()
                  ? profile.accountId.trim()
                  : extractOpenAICodexAccountIdFromToken(access),
              expiresAt,
            }
          : {
              access,
              refresh,
              expiresAt,
            };
      candidates.push(
        buildCandidate({
          provider,
          label,
          source,
          sourceType: "openclaw-auth-store",
          sourcePath: storePath,
          sourceMtime: fileMtimeIso(storePath),
          credential,
          accountPolicy: accountPolicyForStateLabel(state, provider, label),
          collectedAt,
          nowMs,
          detail: { agentId, profileId },
        }),
      );
    }
  }
  return { sources, candidates };
}

export function collectRedisMigrationBundle({
  homeDir,
  aimVersion = "0.0.0",
  now = new Date(),
} = {}) {
  const collectedAt = now.toISOString();
  const nowMs = now.getTime();
  const source = {
    id: stableHash({ homeDir, hostname: os.hostname(), platform: process.platform }).slice(0, 16),
    hostname: os.hostname(),
    platform: process.platform,
    aimVersion,
    collectedHome: homeDir,
  };
  const statePath = resolveAimgrStatePath({ home: homeDir }, { env: { HOME: homeDir } });
  let state = null;
  const candidates = [];
  const sources = {
    legacyState: readTextFileIfExists(statePath),
    legacyStateSnapshots: [],
    codexTarget: null,
    claudeNative: { skipped: true, reason: "anthropic_migration_disabled" },
    hermesAuthFiles: [],
    openclawAuthStores: [],
  };

  for (const snapshotPath of discoverLocalStateSnapshotPaths(statePath)) {
    const stateSource = readTextFileIfExists(snapshotPath);
    if (snapshotPath === statePath) {
      sources.legacyState = stateSource;
    } else {
      sources.legacyStateSnapshots.push(sourceReadSummary(stateSource));
    }
    if (stateSource.ok !== true) continue;
    try {
      const snapshotState = loadAimgrStateFromJsonValue(JSON.parse(stateSource.text), snapshotPath);
      state = state ?? snapshotState;
      candidates.push(...collectStateCredentialCandidates({
        state: snapshotState,
        statePath: snapshotPath,
        source,
        collectedAt,
        nowMs,
      }));
    } catch (err) {
      const failed = {
        ...sourceReadSummary(stateSource),
        ok: false,
        error: String(err?.message ?? err),
      };
      if (snapshotPath === statePath) {
        sources.legacyState = { ...stateSource, ok: false, error: failed.error };
      } else {
        sources.legacyStateSnapshots[sources.legacyStateSnapshots.length - 1] = failed;
      }
    }
  }
  state = state ?? loadAimgrStateFromJsonValue({ schemaVersion: "0.2" });

  const codexTarget = collectCodexAuthCandidate({ state, homeDir, source, collectedAt, nowMs });
  sources.codexTarget = codexTarget.source;
  candidates.push(...codexTarget.candidates);

  const hermes = collectHermesCandidates({ state, homeDir, source, collectedAt, nowMs });
  sources.hermesAuthFiles = hermes.sources;
  candidates.push(...hermes.candidates);

  const openclaw = collectOpenclawCandidates({ state, homeDir, source, collectedAt, nowMs });
  sources.openclawAuthStores = openclaw.sources;
  candidates.push(...openclaw.candidates);

  const bundleId = stableHash({ source, collectedAt, candidateIds: candidates.map((candidate) => candidate.id) }).slice(0, 24);
  return {
    kind: "aimgr.redisMigration.bundle.v1",
    version: REDIS_MIGRATION_BUNDLE_VERSION,
    bundleId,
    collectedAt,
    source,
    sources,
    candidates,
    summary: summarizeMigrationBundle({ candidates, sources }),
  };
}

export function summarizeMigrationBundle(bundleOrParts) {
  const candidates = bundleOrParts.candidates ?? [];
  return {
    candidateCount: candidates.length,
    validCandidateCount: candidates.filter((candidate) => candidate.validation?.ok === true).length,
    freshCandidateCount: candidates.filter((candidate) => candidate.validation?.fresh === true).length,
    providers: [...new Set(candidates.map((candidate) => candidate.provider))].sort(),
  };
}

function candidateScore(candidate) {
  const mtimeMs = Date.parse(candidate.sourceMtime ?? "") || 0;
  const expiresMs = parseExpiresAtToMs(candidate.validation?.expiresAt) ?? 0;
  let score = 0;
  if (candidate.validation?.fresh) score += 1_000_000_000_000;
  if (candidate.authorityMeta?.dirtyLocal === true) score += 100_000_000_000;
  if (candidate.sourceType === "codex-auth-json" || candidate.sourceType === "claude-native") score += 10_000_000_000;
  if (candidate.sourceType === "legacy-state") score += 5_000_000_000;
  if (candidate.sourceType === "openclaw-auth-store" || candidate.sourceType === "hermes-auth-json") score += 1_000_000_000;
  score += Math.floor(mtimeMs / 1000);
  score += Math.floor(expiresMs / 1_000_000);
  return score;
}

function sortCandidatesBestFirst(candidates) {
  return [...candidates].sort((a, b) => {
    const scoreDelta = candidateScore(b) - candidateScore(a);
    if (scoreDelta !== 0) return scoreDelta;
    return a.id.localeCompare(b.id);
  });
}

async function refreshExpiredCandidate(candidate, { refreshCandidateImpl, nowMs }) {
  if (candidate.validation?.fresh || candidate.validation?.ok !== true) return candidate;
  if (!candidate.credential?.refresh) {
    return {
      ...candidate,
      refreshAttempt: { status: "not_refreshable", reason: "missing_refresh" },
    };
  }
  if (typeof refreshCandidateImpl !== "function") {
    return {
      ...candidate,
      refreshAttempt: { status: "not_attempted", reason: "refresh_impl_missing" },
    };
  }
  try {
    const refreshed = await refreshCandidateImpl(candidate);
    if (!isObject(refreshed?.credential)) {
      return {
        ...candidate,
        refreshAttempt: { status: "provider_rejected", reason: refreshed?.reason ?? "missing_refreshed_credential" },
      };
    }
    const next = {
      ...candidate,
      credential: cloneJson(refreshed.credential),
      sourceType: `${candidate.sourceType}:refreshed`,
      refreshAttempt: {
        status: "refreshed",
        detail: isObject(refreshed.detail) ? cloneJson(refreshed.detail) : {},
      },
    };
    next.validation = validateCredential({
      provider: next.provider,
      label: next.label,
      credential: next.credential,
      nowMs,
    });
    next.id = stableHash({
      id: candidate.id,
      refreshedFingerprint: next.validation.fingerprint,
      refreshedExpiresAt: next.validation.expiresAt,
    }).slice(0, 24);
    return next;
  } catch (err) {
    return {
      ...candidate,
      refreshAttempt: { status: "provider_rejected", reason: String(err?.message ?? err) },
    };
  }
}

function groupBy(items, getKey) {
  const groups = new Map();
  for (const item of items) {
    const key = getKey(item);
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
  }
  return groups;
}

function buildImportCredential({ provider, label, selected, candidateIds }) {
  return {
    provider,
    label,
    status: "import",
    selectedCandidateId: selected.id,
    candidateIds,
    identity: selected.validation.identity,
    policy: selected.accountPolicy,
  };
}

function buildBlockedCredential({ provider, label, status, candidateIds, reason, identities = [] }) {
  return {
    provider,
    label,
    status,
    candidateIds,
    reason,
    identities,
  };
}

export async function buildRedisMigrationPlan({
  bundles,
  now = new Date(),
  refreshCandidateImpl = null,
} = {}) {
  const plannedAt = now.toISOString();
  const nowMs = now.getTime();
  const inputBundles = Array.isArray(bundles) ? bundles : [];
  let candidates = inputBundles.flatMap((bundle) => (Array.isArray(bundle?.candidates) ? bundle.candidates : []));
  candidates = await Promise.all(candidates.map((candidate) => refreshExpiredCandidate(candidate, { refreshCandidateImpl, nowMs })));

  const credentials = [];
  const superseded = [];
  const reloginRequired = [];
  const blocked = [];
  const groups = groupBy(candidates, (candidate) => `${candidate.provider}:${candidate.label}`);

  for (const [key, labelCandidates] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const [provider, label] = key.split(":");
    const candidateIds = labelCandidates.map((candidate) => candidate.id);
    const valid = labelCandidates.filter((candidate) => candidate.validation?.ok === true);
    const fresh = valid.filter((candidate) => candidate.validation?.fresh === true);
    if (fresh.length === 0) {
      const entry = buildBlockedCredential({
        provider,
        label,
        status: "relogin_required",
        candidateIds,
        reason: valid.length > 0 ? "no_fresh_candidate" : "no_valid_candidate",
      });
      credentials.push(entry);
      reloginRequired.push(entry);
      continue;
    }

    const identityKeys = [...new Set(fresh.map((candidate) => candidate.validation.identityKey).filter(Boolean))];
    if (identityKeys.length > 1) {
      const entry = buildBlockedCredential({
        provider,
        label,
        status: "blocked",
        candidateIds,
        reason: "identity_conflict",
        identities: identityKeys,
      });
      credentials.push(entry);
      blocked.push(entry);
      continue;
    }

    const [selected, ...weakerCandidates] = sortCandidatesBestFirst(fresh);
    credentials.push(buildImportCredential({ provider, label, selected, candidateIds }));
    superseded.push(...weakerCandidates.map((candidate) => ({
      candidateId: candidate.id,
      keptCandidateId: selected.id,
      reason: "weaker_provider_label_candidate",
    })));
  }

  const planId = stableHash({
    plannedAt,
    bundleIds: inputBundles.map((bundle) => bundle.bundleId),
    credentialStatuses: credentials.map((credential) => [
      credential.provider,
      credential.label,
      credential.status,
      credential.selectedCandidateId,
    ]),
  }).slice(0, 24);

  return {
    kind: "aimgr.redisMigration.plan.v1",
    version: REDIS_MIGRATION_PLAN_VERSION,
    planId,
    plannedAt,
    bundleIds: inputBundles.map((bundle) => bundle.bundleId),
    sources: inputBundles.map((bundle) => bundle.source).filter(Boolean),
    credentials,
    candidates,
    superseded,
    reloginRequired,
    blocked,
    summary: {
      bundleCount: inputBundles.length,
      candidateCount: candidates.length,
      importCredentialCount: credentials.filter((credential) => credential.status === "import").length,
      blockedCount: blocked.length,
      reloginRequiredCount: reloginRequired.length,
      supersededCount: superseded.length,
    },
  };
}

export function createMigrationRefreshCandidateImpl({ refreshOpenAICodexImpl } = {}) {
  return async (candidate) => {
    if (candidate.provider === OPENAI_CODEX_PROVIDER) {
      if (typeof refreshOpenAICodexImpl !== "function") {
        throw new Error("OpenAI Codex refresh implementation is unavailable.");
      }
      const updated = await refreshOpenAICodexImpl(candidate.credential.refresh);
      const accountId = typeof updated?.accountId === "string" ? updated.accountId.trim() : "";
      if (!accountId) throw new Error("refresh returned no accountId");
      const existingAccountId = typeof candidate.credential.accountId === "string" ? candidate.credential.accountId.trim() : "";
      if (existingAccountId && existingAccountId !== accountId) {
        throw new Error(`refresh produced different accountId (${accountId}) than existing (${existingAccountId})`);
      }
      const expiresAt = toIsoFromExpiresMs(updated.expires);
      if (!expiresAt) throw new Error("refresh returned no expires");
      return {
        credential: {
          ...candidate.credential,
          access: updated.access,
          refresh: updated.refresh,
          idToken: updated.access,
          accountId,
          expiresAt,
        },
      };
    }
    if (candidate.provider === ANTHROPIC_PROVIDER) {
      throw new Error(
        "Anthropic migration refresh is retired; use `aim claude capture-native` or `aim claude import-native`, then `aim claude run`.",
      );
    }
    throw new Error(`Unsupported provider for migration refresh: ${candidate.provider}`);
  };
}

function findPlanCandidate(plan, candidateId) {
  return (plan.candidates ?? []).find((candidate) => candidate.id === candidateId) ?? null;
}

export function assertMigrationPlanCanApply(plan) {
  if (!isObject(plan) || plan.kind !== "aimgr.redisMigration.plan.v1") {
    throw new Error("Migration apply requires an aimgr.redisMigration.plan.v1 plan.");
  }
  const blockedCredentials = (plan.credentials ?? []).filter((credential) => credential.status !== "import");
  if (blockedCredentials.length > 0) {
    throw new Error(
      `Migration plan is not applyable: ${blockedCredentials.length} credential(s) are blocked or require re-login.`,
    );
  }
}

export function buildRedisSnapshotFromMigrationPlan(plan, { appliedAt = new Date().toISOString(), appliedBy = "migration" } = {}) {
  assertMigrationPlanCanApply(plan);
  const credentials = [];
  for (const plannedCredential of plan.credentials ?? []) {
    const candidate = findPlanCandidate(plan, plannedCredential.selectedCandidateId);
    if (!candidate) {
      throw new Error(`Migration plan references missing selected candidate: ${plannedCredential.selectedCandidateId}`);
    }
    credentials.push({
      provider: plannedCredential.provider,
      label: plannedCredential.label,
      credential: candidate.credential,
      identity: candidate.validation.identity,
      policy: {
        expect: plannedCredential.policy?.expect ?? {},
        reauth: plannedCredential.policy?.reauth ?? {},
        browser: plannedCredential.policy?.browser ?? {},
        pool: plannedCredential.policy?.pool ?? { enabled: true },
      },
      health: { status: "ready", reason: null },
      provenance: {
        lastSourceType: "migration-import",
        fingerprint: candidate.validation.fingerprint,
        sourceType: candidate.sourceType,
        sourcePath: candidate.sourcePath,
        source: candidate.source ?? {},
        candidateId: candidate.id,
      },
    });
  }
  return {
    meta: {
      cutover: {
        breakingNonReverseCompatible: true,
        appliedAt,
        appliedBy,
      },
      migration: {
        planId: plan.planId,
        plannedAt: plan.plannedAt,
        appliedAt,
        bundleIds: plan.bundleIds ?? [],
      },
    },
    credentials,
  };
}

export async function assertRedisPrefixEmpty(store) {
  const snapshot = await readSnapshot(store);
  const counts = {
    credentials: snapshot.credentials.length,
    meta: snapshot.meta ? 1 : 0,
  };
  const total = counts.credentials + counts.meta;
  if (total > 0) {
    throw new Error(`Refusing migration apply into non-empty Redis prefix ${snapshot.keyPrefix}: ${JSON.stringify(counts)}`);
  }
  return snapshot;
}

export async function applyRedisMigrationPlan(store, plan, {
  updatedBy = "migration",
  observedAt = new Date().toISOString(),
  requireEmpty = true,
} = {}) {
  if (requireEmpty) {
    await assertRedisPrefixEmpty(store);
  }
  const snapshot = buildRedisSnapshotFromMigrationPlan(plan, { appliedAt: observedAt, appliedBy: updatedBy });
  if (snapshot.credentials.some((record) => normalizeProviderId(record.provider) === ANTHROPIC_PROVIDER)) {
    throw new Error(
      "Redis migration apply cannot write Claude credentials; use `aim claude import-native` under the per-label lease.",
    );
  }
  const results = await importCredentialsSnapshot(store, {
    ...snapshot,
  }, { updatedBy, observedAt, replaceExisting: !requireEmpty });
  return {
    ok: results.every((result) => result.ok),
    results,
    counts: {
      credentials: snapshot.credentials.length,
    },
  };
}

export function defaultMigrationDir({ homeDir }) {
  return resolveAimgrRedisMigrationDir({ homeDir });
}

export function readMigrationBundlesFromDir(dirPath) {
  const entries = fs.readdirSync(dirPath, { withFileTypes: true });
  const bundles = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const filePath = path.join(dirPath, entry.name);
    const parsed = readJsonFile(filePath);
    if (parsed?.kind === "aimgr.redisMigration.bundle.v1") {
      bundles.push(parsed);
    }
  }
  return bundles.sort((a, b) => String(a.bundleId ?? "").localeCompare(String(b.bundleId ?? "")));
}
