import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { CODEX_AUTH_STORE_MODE_AUTO, CODEX_AUTH_STORE_MODE_FILE, CODEX_AUTH_STORE_MODE_KEYRING } from "../core/constants.js";
import { isObject } from "../core/normalize.js";
import { isLikelyJwt } from "../credentials/jwt.js";
import { resolveCodexAuthFilePath, resolveCodexConfigPath, resolveManagedCodexHomeDir } from "../io/paths.js";
import { resolveExecutableOnPath } from "../io/process.js";
import { getCodexTargetState } from "../state/accounts.js";
import { ensureStateShape } from "../state/schema.js";

export function resolveClaudeCommand({ homeDir, spawnImpl = spawnSync } = {}) {
  if (spawnImpl !== spawnSync) {
    return "claude";
  }
  return resolveExecutableOnPath("claude", {
    extraSearchPaths: homeDir ? [path.join(homeDir, ".local", "bin")] : [],
  });
}

export function normalizeCodexStoreMode(value) {
  const raw = String(value ?? "").trim().toLowerCase();
  if (raw === CODEX_AUTH_STORE_MODE_FILE) return CODEX_AUTH_STORE_MODE_FILE;
  if (raw === CODEX_AUTH_STORE_MODE_KEYRING) return CODEX_AUTH_STORE_MODE_KEYRING;
  if (raw === CODEX_AUTH_STORE_MODE_AUTO) return CODEX_AUTH_STORE_MODE_AUTO;
  return null;
}

export function readCodexCliStoreMode({ codexHome }) {
  const configPath = resolveCodexConfigPath(codexHome);
  if (!fs.existsSync(configPath)) {
    return { storeMode: CODEX_AUTH_STORE_MODE_FILE, source: "default", configPath };
  }

  const raw = fs.readFileSync(configPath, "utf8");
  const lines = raw.split(/\r?\n/);
  for (const lineRaw of lines) {
    const line = lineRaw.replace(/#.*/, "").trim();
    if (!line) continue;
    const match = line.match(/^cli_auth_credentials_store\s*=\s*"([^"]+)"\s*$/);
    if (!match) continue;
    const storeMode = normalizeCodexStoreMode(match[1]);
    if (!storeMode) {
      throw new Error(`Unsupported cli_auth_credentials_store value in ${configPath}: ${match[1]}`);
    }
    return { storeMode, source: "config", configPath };
  }

  return { storeMode: CODEX_AUTH_STORE_MODE_FILE, source: "default", configPath };
}

export function ensureFileBackedCodexHome({ codexHome }) {
  const { storeMode, source, configPath } = readCodexCliStoreMode({ codexHome });
  if (storeMode !== CODEX_AUTH_STORE_MODE_FILE) {
    throw new Error(
      `Refusing to manage Codex home ${codexHome}: cli_auth_credentials_store=${storeMode} ` +
        `(${source === "config" ? configPath : "default"}). ` +
        "Managed Codex activation requires file-backed auth storage.",
    );
  }
  return { storeMode, source, configPath };
}

export function readCodexAuthFile({ codexHome }) {
  const authPath = resolveCodexAuthFilePath(codexHome);
  if (!fs.existsSync(authPath)) {
    return { exists: false, authPath };
  }

  try {
    const parsed = JSON.parse(fs.readFileSync(authPath, "utf8"));
    const tokens = isObject(parsed?.tokens) ? parsed.tokens : null;
    const accountId = typeof tokens?.account_id === "string" ? tokens.account_id.trim() : null;
    return {
      exists: true,
      ok: true,
      authPath,
      accountId: accountId || null,
      json: parsed,
    };
  } catch (err) {
    return {
      exists: true,
      ok: false,
      authPath,
      error: String(err?.message ?? err),
    };
  }
}

export function clearManagedCodexCliActivation({ state, homeDir, env = {} }) {
  ensureStateShape(state);
  const codexHome = resolveManagedCodexHomeDir({ homeDir, env });
  ensureFileBackedCodexHome({ codexHome });
  const authPath = resolveCodexAuthFilePath(codexHome);
  fs.rmSync(authPath, { force: true });

  const target = getCodexTargetState(state);
  delete target.homeDir;
  delete target.activeLabel;
  delete target.expectedAccountId;
  delete target.lastAppliedAt;
}

// Pi auth.json is a multi-provider store. AIM owns only the `openai-codex` entry there,
// so clearing managed Pi activation must preserve any unrelated Pi providers.

export function resolveCodexIdTokenForCredential(credential) {
  const explicit = typeof credential?.idToken === "string" ? credential.idToken.trim() : "";
  if (explicit) {
    if (!isLikelyJwt(explicit)) {
      throw new Error("Stored idToken is not a JWT.");
    }
    return explicit;
  }

  const access = typeof credential?.access === "string" ? credential.access.trim() : "";
  if (isLikelyJwt(access)) {
    // `@mariozechner/pi-ai` currently gives AIM only access/refresh/accountId for OpenAI Codex.
    // Codex auth.json still requires a JWT-shaped `id_token`, and Codex preserves the existing
    // id_token on refreshes that do not return a new one, so v1 seeds that field from the same
    // access JWT claims carrier instead of inventing a second credential source.
    return access;
  }

  throw new Error(
    "Refusing to build Codex auth.json without a JWT-capable id token source. " +
      "Current AIM credentials only include access/refresh data for this label.",
  );
}

export function buildCodexAuthDotJson({ credential, lastRefreshAt }) {
  return {
    OPENAI_API_KEY: null,
    tokens: {
      id_token: resolveCodexIdTokenForCredential(credential),
      access_token: credential.access,
      refresh_token: credential.refresh,
      account_id: credential.accountId,
    },
    last_refresh: String(lastRefreshAt ?? new Date().toISOString()),
  };
}
