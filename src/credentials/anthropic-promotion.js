import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { ensureAccountShape } from "../browser/bindings.js";
import { getAnthropicCredential } from "../browser/seed.js";
import { ANTHROPIC_PROVIDER, REAUTH_MODE_NATIVE_CLAUDE } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { buildPortableAnthropicCredential, clonePortableAnthropicCredential, normalizeRequestedAnthropicLabels } from "./anthropic-portable.js";
import { assertAnthropicCredentialShape, buildAnthropicCredentialFingerprint, tryBuildAnthropicCredentialFingerprint } from "./anthropic.js";
import { authorityLocatorsMatch, buildRemoteAimInternalApplyCommand, resolveAuthorityLocator } from "./authority-locator.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { getAccountReauthState, getAccountRecord } from "../state/accounts.js";
import { buildAnthropicAuthorityIdentityFromCredential, doAnthropicAuthorityIdentitiesMatch, getAuthorityAnthropicImport, getAuthorityAnthropicImportLabelStatus, isImportedAnthropicLabel, markImportedAnthropicLabelPromoted, normalizeAnthropicAuthorityIdentityRecord } from "../state/authority-anthropic.js";
import { ensureStateShape, loadAimgrState } from "../state/schema.js";

export function buildClaudePromotionPayload({ state, to, labels }) {
  ensureStateShape(state);
  const authorityImport = getAuthorityAnthropicImport(state);
  const requestedLabels = normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" });
  const targetDisplay = typeof to === "string" ? resolveAuthorityLocator(to).display : to.display;
  if (!(typeof authorityImport.source === "string" && authorityImport.source.trim())) {
    throw new Error("No authority source is recorded for the local imported Claude replica. Run `aim sync claude --from <authority>` first.");
  }
  if (!authorityLocatorsMatch(authorityImport.source, to)) {
    throw new Error(
      `Refusing to promote imported Claude labels to a different authority. ` +
        `Imported source=${authorityImport.source}; requested target=${targetDisplay}.`,
    );
  }

  const payloadLabels = {};
  for (const label of requestedLabels) {
    if (!isImportedAnthropicLabel(state, label)) {
      throw new Error(`Refusing to promote non-imported Claude label=${label}. Pull it from the authority first.`);
    }
    const account = getAccountRecord(state, label);
    if (!isObject(account) || normalizeProviderId(account.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing to promote non-Claude label=${label}.`);
    }

    const status = getAuthorityAnthropicImportLabelStatus(state, label);
    const credential = assertAnthropicCredentialShape({
      label,
      credential: getAnthropicCredential(state, label),
      requireFresh: true,
      requireClaudeNativeBundle: true,
    });
    if (status.baseIdentity && status.currentIdentity && !doAnthropicAuthorityIdentitiesMatch(status.currentIdentity, status.baseIdentity)) {
      throw new Error(
        `Refusing to promote label=${label}: local Claude identity does not match the imported authority identity.`,
      );
    }

    payloadLabels[label] = {
      provider: ANTHROPIC_PROVIDER,
      credential: buildPortableAnthropicCredential({ label, credential }),
      base: {
        credentialFingerprint: status.baseFingerprint ?? null,
        identity: status.baseIdentity ?? null,
      },
    };
  }

  return {
    kind: "aimgr.claudePromotion.v1",
    sentAt: new Date().toISOString(),
    sourceAuthority: authorityImport.source.trim(),
    labels: payloadLabels,
  };
}

export function applyClaudePromotionPayloadToState({ state, payload, authorityDisplay, observedAt = new Date().toISOString() }) {
  ensureStateShape(state);
  if (!isObject(payload) || payload.kind !== "aimgr.claudePromotion.v1") {
    throw new Error("Invalid Claude promotion payload.");
  }
  const labelEntries = Object.entries(isObject(payload.labels) ? payload.labels : {});
  if (labelEntries.length === 0) {
    throw new Error("Claude promotion payload is empty.");
  }

  const validations = [];
  let requiresWrite = false;
  for (const [labelRaw, entry] of labelEntries) {
    const label = normalizeLabel(labelRaw);
    if (!isObject(entry)) {
      throw new Error(`Invalid Claude promotion entry for label=${label}.`);
    }
    if (normalizeProviderId(entry.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing Claude promotion for label=${label}: provider must be ${ANTHROPIC_PROVIDER}.`);
    }

    const account = getAccountRecord(state, label);
    if (!isObject(account)) {
      throw new Error(`Refusing Claude promotion for unknown authority label=${label}.`);
    }
    if (normalizeProviderId(account.provider) !== ANTHROPIC_PROVIDER) {
      throw new Error(`Refusing Claude promotion for label=${label}: authority provider is not ${ANTHROPIC_PROVIDER}.`);
    }

    const authorityCredential = getAnthropicCredential(state, label);
    const incomingCredential = assertAnthropicCredentialShape({
      label,
      credential: entry.credential,
      requireFresh: true,
      requireClaudeNativeBundle: true,
    });
    const authorityFingerprint = tryBuildAnthropicCredentialFingerprint(authorityCredential);
    const incomingFingerprint = buildAnthropicCredentialFingerprint(incomingCredential);
    const baseFingerprint =
      typeof entry.base?.credentialFingerprint === "string" && entry.base.credentialFingerprint.trim()
        ? entry.base.credentialFingerprint.trim()
        : null;
    const baseIdentity = normalizeAnthropicAuthorityIdentityRecord(entry.base?.identity);
    const authorityIdentity = buildAnthropicAuthorityIdentityFromCredential(authorityCredential);
    const incomingIdentity = buildAnthropicAuthorityIdentityFromCredential(incomingCredential);

    if (authorityFingerprint !== baseFingerprint) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: authority credentials changed since the consumer imported them.`,
      );
    }
    if (baseIdentity && incomingIdentity && !doAnthropicAuthorityIdentitiesMatch(incomingIdentity, baseIdentity)) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: local Claude identity does not match the imported authority identity.`,
      );
    }
    if (baseIdentity && authorityIdentity && !doAnthropicAuthorityIdentitiesMatch(authorityIdentity, baseIdentity)) {
      throw new Error(
        `Refusing Claude promotion for label=${label}: authority Claude identity no longer matches the imported authority identity.`,
      );
    }

    const blockedReason =
      typeof account.reauth?.blockedReason === "string" && account.reauth.blockedReason.trim()
        ? account.reauth.blockedReason.trim()
        : "";
    const needsCredentialWrite = authorityFingerprint !== incomingFingerprint;
    const needsCleanup = Boolean(blockedReason);
    if (needsCredentialWrite || needsCleanup) {
      requiresWrite = true;
    }
    validations.push({
      label,
      incomingCredential,
    });
  }

  if (!requiresWrite) {
    return {
      status: "noop",
      observedAt,
      target: authorityDisplay,
      labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
    };
  }

  for (const validation of validations) {
    const account = getAccountRecord(state, validation.label, { create: true });
    account.provider = ANTHROPIC_PROVIDER;
    ensureAccountShape(account, { providerHint: ANTHROPIC_PROVIDER });
    account.browser = null;
    state.credentials[ANTHROPIC_PROVIDER][validation.label] = clonePortableAnthropicCredential(validation.incomingCredential);
    const reauth = getAccountReauthState(state, validation.label, { create: true });
    reauth.mode = REAUTH_MODE_NATIVE_CLAUDE;
    reauth.lastAttemptAt = observedAt;
    reauth.lastVerifiedAt = observedAt;
    if (Object.hasOwn(reauth, "blockedReason")) {
      delete reauth.blockedReason;
    }
  }

  return {
    status: "applied",
    observedAt,
    target: authorityDisplay,
    labels: validations.map((entry) => entry.label).toSorted((a, b) => a.localeCompare(b)),
  };
}

export function applyClaudePromotionToFileAuthority({ source, payload }) {
  if (!fs.existsSync(source.path)) {
    throw new Error(`Authority AIM state file not found: ${source.path}`);
  }
  const state = loadAimgrState(source.path);
  const receipt = applyClaudePromotionPayloadToState({
    state,
    payload,
    authorityDisplay: source.display,
  });
  if (receipt.status === "applied") {
    writeJsonFileWithBackup(source.path, state);
  }
  return receipt;
}

export function invokeClaudePromotionOnRemoteAuthority({ source, payload, spawnImpl = spawnSync }) {
  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteAimInternalApplyCommand({
    remotePath: source.remotePath,
    subcmd: "apply-claude-promotion",
  }));
  const result = spawnImpl("ssh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: `${JSON.stringify(payload)}\n`,
  });
  if (result?.error) {
    throw new Error(`Failed to promote Claude credentials via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `ssh Claude promotion failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Failed to parse Claude promotion receipt from ${source.display}: ${String(err?.message ?? err)}`);
  }
  const receipt = isObject(parsed?.applied) ? parsed.applied : parsed;
  if (!isObject(receipt) || typeof receipt.status !== "string") {
    throw new Error(`Remote Claude promotion receipt from ${source.display} is missing status.`);
  }
  return receipt;
}

export function promoteClaudeToAuthority({ to, labels, state }, { spawnImpl = spawnSync } = {}) {
  ensureStateShape(state);
  if (!String(to ?? "").trim()) {
    throw new Error("Missing authority locator. Use: aim promote claude --to agents@amirs-mac-studio <label> [<label>...]");
  }
  const source = resolveAuthorityLocator(to);
  const payload = buildClaudePromotionPayload({ state, to: source, labels });
  const receipt =
    source.kind === "file"
      ? applyClaudePromotionToFileAuthority({ source, payload })
      : invokeClaudePromotionOnRemoteAuthority({ source, payload, spawnImpl });

  const promotedAt = typeof receipt.observedAt === "string" && receipt.observedAt.trim()
    ? receipt.observedAt.trim()
    : new Date().toISOString();
  for (const label of normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" })) {
    markImportedAnthropicLabelPromoted(state, label, { promotedAt });
  }

  return {
    action: "promote_claude",
    status: receipt.status,
    observedAt: promotedAt,
    target: source.display,
    labels: normalizeRequestedAnthropicLabels(labels, { context: "aim promote claude" }),
  };
}
