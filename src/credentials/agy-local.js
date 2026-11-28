import fs from "node:fs";
import path from "node:path";
import lockfile from "proper-lockfile";

const labelPattern = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const markerFile = "connection.json";
const stateError = () => new Error("Antigravity connection state is unsafe or could not be accessed.");

export function isAgyLabel(label) {
  return typeof label === "string" && labelPattern.test(label);
}

export function validateAgyLabel(label) {
  if (!isAgyLabel(label)) {
    throw new Error("Use an Antigravity label of 1–64 lowercase letters, numbers, underscores or hyphens, starting with a letter or number.");
  }
}

export function assertAgyRouteMatches(label, configuredProfile, enrolledProfile) {
  if (configuredProfile === undefined || configuredProfile === enrolledProfile) return;
  const repair = enrolledProfile ? `Restore its ${enrolledProfile} assignment.` : "Remove the assignment or enroll a separate label for the routed connection.";
  throw new Error(`Antigravity connection ${label} has a different enrolled route than the configured route. ${repair}`);
}

function lstat(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw stateError();
  }
}

function directory(dir, { create = false, privateMode = false } = {}) {
  let stat = lstat(dir);
  if (!stat && create) {
    try {
      fs.mkdirSync(dir, { mode: 0o700 });
    } catch (error) {
      if (error.code !== "EEXIST") throw stateError();
    }
    stat = lstat(dir);
  }
  if (!stat) return false;
  const unsafeMode = privateMode ? (stat.mode & 0o7777) !== 0o700 : (stat.mode & 0o022) !== 0;
  if (!stat.isDirectory() || stat.uid !== process.getuid() || unsafeMode) {
    throw stateError();
  }
  return true;
}

function rootDirectory(homeDir, create = false) {
  if (!path.isAbsolute(homeDir)) throw stateError();
  if (!directory(homeDir)) return null;
  let canonicalHome;
  try {
    canonicalHome = fs.realpathSync(homeDir);
  } catch {
    throw stateError();
  }
  const aimgrDir = path.join(canonicalHome, ".aimgr");
  if (!directory(aimgrDir, { create })) return null;
  const root = path.join(aimgrDir, "agy");
  return directory(root, { create, privateMode: true }) ? root : null;
}

function isPrivateFile(stat) {
  return stat.isFile() && stat.uid === process.getuid() && stat.nlink === 1 && (stat.mode & 0o7777) === 0o600;
}

function readMarker(file, label) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!isPrivateFile(stat) || stat.size > 256) throw stateError();
    const marker = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (marker.version !== 1 || marker.label !== label
      || Object.keys(marker).some(key => !["version", "label", "profileRef"].includes(key))) throw stateError();
    if (Object.hasOwn(marker, "profileRef") && (typeof marker.profileRef !== "string" || !/^[a-z0-9][a-z0-9_-]{0,127}$/.test(marker.profileRef))) {
      throw stateError();
    }
    return marker;
  } finally {
    fs.closeSync(fd);
  }
}

function nativeGrantExists(home) {
  if (!directory(home, { privateMode: true })) return false;
  const gemini = path.join(home, ".gemini");
  if (!directory(gemini)) return false;
  const antigravity = path.join(gemini, "antigravity-cli");
  if (!directory(antigravity)) return false;
  const grant = lstat(path.join(antigravity, "antigravity-oauth-token"));
  if (grant && (!isPrivateFile(grant) || !grant.size)) throw stateError();
  return Boolean(grant);
}

function inspectConnection(connection, label) {
  if (!connection) return { label, status: "not-enrolled" };
  try {
    if (!directory(connection, { privateMode: true })) return { label, status: "not-enrolled" };
    const { profileRef } = readMarker(path.join(connection, markerFile), label);
    const accountHome = path.join(connection, "home");
    return nativeGrantExists(accountHome)
      ? { label, status: "ready", accountHome, profileRef }
      : { label, status: "needs-sign-in", profileRef };
  } catch {
    return { label, status: "invalid-state" };
  }
}

export function readAgyConnection(homeDir, label) {
  validateAgyLabel(label);
  const root = rootDirectory(homeDir);
  return inspectConnection(root && path.join(root, label), label);
}

export function listAgyConnections(homeDir) {
  const root = rootDirectory(homeDir);
  if (!root) return [];
  let labels;
  try {
    labels = fs.readdirSync(root);
  } catch {
    throw stateError();
  }
  return labels.filter(isAgyLabel).sort()
    .map((label) => inspectConnection(path.join(root, label), label));
}

export function isAgyConnectionInUse(accountHome) {
  // This checks the same path and stale timeout as acquisition without
  // refreshing the existing lock or creating one for status.
  return lockfile.checkSync(path.dirname(accountHome), { realpath: false });
}

async function lockAgyConnection(root, label) {
  const connection = path.join(root, label);
  let release;
  let compromised = false;
  try {
    release = await lockfile.lock(connection, {
      realpath: false,
      onCompromised: () => { compromised = true; },
    });
  } catch (error) {
    if (error.code === "ELOCKED") throw new Error(`An Antigravity operation is already in progress for ${label}.`);
    throw stateError();
  }
  return {
    assertHeld() { if (compromised) throw stateError(); },
    async release() { if (!compromised) await release(); },
  };
}

export async function withAgyConnection(homeDir, label, useConnection) {
  validateAgyLabel(label);
  const root = rootDirectory(homeDir);
  if (!root) return useConnection({ label, status: "not-enrolled" });
  const lock = await lockAgyConnection(root, label);
  try {
    const result = await useConnection(inspectConnection(path.join(root, label), label));
    lock.assertHeld();
    return result;
  } finally {
    await lock.release();
  }
}

function finishAgyReplacement(root, label, connection, pending) {
  if (!lstat(pending)) return;
  if (inspectConnection(pending, label).status !== "needs-sign-in") throw stateError();

  // If publishing was interrupted, restore the old home for another attempt.
  let archive;
  try {
    if (!lstat(connection)) {
      fs.renameSync(pending, connection);
      return;
    }
    // Put the signed-out home at a stable private path, outside the active label.
    archive = fs.mkdtempSync(path.join(root, `.signed-out-${label}-`));
    fs.renameSync(pending, archive);
  } catch {
    if (archive) {
      try { fs.rmdirSync(archive); } catch { /* The old home is still in pending. */ }
    }
    throw stateError();
  }
  return path.basename(archive);
}

export async function enrollAgyConnection(homeDir, label, signIn, { profileRef } = {}) {
  validateAgyLabel(label);
  const root = rootDirectory(homeDir, true);
  if (!root) throw stateError();
  const connection = path.join(root, label);
  const pending = path.join(root, `.reauth-${label}`);
  const lock = await lockAgyConnection(root, label);

  let candidate;
  try {
    const recoveredArchive = finishAgyReplacement(root, label, connection, pending);
    const existing = inspectConnection(connection, label);
    if (existing.status === "invalid-state") throw stateError();
    if (existing.status === "ready") {
      return { alreadyEnrolled: true, archiveName: recoveredArchive };
    }
    const replacing = existing.status === "needs-sign-in";
    if (replacing) {
      assertAgyRouteMatches(label, profileRef, existing.profileRef);
      profileRef = existing.profileRef;
    }
    const previous = lstat(connection);
    candidate = fs.mkdtempSync(path.join(root, ".login-"));
    const accountHome = path.join(candidate, "home");
    fs.mkdirSync(accountHome, { mode: 0o700 });
    await signIn(accountHome, profileRef);
    const current = lstat(connection);
    const currentState = inspectConnection(connection, label);
    if (!directory(candidate, { privateMode: true }) || !nativeGrantExists(accountHome)
      || current?.dev !== previous?.dev || current?.ino !== previous?.ino
      || currentState.status !== existing.status || currentState.profileRef !== existing.profileRef) {
      throw stateError();
    }
    fs.writeFileSync(path.join(candidate, markerFile), `${JSON.stringify({ version: 1, label, profileRef })}\n`, {
      flag: "wx", mode: 0o600,
    });
    // Publish the marker and the native home together only after verified sign-in.
    // The old marker cannot prove who owned the history. Keep the whole home private.
    lock.assertHeld();
    let movedOriginal = false;
    try {
      if (replacing) {
        fs.renameSync(connection, pending);
        movedOriginal = true;
      }
      fs.renameSync(candidate, connection);
    } catch {
      if (movedOriginal && !lstat(connection)) finishAgyReplacement(root, label, connection, pending);
      throw stateError();
    }
    candidate = undefined;
    const archiveName = finishAgyReplacement(root, label, connection, pending) ?? recoveredArchive;
    return { alreadyEnrolled: false, archiveName };
  } finally {
    try {
      if (candidate) fs.rmSync(candidate, { recursive: true, force: true });
    } finally {
      await lock.release();
    }
  }
}
