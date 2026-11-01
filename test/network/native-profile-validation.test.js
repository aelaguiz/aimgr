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
