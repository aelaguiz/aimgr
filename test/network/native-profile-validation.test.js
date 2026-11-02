import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("native installers reject profile names that collide with generated files", () => {
  for (const [file, method] of [["linux_proxy.py", "validate_name"], ["darwin_proxy.py", "validate"]]) {
    const result = execFileSync("/usr/bin/python3", ["-I", "-c", `import runpy,sys,json
validate=runpy.run_path(sys.argv[1])[sys.argv[2]]
for name in ['manifest','install','a-sing-box','a'*129,'../bad','direct','default']:
 try: validate(name)
 except (ValueError,RuntimeError): pass
 else: raise AssertionError(name)
assert validate('proxy5')=='proxy5'
assert validate('a'*128)=='a'*128
print('ok')`, fileURLToPath(new URL(`../../native/claude/${file}`, import.meta.url)), method], { encoding: "utf8" });
    assert.equal(result.trim(), "ok");
  }
});

test("macOS root route-state publication never writes or chmods symlink targets", () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", `import runpy,sys,tempfile,pathlib,os,stat
publish=runpy.run_path(sys.argv[1])['publish_state']
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder)
 victim=root/'private';victim.write_text('keep private');victim.chmod(0o600)
 for name,contents,mode in [('starting','',0o600),('ready.json','{"owners":[]}',0o644)]:
  destination=root/name;destination.symlink_to(victim)
  publish(destination,contents,mode)
  assert not destination.is_symlink() and destination.read_text()==contents
  assert stat.S_IMODE(destination.stat().st_mode)==mode
  assert victim.read_text()=='keep private' and stat.S_IMODE(victim.stat().st_mode)==0o600
 # Replace the public pathname during the permission-setting operation. The
 # root-equivalent writer must act on its open inode, never this replacement.
 original=os.fchmod
 def swap(fd,mode):
  destination.unlink();destination.symlink_to(victim)
  original(fd,mode)
 os.fchmod=swap
 publish(destination,'new owners',0o644)
 os.fchmod=original
 assert destination.read_text()=='new owners' and not destination.is_symlink()
 assert victim.read_text()=='keep private' and stat.S_IMODE(victim.stat().st_mode)==0o600
 assert not list(root.glob('.publish-*'))
print('ok')`, fileURLToPath(new URL("../../native/claude/darwin_proxy.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.trim(), "ok");
});
