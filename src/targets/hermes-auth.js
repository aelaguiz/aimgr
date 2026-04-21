import fs from "node:fs";
import path from "node:path";
import { getCodexCredential } from "../browser/seed.js";
import { HERMES_AUTH_STORE_VERSION, HERMES_CODEX_BASE_URL, OPENAI_CODEX_PROVIDER } from "../core/constants.js";
import { isObject, normalizeLabel, normalizeProviderId } from "../core/normalize.js";
import { assertCodexCredentialShape, findCodexLabelByTokenPair } from "../credentials/codex.js";
import { extractJwtIdentityLabel, extractOpenAICodexAccountIdFromToken } from "../credentials/jwt.js";
import { writeJsonFileIfChanged } from "../io/json-store.js";
import { resolveExplicitHermesAuthFilePath } from "../io/paths.js";
import { ensureStateShape } from "../state/schema.js";

export function readHermesAuthFile({ authPath }) {
  const resolvedAuthPath = resolveExplicitHermesAuthFilePath(authPath);
  if (!fs.existsSync(resolvedAuthPath)) {
    return { exists: false, authPath: resolvedAuthPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(resolvedAuthPath, "utf8"));
    if (!isObject(parsed)) {
      throw new Error("Hermes auth.json is not a JSON object.");
    }
    const providers = isObject(parsed.providers) ? parsed.providers : {};
    const providerEntry = isObject(providers[OPENAI_CODEX_PROVIDER]) ? providers[OPENAI_CODEX_PROVIDER] : null;
    const tokens = isObject(providerEntry?.tokens) ? providerEntry.tokens : null;
    const accessToken = typeof tokens?.access_token === "string" ? tokens.access_token.trim() : null;
    const refreshToken = typeof tokens?.refresh_token === "string" ? tokens.refresh_token.trim() : null;
    const credentialPool = isObject(parsed.credential_pool) ? parsed.credential_pool : {};
    const rawProviderPoolEntries = Array.isArray(credentialPool[OPENAI_CODEX_PROVIDER])
      ? credentialPool[OPENAI_CODEX_PROVIDER].filter((entry) => isObject(entry))
      : [];
    const deviceCodePoolEntry =
      rawProviderPoolEntries.find((entry) => {
        const source = typeof entry?.source === "string" ? entry.source.trim().toLowerCase().replace(/-/g, "_") : "";
        return source === "device_code";
      })
      ?? (rawProviderPoolEntries.length === 1 ? rawProviderPoolEntries[0] : null);
    const poolAccessToken = typeof deviceCodePoolEntry?.access_token === "string" ? deviceCodePoolEntry.access_token.trim() : null;
    const poolRefreshToken = typeof deviceCodePoolEntry?.refresh_token === "string" ? deviceCodePoolEntry.refresh_token.trim() : null;
    const activeProvider = typeof parsed.active_provider === "string" ? parsed.active_provider.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath: resolvedAuthPath,
      activeProvider: activeProvider || null,
      providerEntryPresent: Boolean(providerEntry),
      accessToken: accessToken || null,
      refreshToken: refreshToken || null,
      accountId: extractOpenAICodexAccountIdFromToken(accessToken) || null,
      providerPoolEntryCount: rawProviderPoolEntries.length,
      deviceCodePoolEntryPresent: Boolean(deviceCodePoolEntry),
      poolAccessToken: poolAccessToken || null,
      poolRefreshToken: poolRefreshToken || null,
      poolAccountId: extractOpenAICodexAccountIdFromToken(poolAccessToken) || null,
      lastRefresh: typeof providerEntry?.last_refresh === "string" ? providerEntry.last_refresh.trim() : null,
      authMode: typeof providerEntry?.auth_mode === "string" ? providerEntry.auth_mode.trim() : null,
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath: resolvedAuthPath,
      error: String(err?.message ?? err),
    };
  }
}

export function generateHermesPoolEntryId(updatedAt) {
  const timestamp = Date.parse(String(updatedAt ?? "").trim());
  const basis = Number.isFinite(timestamp) ? timestamp : Date.now();
  return Math.abs(basis).toString(16).slice(-6).padStart(6, "0");
}

export function buildHermesCodexPoolEntry({ existing, credential, updatedAt }) {
  const existingEntries =
    Array.isArray(existing?.credential_pool?.[OPENAI_CODEX_PROVIDER]) ? existing.credential_pool[OPENAI_CODEX_PROVIDER] : [];
  const existingDeviceCodeEntry =
    existingEntries.find((entry) => {
      const source = typeof entry?.source === "string" ? entry.source.trim().toLowerCase().replace(/-/g, "_") : "";
      return source === "device_code";
    })
    ?? (existingEntries.length === 1 ? existingEntries[0] : null);
  const id =
    typeof existingDeviceCodeEntry?.id === "string" && existingDeviceCodeEntry.id.trim()
      ? existingDeviceCodeEntry.id.trim()
      : generateHermesPoolEntryId(updatedAt);
  return {
    id,
    label: extractJwtIdentityLabel(credential.access, "device_code"),
    auth_type: "oauth",
    priority: 0,
    source: "device_code",
    access_token: credential.access,
    refresh_token: credential.refresh,
    last_status: null,
    last_status_at: null,
    last_error_code: null,
    base_url: HERMES_CODEX_BASE_URL,
    last_refresh: updatedAt.replace("+00:00", "Z"),
    request_count: 0,
  };
}

export function buildHermesAuthDotJson({ existing, credential, updatedAt }) {
  const next = isObject(existing) ? structuredClone(existing) : {};
  next.version = HERMES_AUTH_STORE_VERSION;
  next.updated_at = updatedAt;
  next.providers = isObject(next.providers) ? next.providers : {};
  next.providers[OPENAI_CODEX_PROVIDER] = {
    tokens: {
      access_token: credential.access,
      refresh_token: credential.refresh,
    },
    last_refresh: updatedAt.replace("+00:00", "Z"),
    auth_mode: "chatgpt",
  };
  next.credential_pool = isObject(next.credential_pool) ? next.credential_pool : {};
  next.credential_pool[OPENAI_CODEX_PROVIDER] = [
    buildHermesCodexPoolEntry({
      existing,
      credential,
      updatedAt,
    }),
  ];
  next.active_provider = OPENAI_CODEX_PROVIDER;
  return next;
}

// AIM owns only Hermes auth material. The caller must provide the exact native
// auth.json path; runtime config, cwd, env, service state, and home routing all
// live outside AIM.

export function writeHermesAuthFromState({ label, authPath }, state) {
  ensureStateShape(state);
  const normalizedLabel = normalizeLabel(label);
  const account = state.accounts[normalizedLabel];
  if (!isObject(account)) {
    throw new Error(`Unknown Hermes label: ${normalizedLabel}. Run \`aim status\` to inspect the pool.`);
  }
  const provider = normalizeProviderId(account.provider);
  if (provider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(`Refusing to activate non-Codex label=${normalizedLabel} provider=${provider || "unknown"} for Hermes.`);
  }

  const resolvedAuthPath = resolveExplicitHermesAuthFilePath(authPath);
  const parentDir = path.dirname(resolvedAuthPath);
  if (!fs.existsSync(parentDir)) {
    throw new Error(`Hermes auth parent directory does not exist: ${parentDir}`);
  }
  if (!fs.statSync(parentDir).isDirectory()) {
    throw new Error(`Hermes auth parent is not a directory: ${parentDir}`);
  }

  const credential = assertCodexCredentialShape({
    label: normalizedLabel,
    credential: getCodexCredential(state, normalizedLabel),
    requireFresh: true,
  });

  const authRead = readHermesAuthFile({ authPath: resolvedAuthPath });
  if (authRead.exists === true && authRead.ok !== true) {
    throw new Error(`Failed to read current Hermes auth.json before write: ${authRead.error || "unknown error"}`);
  }

  const appliedAt = new Date().toISOString();
  const authPayload = buildHermesAuthDotJson({
    existing: authRead.ok === true ? authRead.json : {},
    credential,
    updatedAt: appliedAt,
  });
  const authWrite = writeJsonFileIfChanged(resolvedAuthPath, authPayload, { mode: 0o600 });
  const readback = readHermesAuthFile({ authPath: resolvedAuthPath });
  if (readback.ok !== true) {
    throw new Error(`Failed to read back Hermes auth.json after write: ${readback.error || "unknown error"}`);
  }
  if (readback.activeProvider !== OPENAI_CODEX_PROVIDER) {
    throw new Error(
      `Hermes auth mismatch after write: expected active_provider=${OPENAI_CODEX_PROVIDER}, got ${readback.activeProvider || "none"}.`,
    );
  }
  const inferredLabel = findCodexLabelByTokenPair(state, {
    accessToken: readback.accessToken,
    refreshToken: readback.refreshToken,
  });
  if (inferredLabel && inferredLabel !== normalizedLabel) {
    throw new Error(`Hermes readback mismatch after write: expected label=${normalizedLabel}, got ${inferredLabel}.`);
  }
  if (
    readback.providerPoolEntryCount !== 1
    || readback.deviceCodePoolEntryPresent !== true
    || !doesHermesPoolMatchCodexCredential(readback, credential)
  ) {
    throw new Error(`Hermes auth pool mismatch after write: expected a single coherent ${OPENAI_CODEX_PROVIDER} device_code entry.`);
  }

  return {
    status: authWrite.wrote ? "applied" : "noop",
    label: normalizedLabel,
    authPath: resolvedAuthPath,
    wrote: {
      auth: authWrite.wrote,
    },
    inferredLabel: inferredLabel || normalizedLabel,
  };
}

export function doesHermesReadbackMatchCodexCredential(readback, credential) {
  if (!readback || !credential) return false;
  return (
    String(readback.accessToken ?? "").trim() === String(credential.access ?? "").trim()
    && String(readback.refreshToken ?? "").trim() === String(credential.refresh ?? "").trim()
  );
}

export function doesHermesPoolMatchCodexCredential(readback, credential) {
  if (!readback || !credential) return false;
  if (Math.max(0, Math.round(Number(readback.providerPoolEntryCount ?? 0))) !== 1) return false;
  return (
    readback.deviceCodePoolEntryPresent === true
    && String(readback.poolAccessToken ?? "").trim() === String(credential.access ?? "").trim()
    && String(readback.poolRefreshToken ?? "").trim() === String(credential.refresh ?? "").trim()
  );
}
