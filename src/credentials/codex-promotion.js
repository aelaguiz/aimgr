import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { getCodexCredential } from "../browser/seed.js";
import { OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { authorityLocatorsMatch, buildRemoteAimInternalApplyCommand, resolveAuthorityLocator } from "./authority-locator.js";
import { buildPortableCodexCredential, normalizeRequestedCodexLabels } from "./codex-portable.js";
import { assertCodexCredentialShape, buildCodexCredentialFingerprint } from "./codex.js";
import { writeJsonFileWithBackup } from "../io/json-store.js";
import { getAccountReauthState, getAccountRecord } from "../state/accounts.js";
import { getAuthorityCodexImport, getAuthorityCodexImportLabelStatus, isImportedCodexLabel, markImportedCodexLabelPromoted } from "../state/authority-codex.js";
import { ensureStateShape, loadAimgrState } from "../state/schema.js";

export function buildCodexPromotionPayload({ state, to, labels }) {
  ensureStateShape(state);
  const authorityImport = getAuthorityCodexImport(state);
  const requestedLabels = normalizeRequestedCodexLabels(labels, { context: "aim promote codex" });
  const targetDisplay = typeof to === "string" ? resolveAuthorityLocator(to).display : to.display;
  if (!(typeof authorityImport.source === "string" && authorityImport.source.trim())) {
    throw new Error("No authority source is recorded for the local imported Codex replica. Run `aim sync codex --from <authority>` first.");
  }
  if (!authorityLocatorsMatch(authorityImport.source, to)) {
    throw new Error(
      `Refusing to promote imported labels to a different authority. ` +
        `Imported source=${authorityImport.source}; requested target=${targetDisplay}.`,
    );
  }

  const payloadLabels = {};
  for (const label of requestedLabels) {
    if (!isImportedCodexLabel(state, label)) {
      throw new Error(`Refusing to promote non-imported label=${label}. Pull it from the authority first.`);
    }
    const account = getAccountRecord(state, label);
    if (!isObject(account) || normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing to promote non-Codex label=${label}.`);
    }

    const status = getAuthorityCodexImportLabelStatus(state, label);
    const credential = assertCodexCredentialShape({
      label,
      credential: getCodexCredential(state, label),
      requireFresh: true,
    });
    if (status.baseAccountId && status.currentAccountId && status.baseAccountId !== status.currentAccountId) {
      throw new Error(
        `Refusing to promote label=${label}: local accountId=${status.currentAccountId} ` +
          `does not match imported authority accountId=${status.baseAccountId}.`,
      );
    }
    if (!(typeof status.baseFingerprint === "string" && status.baseFingerprint.trim())) {
      throw new Error(`Missing authority base fingerprint for imported label=${label}. Re-run \`aim sync codex --from ${authorityImport.source}\`.`);
    }

    payloadLabels[label] = {
      provider: OPENAI_CODEX_PROVIDER,
      accountId: credential.accountId,
      credential: buildPortableCodexCredential({ label, credential }),
      base: {
        accountId: status.baseAccountId ?? credential.accountId,
        credentialFingerprint: status.baseFingerprint,
      },
    };
  }

  return {
    kind: "aimgr.codexPromotion.v1",
    sentAt: new Date().toISOString(),
    sourceAuthority: authorityImport.source.trim(),
    labels: payloadLabels,
  };
}

export function applyCodexPromotionPayloadToState({ state, payload, authorityDisplay, observedAt = new Date().toISOString() }) {
  ensureStateShape(state);
  if (!isObject(payload) || payload.kind !== "aimgr.codexPromotion.v1") {
    throw new Error("Invalid codex promotion payload.");
  }
  const labelEntries = Object.entries(isObject(payload.labels) ? payload.labels : {});
  if (labelEntries.length === 0) {
    throw new Error("Codex promotion payload is empty.");
  }

  const validations = [];
  let requiresWrite = false;
  for (const [labelRaw, entry] of labelEntries) {
    const label = normalizeLabel(labelRaw);
    if (!isObject(entry)) {
      throw new Error(`Invalid codex promotion entry for label=${label}.`);
    }
    if (normalizeProviderId(entry.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing codex promotion for label=${label}: provider must be ${OPENAI_CODEX_PROVIDER}.`);
    }

    const account = getAccountRecord(state, label);
    if (!isObject(account)) {
      throw new Error(`Refusing codex promotion for unknown authority label=${label}.`);
    }
    if (normalizeProviderId(account.provider) !== OPENAI_CODEX_PROVIDER) {
      throw new Error(`Refusing codex promotion for label=${label}: authority provider is not ${OPENAI_CODEX_PROVIDER}.`);
    }

    const authorityCredential = assertCodexCredentialShape({
      label,
      credential: getCodexCredential(state, label),
      requireFresh: false,
    });
    const incomingCredential = assertCodexCredentialShape({
      label,
      credential: entry.credential,
      requireFresh: true,
    });
    const authorityFingerprint = buildCodexCredentialFingerprint(authorityCredential);
    const incomingFingerprint = buildCodexCredentialFingerprint(incomingCredential);
    const baseFingerprint =
      typeof entry.base?.credentialFingerprint === "string" ? entry.base.credentialFingerprint.trim() : "";
    const baseAccountId = typeof entry.base?.accountId === "string" ? entry.base.accountId.trim() : "";

    if (!baseFingerprint) {
      throw new Error(`Refusing codex promotion for label=${label}: missing base fingerprint.`);
    }
    if (authorityFingerprint !== baseFingerprint) {
      throw new Error(
        `Refusing codex promotion for label=${label}: authority credentials changed since the consumer imported them.`,
      );
    }
    if (baseAccountId && authorityCredential.accountId.trim() !== baseAccountId) {
      throw new Error(
        `Refusing codex promotion for label=${label}: authority accountId=${authorityCredential.accountId} ` +
          `does not match expected imported accountId=${baseAccountId}.`,
      );
    }
    if (authorityCredential.accountId.trim() !== incomingCredential.accountId.trim()) {
      throw new Error(
        `Refusing codex promotion for label=${label}: local accountId=${incomingCredential.accountId} ` +
          `does not match authority accountId=${authorityCredential.accountId}.`,
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
      needsCredentialWrite,
      needsCleanup,
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
    state.credentials[OPENAI_CODEX_PROVIDER][validation.label] = validation.incomingCredential;
    const reauth = getAccountReauthState(state, validation.label, { create: true });
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

export function applyCodexPromotionToFileAuthority({ source, payload }) {
  if (!fs.existsSync(source.path)) {
    throw new Error(`Authority AIM state file not found: ${source.path}`);
  }
  const state = loadAimgrState(source.path);
  const receipt = applyCodexPromotionPayloadToState({
    state,
    payload,
    authorityDisplay: source.display,
  });
  if (receipt.status === "applied") {
    writeJsonFileWithBackup(source.path, state);
  }
  return receipt;
}

export function invokeCodexPromotionOnRemoteAuthority({ source, payload, spawnImpl = spawnSync }) {
  const args = [];
  if (source.port) {
    args.push("-p", source.port);
  }
  args.push(source.target, buildRemoteAimInternalApplyCommand({ remotePath: source.remotePath }));
  const result = spawnImpl("ssh", args, {
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
    input: `${JSON.stringify(payload)}\n`,
  });
  if (result?.error) {
    throw new Error(`Failed to promote codex credentials via ssh (${source.display}): ${String(result.error?.message ?? result.error)}`);
  }
  if (result?.status !== 0) {
    throw new Error(
      `ssh codex promotion failed for ${source.display} (exit ${result.status}). ` +
        `${String(result.stderr ?? "").trim() || String(result.stdout ?? "").trim()}`,
    );
  }

  let parsed;
  try {
    parsed = JSON.parse(String(result.stdout ?? ""));
  } catch (err) {
    throw new Error(`Failed to parse codex promotion receipt from ${source.display}: ${String(err?.message ?? err)}`);
  }
  const receipt = isObject(parsed?.applied) ? parsed.applied : parsed;
  if (!isObject(receipt) || typeof receipt.status !== "string") {
    throw new Error(`Remote codex promotion receipt from ${source.display} is missing status.`);
  }
  return receipt;
}

export function promoteCodexToAuthority({ to, labels, state }, { spawnImpl = spawnSync } = {}) {
  ensureStateShape(state);
  if (!String(to ?? "").trim()) {
    throw new Error("Missing authority locator. Use: aim promote codex --to agents@amirs-mac-studio <label> [<label>...]");
  }
  const source = resolveAuthorityLocator(to);
  const payload = buildCodexPromotionPayload({ state, to: source, labels });
  const receipt =
    source.kind === "file"
      ? applyCodexPromotionToFileAuthority({ source, payload })
      : invokeCodexPromotionOnRemoteAuthority({ source, payload, spawnImpl });

  const promotedAt = typeof receipt.observedAt === "string" && receipt.observedAt.trim()
    ? receipt.observedAt.trim()
    : new Date().toISOString();
  for (const label of normalizeRequestedCodexLabels(labels, { context: "aim promote codex" })) {
    markImportedCodexLabelPromoted(state, label, { promotedAt });
  }

  return {
    action: "promote_codex",
    status: receipt.status,
    observedAt: promotedAt,
    target: source.display,
    labels: normalizeRequestedCodexLabels(labels, { context: "aim promote codex" }),
  };
}
