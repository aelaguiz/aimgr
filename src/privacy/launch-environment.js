import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

/** Unlinked, private data transfer through a native entry. Values never enter
 * argv or the privileged helper's initial environment. */
export function stageLaunchEnvironment(env, directory) {
  const entries = [];
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue;
    if (!key || /[=\0]/.test(key) || typeof value !== "string" || value.includes("\0")) throw new Error("Invalid launch environment.");
    entries.push(`${key}=${value}\0`);
  }
  const bytes = Buffer.from(entries.join(""));
  if (!bytes.length || bytes.length > 16 * 1024 * 1024) throw new Error("Launch environment exceeds native transfer bounds.");
  const file = path.join(directory, `.environment-${randomUUID()}`);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
  try { fs.unlinkSync(file); fs.writeFileSync(fd, bytes); return fd; }
  catch (error) { fs.closeSync(fd); try { fs.unlinkSync(file); } catch {} throw error; }
}
