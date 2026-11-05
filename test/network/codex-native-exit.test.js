import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("both native monitors accept exactly one approved IPv4 trace line and keep malformed responses fatal", () => {
  const script = `
import importlib.util,sys
for file in sys.argv[1:]:
 spec=importlib.util.spec_from_file_location('route',file);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
 config={'exitCheckFormat':'cloudflare-trace','expectedExits':['192.0.2.1']}
 for body in [b'fl=synthetic\\nip=192.0.2.1\\n',b'ip=192.0.2.1\\r\\n']:
  m.approved_exit(config,body)
 for body in [b'',b'ip=',b'ip=192.0.2.1\\nip=\\n',b'ip=192.0.2.1\\nip=192.0.2.1',b'ip=192.0.2.2',b'ip=::1',b'ip=bad',b'ip=192.0.2.1 extra',b'ip=192.0.2.1\\xff']:
  try:m.approved_exit(config,body)
  except m.TransientProxyError:raise AssertionError('malformed exit received connectivity grace')
  except (ValueError,RuntimeError):pass
  else:raise AssertionError('invalid trace accepted: '+repr(body))
 m.approved_exit({'expectedExits':['192.0.2.1']},b'{"ip":"192.0.2.1"}')
`;
  const files = ["linux_proxy.py", "darwin_proxy.py"].map(name => fileURLToPath(new URL(`../../native/claude/${name}`, import.meta.url)));
  const result = spawnSync("python3", ["-c", script, ...files], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
});
