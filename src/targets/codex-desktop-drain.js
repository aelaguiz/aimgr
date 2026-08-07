import fs from "node:fs";
import path from "node:path";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import {
  buildCodexDesktopIdentityFingerprint,
  CodexDesktopReservedError,
} from "../coordination/codex-identity.js";
import { extractOpenAICodexAccountIdFromToken } from "../credentials/jwt.js";
import { readJsonFile, writeJsonFileIfChanged } from "../io/json-store.js";
import {
  resolveAimgrStateDir,
  resolveHermesProfilesRoot,
  resolveManagedCodexHomeDir,
  resolveOpenclawAuthStorePath,
} from "../io/paths.js";
import { discoverOpenclawAgentIdsWithAuthStores } from "../openclaw/stores.js";
import { ensureStateShape } from "../state/schema.js";

const HARNESS_BACKUP_TARGET_IDS = Object.freeze(["pi", "prime"]);

/**
 * Consumer-side reservation view over the normalized coordination state.
 *
 * Materializers that only hold a coordination-view `state` (OpenClaw apply,
 * Hermes auth writes, rebalance planners) cannot re-scan raw Redis records,
 * but the normalized view preserves `policy.expect` for every record —
 * including credential-empty identity-only records — as
 * `state.accounts[label].expect`. That makes the reservation (and its opaque
 * identity fingerprint) visible here without exposing the immutable account
 * ID. A reservation with no fingerprint is corrupted and fails closed.
 */
export function listReservedCodexDesktopStateEntries(state) {
  ensureStateShape(state);
  const entries = [];
  for (const [label, account] of Object.entries(state.accounts)) {
    if (normalizeProviderId(account?.provider) !== OPENAI_CODEX_PROVIDER) continue;
    const reservation = account?.expect?.codexDesktop;
    if (!isObject(reservation) || reservation.reserved !== true) continue;
    const fingerprint = typeof reservation.identityFingerprint === "string"
      ? reservation.identityFingerprint.trim()
      : "";
    if (!fingerprint) {
      throw new Error(
        `Codex Desktop reservation on label=${label} has no identity fingerprint; refusing to proceed.`,
      );
    }
    entries.push({ label, identityFingerprint: fingerprint });
  }
  return entries;
}

/**
 * Record-level reservation gate for consumers that hold only the normalized
 * state snapshot (no Redis store handle). Rejects a reserved label and any
 * same-immutable-account alias: the candidate account ID is fingerprinted with
 * the same opaque derivation the reservation stores, so an alias under another
 * label is caught without ever comparing raw account IDs from status data.
 */
export function assertCodexStateCredentialUseAllowed(state, { label, accountId, operation } = {}) {
  const reserved = listReservedCodexDesktopStateEntries(state);
  if (reserved.length === 0) return;
  const normalizedLabel = label ? normalizeLabel(label) : null;
  if (normalizedLabel && reserved.some((entry) => entry.label === normalizedLabel)) {
    throw new CodexDesktopReservedError({ label: normalizedLabel, operation });
  }
  const normalizedAccountId = typeof accountId === "string" ? accountId.trim() : "";
  if (normalizedAccountId) {
    const fingerprint = buildCodexDesktopIdentityFingerprint(normalizedAccountId);
    const aliased = reserved.find((entry) => entry.identityFingerprint === fingerprint);
    if (aliased) {
      throw new CodexDesktopReservedError({ label: normalizedLabel ?? aliased.label, operation });
    }
  }
}

/**
 * Boolean variant for selection/rebalance filters. Corrupted reservations
 * still fail closed by rethrowing instead of silently treating the label as
 * usable.
 */
export function isCodexStateCredentialUseAllowed(state, { label, accountId } = {}) {
  try {
    assertCodexStateCredentialUseAllowed(state, { label, accountId });
    return true;
  } catch (error) {
    if (error instanceof CodexDesktopReservedError) return false;
    throw error;
  }
}

/**
 * Best-effort immutable account ID for one raw Codex auth entry: an explicit
 * accountId field wins, else the ID is decoded from any embedded access token.
 * Returns null when the entry carries no attributable Codex identity.
 */
export function resolveCodexAuthEntryAccountId(entry) {
  if (!isObject(entry)) return null;
  const direct = typeof entry.accountId === "string" && entry.accountId.trim()
    ? entry.accountId.trim()
    : typeof entry.account_id === "string" && entry.account_id.trim()
      ? entry.account_id.trim()
      : null;
  if (direct) return direct;
  const tokens = [
    entry.access,
    entry.accessToken,
    entry.access_token,
    isObject(entry.tokens) ? entry.tokens.access_token : null,
    isObject(entry.tokens) ? entry.tokens.accessToken : null,
  ];
  for (const token of tokens) {
    const extracted = extractOpenAICodexAccountIdFromToken(token);
    if (extracted) return extracted;
  }
  return null;
}

function isCodexOpenclawProfileEntry(profileId, credential) {
  if (normalizeProviderId(credential?.provider) === OPENAI_CODEX_PROVIDER) return true;
  const id = typeof profileId === "string" ? profileId.trim() : "";
  const delimiter = id.indexOf(":");
  return delimiter > 0 && normalizeProviderId(id.slice(0, delimiter)) === OPENAI_CODEX_PROVIDER;
}

/**
 * Removes matching-identity Codex entries from one OpenClaw auth-profile
 * document. Unrelated entries are preserved; order/lastGood pointers that
 * referenced a removed profile are cleaned so the store stays coherent.
 */
function sanitizeOpenclawAuthDocument(document, accountId) {
  if (!isObject(document) || !isObject(document.profiles)) {
    return { changed: false, entriesRemoved: 0, next: null };
  }
  const next = structuredClone(document);
  const removedProfileIds = [];
  for (const [profileId, credential] of Object.entries(next.profiles)) {
    if (!isObject(credential)) continue;
    if (!isCodexOpenclawProfileEntry(profileId, credential)) continue;
    if (resolveCodexAuthEntryAccountId(credential) !== accountId) continue;
    delete next.profiles[profileId];
    removedProfileIds.push(profileId);
  }
  if (removedProfileIds.length === 0) {
    return { changed: false, entriesRemoved: 0, next: null };
  }
  const removedSet = new Set(removedProfileIds);
  if (isObject(next.order)) {
    for (const [provider, order] of Object.entries(next.order)) {
      if (!Array.isArray(order)) continue;
      const filtered = order.filter((profileId) => !removedSet.has(profileId));
      if (filtered.length !== order.length) next.order[provider] = filtered;
    }
  }
  if (isObject(next.lastGood)) {
    for (const [provider, profileId] of Object.entries(next.lastGood)) {
      if (removedSet.has(profileId)) delete next.lastGood[provider];
    }
  }
  return { changed: true, entriesRemoved: removedProfileIds.length, next };
}

function listOpenclawBackupPaths(storePath, fsImpl) {
  const dir = path.dirname(storePath);
  const base = `${path.basename(storePath)}.bak.`;
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.startsWith(base))
    .map((name) => path.join(dir, name))
    .toSorted((a, b) => a.localeCompare(b));
}

/**
 * Removes matching-identity Codex material from one Hermes auth.json
 * document: the active provider token pair and any matching credential-pool
 * entries. Unrelated providers/entries are preserved.
 */
function sanitizeHermesAuthDocument(document, accountId) {
  if (!isObject(document)) {
    return { changed: false, tokenSetsRemoved: 0, poolEntriesRemoved: 0, next: null };
  }
  const next = structuredClone(document);
  let tokenSetsRemoved = 0;
  let poolEntriesRemoved = 0;
  const providerEntry = isObject(next.providers) ? next.providers[OPENAI_CODEX_PROVIDER] : null;
  if (isObject(providerEntry) && resolveCodexAuthEntryAccountId(providerEntry.tokens ?? providerEntry) === accountId) {
    delete next.providers[OPENAI_CODEX_PROVIDER];
    tokenSetsRemoved += 1;
    if (next.active_provider === OPENAI_CODEX_PROVIDER) delete next.active_provider;
  }
  const pool = isObject(next.credential_pool) ? next.credential_pool[OPENAI_CODEX_PROVIDER] : null;
  if (Array.isArray(pool)) {
    const filtered = pool.filter((entry) => resolveCodexAuthEntryAccountId(entry) !== accountId);
    poolEntriesRemoved = pool.length - filtered.length;
    if (poolEntriesRemoved > 0) next.credential_pool[OPENAI_CODEX_PROVIDER] = filtered;
  }
  const changed = tokenSetsRemoved > 0 || poolEntriesRemoved > 0;
  return { changed, tokenSetsRemoved, poolEntriesRemoved, next: changed ? next : null };
}

function discoverHermesAuthPaths(homeDir, fsImpl) {
  const profilesRoot = resolveHermesProfilesRoot(homeDir);
  let entries;
  try {
    entries = fsImpl.readdirSync(profilesRoot, { withFileTypes: true });
  } catch {
    return [];
  }
  const authPaths = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const authPath = path.join(profilesRoot, entry.name, "auth.json");
    if (fsImpl.existsSync(authPath)) authPaths.push(authPath);
  }
  return authPaths.toSorted((a, b) => a.localeCompare(b));
}

function resolveDrainAccountId({ accountId, label, records }) {
  const explicit = typeof accountId === "string" ? accountId.trim() : "";
  if (explicit) return explicit;
  const normalizedLabel = normalizeLabel(label);
  const record = (Array.isArray(records) ? records : []).find(
    (candidate) => candidate?.label === normalizedLabel
      && normalizeProviderId(candidate?.provider) === OPENAI_CODEX_PROVIDER,
  );
  const resolved = typeof record?.identity?.accountId === "string" && record.identity.accountId.trim()
    ? record.identity.accountId.trim()
    : resolveCodexAuthEntryAccountId(record?.credential);
  if (!resolved) {
    throw new Error(
      "Cannot resolve an immutable Codex account identity for the Desktop drain; "
        + "pass accountId or raw records that carry the identity.",
    );
  }
  return resolved;
}

/**
 * Identity-targeted drain of local raw Codex credential copies for the
 * Desktop-reserved account: active OpenClaw auth-profile stores, AIM-created
 * timestamped OpenClaw store backups, Hermes profile auth files, and displaced
 * Pi/Prime harness auth backups.
 *
 * Contract:
 * - Sanitized rewrites happen in place through the backup-free atomic writer;
 *   removing a reserved entry never creates a new secret-bearing backup copy.
 * - Unrelated entries, providers, and backups are preserved byte-for-byte.
 * - `dryRun: true` performs the identical scan and returns the same counts
 *   with zero filesystem writes.
 * - The receipt carries only kinds, counts, and booleans — no labels, paths,
 *   secrets, or account IDs.
 */
export function drainCodexDesktopIdentityCopies({
  homeDir,
  accountId = null,
  label = null,
  records = [],
  dryRun = false,
} = {}, { fsImpl = fs } = {}) {
  if (typeof homeDir !== "string" || !homeDir.trim()) {
    throw new Error("Codex Desktop drain requires a home directory.");
  }
  const targetAccountId = resolveDrainAccountId({ accountId, label, records });

  const openclaw = {
    storesScanned: 0,
    storesWithMatches: 0,
    entriesRemoved: 0,
    backupsScanned: 0,
    backupsWithMatches: 0,
    backupEntriesRemoved: 0,
    unreadable: 0,
  };
  for (const agentId of discoverOpenclawAgentIdsWithAuthStores(homeDir)) {
    const storePath = resolveOpenclawAuthStorePath(homeDir, agentId);
    const scanTargets = [
      { kind: "store", filePath: storePath },
      ...listOpenclawBackupPaths(storePath, fsImpl).map((filePath) => ({ kind: "backup", filePath })),
    ];
    for (const { kind, filePath } of scanTargets) {
      if (kind === "store") openclaw.storesScanned += 1;
      else openclaw.backupsScanned += 1;
      let document;
      try {
        document = readJsonFile(filePath);
      } catch {
        openclaw.unreadable += 1;
        continue;
      }
      const sanitized = sanitizeOpenclawAuthDocument(document, targetAccountId);
      if (!sanitized.changed) continue;
      if (kind === "store") {
        openclaw.storesWithMatches += 1;
        openclaw.entriesRemoved += sanitized.entriesRemoved;
      } else {
        openclaw.backupsWithMatches += 1;
        openclaw.backupEntriesRemoved += sanitized.entriesRemoved;
      }
      if (!dryRun) writeJsonFileIfChanged(filePath, sanitized.next, { mode: 0o600 });
    }
  }

  const hermes = {
    homesScanned: 0,
    homesWithMatches: 0,
    tokenSetsRemoved: 0,
    poolEntriesRemoved: 0,
    unreadable: 0,
  };
  for (const authPath of discoverHermesAuthPaths(homeDir, fsImpl)) {
    hermes.homesScanned += 1;
    let document;
    try {
      document = readJsonFile(authPath);
    } catch {
      hermes.unreadable += 1;
      continue;
    }
    const sanitized = sanitizeHermesAuthDocument(document, targetAccountId);
    if (!sanitized.changed) continue;
    hermes.homesWithMatches += 1;
    hermes.tokenSetsRemoved += sanitized.tokenSetsRemoved;
    hermes.poolEntriesRemoved += sanitized.poolEntriesRemoved;
    if (!dryRun) writeJsonFileIfChanged(authPath, sanitized.next, { mode: 0o600 });
  }

  // The managed rotating home itself may hold the reserved account's raw
  // tokens (a pre-pin selection or a raced projection). Deleting the one
  // auth.json file removes the copy without rewriting secret material.
  const managedCli = { scanned: 0, matched: 0, removed: 0, unreadable: 0 };
  {
    const managedAuthPath = path.join(resolveManagedCodexHomeDir({ homeDir }), "auth.json");
    if (fsImpl.existsSync(managedAuthPath)) {
      managedCli.scanned += 1;
      let document;
      try {
        document = readJsonFile(managedAuthPath);
      } catch {
        managedCli.unreadable += 1;
        document = null;
      }
      const managedAccountId = typeof document?.tokens?.account_id === "string"
        ? document.tokens.account_id.trim()
        : null;
      if (managedAccountId && managedAccountId === targetAccountId) {
        managedCli.matched += 1;
        if (!dryRun) {
          fsImpl.unlinkSync(managedAuthPath);
          managedCli.removed += 1;
        }
      }
    }
  }

  const harnessBackups = { scanned: 0, matched: 0, removed: 0, unreadable: 0 };
  for (const targetId of HARNESS_BACKUP_TARGET_IDS) {
    const backupPath = path.join(
      resolveAimgrStateDir({ homeDir }),
      "backups",
      "harness-auth",
      `${targetId}-${OPENAI_CODEX_PROVIDER}.json`,
    );
    if (!fsImpl.existsSync(backupPath)) continue;
    harnessBackups.scanned += 1;
    let document;
    try {
      document = readJsonFile(backupPath);
    } catch {
      harnessBackups.unreadable += 1;
      continue;
    }
    const entry = isObject(document) && isObject(document.entry) ? document.entry : null;
    if (!entry || resolveCodexAuthEntryAccountId(entry) !== targetAccountId) continue;
    harnessBackups.matched += 1;
    if (!dryRun) {
      // The displaced-backup file is one raw credential entry; removing the
      // matching identity means deleting the file, never rewriting or
      // re-copying its secret material.
      fsImpl.unlinkSync(backupPath);
      harnessBackups.removed += 1;
    }
  }

  const matched = openclaw.storesWithMatches > 0
    || openclaw.backupsWithMatches > 0
    || hermes.homesWithMatches > 0
    || managedCli.matched > 0
    || harnessBackups.matched > 0;
  return Object.freeze({
    action: "codex_desktop_drain",
    dryRun: dryRun === true,
    matched,
    wrote: dryRun !== true && matched,
    openclaw: Object.freeze(openclaw),
    hermes: Object.freeze(hermes),
    managedCli: Object.freeze(managedCli),
    harnessBackups: Object.freeze(harnessBackups),
  });
}

/** Scan-only convenience wrapper: identical counting, zero writes. */
export function scanCodexDesktopIdentityCopies(args = {}, impls = {}) {
  return drainCodexDesktopIdentityCopies({ ...args, dryRun: true }, impls);
}
