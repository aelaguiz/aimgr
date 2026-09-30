import fs from "node:fs";
import path from "node:path";

// These stay separate in each Codex home: the login, the device id Codex sends
// for remote control, the desktop app's UI state and control sockets, scratch
// space, and SQLite side files (SQLite puts them beside the real database).
const PER_HOME_NAMES = new Set([
  "installation_id",
  ".codex-global-state.json",
  "app-server-control",
  "app-server-daemon",
  "tmp",
]);

function isPerHomeEntry(name) {
  return PER_HOME_NAMES.has(name) || name.startsWith("auth.json") || /-(wal|shm|journal)$/.test(name);
}

/**
 * Links every shared entry of the native Codex home (`~/.codex`: config,
 * profiles, AGENTS.md, skills, session history, thread index) into AIM's
 * managed home, so rotating pool accounts in the managed home never touches
 * the desktop app's login while settings and history stay single-sourced.
 * Entries already present in the managed home are left alone.
 */
export function linkManagedCodexHome({ managedHome, nativeHome, fsImpl = fs }) {
  if (path.resolve(managedHome) === path.resolve(nativeHome)) return { linked: [] };
  let names;
  try {
    names = fsImpl.readdirSync(nativeHome);
  } catch {
    return { linked: [] };
  }
  fsImpl.mkdirSync(managedHome, { recursive: true, mode: 0o700 });
  const linked = [];
  for (const name of names) {
    if (isPerHomeEntry(name)) continue;
    const entry = path.join(managedHome, name);
    try {
      fsImpl.lstatSync(entry);
      continue;
    } catch {
      // Missing: link it.
    }
    try {
      fsImpl.symlinkSync(path.join(nativeHome, name), entry);
      linked.push(name);
    } catch {
      // A concurrent AIM process linked it first, or the entry is unlinkable.
    }
  }
  return { linked };
}
