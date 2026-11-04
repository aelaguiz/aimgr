import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { execFileSync, spawnSync } from "node:child_process";
import {
  admitClaudeArtifact,
  claudeArtifactSetDigest,
  CLAUDE_PRIVACY_ABI,
} from "../../src/privacy/claude-artifacts.js";

const hash = (value) => crypto.createHash("sha256").update(value).digest("hex");
const inventory = {
  claude: { sha256: hash("never execute this synthetic file\n"), size: 34, executable: true, role: "vendor" },
};

test("artifact inventory hashes are stable across key order and include role/mode/size", () => {
  const a = { ...inventory, policy: { sha256: hash("{}"), size: 2, executable: false, role: "policy" } };
  assert.equal(claudeArtifactSetDigest(a), claudeArtifactSetDigest({ policy: a.policy, claude: a.claude }));
  assert.notEqual(claudeArtifactSetDigest(a), claudeArtifactSetDigest({ ...a, claude: { ...a.claude, executable: false } }));
  assert.notEqual(claudeArtifactSetDigest(a), claudeArtifactSetDigest({ ...a, claude: { ...a.claude, size: 33 } }));
  assert.notEqual(claudeArtifactSetDigest(a), claudeArtifactSetDigest({ ...a, claude: { ...a.claude, role: "resource" } }));
});

test("inventory rejects traversal, ambiguous paths, invalid digests and empty sets", () => {
  for (const name of ["../claude", "/claude", "a//claude", "a/./claude", "a/../claude", "a\\claude"]) {
    assert.throws(() => claudeArtifactSetDigest({ [name]: inventory.claude }), { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED" });
  }
  for (const files of [{}, { claude: { ...inventory.claude, sha256: "unknown" } },
    { claude: { ...inventory.claude, size: -1 } }, { claude: { ...inventory.claude, executable: "true" } }]) {
    assert.throws(() => claudeArtifactSetDigest(files), { code: "AIMGR_CLAUDE_BUILD_NOT_APPROVED" });
  }
});

// These ownership/rename tests use the actual offsite filesystem, not fake uid
// answers. They create only their own synthetic artifacts. Nothing in this test
// executes Claude or grants normal-use approval to a real vendor artifact.
const native = process.env.AIMGR_TEST_CLAUDE_ARTIFACT_FILESYSTEM === "1";
test("administrator-owned artifact admission contracts on the offsite host", { skip: !native }, async (t) => {
  assert.equal(process.getuid(), 0, "fixture setup needs administrator ownership");
  const base = "/opt/aimgr-state-audit";
  assert.ok(fs.existsSync(path.join(base, "OFFSITE_AUDIT_HOST")), "offsite test marker required");
  const hostFile = path.join(base, "CLAUDE_TEST_HOST.json");
  if (!fs.existsSync(hostFile)) {
    fs.writeFileSync(hostFile, JSON.stringify({ schema: 1, token: crypto.randomBytes(32).toString("hex") }), { mode: 0o644, flag: "wx" });
    t.after(() => fs.unlinkSync(hostFile));
  }
  const hostToken = JSON.parse(fs.readFileSync(hostFile, "utf8")).token;
  const parent = fs.mkdtempSync(path.join(base, "claude-artifact-contract-"));
  fs.chmodSync(parent, 0o755);
  fs.writeFileSync(path.join(parent, "package.json"), '{"type":"module"}', { mode: 0o644 });
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const runtimeUser = process.platform === "darwin" ? "ec2-user" : "aimprivacy";
  const uid = Number(execFileSync("/usr/bin/id", ["-u", runtimeUser], { encoding: "utf8" }).trim());
  const gid = Number(execFileSync("/usr/bin/id", ["-g", runtimeUser], { encoding: "utf8" }).trim());
  assert.ok(uid > 0 && gid > 0);
  const moduleFile = path.join(parent, "admission.mjs");
  fs.copyFileSync(new URL("../../src/privacy/claude-artifacts.js", import.meta.url), moduleFile);
  fs.chmodSync(moduleFile, 0o644);
  const sharedAdmission = path.join(parent, "artifact-admission.js");
  fs.copyFileSync(new URL("../../src/privacy/artifact-admission.js", import.meta.url), sharedAdmission);
  fs.chmodSync(sharedAdmission, 0o644);
  const child = (source) => spawnSync(process.execPath, ["--input-type=module", "-e",
    `process.setgroups([]); process.setgid(${gid}); process.setuid(${uid});\n${source}`], { encoding: "utf8" });
  const runtimeAdmission = (root, selectedCommand, pinnedArtifactSet) => child(`
    const { admitClaudeArtifact } = await import(${JSON.stringify(moduleFile)});
    try { console.log(JSON.stringify(admitClaudeArtifact({runtimeRoot: ${JSON.stringify(root)}, selectedCommand: ${JSON.stringify(selectedCommand)}, pinnedArtifactSet: ${JSON.stringify(pinnedArtifactSet)}}))); }
    catch (error) { console.log(JSON.stringify({code:error.code, message:error.message})); process.exitCode=77; }
  `);

  function fixture(name, variant = "", transformInventory = () => {}) {
    const root = path.join(parent, name);
    fs.mkdirSync(root, { mode: 0o755 });
    const bodies = {
      claude: "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE'\n" + variant,
      launcher: "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE-LAUNCHER'\n",
      "policy.json": "{}\n",
      "helpers/worker": "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE-WORKER'\n",
      ...(process.platform === "darwin" ? { security: "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE-ADAPTER'\n" } : {}),
      ...(process.platform === "linux" ? { "validate-settings": "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE-VALIDATOR'\n" } : {}),
    };
    const files = Object.fromEntries(Object.entries(bodies).map(([name, body]) => [name, {
      sha256: hash(body), size: Buffer.byteLength(body), executable: name !== "policy.json",
      role: name === "policy.json" ? "policy" : ["launcher", "validate-settings"].includes(name) ? "launcher" : name === "security" ? "resource" : "vendor",
    }]));
    transformInventory(files);
    const artifactSet = claudeArtifactSetDigest(files);
    const bundle = path.join(root, "artifacts", artifactSet);
    fs.mkdirSync(path.join(bundle, "helpers"), { recursive: true, mode: 0o755 });
    for (const [name, body] of Object.entries(bodies)) {
      fs.writeFileSync(path.join(bundle, name), body, { mode: files[name].executable ? 0o755 : 0o644 });
    }
    if (process.platform === "linux") fs.chmodSync(path.join(bundle, "launcher"), 0o4755);
    const manifest = { schema: 1, platform: process.platform, arch: process.arch, privacyAbi: CLAUDE_PRIVACY_ABI,
      version: "synthetic-no-vendor", reviewedAimRevision: "a".repeat(40), entrypoint: "claude", launcher: "launcher", policy: "policy.json", files,
      ...(process.platform === "darwin" ? { securityAdapter: "security" } : {}),
      approval: { kind: "normal-use", approver: "synthetic-fixture", reference: "no real authorization",
        reviewEvidence: "no real vendor build", approvedAt: "2026-11-01T00:00:00Z" } };
    const approval = path.join(bundle, "approval.json");
    fs.writeFileSync(approval, JSON.stringify(manifest), { mode: 0o644 });
    fs.writeFileSync(path.join(root, "active.json"), JSON.stringify({ schema: 1, artifactSet }), { mode: 0o644 });
    return { root, bundle, manifest, approval, artifactSet };
  }
  const denied = (root) => {
    const result = runtimeAdmission(root);
    assert.equal(result.status, 77, result.stderr || result.stdout);
    assert.equal(JSON.parse(result.stdout).code, "AIMGR_CLAUDE_BUILD_NOT_APPROVED");
  };

  await t.test("fixed platform helper cannot be approved with a nonexecutable or wrong-role inventory", () => {
    const helper = process.platform === "darwin" ? "security" : "validate-settings";
    for (const [name, mutate] of [["nonexecutable", file => { file.executable = false; }],
      ["wrong-role", file => { file.role = "vendor"; }]]) {
      const f = fixture("fixed-helper-" + name, "", files => mutate(files[helper]));
      denied(f.root);
    }
  });

  await t.test("returns one immutable command, matching helper and policy without execution", () => {
    const f = fixture("valid");
    const actual = admitClaudeArtifact({ runtimeRoot: f.root });
    assert.equal(actual.command, path.join(f.bundle, "claude"));
    assert.equal(actual.launcher, path.join(f.bundle, "launcher"));
    assert.equal(actual.policy, path.join(f.bundle, "policy.json"));
    assert.equal(actual.artifactSet, f.artifactSet);
    assert.ok(Object.isFrozen(actual));
    const unprivileged = runtimeAdmission(f.root);
    assert.equal(unprivileged.status, 0, unprivileged.stderr || unprivileged.stdout);
    assert.equal(JSON.parse(unprivileged.stdout).command, actual.command);
  });
  await t.test("explicit selection must contain approved bytes, including through a normal symlink", () => {
    const f = fixture("selection");
    const selected = path.join(f.root, "selected"), alias = path.join(f.root, "alias");
    fs.copyFileSync(path.join(f.bundle, "claude"), selected); fs.chmodSync(selected, 0o755);
    fs.symlinkSync(selected, alias);
    const result = runtimeAdmission(f.root, alias);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const admitted = JSON.parse(result.stdout);
    assert.equal(admitted.command, path.join(f.bundle, "claude"));
    assert.equal(admitted.vendorSha256, f.manifest.files.claude.sha256);
    const bytes = fs.readFileSync(selected); bytes[bytes.length - 2] ^= 1;
    fs.writeFileSync(selected, bytes);
    assert.equal(runtimeAdmission(f.root, alias).status, 77, "same-size byte change must fail digest admission");
    fs.copyFileSync(path.join(f.bundle, "claude"), selected); fs.chmodSync(selected, 0o744);
    assert.equal(runtimeAdmission(f.root, alias).status, 77, "root-only execution must refuse for runtime user");
    fs.chmodSync(selected, 0o755);
    if (process.platform === "darwin") {
      execFileSync("/bin/chmod", ["+a", `user:${runtimeUser} deny execute`, selected]);
      assert.equal(runtimeAdmission(f.root, alias).status, 77, "execution-denying ACL must refuse");
      execFileSync("/bin/chmod", ["-N", selected]);
    }
    assert.equal(runtimeAdmission(f.root, alias).status, 0);
    fs.appendFileSync(selected, "unapproved update");
    assert.equal(runtimeAdmission(f.root, alias).status, 77);
    assert.equal(runtimeAdmission(f.root, "claude").status, 77);
    fs.unlinkSync(selected);
    assert.equal(runtimeAdmission(f.root, alias).status, 77);
  });
  await t.test("refusal compares selected and approved versions without trusting an installation filename", () => {
    const f = fixture("version-diagnostics");
    f.manifest.version = "2.1.316";
    fs.writeFileSync(f.approval, JSON.stringify(f.manifest));
    const selected = path.join(f.root, "2.1.999");
    fs.writeFileSync(selected, "#!/bin/sh\nprintf 'MUST-NOT-EXECUTE'\n# unknown bytes\n", { mode: 0o755 });
    const result = runtimeAdmission(f.root, selected);
    assert.equal(result.status, 77);
    const message = JSON.parse(result.stdout).message;
    assert.match(message, /Selected Claude: 2\.1\.999 \(installation filename; not executed\)/);
    assert.match(message, /Approved Claude for this launch: 2\.1\.316 \(normal-use\)/);
    assert.doesNotMatch(message, /MUST-NOT-EXECUTE/);
    fs.writeFileSync(f.approval, "PRIVATE-CONTENT");
    const broken = runtimeAdmission(f.root, selected);
    assert.equal(broken.status, 77);
    assert.match(JSON.parse(broken.stdout).message, /approval unavailable or invalid/);
    assert.doesNotMatch(broken.stdout, /2\.1\.316|PRIVATE-CONTENT/);
  });
  await t.test("nested pin keeps a still-approved package through activation and rechecks revocation and explicit selection", () => {
    const old = fixture("pinned-old"), next = fixture("pinned-next", "# synthetic newer package\n");
    fs.cpSync(next.bundle, path.join(old.root, "artifacts", next.artifactSet), { recursive: true });
    fs.writeFileSync(path.join(old.root, "active.json"), JSON.stringify({ schema: 1, artifactSet: next.artifactSet }));
    const ordinary = runtimeAdmission(old.root);
    assert.equal(ordinary.status, 0, ordinary.stderr || ordinary.stdout);
    assert.equal(JSON.parse(ordinary.stdout).artifactSet, next.artifactSet);
    const nested = runtimeAdmission(old.root, path.join(old.bundle, "claude"), old.artifactSet);
    assert.equal(nested.status, 0, nested.stderr || nested.stdout);
    assert.equal(JSON.parse(nested.stdout).artifactSet, old.artifactSet);
    assert.equal(runtimeAdmission(old.root, path.join(next.bundle, "claude"), old.artifactSet).status, 77);
    for (const pin of ["unknown", "f".repeat(64), [old.artifactSet]]) {
      assert.equal(runtimeAdmission(old.root, undefined, pin).status, 77);
    }
    fs.writeFileSync(path.join(old.root, "active.json"), JSON.stringify({ schema: 1, artifactSet: [next.artifactSet] }));
    assert.equal(runtimeAdmission(old.root, undefined, old.artifactSet).status, 77, "a valid pin cannot excuse a malformed active selector");
    fs.writeFileSync(path.join(old.root, "active.json"), JSON.stringify({ schema: 1, artifactSet: next.artifactSet }));
    fs.unlinkSync(old.approval);
    assert.equal(runtimeAdmission(old.root, undefined, old.artifactSet).status, 77, "revoked approval cannot be borrowed from the new active set");
  });
  for (const [name, mutate] of [
    ["unknown active digest", f => fs.writeFileSync(path.join(f.root, "active.json"), JSON.stringify({ schema: 1, artifactSet: "f".repeat(64) }))],
    ["corrupt approval", f => fs.writeFileSync(f.approval, "broken PRIVATE-CONTENT")],
    ["missing approval", f => fs.unlinkSync(f.approval)],
    ["extra unapproved resource", f => fs.writeFileSync(path.join(f.bundle, "extra.js"), "code")],
    ["changed binary same display version", f => fs.appendFileSync(path.join(f.bundle, "claude"), "changed")],
    ["changed helper", f => fs.appendFileSync(path.join(f.bundle, "helpers/worker"), "changed")],
    ["missing helper", f => fs.unlinkSync(path.join(f.bundle, "helpers/worker"))],
    ["changed policy", f => fs.writeFileSync(path.join(f.bundle, "policy.json"), "[]\n")],
    ["non-executable binary", f => fs.chmodSync(path.join(f.bundle, "claude"), 0o644)],
    ["root-only executable binary", f => fs.chmodSync(path.join(f.bundle, "claude"), 0o744)],
    ["setuid runtime", f => fs.chmodSync(path.join(f.bundle, "claude"), 0o4755)],
    ["setgid launcher", f => fs.chmodSync(path.join(f.bundle, "launcher"), 0o6755)],
    ["setuid extra helper", f => fs.chmodSync(path.join(f.bundle, "helpers/worker"), 0o4755)],
    ["wrong launcher privilege", f => fs.chmodSync(path.join(f.bundle, "launcher"), process.platform === "linux" ? 0o755 : 0o4755)],
    ["writable approval", f => fs.chmodSync(f.approval, 0o666)],
    ["writable parent", f => fs.chmodSync(path.join(f.root, "artifacts"), 0o777)],
    ["runtime-owned ancestor", f => fs.chownSync(f.bundle, 65534, 65534)],
    ["runtime-owned binary", f => fs.chownSync(path.join(f.bundle, "claude"), 65534, 65534)],
    ["hardlinked runtime", f => fs.linkSync(path.join(f.bundle, "claude"), path.join(f.root, "alias"))],
    ["symlinked binary", f => { fs.renameSync(path.join(f.bundle, "claude"), path.join(f.root, "outside")); fs.symlinkSync(path.join(f.root, "outside"), path.join(f.bundle, "claude")); }],
    ["symlinked selector", f => { fs.renameSync(path.join(f.root, "active.json"), path.join(f.root, "other.json")); fs.symlinkSync("other.json", path.join(f.root, "active.json")); }],
    ["symlinked parent", f => { fs.renameSync(f.bundle, path.join(f.root, "outside")); fs.symlinkSync(path.join(f.root, "outside"), f.bundle); }],
  ]) {
    await t.test(name, () => { const f = fixture(name.replaceAll(" ", "-")); mutate(f); denied(f.root); });
  }
  if (process.platform === "darwin") {
    const acl = (file, rights) => execFileSync("/bin/chmod", ["+a", `user:${runtimeUser} ${rights}`, file]);
    await t.test("directory ACL permits replacement although W_OK denies it", () => {
      const f = fixture("acl-replacement");
      acl(f.bundle, "allow add_file,delete_child");
      const mutation = child(`
        const fs = await import('node:fs');
        const dir = ${JSON.stringify(f.bundle)};
        let denied = false; try { fs.accessSync(dir, fs.constants.W_OK); } catch { denied = true; }
        if (!denied) throw Error('positive control must bypass W_OK');
        fs.unlinkSync(dir+'/policy.json'); fs.writeFileSync(dir+'/policy.json', 'replaced');
      `);
      assert.equal(mutation.status, 0, mutation.stderr);
      // Restore root ownership and exact content: the refusal must come from
      // the vulnerable ancestor ACL, not changed content or leaf ownership.
      fs.unlinkSync(path.join(f.bundle, "policy.json"));
      fs.writeFileSync(path.join(f.bundle, "policy.json"), "{}\n", { mode: 0o644 });
      denied(f.root);
    });
    await t.test("writesecurity ACL permits granting later write access", () => {
      const f = fixture("acl-security");
      const file = path.join(f.bundle, "policy.json");
      acl(file, "allow writesecurity");
      denied(f.root);
      const mutation = child(`
        const {execFileSync} = await import('node:child_process');
        execFileSync('/bin/chmod', ['+a', ${JSON.stringify(`user:${runtimeUser} allow write`)}, ${JSON.stringify(file)}]);
        const fs = await import('node:fs'); fs.writeFileSync(${JSON.stringify(file)}, 'changed');
      `);
      assert.equal(mutation.status, 0, mutation.stderr);
    });
    await t.test("append-only ACL permits modifying a policy", () => {
      const f = fixture("acl-append");
      const file = path.join(f.bundle, "policy.json");
      acl(file, "allow append");
      denied(f.root);
      const mutation = child(`const fs = await import('node:fs'); fs.appendFileSync(${JSON.stringify(file)}, 'changed');`);
      assert.equal(mutation.status, 0, mutation.stderr);
    });
    await t.test("an unreadable ACL cannot be mistaken for absent permissions", () => {
      const f = fixture("acl-unreadable");
      const file = path.join(f.bundle, "policy.json");
      acl(file, "deny readsecurity");
      acl(file, "allow append");
      // Darwin lstat itself requires READ_SECURITY. Establish that this OS
      // refuses inspection before trusting ls, which can omit unreadable ACLs.
      const mutation = child(`
        const fs = await import('node:fs');
        let refused = false; try { fs.lstatSync(${JSON.stringify(file)}); }
        catch(e) { if (!['EACCES','EPERM'].includes(e.code)) throw e; refused = true; }
        if (!refused) throw Error('unreadable ACL must fail lstat');
        fs.appendFileSync(${JSON.stringify(file)}, 'changed');
      `);
      assert.equal(mutation.status, 0, mutation.stderr);
      // Restore content without replacing the inode/ACL.
      fs.writeFileSync(file, "{}\n");
      denied(f.root);
    });
    await t.test("ACL can deny execution despite executable mode bits", () => {
      const f = fixture("acl-execution");
      acl(path.join(f.bundle, "claude"), "deny execute");
      denied(f.root);
    });
    await t.test("read-only allow ACL and deny ACL remain admissible", () => {
      const f = fixture("acl-readonly");
      acl(path.join(f.bundle, "policy.json"), "allow read,readattr,readsecurity");
      acl(f.bundle, "deny delete");
      const result = runtimeAdmission(f.root);
      assert.equal(result.status, 0, result.stderr || result.stdout);
    });
  }
  for (const [name, mutate] of [
    ["different platform", m => { m.platform = "unsupported"; }],
    ["different architecture", m => { m.arch = "unsupported"; }],
    ["different privacy ABI", m => { m.privacyAbi = "unreviewed"; }],
    ["missing human approval", m => { delete m.approval; }],
    ["offsite approval is not normal-use approval", m => { m.approval.kind = "offsite-test"; }],
    ["review alone is not approval", m => { m.approval.kind = "reviewed"; }],
    ["absent review evidence", m => { delete m.approval.reviewEvidence; }],
    ["invalid approval date", m => { m.approval.approvedAt = "later"; }],
    ["unapproved entrypoint", m => { m.entrypoint = "helpers/missing"; }],
  ]) {
    await t.test(name, () => { const f = fixture(name.replaceAll(" ", "-")); mutate(f.manifest); fs.writeFileSync(f.approval, JSON.stringify(f.manifest)); denied(f.root); });
  }
  await t.test("safe errors do not echo malformed approval content", () => {
    const f = fixture("private-error");
    fs.writeFileSync(f.approval, "PRIVATE-CONTENT");
    assert.throws(() => admitClaudeArtifact({ runtimeRoot: f.root }), error => !String(error).includes("PRIVATE-CONTENT"));
  });
  await t.test("offsite authorization binds the exact candidate to this enrolled host for a bounded time", () => {
    const f = fixture("offsite-authorized");
    f.manifest.candidateSourceSha256 = "b".repeat(64);
    f.manifest.approval = { kind: "offsite-test", normalUseApproved: false, reference: "synthetic authorization only" };
    fs.writeFileSync(f.approval, JSON.stringify(f.manifest));
    const file = path.join(f.root, "offsite-test.json");
    denied(f.root);
    const authorization = { schema: 1, artifactSet: f.artifactSet, platform: process.platform, arch: process.arch,
      normalUseApproved: false, hostTokenSha256: hash(hostToken), reference: "synthetic authorization only",
      authorizedAt: new Date(Date.now() - 1000).toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() };
    fs.writeFileSync(file, JSON.stringify(authorization), { mode: 0o644 });
    const valid = runtimeAdmission(f.root);
    assert.equal(valid.status, 0, valid.stderr || valid.stdout);
    const result = JSON.parse(valid.stdout);
    assert.equal(result.approvalKind, "offsite-test");
    assert.doesNotMatch(valid.stdout, new RegExp(hostToken + "|" + hash(hostToken)));
    for (const update of [
      { artifactSet: "f".repeat(64) }, { platform: "other" }, { arch: "other" },
      { hostTokenSha256: "f".repeat(64) }, { reference: "" }, { normalUseApproved: true },
      { authorizedAt: "invalid" }, { expiresAt: "invalid" }, { expiresAt: new Date(0).toISOString() },
      { authorizedAt: new Date(Date.now() + 60000).toISOString() },
      { expiresAt: new Date(Date.now() + 8 * 86400000).toISOString() },
    ]) {
      fs.writeFileSync(file, JSON.stringify({ ...authorization, ...update }));
      denied(f.root);
    }
    fs.writeFileSync(file, JSON.stringify(authorization));
    fs.chmodSync(file, 0o666); denied(f.root); fs.chmodSync(file, 0o644);
    fs.appendFileSync(path.join(f.bundle, "claude"), "changed"); denied(f.root);
  });
});
