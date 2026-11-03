import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Mac proxy preserves sessions through transient checks, bounds retries, and refuses a changed exit immediately", () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", String.raw`
import contextlib,importlib.util,io,pathlib,subprocess,sys,tempfile,types
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('proxy',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
with tempfile.TemporaryDirectory() as root:
 m.ROOT=pathlib.Path(root);m.state_dir('example').mkdir()
 marker=m.state_dir('example')/'starting'
 clock=[0];calls=[];outcomes=[]
 def check(*args):
  calls.append(clock[0])
  result=outcomes.pop(0) if outcomes else m.TransientProxyError('offline')
  if isinstance(result,Exception):raise result
 def sleep(seconds):clock[0]+=seconds
 with patch.object(m,'check_native_path',check),patch.object(m.time,'monotonic',lambda:clock[0]),patch.object(m.time,'sleep',sleep),contextlib.redirect_stdout(io.StringIO()) as log:
  outcomes[:]=[m.TransientProxyError('timeout'),m.TransientProxyError('DNS'),None]
  m.check_native_path_with_retry('example',{})
  assert calls==[0,2,4] and not marker.exists()
  assert 'recovered; existing sessions preserved' in log.getvalue()
  # Each later outage gets its own bounded window; one successful check resets it.
  calls.clear();clock[0]=100;outcomes[:]=[m.TransientProxyError('offline'),None]
  m.check_native_path_with_retry('example',{})
  assert calls==[100,102] and not marker.exists()
  calls.clear();clock[0]=200
  try:m.check_native_path_with_retry('example',{})
  except RuntimeError as error:assert '60 seconds' in str(error)
  else:raise AssertionError('permanent outage did not stop')
  assert calls[0]==200 and calls[-1]==260 and marker.exists()
  marker.unlink();calls.clear();clock[0]=300;outcomes[:]=[RuntimeError('native route exit mismatch')]
  try:m.check_native_path_with_retry('example',{})
  except RuntimeError as error:assert 'exit mismatch' in str(error)
  else:raise AssertionError('changed exit accepted')
  assert calls==[300] and not marker.exists()

# Exercise curl's actual error classification, including failures that must
# never acquire a connectivity grace period (identity/certificate failures).
config={'uid':501,'gid':64081,'expectedExits':['192.0.2.1']}
with patch.object(m.os,'geteuid',lambda:0),patch.object(m,'lock',lambda *a,**k:contextlib.nullcontext()),patch.object(m,'current_ready',lambda *a,**k:None):
 for failure in [subprocess.TimeoutExpired('curl',8),*[subprocess.CalledProcessError(code,'curl') for code in [5,6,7,18,22,28,35,52,55,56]]]:
  with patch.object(m,'command',side_effect=failure):
   try:m.check_native_path('example',config)
   except m.TransientProxyError:pass
   else:raise AssertionError('connectivity failure not retryable')
 for code in [60,125]:
  with patch.object(m,'command',side_effect=subprocess.CalledProcessError(code,'curl')):
   try:m.check_native_path('example',config)
   except subprocess.CalledProcessError:pass
   else:raise AssertionError('identity/certificate failure retried')
 with patch.object(m,'command',return_value=types.SimpleNamespace(stdout='{"ip":"192.0.2.2"}\n200')):
  try:m.check_native_path('example',config)
  except m.TransientProxyError:raise AssertionError('changed exit retried')
  except RuntimeError:pass
  else:raise AssertionError('changed exit accepted')
print('ok')`, fileURLToPath(new URL("../../native/claude/darwin_proxy.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.trim(), "ok");
});
