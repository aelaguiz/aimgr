import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

test("Mac proxy reload replaces monitor code without replacing its PID, adapter, tunnel, or guardian", {
  skip: process.platform !== "darwin", timeout: 20000,
}, () => {
  const result = execFileSync("/usr/bin/python3", ["-I", "-c", String.raw`
import json,os,pathlib,signal,subprocess,sys,tempfile,time
with tempfile.TemporaryDirectory() as folder:
 root=pathlib.Path(folder);state=root/'example-state';state.mkdir()
 (root/'example.lock').touch();(root/'generation').write_text('first')
 (root/'example.json').write_text(json.dumps({'uid':os.getuid(),'gid':65071,'socksPort':1,'interface':'fixture'}))
 tunnel=subprocess.Popen(['/bin/sleep','60']);monitor=None;owners=[]
 # The service lifecycle and kqueue are real. Only network setup and the
 # privileged identity drop are replaced; no installed profile is touched.
 shim='''import importlib.util,json,os,pathlib,select,sys,types
spec=importlib.util.spec_from_file_location('proxy',__MODULE__);m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
m.ROOT=pathlib.Path(__ROOT__);m.SOURCE_REVISION=(m.ROOT/'generation').read_text()
original_run=m.subprocess.run;original_spawn=m.os.posix_spawn
def run(args,**kw):
 if args[0]=='/sbin/ifconfig':return types.SimpleNamespace(stdout='',returncode=0)
 return original_run(args,**kw)
m.subprocess.run=run
m.os.posix_spawn=lambda *args,**kw:original_spawn('/bin/sleep',['/bin/sleep','60'],os.environ)
m.listener_pid=lambda port:__TUNNEL__
m.configure_firewall=lambda *args:None
m.check_native_path_with_retry=lambda *args:None
m.stop=lambda name:(m.ROOT/'stopped').write_text('stopped')
def guardian(name,monitor,adapter,tunnel,fd):
 os.setsid();queue=select.kqueue()
 queue.control([select.kevent(pid,filter=select.KQ_FILTER_PROC,flags=select.KQ_EV_ADD|select.KQ_EV_ONESHOT,fflags=select.KQ_NOTE_EXIT) for pid in [monitor,adapter,tunnel]],0,0)
 os.write(fd,b'1');os.close(fd);queue.control(None,3,None);m.stop(name)
m.guardian=guardian
m.serve('example')
'''.replace('__MODULE__',repr(sys.argv[1])).replace('__ROOT__',repr(str(root))).replace('__TUNNEL__',str(tunnel.pid))
 helper=root/'darwin_proxy.py';helper.write_text(shim)
 def ready(generation):
  deadline=time.monotonic()+8
  while time.monotonic()<deadline:
   if monitor.poll() is not None:raise AssertionError('monitor exited: '+monitor.stderr.read())
   try:
    value=json.loads((state/'ready.json').read_text())
    if value.get('revision')==generation and not (state/'starting').exists():return value
   except (FileNotFoundError,ValueError):pass
   time.sleep(.02)
  raise AssertionError('reload did not finish')
 try:
  monitor=subprocess.Popen(['/usr/bin/python3','-I',str(helper),'serve','example'],stdout=subprocess.DEVNULL,stderr=subprocess.PIPE,text=True)
  before=ready('first');owners=before['owners'];assert before['hotReload']
  (root/'generation').write_text('second');monitor.send_signal(signal.SIGHUP)
  after=ready('second')
  assert after['owners']==before['owners'],(before,after)
  assert not (root/'stopped').exists(),'reload invoked the shutdown path'
  for owner in after['owners']:os.kill(owner['pid'],0)
 finally:
  if monitor and monitor.poll() is None:
   monitor.terminate()
   try:monitor.wait(timeout=3)
   except subprocess.TimeoutExpired:monitor.kill();monitor.wait()
  for owner in owners:
   if owner['role'] in ['adapter','guardian']:
    try:os.kill(owner['pid'],signal.SIGKILL)
    except ProcessLookupError:pass
  tunnel.terminate();tunnel.wait()
print('ok')`, fileURLToPath(new URL("../../native/claude/darwin_proxy.py", import.meta.url))], { encoding: "utf8", timeout: 18000 });
  assert.equal(result.trim(), "ok");
});
