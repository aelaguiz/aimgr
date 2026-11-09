import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import vm from "node:vm";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { codexManagedPolicyText } from "../../src/privacy/codex-managed-policy.js";

// Run the actual fixed-path CLI body with only its /etc boundary redirected.
// Real filesystem calls retain umask behavior; no root or real policy changes.
const source = fs.readFileSync(new URL("../../scripts/install-codex-policy.mjs", import.meta.url), "utf8")
  .replace(/^#!.*\n/, "").replace(/^import .*;\n/gm, "");
const mode = file => fs.statSync(file).mode & 0o777;
function install(etc) {
  const filesystem = Object.create(fs);
  filesystem.realpathSync = file => file === "/etc" ? etc : fs.realpathSync(file);
  const inspectCodexAdministratorPath = file => fs.existsSync(file)
    ? { kind: fs.statSync(file).isDirectory() ? "directory" : "file", bytes: fs.statSync(file).isFile() ? fs.readFileSync(file) : undefined }
    : null;
  vm.runInNewContext(source, { fs: filesystem, path, randomUUID, codexManagedPolicyText, inspectCodexAdministratorPath,
    process: { getuid: () => 0, argv: ["node", "install-codex-policy.mjs"], stdout: { write() {} } } });
}

test("policy installation under restrictive umask publishes readable new policy and retains private existing policy", () => {
  const etc = fs.mkdtempSync(path.join(os.tmpdir(), "aim-policy-install-"));
  const previousUmask = process.umask(0o077);
  try {
    const directory = path.join(etc, "codex");
    install(etc);
    assert.equal(mode(directory), 0o755);
    for (const name of ["managed_config.toml", "requirements.toml"]) assert.equal(mode(path.join(directory, name)), 0o644);
    assert.deepEqual(fs.readFileSync(path.join(directory, "requirements.toml"), "utf8"), codexManagedPolicyText().requirements);

    fs.chmodSync(directory, 0o700);
    const config = path.join(directory, "managed_config.toml");
    const original = '# administrator policy\nmcp_oauth_credentials_store="keyring"\n';
    fs.writeFileSync(config, original);
    fs.chmodSync(config, 0o600);
    install(etc);
    assert.equal(mode(directory), 0o700);
    assert.equal(mode(config), 0o600);
    assert.match(fs.readFileSync(config, "utf8"), /mcp_oauth_credentials_store="keyring"/);
    const backups = fs.readdirSync(directory).filter(name => name.startsWith("managed_config.toml.before-aim-"));
    assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(directory, backups[0]), "utf8"), original);
    assert.equal(mode(path.join(directory, backups[0])), 0o600);
    install(etc);
    assert.equal(fs.readdirSync(directory).filter(name => name.includes("before-aim")).length, 1);
  } finally {
    process.umask(previousUmask);
    fs.rmSync(etc, { recursive: true, force: true });
  }
});
