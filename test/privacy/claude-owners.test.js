import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, execFile } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { assertClaudeNativeOwnersStopped } from "../../src/privacy/claude-state-migration.js";

const execute = promisify(execFile);
const helper = fileURLToPath(new URL("../../native/claude/check_owners.py", import.meta.url));

test("stopped-owner admission excludes the selected native owner including config aliases", {
  skip: !fs.existsSync("/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST"), timeout: 15_000,
}, async t => {
  // A synthetic executable exercises the real OS inventory. Run only offsite:
  // targeting Node on a shared developer Mac would inspect unrelated agents.
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "aim-stopped-owner-")));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const selected = path.join(root, "selected"), other = path.join(root, "other"), alias = path.join(root, "alias");
  fs.mkdirSync(selected); fs.mkdirSync(other); fs.symlinkSync(selected, alias);
  const command = fs.realpathSync(process.execPath);
  const commandAlias = path.join(root, "claude");
  fs.symlinkSync(command, commandAlias);
  const checkViaAlias = configDir => assertClaudeNativeOwnersStopped({ configDir, command: commandAlias });
  const check = config => execute("/usr/bin/python3", ["-I", helper, config, command],
    { env: { PATH: "/usr/bin:/bin" }, timeout: 5000, maxBuffer: 16384 });
  await check(selected);
  await checkViaAlias(alias);
  await assert.rejects(assertClaudeNativeOwnersStopped({configDir:selected,command:path.join(root,"missing")}),
    error => error.code === "AIMGR_CLAUDE_PRIVATE_IDENTITY");
  const child = spawn(command, ["-e", "process.stdout.write('ready\\n'); setInterval(()=>{},1000)"],
    { env: { PATH: "/usr/bin:/bin", CLAUDE_CONFIG_DIR: alias }, stdio: ["ignore", "pipe", "pipe"] });
  const closed = once(child, "exit");
  try {
    assert.equal((await once(child.stdout, "data"))[0].toString(), "ready\n");
    await assert.rejects(check(selected), error => error.code === 125 && /stop its sessions and background owners/.test(error.stderr));
    await assert.rejects(checkViaAlias(alias), error => error.code === "AIMGR_CLAUDE_PRIVATE_IDENTITY");
    await check(other);
    await checkViaAlias(other);
  } finally { child.kill("SIGKILL"); await closed; }
  await check(selected);
  await checkViaAlias(alias);
});
