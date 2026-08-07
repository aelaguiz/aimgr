import fs from "node:fs";
import path from "node:path";
import { resolveManagedCodexHomeDir } from "../io/paths.js";
import { acquireCodexRunLock } from "./codex-run-lock.js";
import { buildSakanaKeyFingerprint, normalizeSakanaApiKey } from "../providers/sakana.js";

export const SAKANA_CODEX_ENV_KEY = "SAKANA_API_KEY";

// The Sakana key rides in the AIM-managed rotating Codex home. The native
// ~/.codex home belongs exclusively to the Codex Desktop app, so AIM never
// writes even a non-secret dotfile there.
export function resolveSakanaCodexEnvPath({ homeDir }) {
  return path.join(resolveManagedCodexHomeDir({ homeDir }), ".env");
}

function isSakanaApiKeyLine(line) {
  return /^\s*(?:export\s+)?SAKANA_API_KEY\s*=/.test(String(line ?? ""));
}

function renderEnvWithSakanaKey(existingText, apiKey) {
  const nextLine = `${SAKANA_CODEX_ENV_KEY}=${apiKey}`;
  const text = String(existingText ?? "");
  const lines = text === "" ? [] : text.replace(/\n$/, "").split("\n");
  let wrote = false;
  const nextLines = [];
  for (const line of lines) {
    if (isSakanaApiKeyLine(line)) {
      if (!wrote) {
        nextLines.push(nextLine);
        wrote = true;
      }
      continue;
    }
    nextLines.push(line);
  }
  if (!wrote) {
    nextLines.push(nextLine);
  }
  return `${nextLines.join("\n")}\n`;
}

function readActiveSakanaKeyFromEnvText(text) {
  const lines = String(text ?? "").split(/\r?\n/);
  for (const line of lines) {
    if (!isSakanaApiKeyLine(line)) continue;
    const raw = line.replace(/^\s*(?:export\s+)?SAKANA_API_KEY\s*=\s*/, "").trim();
    if (!raw) return null;
    return normalizeSakanaApiKey(raw.replace(/^['"]|['"]$/g, ""));
  }
  return null;
}

export function readSakanaCodexTargetStatus({ homeDir }) {
  const envPath = resolveSakanaCodexEnvPath({ homeDir });
  if (!fs.existsSync(envPath)) {
    return {
      envPath,
      exists: false,
      activeKeyFingerprint: null,
    };
  }
  const text = fs.readFileSync(envPath, "utf8");
  const activeKey = readActiveSakanaKeyFromEnvText(text);
  return {
    envPath,
    exists: true,
    activeKeyFingerprint: activeKey ? buildSakanaKeyFingerprint(activeKey) : null,
  };
}

export function activateSakanaCodexEnvSelection({
  state,
  homeDir,
  label,
  apiKey,
  observedAt = new Date().toISOString(),
}) {
  const normalizedApiKey = normalizeSakanaApiKey(apiKey);
  const expectedKeyFingerprint = buildSakanaKeyFingerprint(normalizedApiKey);
  const codexHome = resolveManagedCodexHomeDir({ homeDir });
  // The managed home has exactly one writer contract: even this non-secret
  // dotfile write serializes behind the same owner lock `aim codex run`
  // holds, so it can never interleave with a live selection/launch.
  const envPath = resolveSakanaCodexEnvPath({ homeDir });
  const lock = acquireCodexRunLock({ managedCodexHome: codexHome });
  try {
    fs.mkdirSync(codexHome, { recursive: true, mode: 0o700 });
    const existingText = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    fs.writeFileSync(envPath, renderEnvWithSakanaKey(existingText, normalizedApiKey), {
      encoding: "utf8",
      mode: 0o600,
    });
    fs.chmodSync(envPath, 0o600);
  } finally {
    lock.release();
  }
  const readback = readSakanaCodexTargetStatus({ homeDir });
  const receipt = {
    action: "sakana_use",
    status: readback.activeKeyFingerprint === expectedKeyFingerprint ? "activated" : "blocked",
    label,
    wroteEnv: true,
    warnings: [],
    blockers: [],
  };
  if (receipt.status === "blocked") {
    receipt.blockers.push("env_readback_fingerprint_mismatch");
  }
  state.targets = state.targets && typeof state.targets === "object" ? state.targets : {};
  state.targets.sakanaCodex = {
    homeDir: codexHome,
    envPath,
    activeLabel: label,
    expectedKeyFingerprint,
    activeKeyFingerprint: readback.activeKeyFingerprint,
    lastAppliedAt: observedAt,
    lastSelectionReceipt: receipt,
  };
  return state.targets.sakanaCodex;
}
