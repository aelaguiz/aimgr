#!/usr/bin/env python3
"""Offsite synthetic Codex standalone compatibility experiment, not a launcher.

The user authorized testing the named official candidate, not normal-use build
approval. Linux must have only loopback; a rented Mac needs its independently
verified outbound deny policy. No account, Redis, browser or personal home is used.
Model-selected tool calls execute in the official binary; the model is a fixture.
"""
import argparse
import base64
import concurrent.futures
import ctypes
import fcntl
import hashlib
import http.server
import json
import os
from pathlib import Path
import platform
import pty
import re
import select
import shlex
import shutil
import signal
import socket
import ssl
import struct
import subprocess
import sys
import termios
import threading
import time


def mcp_result(request, transport):
    method = request.get('method')
    if method == 'initialize':
        return {'protocolVersion': request['params']['protocolVersion'],
                'capabilities': {'tools': {}, 'resources': {}},
                'serverInfo': {'name': 'standalone-' + transport, 'version': '1'}}
    if method == 'tools/list':
        return {'tools': [{'name': 'echo', 'description': 'Return the synthetic test marker',
                          'inputSchema': {'type': 'object', 'properties': {'text': {'type': 'string'}},
                                          'required': ['text']}}]}
    if method == 'tools/call':
        return {'content': [{'type': 'text', 'text': 'MCP_' + transport.upper() + '_RESULT:' +
                             request['params']['arguments']['text']}], 'isError': False}
    if method == 'resources/list':
        return {'resources': [{'uri': 'audit://proof', 'name': 'proof', 'mimeType': 'text/plain'}]}
    if method == 'resources/read':
        return {'contents': [{'uri': 'audit://proof', 'mimeType': 'text/plain', 'text': 'MCP_RESOURCE_PROOF'}]}
    if method == 'resources/templates/list':
        return {'resourceTemplates': []}
    if method == 'prompts/list':
        return {'prompts': []}
    return {}


if '--mcp-stdio' in sys.argv:
    # This branch runs only as an explicitly configured synthetic MCP child.
    for line in sys.stdin:
        item = json.loads(line)
        if 'id' in item:
            print(json.dumps({'jsonrpc': '2.0', 'id': item['id'], 'result': mcp_result(item, 'stdio')}), flush=True)
    sys.exit(0)

parser = argparse.ArgumentParser()
parser.add_argument('--root', required=True)
parser.add_argument('--codex', required=True)
parser.add_argument('--sha256', required=True)
parser.add_argument('--aim-root')
parser.add_argument('--aim-cli', action='store_true')
parser.add_argument('--phase', choices=['exec', 'tui', 'tui-edits', 'concurrent-tui', 'features', 'continuity', 'rotation', 'lifetime', 'routine', 'daemon', 'required-failure', 'all'], default='all')
parser.add_argument('--terminal-input', action='store_true')
parser.add_argument('--prepare-database', action='store_true')
parser.add_argument('--shared-database', action='store_true')
parser.add_argument('--sandbox-profile')
parser.add_argument('--mcp-auth', action='store_true')
args = parser.parse_args()
if args.aim_cli and (not args.aim_root or args.phase in ['daemon', 'routine'] or args.sandbox_profile):
    raise SystemExit('AIM CLI mode requires --aim-root and a direct workflow phase without an extra sandbox wrapper.')
if args.phase == 'rotation' and not args.aim_cli:
    raise SystemExit('Rotation requires the actual AIM CLI driver.')
if args.phase == 'tui-edits' and not args.aim_cli:
    raise SystemExit('Native settings reconciliation requires the actual AIM CLI driver.')
node = shutil.which('node') if args.aim_cli else None
if args.aim_cli and not node:
    raise SystemExit('AIM CLI integration requires the isolated host Node runtime.')
harness_digest = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
root = Path(args.root).resolve()
base = Path('/opt/aimgr-state-audit')
if root.parent != base or not (base / 'OFFSITE_AUDIT_HOST').is_file():
    raise SystemExit('Requires the marked disposable offsite host and an immediate child fixture root.')
if platform.system() == 'Linux' and [name for _, name in socket.if_nameindex()] != ['lo']:
    raise SystemExit('Linux requires a fresh loopback-only network namespace.')
binary = Path(args.codex).resolve()
digest = hashlib.sha256(binary.read_bytes()).hexdigest()
if digest != args.sha256:
    raise SystemExit('Candidate differs from the exact artifact authorized for this test.')
helper = binary.with_name('codex-code-mode-host')
helper_digest = hashlib.sha256(helper.read_bytes()).hexdigest()
expected_helper = {'Linux': '657f4e902726e05867c937b583049d5997e057f8cd0ab40450633c9c9ef8d630',
                   'Darwin': 'fd37051bfdce0b65cf22a7077e265720a7bd6709d5e400dcbc26197f3041400a'}
if helper_digest != expected_helper[platform.system()]:
    raise SystemExit('This fixture requires the matching reviewed official code-mode helper.')
if root.exists() and any(root.iterdir()):
    raise SystemExit('Refusing reused fixture root.')
root.mkdir(mode=0o700, exist_ok=True)
os.umask(0o077)
project = root / 'project'
project.mkdir()
subprocess.run(['git', 'init', '-q', str(project)], check=True)
(project / 'README.md').write_text('Synthetic standalone test; no personal data.\n')
skill = project / '.agents/skills/privacy-proof/SKILL.md'
skill.parent.mkdir(parents=True)
skill.write_text('---\nname: privacy-proof\ndescription: SKILL_DISCOVERY_CANARY. Use for the synthetic standalone test.\n---\nSKILL_CONTENT_CANARY. Run the configured MCP echo tools and native shell proof.\n')
homes = {}
aim_prepared = {}
requests = []
states = {}
tool_sets = {}
state_lock = threading.Lock()
barrier = threading.Barrier(3)
children = []
daemon_listeners = []
daemon_socket_paths = []
daemon_connections = []
observed_descendants = {}
open_ptys = []
sibling_ready = threading.Event()
sibling_release = threading.Event()
image_digests = {}


def process_table():
    result = subprocess.run(['/bin/ps', '-axo', 'pid=,ppid=,stat=,command='], capture_output=True, text=True, check=True)
    return {int(parts[0]): {'parent': int(parts[1]), 'state': parts[2], 'command': parts[3]}
            for line in result.stdout.splitlines() if len(parts := line.split(None, 3)) == 4}


def observe_descendants():
    table = process_table()
    owned = set(children)
    while True:
        added = {pid for pid, row in table.items() if row['parent'] in owned} - owned
        if not added:
            break
        owned.update(added)
    for pid in owned:
        if pid in table:
            observed_descendants[pid] = table[pid]


def observe_vendor_confinement():
    """Inspect actual survivor images and their kernel boundary, before cleanup."""
    observe_descendants()
    table = process_table()
    result = []
    for pid in observed_descendants:
        if pid not in table or table[pid]['state'].startswith('Z'):
            continue
        try:
            if platform.system() == 'Linux':
                # The privileged launcher intentionally makes native processes
                # nondumpable. Observe only this owned PID's executable/profile
                # as root rather than changing that production protection.
                probe = subprocess.run(['sudo', '-n', '/usr/bin/python3', '-I', '-c',
                    'import json,os,sys; from pathlib import Path; p="/proc/"+sys.argv[1]; '
                    'print(json.dumps({"image":os.readlink(p+"/exe"),"profile":Path(p+"/attr/current").read_text().strip()}))',
                    str(pid)], capture_output=True, text=True)
                if probe.returncode:
                    if pid not in process_table() or process_table()[pid]['state'].startswith('Z'):
                        continue
                    raise RuntimeError('Cannot independently observe a live owned process boundary.')
                observed = json.loads(probe.stdout)
                image = Path(observed['image'])
            else:
                libproc = ctypes.CDLL('/usr/lib/libproc.dylib', use_errno=True)
                buffer = ctypes.create_string_buffer(4096)
                if libproc.proc_pidpath(pid, buffer, len(buffer)) <= 0:
                    raise ProcessLookupError(pid)
                image = Path(os.fsdecode(buffer.value))
            if image.name not in ['codex', 'codex-code-mode-host']:
                continue  # AIM and ordinary background tools have separate lifetimes.
            stat = image.stat()
            key = (str(image), stat.st_ino, stat.st_mtime_ns, stat.st_size)
            if key not in image_digests:
                image_digests[key] = hashlib.sha256(image.read_bytes()).hexdigest()
            approved = image_digests[key] == (digest if image.name == 'codex' else helper_digest)
            if platform.system() == 'Linux':
                boundary = observed['profile']
                confined = bool(re.fullmatch(r'aim-codex-p-\d+-[0-9a-f]+ \(enforce\)', boundary))
            else:
                sandbox = ctypes.CDLL('/usr/lib/libSystem.B.dylib', use_errno=True)
                target = os.fsencode(str(homes['A'][0] / '.ssh/private-canary'))
                # The same kernel query must permit this unrestricted fixture.
                if sandbox.sandbox_check(os.getpid(), b'file-read-data', 1, target) != 0:
                    raise RuntimeError('Sandbox observation control did not permit the fixture read.')
                boundary = sandbox.sandbox_check(pid, b'file-read-data', 1, target)
                confined = boundary == 1
            result.append({'pid': pid, 'image': str(image), 'approved': approved,
                           'kernelBoundary': boundary, 'confined': confined})
        except (FileNotFoundError, ProcessLookupError):
            continue  # A process that exited during observation cannot survive.
    if any(not row['approved'] or not row['confined'] for row in result):
        raise RuntimeError('A live native vendor image lost its admitted image or kernel confinement.')
    return result


def names(tools, namespace=None):
    for tool in tools:
        if tool.get('type') == 'namespace':
            yield from names(tool.get('tools', []), tool.get('name'))
        elif tool.get('name'):
            yield namespace, tool['name'], tool


def events(body, case_hint=None):
    content = json.dumps(body)
    # Current models place tool definitions in additional_tools input items.
    # Prewarming and title generation are separate requests, not test turns.
    if body.get('generate') is False:
        response = {'id': 'resp_warmup', 'object': 'response', 'status': 'completed', 'output': []}
        return [{'type': 'response.created', 'response': dict(response, status='in_progress')},
                {'type': 'response.completed', 'response': response}]
    title_request = body.get('text', {}).get('format', {}).get('name') == 'codex_output_schema'
    cases = [match.group(1) for item in body.get('input', []) if item.get('type') == 'message' and item.get('role') == 'user'
             for part in item.get('content', []) if isinstance(part, dict)
             for match in [re.match(r'PROBE_CASE:([A-Za-z0-9_]+)', part.get('text', ''))] if match]
    # Native collaboration delivers the child's task as agent_message content.
    # Our synthetic endpoint sees its literal marker in encrypted_content; no
    # production encrypted payload or account state is read by this fixture.
    cases.extend(match.group(1) for item in body.get('input', []) if item.get('type') == 'agent_message'
                 and item.get('recipient') == '/root/privacy_child'
                 for part in item.get('content', []) if isinstance(part, dict)
                 for match in [re.match(r'PROBE_CASE:([A-Za-z0-9_]+)', part.get('encrypted_content', part.get('text', '')))] if match)
    previous = re.match(r'resp_(.+)_\d+$', str(body.get('previous_response_id', '')))
    case = 'TITLE' if title_request else cases[-1] if cases else previous.group(1) if previous else case_hint or 'unknown'
    with state_lock:
        state = states.setdefault(case, {'count': 0, 'calls': [], 'toolNames': [], 'skillSeen': False,
                                        'stdioReturned': False, 'httpReturned': False, 'shellReturned': False})
        first = state['count'] == 0
        state['count'] += 1
        if first:
            state['firstRequestSkillLoaded'] = 'SKILL_CONTENT_CANARY' in content
            state['priorSeedResponsePresent'] = 'STANDALONE_DONE:SEED' in content
        state['skillSeen'] |= 'SKILL_CONTENT_CANARY' in content
        definitions = list(body.get('tools', []))
        for item in body.get('input', []):
            if item.get('type') == 'additional_tools':
                definitions.extend(item.get('tools', []))
        if definitions:
            tool_sets[case] = list(names(definitions))
        available = tool_sets.get(case, [])
        executor = next((t for t in available if t[0] == 'functions' and t[1] == 'exec'), None)
        state['toolNames'] = [(ns or '') + '/' + name for ns, name, _ in available]
        outputs = '\n'.join(str(i.get('output', '')) for i in body.get('input', [])
                            if isinstance(i, dict) and i.get('type') in ['function_call_output', 'custom_tool_call_output'])
        for key, marker in [('stdioReturned', 'MCP_STDIO_RESULT:'), ('httpReturned', 'MCP_HTTP_RESULT:'),
                            ('shellReturned', 'SHELL_PROOF:')]:
            state[key] |= marker + case in outputs
        if 'MCP_RESOURCE_PROOF' in outputs:
            state['resourceReturned'] = True
        if 'SUBAGENT_DONE' in outputs:
            state['subagentReturned'] = True
        for item in body.get('input', []):
            if isinstance(item, dict) and item.get('type') == 'function_call_output':
                match = re.search(r'"(?:agent_id|task_name)"\s*:\s*"([^"]+)"', str(item.get('output', '')))
                if match:
                    state['agentId'] = match.group(1)
        # New collaboration sends the completed child's message as an injected
        # developer message, rather than putting it inside wait_agent's result.
        state['subagentReturned'] = state.get('subagentReturned', False) or any(
            (item.get('type') == 'agent_message' or item.get('type') == 'message' and item.get('role') == 'developer') and
            'Message Type: FINAL_ANSWER' in json.dumps(item) and 'SUBAGENT_DONE' in json.dumps(item)
            for item in body.get('input', []))
    if first and case in ['A1', 'A2', 'B1']:
        try:
            barrier.wait(timeout=35)
        except threading.BrokenBarrierError:
            state['barrierFailed'] = True
    if first and case == 'SIBLING':
        sibling_ready.set()
        if not sibling_release.wait(timeout=60):
            raise RuntimeError('Owner-death sibling barrier was not released.')
    selected = None
    parameters = None
    executor_code = None
    for transport in ['stdio', 'http']:
        if not state[transport + 'Returned']:
            selected = next((t for t in available if transport in ((t[0] or '') + t[1]) and t[1].endswith('echo')), None)
            if selected:
                parameters = {'text': case}
                break
            if executor:
                selected = executor
                executor_code = ('const t = ALL_TOOLS.find(t => t.name.includes(' + json.dumps(transport) +
                                 ') && t.name.endsWith("echo")); if (!t) throw new Error("MCP missing"); '
                                 'text(await tools[t.name](' + json.dumps({'text': case}) + '));')
                break
    if selected is None and not state['shellReturned']:
        selected = next((t for t in available if t[1] == 'exec_command'), None)
        command = 'cat ' + shlex.quote(str(skill)) + '; printf %s ' + shlex.quote('SHELL_PROOF:' + case) + ' > ' + shlex.quote(str(project / (case + '.txt'))) + '; cat ' + shlex.quote(str(project / (case + '.txt')))
        parameters = {'cmd': command, 'login': False, 'yield_time_ms': 1000, 'max_output_tokens': 700}
        if selected is None and executor:
            selected = executor
            executor_code = 'text(await tools.exec_command(' + json.dumps(parameters) + '));'
    if selected is None and case in ['OWNER', 'KILLED'] and not state.get('backgroundIssued'):
        code = ('import os,time; from pathlib import Path; p=Path(' + repr(str(root / (case + '.heartbeat'))) + '); '
                'p.with_suffix(".pid").write_text(str(os.getpid())); '
                'exec("while True:\\n p.write_text(str(time.monotonic()))\\n time.sleep(.1)")')
        parameters = {'cmd': '/usr/bin/python3 -c ' + shlex.quote(code), 'login': False, 'yield_time_ms': 1000, 'max_output_tokens': 400}
        selected = next((t for t in available if t[1] == 'exec_command'), None)
        if selected is None and executor:
            selected = executor
            executor_code = 'text(await tools.exec_command(' + json.dumps(parameters) + '));'
        state['backgroundIssued'] = True
    if selected is None and case == 'FEATURES' and not state.get('resourceReturned'):
        selected = next((t for t in available if t[1] == 'read_mcp_resource'), None)
        parameters = {'server': 'http', 'uri': 'audit://proof'}
        if selected is None and executor:
            selected = executor
            executor_code = 'text(await tools.read_mcp_resource(' + json.dumps(parameters) + '));'
    if selected is None and case == 'FEATURES' and not state.get('agentId'):
        selected = next((t for t in available if t[1] == 'spawn_agent'), None)
        parameters = {'message': 'PROBE_CASE:CHILD Return SUBAGENT_DONE. This is an explicitly requested synthetic subagent test.', 'fork_context': False}
        if selected and selected[0] == 'collaboration':
            parameters = {'message': parameters['message'], 'fork_turns': 'none', 'task_name': 'privacy_child'}
    if selected is None and case == 'FEATURES' and state.get('agentId') and not state.get('subagentReturned'):
        selected = next((t for t in available if t[1] == 'wait_agent'), None)
        parameters = {'targets': [state['agentId']], 'timeout_ms': 10000}
        if selected and selected[0] == 'collaboration':
            parameters = {'timeout_ms': 10000}
    if case in ['CHILD', 'TITLE']:
        selected = None
    if selected and state['count'] < 12:
        ns, name, _ = selected
        item = {'id': 'fc_' + case + '_' + str(state['count']), 'type': 'function_call',
                'call_id': 'call_' + case + '_' + str(state['count']), 'name': name,
                'arguments': json.dumps(parameters), 'status': 'completed'}
        if ns:
            item['namespace'] = ns
        if executor_code:
            item['type'] = 'custom_tool_call'
            item['input'] = executor_code
            del item['arguments']
        state['calls'].append((ns or '') + '/' + name)
    else:
        item = {'id': 'msg_' + case, 'type': 'message', 'role': 'assistant', 'status': 'completed',
                'content': [{'type': 'output_text', 'text': '{"title":"Test standalone workflow"}' if title_request else 'SUBAGENT_DONE' if case == 'CHILD' else 'STANDALONE_DONE:' + case, 'annotations': []}]}
        state['finished'] = True
    response = {'id': 'resp_' + case + '_' + str(state['count']), 'object': 'response', 'status': 'completed',
                'output': [item], 'usage': {'input_tokens': 10, 'output_tokens': 3, 'total_tokens': 13,
                'input_tokens_details': {'cached_tokens': 0}, 'output_tokens_details': {'reasoning_tokens': 0}}}
    return [{'type': 'response.created', 'response': dict(response, status='in_progress', output=[])},
            {'type': 'response.output_item.done', 'output_index': 0, 'item': item},
            {'type': 'response.completed', 'response': response}]


class Mock(http.server.BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'
    def log_message(self, *unused):
        pass
    def reply(self, obj, status=200, mime='application/json'):
        raw = obj.encode() if isinstance(obj, str) else json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('Content-Type', mime)
        self.send_header('Content-Length', str(len(raw)))
        self.send_header('Connection', 'close')
        self.end_headers()
        try:
            self.wfile.write(raw)
        except (BrokenPipeError, ConnectionResetError, ssl.SSLEOFError):
            pass  # Native cancels optional metadata requests during shutdown.
        self.close_connection = True
    def capture(self, body):
        observe_descendants()
        row = {'path': self.path, 'headers': dict(self.headers), 'body': body}
        with state_lock:
            requests.append(row)
            with (root / 'requests.private.jsonl').open('a') as stream:
                stream.write(json.dumps(row) + '\n')
    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', '0'))) or '{}')
        self.capture(body)
        if self.path == '/mcp-fail':
            return self.reply({'error': 'Deliberately unavailable required MCP server'}, 503)
        if self.path in ['/mcp', '/ps/mcp', '/api/codex/ps/mcp']:
            if args.mcp_auth and self.headers.get('Authorization') != 'Bearer synthetic-mcp-token':
                return self.reply({'error': 'Synthetic MCP authentication required'}, 401)
            if 'id' not in body:
                return self.reply('', 202)
            result = mcp_result(body, 'http')
            if self.path.endswith('/ps/mcp') and body.get('method') == 'tools/list':
                result = {'tools': []}
            return self.reply({'jsonrpc': '2.0', 'id': body['id'], 'result': result})
        if 'responses' in self.path:
            return self.reply(''.join('event: ' + e['type'] + '\ndata: ' + json.dumps(e) + '\n\n' for e in events(body)), mime='text/event-stream')
        return self.reply({})
    def do_GET(self):
        if self.headers.get('Upgrade', '').lower() != 'websocket':
            self.capture({})
            if self.path.split('?', 1)[0] == '/api/codex/accounts/check':
                accounts = [{'id': 'synthetic-cli-' + label, 'plan_type': 'plus', 'structure': 'personal',
                             'workspace_backend_origin': 'NO_CONSTRAINT', 'account_routing_override': 'NO_CONSTRAINT'}
                            for label in ['a', 'b']]
                return self.reply({'accounts': accounts, 'account_ordering': [row['id'] for row in accounts],
                                   'default_account_id': accounts[0]['id']})
            return self.reply({'data': [], 'models': []}, 405 if self.path == '/mcp' or self.path.endswith('/ps/mcp') else 200)
        key = self.headers['Sec-WebSocket-Key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'
        self.send_response(101)
        self.send_header('Upgrade', 'websocket')
        self.send_header('Connection', 'Upgrade')
        self.send_header('Sec-WebSocket-Accept', base64.b64encode(hashlib.sha1(key.encode()).digest()).decode())
        self.end_headers()
        self.wfile.flush()
        self.connection.settimeout(50)
        try:
            while True:
                head = self.rfile.read(2)
                if len(head) < 2 or head[0] & 15 == 8:
                    break
                length = head[1] & 127
                if length == 126:
                    length = struct.unpack('!H', self.rfile.read(2))[0]
                elif length == 127:
                    length = struct.unpack('!Q', self.rfile.read(8))[0]
                mask = self.rfile.read(4) if head[1] & 128 else None
                raw = self.rfile.read(length)
                if mask:
                    raw = bytes(v ^ mask[i % 4] for i, v in enumerate(raw))
                body = json.loads(raw)
                self.capture(body)
                definitions = list(body.get('tools', []))
                for item in body.get('input', []):
                    if item.get('type') == 'additional_tools':
                        definitions.extend(item.get('tools', []))
                if definitions:
                    self.connection_tools = definitions
                elif getattr(self, 'connection_tools', None):
                    body = dict(body, tools=self.connection_tools)
                matches = re.findall(r'PROBE_CASE:([A-Za-z0-9_]+)', json.dumps(body))
                if matches:
                    self.case_hint = matches[-1]
                for event in events(body, getattr(self, 'case_hint', None)):
                    data = json.dumps(event).encode()
                    frame = b'\x81' + (bytes([len(data)]) if len(data) < 126 else b'\x7e' + struct.pack('!H', len(data))) + data
                    self.wfile.write(frame)
                    self.wfile.flush()
        except (OSError, ValueError):
            pass
        self.close_connection = True


server = http.server.ThreadingHTTPServer(('127.0.0.1', 0), Mock)
authority = None
if args.phase == 'rotation':
    # ChatGPT account/read validates workspace origins as HTTPS. Use a private
    # fixture CA, retaining the exact native validation rather than bypassing it.
    authority, authority_key = root / 'authority.pem', root / 'authority.key'
    certificate, certificate_key = root / 'loopback.pem', root / 'loopback.key'
    config, request, extensions = root / 'authority.cnf', root / 'loopback.csr', root / 'loopback.ext'
    config.write_text('[req]\ndistinguished_name=dn\nx509_extensions=ext\nprompt=no\n[dn]\nCN=Synthetic AIM fixture authority\n[ext]\nbasicConstraints=critical,CA:TRUE\n')
    extensions.write_text('basicConstraints=critical,CA:FALSE\nkeyUsage=critical,digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\nsubjectAltName=IP:127.0.0.1\n')
    commands = [
        ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-config', config, '-keyout', authority_key, '-out', authority],
        ['req', '-new', '-newkey', 'rsa:2048', '-nodes', '-subj', '/CN=127.0.0.1', '-keyout', certificate_key, '-out', request],
        ['x509', '-req', '-in', request, '-CA', authority, '-CAkey', authority_key, '-set_serial', '1', '-days', '1', '-extfile', extensions, '-out', certificate],
        ['verify', '-CAfile', authority, '-purpose', 'sslserver', certificate],
    ]
    for command in commands:
        subprocess.run(['openssl', *map(str, command)], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    tls.load_cert_chain(certificate, certificate_key)
    server.socket = tls.wrap_socket(server.socket, server_side=True)
threading.Thread(target=server.serve_forever, daemon=True).start()
endpoint = ('https' if authority else 'http') + '://127.0.0.1:' + str(server.server_port)
for label in ['A', 'B']:
    home = root / ('home-' + label)
    app = home / '.codex'
    app.mkdir(parents=True)
    (home / 'tmp').mkdir()
    (home / '.ssh').mkdir()
    (home / '.ssh/private-canary').write_text('SYNTHETIC_VENDOR_PRIVATE_FILE\n')
    config = ('model="gpt-6.1-sol"\nopenai_base_url=' + json.dumps(endpoint + '/v1') + '\n'
              'cli_auth_credentials_store="file"\napproval_policy="never"\nsandbox_mode="danger-full-access"\n'
              '[features]\nhooks=false\n[analytics]\nenabled=false\n[feedback]\nenabled=false\n'
              '[otel]\nexporter="none"\ntrace_exporter="none"\nmetrics_exporter="none"\n'
              '[projects.' + json.dumps(str(project)) + ']\ntrust_level="trusted"\n'
              '[mcp_servers.stdio]\ncommand="/usr/bin/python3"\nargs=[' + json.dumps(str(Path(__file__).resolve())) + ',"--mcp-stdio"]\nrequired=true\n'
              '[mcp_servers.http]\nurl=' + json.dumps(endpoint + '/mcp') + '\nrequired=true\n')
    if args.mcp_auth:
        config += 'bearer_token_env_var="PRIVACY_MCP_TOKEN"\n'
    if args.aim_cli:
        config = 'model_provider="fixture"\nchatgpt_base_url=' + json.dumps(endpoint) + '\n' + config + '\n[model_providers.fixture]\nname="Fixture"\nbase_url=' + json.dumps(endpoint + '/v1') + '\nwire_api="responses"\n'
    if args.phase == 'rotation':
        config += 'requires_openai_auth=true\n'
    if args.phase == 'required-failure' and label == 'A':
        config = config.replace(endpoint + '/mcp', endpoint + '/mcp-fail')
    if args.phase == 'tui-edits':
        config += '\n[skills]\nconfig=[{path="../../project/.agents/skills/privacy-proof",enabled=true}]\n'
    (app / 'config.toml').write_text(config)
    if args.phase == 'rotation':
        # The admitted release selects a complete named user-layer file.
        (app / 'yolo.config.toml').write_text(config)
    # TUI deliberately does not treat an ambient API key as completed login.
    # Install only a synthetic key in the fresh fixture's native credential file;
    # never activate a browser/device-login route to get past onboarding.
    (app / 'auth.json').write_text(json.dumps({'OPENAI_API_KEY': 'sk-synthetic-standalone-not-real'}))
    homes[label] = (home, app)
    # A live stale endpoint is a stronger no-attach check than absence of files.
    control = app / 'app-server-control/app-server-control.sock'
    control.parent.mkdir()
    protected_dir = Path('/tmp').resolve() / ('codex-daemon-' + str(os.geteuid()))
    protected_dir.mkdir(mode=0o700, exist_ok=True)
    stat = protected_dir.lstat()
    if protected_dir.is_symlink() or stat.st_uid != os.geteuid() or stat.st_mode & 0o777 != 0o700:
        raise RuntimeError('Unsafe native socket directory')
    physical = protected_dir / hashlib.sha256(os.fsencode(str(control))).hexdigest()
    listener = socket.socket(socket.AF_UNIX)
    listener.bind(str(physical))
    daemon_socket_paths.append(physical)
    control.symlink_to(physical)
    listener.listen()
    listener.settimeout(.2)
    positive = socket.socket(socket.AF_UNIX)
    positive.connect(str(control))
    accepted, _ = listener.accept()
    accepted.close()
    positive.close()
    daemon_listeners.append(listener)
    def refuse_stale(sock, account):
        while True:
            try:
                connection, _ = sock.accept()
            except socket.timeout:
                continue
            except OSError:
                return
            daemon_connections.append(account)
            # Keep the connected positive control waiting so it cannot fall
            # through to automatic daemon creation while the driver observes it.
            time.sleep(3)
            connection.close()
    threading.Thread(target=refuse_stale, args=(listener, label), daemon=True).start()


def env_for(label, terminal_extras=False):
    home, app = homes[label]
    env = {'PATH': '/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin', 'HOME': str(home), 'CODEX_HOME': str(app),
           'SHELL': '/bin/bash', 'TMPDIR': str(home / 'tmp'), 'TERM': 'xterm-256color', 'COLORTERM': 'truecolor',
           'OPENAI_API_KEY': 'sk-synthetic-standalone-not-real'}
    if args.mcp_auth:
        env['PRIVACY_MCP_TOKEN'] = 'synthetic-mcp-token'
    if authority:
        env['CODEX_CA_CERTIFICATE'] = str(authority)
    if args.shared_database:
        env['CODEX_SQLITE_HOME'] = str(root / 'shared-database')
    if terminal_extras:
        env.update(TERM_PROGRAM='AuditTerminal', TERM_PROGRAM_VERSION='PRIVATE_TERMINAL_VERSION')
    return env


def wrap(command):
    if args.aim_cli:
        assert command[0] == str(binary)
        return [node, str(Path(args.aim_root).resolve() / 'test/privacy/codex-cli-fixture.mjs'), '--', *command[1:]]
    return ['/usr/bin/sandbox-exec', '-f', args.sandbox_profile] + command if args.sandbox_profile else command


def prepare_database(label):
    # Exercise the official initialization/migration, never change SQLite by
    # hand. This is a finite setup process, not a persistent shared daemon.
    request = {'id': 1, 'method': 'initialize', 'params': {'clientInfo': {'name': 'privacy_init', 'version': '1'}}}
    child = subprocess.Popen(wrap([str(binary), 'app-server', '--listen', 'stdio://']),
        cwd=project, env=env_for(label), stdin=subprocess.PIPE, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE, text=True, start_new_session=True)
    children.append(child.pid)
    try:
        child.stdin.write(json.dumps(request) + '\n')
        child.stdin.flush()
        output = ''
        deadline = time.monotonic() + 20
        while time.monotonic() < deadline:
            if select.select([child.stdout], [], [], .2)[0]:
                line = child.stdout.readline()
                output += line
                if not line or json.loads(line).get('id') == 1:
                    break
        child.stdin.close()
        child.stdin = None
        rest, error = child.communicate(timeout=20)
        output += rest
    except subprocess.TimeoutExpired:
        os.killpg(child.pid, signal.SIGKILL)
        child.wait()
        raise RuntimeError('Finite native database preparation did not exit.')
    (root / ('prepare-' + label + '.private.json')).write_text(json.dumps({'exitCode': child.returncode, 'stdout': output, 'stderr': error}))
    if child.returncode != 0 or not any(json.loads(line).get('id') == 1 and 'result' in json.loads(line)
                                      for line in output.splitlines() if line.startswith('{')):
        raise RuntimeError('Native database preparation failed.')


def execute(case, label, tui=False, resume=None, fork=None, history_only=None, rotate=None):
    prompt = 'PROBE_CASE:' + case + ' Use $privacy-proof and both configured MCP echo tools, then do the native shell proof. For FEATURES explicitly spawn and wait for one test subagent.'
    command = [str(binary)]
    if tui:
        command += ([] if case == 'DAEMON_CONTROL' else ['--no-daemon']) + ['--no-alt-screen', '--dangerously-bypass-approvals-and-sandbox']
        if resume:
            command += ['resume', resume]
        elif fork:
            command += ['fork', fork]
        if history_only is None and not args.terminal_input and case != 'DAEMON_CONTROL':
            command += [prompt]
    else:
        command += ['exec', '--skip-git-repo-check', '--dangerously-bypass-approvals-and-sandbox', '--json', prompt]
    if rotate:
        assert tui and resume and args.aim_cli and rotate in ['resume-fresh', 'resume']
        command = [node, str(Path(args.aim_root).resolve() / 'test/privacy/codex-cli-fixture.mjs'),
                   '--aim', 'codex', rotate, resume, '--', '--no-daemon', '--no-alt-screen',
                   '--dangerously-bypass-approvals-and-sandbox']
        if not args.terminal_input:
            command.append(prompt)
    else:
        command = wrap(command)
    env = env_for(label)
    started = time.monotonic()
    request_start = len(requests)
    before_requests = sum(s['count'] for c, s in states.items() if c != 'TITLE')
    forced = False
    if not tui:
        with (root / (case + '.stdout')).open('w') as out, (root / (case + '.stderr')).open('w') as err:
            child = subprocess.Popen(command, cwd=project, env=env, stdout=out, stderr=err, start_new_session=True)
            children.append(child.pid)
            try:
                code = child.wait(timeout=90)
            except subprocess.TimeoutExpired:
                forced = True
                os.killpg(child.pid, signal.SIGKILL)
                code = child.wait()
        stdout = (root / (case + '.stdout')).read_text()
    else:
        pid, master = pty.fork()
        if pid == 0:
            os.chdir(project)
            os.execve(command[0], command, env)
        children.append(pid)
        open_ptys.append(master)
        fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 40, 120, 0, 0))
        output = bytearray()
        deadline = time.monotonic() + 65
        sent_exit = False
        sent_prompt = False
        code = None
        try:
            while time.monotonic() < deadline:
                done, status = os.waitpid(pid, os.WNOHANG)
                if done:
                    code = os.waitstatus_to_exitcode(status)
                    break
                if select.select([master], [], [], .1)[0]:
                    try:
                        data = os.read(master, 65536)
                    except OSError:
                        break
                    output.extend(data)
                    (root / (case + '.pty.private.txt')).write_bytes(output)
                    if b'\x1b[6n' in data:
                        os.write(master, b'\x1b[1;1R')
                    if b'\x1b[c' in data:
                        os.write(master, b'\x1b[?1;2c')
                if args.terminal_input and not history_only and not sent_prompt and b'GPT-6.1-Sol' in output:
                    text = prompt + '\nUnicode proof: café 🔒'
                    os.write(master, b'\x1b[200~' + text.encode() + b'\x1b[201~')
                    time.sleep(.15)
                    os.write(master, b'\r')
                    fcntl.ioctl(master, termios.TIOCSWINSZ, struct.pack('HHHH', 30, 100, 0, 0))
                    sent_prompt = True
                ready_to_exit = (('STANDALONE_DONE:' + history_only).encode() in output if history_only else
                                 states.get(case, {}).get('finished') and ('STANDALONE_DONE:' + case).encode() in output)
                if case == 'DAEMON_CONTROL' and daemon_connections and not sent_exit:
                    os.kill(pid, signal.SIGTERM)
                    sent_exit = True
                if ready_to_exit and not sent_exit:
                    time.sleep(.5)
                    if case == 'KILLED':
                        os.kill(pid, signal.SIGKILL)
                    else:
                        os.write(master, b'\x03')
                    sent_exit = True
            if code is None:
                # PTY EOF can precede waitpid readiness by a few milliseconds.
                # Reap the owner before deciding a forced group kill is needed;
                # otherwise that cleanup could hide real child survival.
                reap_by = time.monotonic() + 1
                while time.monotonic() < reap_by:
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        code = os.waitstatus_to_exitcode(status)
                        break
                    time.sleep(.02)
            if code is None:
                forced = True
                try:
                    os.killpg(pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
                stop_by = time.monotonic() + 3
                done = 0
                while time.monotonic() < stop_by:
                    done, status = os.waitpid(pid, os.WNOHANG)
                    if done:
                        break
                    time.sleep(.05)
                if not done:
                    os.killpg(pid, signal.SIGKILL)
                    _, status = os.waitpid(pid, 0)
                code = os.waitstatus_to_exitcode(status)
        finally:
            # Keep the terminal open through the owner-only lifetime check.
            # Closing it here can itself deliver SIGHUP and hide survivors.
            pass
        stdout = output.decode(errors='replace')
        (root / (case + '.pty.private.txt')).write_text(stdout)
    thread_ids = re.findall(r'"thread_id"\s*:\s*"([^"]+)"', stdout)
    if not thread_ids:
        thread_ids = re.findall(r'codex resume ([0-9a-f-]{36})', stdout)
    result = {'case': case, 'mode': 'standalone-tui' if tui else 'native-exec', 'exitCode': code,
              'requestStart': request_start, 'requestEnd': len(requests),
              'elapsedSeconds': round(time.monotonic() - started, 2), 'threadId': thread_ids[0] if thread_ids else None,
              'projectEditObserved': (project / (case + '.txt')).exists() and (project / (case + '.txt')).read_text() == 'SHELL_PROOF:' + case,
              'finalMessageReceived': 'STANDALONE_DONE:' + (history_only or case) in stdout,
              'forcedTermination': forced, 'model': states.get(case, {})}
    result['toolWorkflowPassed'] = (code == 0 and not forced and result['finalMessageReceived'] and
        result['projectEditObserved'] and all(result['model'].get(k) for k in
        ['firstRequestSkillLoaded', 'stdioReturned', 'httpReturned', 'shellReturned', 'finished']))
    if case == 'FEATURES':
        result['toolWorkflowPassed'] &= bool(result['model'].get('resourceReturned') and result['model'].get('subagentReturned'))
    if rotate:
        result['manualWarningPresent'] = 'WARNING:' in stdout and 'links the two accounts' in stdout
        if rotate == 'resume-fresh':
            fresh = re.findall(r'\[aim\] new thread ([0-9a-f-]{36}) from', stdout)
            if fresh:
                result['threadId'] = fresh[0]
    if case == 'DAEMON_CONTROL':
        result['officialClientReachedNativeSocket'] = bool(daemon_connections)
        result['toolWorkflowPassed'] = bool(daemon_connections) and not forced
    if case == 'REQUIRED_FAILURE':
        error = (root / (case + '.stderr')).read_text()
        result['failedClearlyBeforeModelTurn'] = code != 0 and not forced and not states.get(case) and 'MCP' in error
        result['toolWorkflowPassed'] = result['failedClearlyBeforeModelTurn']
    if args.terminal_input and tui and not history_only:
        result['unicodePasteReachedModel'] = any('Unicode proof: caf\\u00e9 \\ud83d\\udd12' in json.dumps(row['body']) and
            'PROBE_CASE:' + case in json.dumps(row['body']) for row in requests)
        result['resizeSubmitted'] = sent_prompt
        result['toolWorkflowPassed'] &= result['unicodePasteReachedModel'] and sent_prompt
    if history_only:
        result['noPromptReplayed'] = before_requests == sum(s['count'] for c, s in states.items() if c != 'TITLE')
        result['toolWorkflowPassed'] = code == 0 and not forced and result['finalMessageReceived'] and result['noPromptReplayed'] and result['threadId'] == resume
    if case in ['OWNER', 'KILLED']:
        heartbeat = root / (case + '.heartbeat')
        pidfile = root / (case + '.pid')
        result['backgroundCommandStarted'] = heartbeat.exists() and pidfile.exists()
        child_pid = int(pidfile.read_text()) if pidfile.exists() else None
        before = heartbeat.read_text() if heartbeat.exists() else None
        time.sleep(1)
        table = process_table()
        result['backgroundSurvivesOwner'] = child_pid in table and not table[child_pid]['state'].startswith('Z')
        result['backgroundStillWrites'] = heartbeat.exists() and heartbeat.read_text() != before
        result['ptyKeptOpenDuringOwnerObservation'] = True
        # Abrupt death is a characterization case. Record survival before cleanup;
        # do not silently label it a passing containment boundary.
        result['toolWorkflowPassed'] = (code == (-signal.SIGKILL if case == 'KILLED' else 0) and not forced and
            result['finalMessageReceived'] and result['backgroundCommandStarted'] and result['projectEditObserved'])
        result['ownedBackgroundStopped'] = result['backgroundCommandStarted'] and not result['backgroundSurvivesOwner'] and not result['backgroundStillWrites']
        if args.aim_cli:
            result['liveVendorOwnersBeforePtyClose'] = observe_vendor_confinement()
            result['allObservedVendorOwnersApprovedAndConfined'] = True
    if tui:
        os.close(master)
        open_ptys.remove(master)
    print(json.dumps(result), flush=True)
    return result


def scheduled_routine():
    if not args.aim_root:
        raise RuntimeError('--aim-root is required for the actual AIM native-turn adapter test.')
    module = Path(args.aim_root).resolve() / 'src/routines/codex.js'
    if not module.is_file():
        raise RuntimeError('Actual AIM routine adapter is missing.')
    job = root / 'routine-job.mjs'
    receipt = root / 'routine-receipt.private.json'
    # The OS scheduler must cross the same candidate boundary as the TUI.
    # Wrapping only the handoff would falsely certify an unrestricted job.
    command = wrap([str(binary), 'exec', '--json', '--color', 'never', '--skip-git-repo-check',
                    '--dangerously-bypass-approvals-and-sandbox', '-'])
    # This deliberately uses the real AIM parser/process lifecycle. API-key
    # auth is synthetic; it does not certify ChatGPT rotation/Redis scheduling.
    job.write_text('import fs from "node:fs";\nimport {startCodexRoutineTurn} from ' + json.dumps(module.as_uri()) + ';\n' +
        'fs.writeFileSync(' + json.dumps(str(root/'scheduled-owner.pid')) + ', String(process.pid));\n' +
        'const turn = startCodexRoutineTurn(' + json.dumps({
            'command': command[0], 'args': command[1:],
            'cwd': str(project), 'env': env_for('A'),
            'prompt': 'PROBE_CASE:SCHEDULE Use $privacy-proof and the configured MCP servers.',
            'eventsPath': str(root / 'routine.events.private.jsonl'), 'timeoutMs': 45000
        })[:-1] + ', stdout: process.stdout, stderr: process.stderr});\n' +
        'const result = await turn.result; fs.writeFileSync(' + json.dumps(str(receipt)) +
        ', JSON.stringify({...result, error: result.error?.message ?? null})); process.exitCode=result.error ? 1 : 0;\n')
    (root / 'schedule-ready.private.json').write_text(json.dumps({'pid': os.getpid(), 'job': str(job), 'root': str(root)}))
    # A launchd calendar timer can wait nearly a minute before the native
    # adapter's 45-second turn starts. Leave margin for both stages.
    deadline = time.monotonic() + 180
    registered = False
    while not receipt.exists() and time.monotonic() < deadline:
        owner = root/'scheduled-owner.pid'
        if owner.exists() and not registered:
            children.append(int(owner.read_text()))
            registered = True
        time.sleep(.2)
    if not receipt.exists():
        raise RuntimeError('OS scheduled job did not write its native AIM receipt.')
    native = json.loads(receipt.read_text())
    result = {'case': 'SCHEDULE', 'mode': 'OS scheduler + real AIM native-turn adapter',
              'threadId': native.get('sessionId'), 'error': native.get('error'), 'model': states.get('SCHEDULE', {})}
    result['toolWorkflowPassed'] = bool(native.get('sessionId')) and native.get('error') is None and all(
        result['model'].get(k) for k in ['firstRequestSkillLoaded', 'stdioReturned', 'httpReturned', 'shellReturned', 'finished'])
    results.append(result)
    results.append(execute('HANDOFF', 'A', tui=True, resume=native['sessionId'], history_only='SCHEDULE'))


results = []
try:
    if args.aim_cli:
        for label in homes:
            prepared = subprocess.run([node, str(Path(args.aim_root).resolve() / 'test/privacy/codex-cli-fixture.mjs'),
                '--prepare', label, *(['--pool'] if args.phase == 'rotation' and label == 'A' else [])],
                env=env_for(label), cwd=project, capture_output=True, text=True, check=True)
            aim_prepared[label] = json.loads(prepared.stdout)
    if args.prepare_database:
        for label in homes:
            prepare_database(label)
    if args.phase in ['all', 'exec']:
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(execute, case, label) for case, label in [('A1', 'A'), ('A2', 'A'), ('B1', 'B')]]
            results.extend(f.result() for f in futures)
    if args.phase == 'concurrent-tui':
        with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
            futures = [pool.submit(execute, case, label, True) for case, label in [('A1', 'A'), ('A2', 'A'), ('B1', 'B')]]
            results.extend(f.result() for f in futures)
    if args.phase in ['all', 'tui']:
        results.append(execute('TUI', 'A', tui=True))
    if args.phase == 'tui-edits':
        parser_module = (Path(args.aim_root).resolve() / 'src/io/codex-settings-toml.js').as_uri()
        for count, case in enumerate(['TUI_ONE', 'TUI_TWO'], 1):
            result = execute(case, 'A', tui=True)
            results.append(result)
            source = homes['A'][1] / 'config.toml'
            view = Path(aim_prepared['A']['codexHome']) / 'config.toml'
            values = []
            for file in [source, view]:
                parsed = subprocess.run([node, '--input-type=module', '-e',
                    'import fs from "node:fs"; import {parseCodexSettings} from ' + json.dumps(parser_module) + ';'
                    'console.log(JSON.stringify(parseCodexSettings(fs.readFileSync(process.argv[1],"utf8")).value));',
                    str(file)], capture_output=True, text=True, check=True)
                value = json.loads(parsed.stdout)
                values.append(value)
                text = file.read_text()
                if not re.search(r'^\[(?:tui|"tui")\]$', text, re.MULTILINE):
                    raise RuntimeError('Native-created settings did not retain their editable block table.')
                if (value['tui']['model_availability_nux']['gpt-6.1-sol'] != count or
                        value['tui']['screen_reader_detection_done'] is not True or value['features']['hooks'] is not False):
                    raise RuntimeError('Consecutive native settings saves did not preserve their values.')
            if (values[0]['skills']['config'][0]['path'] != '../../project/.agents/skills/privacy-proof' or
                    values[1]['skills']['config'][0]['path'] != str(skill.parent) or
                    not all(value['skills']['config'][0]['enabled'] for value in values)):
                raise RuntimeError('Consecutive native saves changed the authored relative skill path.')
            result['nativeTableWriteCount'] = count
            result['sourceAndViewValidBlockTables'] = True
            result['relativeSkillPathPreserved'] = True
    if args.phase in ['all', 'features']:
        results.append(execute('FEATURES', 'A'))
    if args.phase in ['all', 'continuity']:
        seed = execute('SEED', 'A')
        results.append(seed)
        if not seed['toolWorkflowPassed'] or not seed['threadId']:
            raise RuntimeError('Cannot test continuity without a successful seed.')
        results.append(execute('HISTORY', 'A', tui=True, resume=seed['threadId'], history_only='SEED'))
        results.append(execute('RESUMED', 'A', tui=True, resume=seed['threadId']))
        results.append(execute('FORKED', 'A', tui=True, fork=seed['threadId']))
        results[-2]['sameThreadPreserved'] = results[-2]['threadId'] == seed['threadId']
        results[-1]['forkHasNewThread'] = bool(results[-1]['threadId']) and results[-1]['threadId'] != seed['threadId']
        results[-1]['forkRestoredHistory'] = results[-1]['model'].get('priorSeedResponsePresent', False)
        results[-2]['toolWorkflowPassed'] &= results[-2]['sameThreadPreserved']
        results[-1]['toolWorkflowPassed'] &= results[-1]['forkHasNewThread'] and results[-1]['forkRestoredHistory']
    if args.phase == 'rotation':
        seed = execute('SEED', 'A')
        results.append(seed)
        if not seed['toolWorkflowPassed'] or not seed['threadId']:
            raise RuntimeError('Cannot test rotation without a successful seed.')
        fresh = execute('FRESH', 'A', tui=True, resume=seed['threadId'], rotate='resume-fresh')
        results.append(fresh)
        if not fresh['toolWorkflowPassed'] or not fresh['threadId']:
            raise RuntimeError('Cannot test manual rotation without a successful fresh continuation.')
        manual = execute('MANUAL', 'A', tui=True, resume=fresh['threadId'], rotate='resume')
        results.append(manual)
        for row, expected_label, fresh_identity in [(seed, 'a', False), (fresh, 'b', True), (manual, 'a', False)]:
            captured = [request for request in requests[row['requestStart']:row['requestEnd']] if 'responses' in request['path']]
            account = aim_prepared['A']['accounts'][expected_label]
            if not captured:
                raise RuntimeError('Missing captured continuation requests.')
            for request in captured:
                headers = {key.lower(): value for key, value in request['headers'].items()}
                if headers.get('chatgpt-account-id') != account['accountId']:
                    raise RuntimeError('Continuation used the wrong underlying account.')
                claims = json.loads(base64.urlsafe_b64decode(headers['authorization'].split('.')[1] + '==='))
                if claims['https://api.openai.com/auth']['chatgpt_account_id'] != account['accountId']:
                    raise RuntimeError('Continuation used the wrong local bearer.')
                metadata = request['body'].get('client_metadata', {})
                if metadata.get('x-codex-installation-id') != account['installationId']:
                    raise RuntimeError('Continuation used the wrong installation identity.')
                wire = json.dumps({'headers': headers, 'metadata': metadata})
                if fresh_identity and seed['threadId'] in wire:
                    raise RuntimeError('Rotated continuation sent the source thread identity.')
                # Native title generation is its own short child thread. It
                # still must use the selected account/install identity and no
                # retired source ID, but cannot carry the foreground thread ID.
                title = request['body'].get('text', {}).get('format', {}).get('name') == 'codex_output_schema'
                thread = metadata.get('thread_id')
                if (not re.fullmatch(r'[0-9a-f-]{36}', thread or '') or metadata.get('session_id') != thread or
                        headers.get('thread-id') != thread or headers.get('session-id') != thread or
                        not title and thread != row['threadId']):
                    raise RuntimeError('Captured request lacks consistent selected thread/session identities.')
            row['capturedAccountAndIdentityPassed'] = True
        fresh['newThreadWithHistory'] = bool(fresh['threadId'] and fresh['threadId'] != seed['threadId'] and fresh['model'].get('priorSeedResponsePresent'))
        manual['originalThreadWithWarning'] = manual['threadId'] == fresh['threadId'] and manual['manualWarningPresent']
        fresh['toolWorkflowPassed'] &= fresh['newThreadWithHistory']
        manual['toolWorkflowPassed'] &= manual['originalThreadWithWarning']
    if args.phase in ['all', 'lifetime']:
        results.append(execute('OWNER', 'A', tui=True))
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            sibling = pool.submit(execute, 'SIBLING', 'A')
            try:
                if not sibling_ready.wait(timeout=45):
                    raise RuntimeError('Healthy sibling did not reach its model barrier.')
                killed = execute('KILLED', 'B', tui=True)
                results.append(killed)
            finally:
                sibling_release.set()
            continued = sibling.result()
            continued['continuedAfterSiblingOwnerDeath'] = continued['toolWorkflowPassed']
            results.append(continued)
    if args.phase == 'routine':
        scheduled_routine()
    if args.phase == 'required-failure':
        with concurrent.futures.ThreadPoolExecutor(max_workers=1) as pool:
            sibling = pool.submit(execute, 'SIBLING', 'B')
            try:
                if not sibling_ready.wait(timeout=45):
                    raise RuntimeError('Healthy sibling did not reach its model barrier.')
                failed = execute('REQUIRED_FAILURE', 'A')
                failed['liveVendorOwnersAfterFailedIntegration'] = observe_vendor_confinement()
                results.append(failed)
            finally:
                sibling_release.set()
            continued = sibling.result()
            continued['continuedAfterSiblingIntegrationFailure'] = continued['toolWorkflowPassed']
            results.append(continued)
    if args.phase == 'daemon':
        positive = execute('DAEMON_CONTROL', 'A', tui=True)
        results.append(positive)
        daemon_connections.clear()
        if not positive['toolWorkflowPassed']:
            raise RuntimeError('Actual Codex did not validate the native socket control.')
        results.append(execute('NO_DAEMON', 'A', tui=True))
    observe_descendants()
    live_table = process_table()
    survivors = {pid: live_table[pid] for pid in observed_descendants if pid in live_table and not live_table[pid]['state'].startswith('Z')}
    (root / 'survivors-before-cleanup.private.json').write_text(json.dumps(survivors, indent=2))
    ids = ({label: prepared['installationId'] for label, prepared in aim_prepared.items()} if args.aim_cli else
           {label: hashlib.sha256((app / 'installation_id').read_bytes()).hexdigest() for label, (_, app) in homes.items() if (app / 'installation_id').exists()})
    summary = {'kind': 'actual AIM CLI with synthetic Redis transport and loopback model/MCP services' if args.aim_cli else 'synthetic standalone compatibility; not production privacy acceptance',
               'platform': platform.system(), 'codexSha256': digest, 'codeModeHostSha256': helper_digest, 'results': results,
               'harnessSha256': harness_digest,
               'databasePreparedByFiniteNativeProcess': args.prepare_database,
               'separateHomesShareDatabase': args.shared_database,
               'httpMcpRequiresSyntheticBearerToken': args.mcp_auth,
               'sandboxProfileSha256': hashlib.sha256(Path(args.sandbox_profile).read_bytes()).hexdigest() if args.sandbox_profile else None,
               'concurrentBarrierPassed': all(states.get(c, {}).get('count', 0) > 0 and not states[c].get('barrierFailed')
                                              for c in ['A1', 'A2', 'B1']) if args.phase in ['all', 'exec', 'concurrent-tui'] else None,
               'separateHomesHaveDifferentInstallationIds': ids['A'] != ids['B'] if len(ids) == 2 else None,
               'daemonDirectoryAbsentOnly': all(not (app / 'app-server-daemon').exists() for _, app in homes.values()),
               'staleDaemonSocketConnections': len(daemon_connections),
               'observedProcessesStillAliveBeforeCleanup': len(survivors),
               'noRealAccounts': True, 'outboundBoundary': 'loopback namespace' if platform.system() == 'Linux' else 'external rental deny policy'}
    (root / 'summary.private.json').write_text(json.dumps(summary, indent=2) + '\n')
    print(json.dumps({'summaryWritten': True, 'concurrentBarrierPassed': summary['concurrentBarrierPassed']}), flush=True)
    if (not all(r['toolWorkflowPassed'] for r in results) or daemon_connections or
            summary['concurrentBarrierPassed'] is False or summary['separateHomesHaveDifferentInstallationIds'] is False):
        raise SystemExit('At least one workflow assertion failed; see private summary.')
finally:
    server.shutdown()
    for fd in open_ptys:
        os.close(fd)
    for listener in daemon_listeners:
        listener.close()
    for path in daemon_socket_paths:
        path.unlink(missing_ok=True)
    for pid in children:
        try:
            os.killpg(pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    # Detached native children can leave their owner's process group. Test only
    # the recorded process identities; never signal unrelated VM processes.
    for pid, row in observed_descendants.items():
        current = process_table().get(pid)
        if current and current['command'] == row['command']:
            try:
                os.kill(pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
