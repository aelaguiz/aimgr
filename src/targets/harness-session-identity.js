import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const MANAGED_MARKER = "// Managed by aimgr.";
const EXTENSION_FILENAME = "session-title-footer.ts";
const SOURCE_PATH = fileURLToPath(
  new URL("../../native/harness/session-title-footer.js", import.meta.url),
);
const LEGACY_EXTENSION_SHA256S = new Set([
  // Exact AIM-created Prime widget and Pi footer assets that predate the managed marker.
  "2e7560e39a897f4e8cf276aa488b02c8e1d72cdbc46357a3034be98590a87759",
  "6b6521197cbd1a3010b9b195e8b28d9b9ff3a278c0561cdf74d7a12226d02864",
]);

export function isLegacyHarnessSessionIdentityExtension(content) {
  const digest = createHash("sha256").update(String(content ?? ""), "utf8").digest("hex");
  return LEGACY_EXTENSION_SHA256S.has(digest);
}

function readManagedSource(fsImpl) {
  const source = fsImpl.readFileSync(SOURCE_PATH, "utf8");
  if (!source.startsWith(MANAGED_MARKER)) {
    throw new Error("AIM session identity extension source is missing its managed marker.");
  }
  return source.endsWith("\n") ? source : `${source}\n`;
}


export function readHarnessSessionIdentityExtensionStatus({ agentDir, fsImpl = fs } = {}) {
  const resolvedAgentDir = path.resolve(String(agentDir ?? ""));
  if (!path.isAbsolute(resolvedAgentDir) || !String(agentDir ?? "").trim()) {
    throw new Error("A harness agent directory is required for the session identity extension.");
  }
  const extensionPath = path.join(resolvedAgentDir, "extensions", EXTENSION_FILENAME);
  try {
    const stat = fsImpl.lstatSync(extensionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return Object.freeze({ installed: true, managed: false, conflict: true });
    }
    const content = fsImpl.readFileSync(extensionPath, "utf8");
    return Object.freeze({
      installed: true,
      managed: content.startsWith(MANAGED_MARKER) || isLegacyHarnessSessionIdentityExtension(content),
      conflict: !content.startsWith(MANAGED_MARKER) && !isLegacyHarnessSessionIdentityExtension(content),
    });
  } catch (error) {
    if (error?.code === "ENOENT") {
      return Object.freeze({ installed: false, managed: false, conflict: false });
    }
    throw error;
  }
}

export function ensureHarnessSessionIdentityExtension({ agentDir, fsImpl = fs } = {}) {
  const resolvedAgentDir = path.resolve(String(agentDir ?? ""));
  if (!path.isAbsolute(resolvedAgentDir) || !String(agentDir ?? "").trim()) {
    throw new Error("A harness agent directory is required for the session identity extension.");
  }
  const extensionsDir = path.join(resolvedAgentDir, "extensions");
  const extensionPath = path.join(extensionsDir, EXTENSION_FILENAME);
  const source = readManagedSource(fsImpl);

  let previous;
  try {
    const stat = fsImpl.lstatSync(extensionPath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`Refusing to replace non-file session identity extension at ${extensionPath}.`);
    }
    previous = fsImpl.readFileSync(extensionPath, "utf8");
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (previous === source) {
    return Object.freeze({ status: "unchanged", path: extensionPath });
  }
  if (
    previous !== undefined &&
    !previous.startsWith(MANAGED_MARKER) &&
    !isLegacyHarnessSessionIdentityExtension(previous)
  ) {
    throw new Error(`Refusing to overwrite unmanaged session identity extension at ${extensionPath}.`);
  }

  fsImpl.mkdirSync(extensionsDir, { recursive: true, mode: 0o700 });
  const tempPath = path.join(extensionsDir, `.${EXTENSION_FILENAME}.${process.pid}.${randomUUID()}.tmp`);
  let renamed = false;
  try {
    fsImpl.writeFileSync(tempPath, source, { encoding: "utf8", mode: 0o644, flag: "wx" });
    fsImpl.renameSync(tempPath, extensionPath);
    renamed = true;
    fsImpl.chmodSync(extensionPath, 0o644);
  } finally {
    if (!renamed) {
      try {
        fsImpl.rmSync(tempPath, { force: true });
      } catch {
        // Preserve the original installation error.
      }
    }
  }

  if (fsImpl.readFileSync(extensionPath, "utf8") !== source) {
    throw new Error(`Session identity extension verification failed at ${extensionPath}.`);
  }
  return Object.freeze({
    status: previous === undefined ? "installed" : "updated",
    path: extensionPath,
  });
}
