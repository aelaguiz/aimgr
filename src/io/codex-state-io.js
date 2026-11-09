import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const helper = fileURLToPath(new URL("../../native/codex/state_io.py", import.meta.url));

export function codexStateIO(request, { spawnSyncImpl = spawnSync, helperPath = helper } = {}) {
  const result = spawnSyncImpl("/usr/bin/python3", ["-I", helperPath], {
    input: JSON.stringify(request), encoding: "utf8", timeout: 10_000,
    env: { PATH: "/usr/bin:/bin" }, maxBuffer: 1024 * 1024,
  });
  let response;
  try { response = JSON.parse(result.stdout); } catch { /* reported without private content */ }
  if (result.error || result.status !== 0 || response?.error) {
    const error = new Error(`Codex state ${request.operation} failed (${response?.error ?? result.error?.code ?? "helper failure"}).`);
    error.code = "AIMGR_CODEX_STATE_IO";
    throw error;
  }
  return response;
}
export function durableCodexWrite(file, text, { exclusive = false, allowUnreadableParent = false } = {}) {
  if (!fs.existsSync(path.dirname(file))) durableCodexMkdir(path.dirname(file));
  const fd = fs.openSync(file, exclusive ? "wx" : "w", 0o600);
  try { fs.writeFileSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  let directory;
  try { directory = fs.openSync(path.dirname(file), "r"); }
  catch (error) { if (allowUnreadableParent && error.code === "EACCES") return false; throw error; }
  try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
  return true;
}

export function durableCodexMkdir(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  // Another first-use owner may have created an ancestor without flushing it
  // yet. Establish the whole chain before acknowledging a saved login, even
  // when this process's mkdir found the directory already present.
  for (let current = directory; ; current = path.dirname(current)) {
    const parent = path.dirname(current);
    const fd = fs.openSync(parent, "r");
    try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    if (parent === current) break;
  }
}
