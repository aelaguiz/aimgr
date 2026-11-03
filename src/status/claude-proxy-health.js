import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execute = promisify(execFile);
export const CLAUDE_PROXY_HEALTH_STATES = new Set(["running", "stopped", "starting", "not_installed", "unknown"]);

// Use the installed Mac launcher's own owner-lifetime and failure-marker check.
// This is an observation: no sudo, network request, service restart or launch.
const MAC_STATUS = `
import json, pathlib, runpy, sys
root = pathlib.Path('/opt/aimgr-claude-proxy')
helper = root / 'darwin_proxy.py'
runtime = runpy.run_path(str(helper)) if helper.is_file() else None
result = {}
for name in json.loads(sys.argv[1]):
    if runtime is None or not (root / (name + '.json')).is_file():
        result[name] = 'not_installed'
        continue
    try:
        runtime['current_ready'](name, allow_starting=True)
        result[name] = 'starting' if (runtime['state_dir'](name) / 'starting').exists() else 'running'
    except (RuntimeError, FileNotFoundError):
        result[name] = 'stopped'
    except Exception:
        result[name] = 'unknown'
print(json.dumps(result))
`;

/** Current native service health, independent of cached credentials/usage.
 * "running" describes the installed service, not an end-to-end exit probe;
 * the normal native launch still verifies the actual assigned network path.
 */
export async function readClaudeProxyHealth(profileRefs, { platform = process.platform, execFileImpl = execute } = {}) {
  const names = [...new Set(profileRefs)].filter(name => typeof name === "string" && /^[a-z0-9][a-z0-9_-]{0,127}$/.test(name));
  const health = Object.fromEntries(names.map(name => [name, "unknown"]));
  if (!names.length) return health;
  const options = { timeout: 2000, maxBuffer: 64 * 1024, encoding: "utf8" };
  try {
    if (platform === "darwin") {
      const { stdout } = await execFileImpl("/usr/bin/python3", ["-I", "-c", MAC_STATUS, JSON.stringify(names)], options);
      const result = JSON.parse(stdout);
      for (const name of names) if (CLAUDE_PROXY_HEALTH_STATES.has(result?.[name])) health[name] = result[name];
    } else if (platform === "linux") {
      const units = new Map(names.map(name => [`aimgr-claude-proxy-${name}.service`, name]));
      // systemctl may return nonzero while still describing the other units.
      const { stdout } = await execFileImpl("/usr/bin/systemctl", ["show", "--property=Id,LoadState,ActiveState,SubState", "--", ...units.keys()], options)
        .catch(error => typeof error.stdout === "string" && error.stdout.trim() ? { stdout: error.stdout } : Promise.reject(error));
      for (const block of stdout.trim().split(/\n\s*\n/)) {
        const fields = Object.fromEntries(block.split("\n").map(line => line.split("=")));
        const name = units.get(fields.Id);
        if (!name) continue;
        health[name] = fields.LoadState === "not-found" ? "not_installed"
          : fields.ActiveState === "active" && fields.SubState === "running" ? "running"
          : fields.ActiveState === "activating" ? "starting"
          : ["inactive", "failed", "deactivating"].includes(fields.ActiveState) ? "stopped" : "unknown";
      }
    }
  } catch { /* A failed observation must remain unknown, never look healthy. */ }
  return health;
}
