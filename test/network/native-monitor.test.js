import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Mac monitor checks the assigned route with bounded native curl and refuses ambiguous responses", () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", String.raw`
import importlib.util,sys,types,contextlib,subprocess
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('monitor',sys.argv[1]);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
config={'uid':501,'gid':64081,'expectedExits':['192.0.2.1']};events=[]
@contextlib.contextmanager
def locked(*args,**kwargs):
 events.append('lock')
 try:yield
 finally:events.append('unlock')
def ready(*args,**kwargs):
 assert kwargs=={'allow_starting':True};events.append('ready')
response='{"ip":"192.0.2.1"}\n200'
def command(args,**kwargs):
 events.append('command')
 assert events[-3:]==['lock','ready','command']
 assert args[0:2]==['/usr/bin/curl','--disable'] and args[-2:]==['--','https://api.ipify.org?format=json']
 for option,value in [('--proxy',''),('--noproxy','*'),('--proto','=http,https'),('--max-time','6'),('--max-filesize','1024')]:
  assert args[args.index(option)+1]==value
 assert '--location' not in args and '--insecure' not in args
 assert kwargs['timeout']==8 and kwargs['env']=={'PATH':'/usr/bin:/bin'}
 drops=[]
 with patch.object(m.os,'setgroups',lambda v:drops.append(('groups',v))),patch.object(m.os,'setgid',lambda v:drops.append(('gid',v))),patch.object(m.os,'setuid',lambda v:drops.append(('uid',v))),patch.object(m.os,'getuid',lambda:501),patch.object(m.os,'geteuid',lambda:501),patch.object(m.os,'getgid',lambda:64081),patch.object(m.os,'getegid',lambda:64081):
  kwargs['preexec_fn']()
 assert drops==[('groups',[]),('gid',64081),('uid',501)]
 if isinstance(response,Exception):raise response
 return types.SimpleNamespace(stdout=response)
m.lock=locked;m.current_ready=ready;m.command=command
with patch.object(m.os,'geteuid',lambda:0):
 m.check_native_path('example',config)
 for bad in ['{"ip":"192.0.2.2"}\n200','{"ip":"192.0.2.1"}\n302','not-json\n200','{}\n200','{"ip":"192.0.2.1"}',subprocess.TimeoutExpired('curl',8)]:
  response=bad
  try:m.check_native_path('example',config)
  except (RuntimeError,ValueError,subprocess.TimeoutExpired):pass
  else:raise AssertionError('accepted invalid result')
  assert events[-1]=='unlock'
 before=len(events)
 for url in ['file:///etc/passwd','https://user:secret@example.com']:
  try:m.check_native_path('example',{**config,'exitCheckUrl':url})
  except RuntimeError:pass
  else:raise AssertionError('accepted invalid check URL')
 assert len(events)==before
print('ok')`, fileURLToPath(new URL("../../native/claude/darwin_proxy.py", import.meta.url))], { encoding: "utf8" });
  assert.equal(result.trim(), "ok");
});
