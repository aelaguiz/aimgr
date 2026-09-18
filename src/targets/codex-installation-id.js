import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ensureLocalStateShape } from "../state/local-state.js";

// Codex sends `installation_id` on every model request as
// `client_metadata["x-codex-installation-id"]`, and on compaction and
// remote-control enrollment as a header. It is one random UUID per CODEX_HOME,
// so every pooled account on a machine shares it unless aim gives each label its
// own value before spawning Codex.
//
// The label -> UUID map lives in aimgr local state, so a label keeps the same
// install identity across rotations. Codex reads the file once per process, so
// writing it before spawn is enough.

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function resolveCodexInstallationIdPath({ codexHome }) {
  return path.join(codexHome, "installation_id");
}

export function readCodexInstallationId({ codexHome, fsImpl = fs } = {}) {
  const filePath = resolveCodexInstallationIdPath({ codexHome });
  try {
    const value = String(fsImpl.readFileSync(filePath, "utf8")).trim().toLowerCase();
    return UUID_PATTERN.test(value) ? value : null;
  } catch (err) {
    if (err?.code === "ENOENT") return null;
    throw err;
  }
}

export function normalizeCodexInstallationLabel(label) {
  return String(label ?? "").trim().toLowerCase();
}

/**
 * Give one Codex label its own installation id.
 *
 * Writes `<codexHome>/installation_id` only when the current value differs, and
 * remembers the label's id in aimgr local state.
 */
export function ensureCodexLabelInstallationId({
  codexHome,
  label,
  localState,
  randomUUIDImpl = randomUUID,
  fsImpl = fs,
} = {}) {
  const normalizedLabel = normalizeCodexInstallationLabel(label);
  const state = ensureLocalStateShape(localState);
  state.targets.codexCli = state.targets.codexCli && typeof state.targets.codexCli === "object"
    ? state.targets.codexCli
    : {};
  const installationIds = state.targets.codexCli.installationIds
    && typeof state.targets.codexCli.installationIds === "object"
    ? state.targets.codexCli.installationIds
    : {};
  state.targets.codexCli.installationIds = installationIds;

  if (!normalizedLabel) {
    return { changed: false, reason: "no_label", installationId: readCodexInstallationId({ codexHome, fsImpl }) };
  }

  const remembered = String(installationIds[normalizedLabel] ?? "").trim().toLowerCase();
  const installationId = UUID_PATTERN.test(remembered)
    ? remembered
    : String(randomUUIDImpl()).trim().toLowerCase();
  if (!UUID_PATTERN.test(installationId)) {
    throw new Error("Could not create a Codex installation identifier.");
  }
  installationIds[normalizedLabel] = installationId;
  if (normalizedLabel === "default" && !installationIds.__default) installationIds.__default = installationId;

  const current = readCodexInstallationId({ codexHome, fsImpl });
  if (current === installationId) {
    return { changed: false, reason: "already_set", installationId, fileChanged: false };
  }
  fsImpl.mkdirSync(codexHome, { recursive: true, mode: 0o755 });
  fsImpl.writeFileSync(resolveCodexInstallationIdPath({ codexHome }), installationId, { mode: 0o644 });
  return {
    changed: true,
    reason: current ? "rotated" : "created",
    previousInstallationId: current,
    installationId,
    fileChanged: true,
  };
}
