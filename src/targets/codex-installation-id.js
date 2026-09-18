import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { normalizeLabel } from "../core/normalize.js";

// Codex sends `installation_id` on every model request as
// `client_metadata["x-codex-installation-id"]`, and on compaction and
// remote-control enrollment as a header. It is one random UUID per CODEX_HOME,
// so every pooled account on a machine shares it unless aim gives each label its
// own value.
//
// The id is derived deterministically from the label, so every code path that
// writes `<codexHome>/auth.json` can also write the matching install id without
// needing shared state: the CLI, `aim codex watch`, and the scheduled routines.
// Codex reads the file once per process, so writing it before spawn is enough.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTALLATION_ID_NAMESPACE = "aimgr-codex-installation-id:";

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

/** Deterministic per-label install id: same label, same id, on every machine path. */
export function resolveCodexLabelInstallationId({ label } = {}) {
  const normalized = normalizeLabel(label);
  if (!normalized) throw new Error("A Codex label is required to resolve an installation id.");
  const digest = createHash("sha256").update(`${INSTALLATION_ID_NAMESPACE}${normalized}`).digest("hex");
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

/**
 * Point `<codexHome>/installation_id` at the given label's id.
 * Writes only when the current value differs.
 */
export function writeCodexLabelInstallationId({ codexHome, label, fsImpl = fs, randomUUIDImpl = randomUUID } = {}) {
  const normalized = normalizeLabel(label);
  if (!normalized) return { changed: false, reason: "no_label", installationId: readCodexInstallationId({ codexHome, fsImpl }) };
  const installationId = resolveCodexLabelInstallationId({ label: normalized });
  const current = readCodexInstallationId({ codexHome, fsImpl });
  if (current === installationId) return { changed: false, reason: "already_set", installationId };
  fsImpl.mkdirSync(codexHome, { recursive: true, mode: 0o755 });
  fsImpl.writeFileSync(resolveCodexInstallationIdPath({ codexHome }), installationId, { mode: 0o644 });
  return {
    changed: true,
    reason: current ? "rotated" : "created",
    previousInstallationId: current,
    installationId,
  };
}

/** Fresh random id; kept for callers that deliberately want a new machine identity. */
export function generateCodexInstallationId({ randomUUIDImpl = randomUUID } = {}) {
  return String(randomUUIDImpl()).trim().toLowerCase();
}
