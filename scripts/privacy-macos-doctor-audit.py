#!/usr/bin/env python3
"""Trace Codex doctor's desktop-ID lookup using only synthetic desktop state.

Run on the disposable rented Mac behind its independent outbound deny boundary.
The local TLS proxy never forwards a request. Its temporary CA is trusted only
by this child through CODEX_CA_CERTIFICATE, never installed into an OS keychain.
Two HOME fixtures share one CODEX_HOME, separating the two lookup roots.
"""
import argparse
import json
import os
from pathlib import Path
import platform
import plistlib
import socketserver
import ssl
import subprocess
import threading
from urllib.parse import parse_qs,urlsplit

p=argparse.ArgumentParser();p.add_argument('--root',required=True);p.add_argument('--codex',required=True);a=p.parse_args()
root=Path(a.root).resolve()
if platform.system()!='Darwin' or not Path('/opt/aimgr-state-audit/OFFSITE_AUDIT_HOST').is_file() or not str(root).startswith('/opt/aimgr-state-audit/'):
    raise SystemExit('Disposable offsite Mac and isolated root required')
if root.exists() and any(root.iterdir()):raise SystemExit('Refusing reused fixture root')
os.umask(0o077);root.mkdir(parents=True,exist_ok=True)
config=root/'tls.cnf'
config.write_text('''[req]
distinguished_name=dn
x509_extensions=ext
prompt=no
[dn]
CN=privacy-audit-loopback
[ext]
basicConstraints=critical,CA:TRUE
subjectAltName=DNS:chatgpt.com,DNS:api.openai.com,DNS:api.github.com,DNS:formulae.brew.sh,DNS:persistent.oaistatic.com
''')
def openssl(*argv):
    subprocess.run(['/usr/bin/openssl',*argv],check=True,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
openssl('req','-x509','-newkey','rsa:2048','-nodes','-days','1','-config',str(config),'-keyout',str(root/'ca-key.pem'),'-out',str(root/'ca.pem'))
openssl('req','-new','-newkey','rsa:2048','-nodes','-subj','/CN=chatgpt.com','-keyout',str(root/'key.pem'),'-out',str(root/'leaf.csr'))
leaf=root/'leaf.cnf'
leaf.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=DNS:chatgpt.com,DNS:api.openai.com,DNS:api.github.com,DNS:formulae.brew.sh,DNS:persistent.oaistatic.com\n')
openssl('x509','-req','-in',str(root/'leaf.csr'),'-CA',str(root/'ca.pem'),'-CAkey',str(root/'ca-key.pem'),'-CAcreateserial','-days','1','-extfile',str(leaf),'-out',str(root/'cert.pem'))
context=ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER);context.load_cert_chain(str(root/'cert.pem'),str(root/'key.pem'))
records=[]
class Proxy(socketserver.BaseRequestHandler):
    def handle(self):
        sock=self.request;sock.settimeout(8)
        def headers(stream):
            data=b''
            while b'\r\n\r\n' not in data and len(data)<65536:
                chunk=stream.recv(1)
                if not chunk:break
                data+=chunk
            return data.decode(errors='replace')
        try:
            outer=headers(sock);first=outer.split('\r\n')[0]
            if first.startswith('CONNECT '):
                host=first.split()[1]
                sock.sendall(b'HTTP/1.1 200 Connection Established\r\n\r\n')
                sock=context.wrap_socket(sock,server_side=True)
                inner=headers(sock);line=inner.split('\r\n')[0]
                parts=line.split()
                if len(parts)<2:return
                target='https://'+host+parts[1]
            else:
                inner=outer;parts=first.split()
                if len(parts)<2:return
                target=parts[1]
            records.append({'target':target,'requestHeaders':inner})
            body=b'{}'
            sock.sendall(b'HTTP/1.1 404 Not Found\r\nContent-Type: application/json\r\nContent-Length: 2\r\nConnection: close\r\n\r\n'+body)
        except (OSError,ssl.SSLError):pass
        finally:sock.close()
class Server(socketserver.ThreadingTCPServer):
    daemon_threads=True
server=Server(('127.0.0.1',0),Proxy)
threading.Thread(target=server.serve_forever,daemon=True).start()
app=root/'codex-home';app.mkdir()
(app/'config.toml').write_text('cli_auth_credentials_store="file"\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n')
results=[]
for label in ['a','b']:
    home=root/('os-home-'+label);home.mkdir()
    bundle=home/'Applications/Codex.app/Contents';bundle.mkdir(parents=True)
    (bundle/'Info.plist').write_bytes(plistlib.dumps({'CFBundleIdentifier':'com.openai.codex','CFBundleShortVersionString':'1.0.0','CFBundleVersion':'1'}))
    support=home/'Library/Application Support/com.openai.codex';support.mkdir(parents=True)
    canary='SYNTHETIC-DESKTOP-INSTALLATION-'+label.upper()
    (support/'production-appcast-bootstrap.json').write_text(json.dumps({'backendAppcastEnabled':True,'installationId':canary}))
    proxy='http://127.0.0.1:'+str(server.server_address[1])
    env={'PATH':'/usr/bin:/bin:/usr/sbin:/sbin','HOME':str(home),'CODEX_HOME':str(app),'TERM':'dumb',
         'HTTPS_PROXY':proxy,'HTTP_PROXY':proxy,'ALL_PROXY':proxy,'CODEX_CA_CERTIFICATE':str(root/'ca.pem')}
    start=len(records)
    with (root/('doctor-'+label+'.stdout')).open('w') as out,(root/('doctor-'+label+'.stderr')).open('w') as err:
        try:run=subprocess.run([a.codex,'doctor','--json'],cwd=root,env=env,stdout=out,stderr=err,timeout=45);code=run.returncode
        except subprocess.TimeoutExpired:code='timeout'
    captures=records[start:]
    appcasts=[r['target'] for r in captures if '/wham/app/appcast?' in r['target']]
    passed=any(parse_qs(urlsplit(url).query).get('installation_id')==[canary] for url in appcasts)
    results.append({'case':label,'doctorExit':code,'requestsCaptured':len(captures),'appcastRequests':appcasts,'passed':passed})
server.shutdown();server.server_close()
(root/'requests.private.json').write_text(json.dumps(records,indent=2)+'\n')
report={'allPassed':all(r['passed'] for r in results),'results':results,
        'meaning':('The CLI sent each synthetic HOME desktop ID despite an unchanged CODEX_HOME and telemetry opt-out; HTTP requests terminated at the loopback test server.'
                   if all(r['passed'] for r in results) else 'The fixture did not establish transmission; inspect doctor output and trace before drawing a conclusion.')}
(root/'doctor-result.json').write_text(json.dumps(report,indent=2)+'\n')
print(json.dumps(report),flush=True)
raise SystemExit(0 if report['allPassed'] else 1)
