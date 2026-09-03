#!/usr/bin/env node
// Start the Prime Agent supervisor on the default socket with zero sessions,
// exactly the way a Prime client does it (detached, stdio ignored, argv0 owner
// token so the registry accepts its process identity), then wait for a hello.
//
// Usage: node scripts/prime-daemon-start.mjs [--bundle <cli.js>] [--socket <path>] [--timeout-ms 120000]
//
// Refuses to start when a supervisor is already serving the socket, and never
// touches workers, descriptors, transcripts, or lock files.
import { spawn, execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const launcher = execFileSync("sh", ["-lc", "command -v prime-agent"], { encoding: "utf8" }).trim();
const bundle = opt("--bundle", launcher ? realpathSync(launcher) : undefined);
if (!bundle) {
  console.error("prime-agent is not on PATH and --bundle was not given");
  process.exit(2);
}
const socketPath = opt("--socket", join(tmpdir(), `prime-agent-${userInfo().uid}`, "daemon.sock"));
const timeoutMs = Number(opt("--timeout-ms", "120000"));

function status() {
  try {
    const out = execFileSync(launcher || "prime-agent", ["status", "--json"], { encoding: "utf8", timeout: 40000 });
    const parsed = JSON.parse(out);
    const rows = Array.isArray(parsed) ? parsed : parsed.daemons ?? parsed.services ?? [];
    return rows.find((r) => r.isDefault || r.default || r.socketPath === socketPath || r.socket === socketPath) ?? rows[0];
  } catch (error) {
    return { status: `status-failed: ${String(error).split("\n")[0]}` };
  }
}

const before = status();
if (before && before.status === "current") {
  console.log(`supervisor already current on ${socketPath} (pid ${before.pid ?? "?"}); nothing to do`);
  process.exit(0);
}

const env = { ...process.env };
for (const key of Object.keys(env)) {
  if (key.startsWith("PRIME_AGENT_INTERNAL_")) delete env[key];
}
const token = randomBytes(32).toString("hex");
const child = spawn(process.execPath, [bundle, "--mode", "daemon", "--daemon-socket", socketPath], {
  argv0: `prime-agent-owner-token=${token}`,
  cwd: homedir(),
  detached: true,
  env,
  stdio: "ignore",
});
child.unref();
console.log(`spawned supervisor pid ${child.pid} from ${bundle}`);
console.log(`waiting for hello on ${socketPath} (up to ${timeoutMs} ms)`);

const deadline = Date.now() + timeoutMs;
let last;
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 1000));
  last = status();
  if (last && last.status === "current") {
    console.log(`ready: pid ${last.pid ?? "?"} version ${last.version ?? "?"} sessions ${last.sessions ?? last.sessionCount ?? "?"}`);
    process.exit(0);
  }
  try {
    process.kill(child.pid, 0);
  } catch {
    console.error(`supervisor pid ${child.pid} exited before hello; read ~/.prime/agent/logs/daemon.sock.*.log`);
    process.exit(1);
  }
}
console.error(`timed out; last status: ${JSON.stringify(last)}`);
process.exit(1);
