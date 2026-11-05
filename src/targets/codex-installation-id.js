import fs from "node:fs";
import path from "node:path";

// The account-state owner creates a random identity for each account on each
// environment. This reader never derives an identity from a shared pool label.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveCodexInstallationIdPath({ codexHome }) {
  return path.join(codexHome, "installation_id");
}

export function readCodexInstallationId({ codexHome, fsImpl = fs } = {}) {
  try {
    const value = String(fsImpl.readFileSync(resolveCodexInstallationIdPath({ codexHome }), "utf8")).trim().toLowerCase();
    return UUID_PATTERN.test(value) ? value : null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}
