"""Exercise the real nft guard with synthetic listeners in a private netns."""
from concurrent.futures import ThreadPoolExecutor
from contextlib import ExitStack
import errno
import importlib.util
import json
import os
from pathlib import Path
import select
import socket
import subprocess
import sys
import tempfile


HELPER = Path(__file__).resolve().parents[2] / "native/claude/linux_proxy.py"
spec = importlib.util.spec_from_file_location("linux_proxy", HELPER)
route = importlib.util.module_from_spec(spec)
spec.loader.exec_module(route)
TABLE = ["table", "inet", "aimgr_claude"]


def command(args, **kwargs):
    return subprocess.run(args, check=True, timeout=10, text=True, **kwargs)


def listener(host, sock_type, port=0):
    endpoint = socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, sock_type)
    endpoint.bind((host, port))
    endpoint.settimeout(6)
    if sock_type == socket.SOCK_STREAM:
        endpoint.listen()
    return endpoint


def attempt(endpoints, *, routed):
    for host, port in endpoints["tcp"]:
        try:
            with socket.create_connection((host, port), timeout=0.5):
                pass
        except OSError:
            if not routed:
                raise
        else:
            if routed:
                raise AssertionError(f"Restricted client connected to TCP {(host, port)}")
    for host, port in endpoints["udp"]:
        with socket.socket(socket.AF_INET6 if ":" in host else socket.AF_INET, socket.SOCK_DGRAM) as sock:
            try:
                sock.sendto(b"fixture", (host, port))
            except OSError as error:
                if not routed or error.errno not in (errno.EPERM, errno.EACCES):
                    raise


def serve_socks(server):
    with server.accept()[0] as client, client.makefile("rwb") as stream:
        client.settimeout(6)
        version, count = stream.read(2)
        assert version == 5 and 0 in stream.read(count)
        stream.write(b"\x05\x00")
        stream.flush()
        assert stream.read(4) == b"\x05\x01\x00\x03", "Expected a remote hostname in the SOCKS CONNECT"
        assert stream.read(stream.read(1)[0]) == b"route-fixture.invalid"
        assert int.from_bytes(stream.read(2), "big") == 80
        stream.write(b"\x05\x00\x00\x01\x00\x00\x00\x00\x00\x00")
        stream.flush()
        assert stream.readline() == b"GET /exit HTTP/1.1\r\n"
        for line in stream:
            if line == b"\r\n":
                break
        stream.write(b'HTTP/1.1 200 OK\r\nContent-Length: 18\r\nConnection: close\r\n\r\n{"ip":"192.0.2.3"}')
        stream.flush()


def check():
    assert os.getuid() == 0, "Run the nft fixture as root"
    assert os.readlink("/proc/self/ns/net") != os.readlink("/proc/1/ns/net")
    assert {name for _, name in socket.if_nameindex()} == {"lo"}
    command(["ip", "link", "set", "lo", "up"])
    command(["ip", "address", "add", "198.18.0.10/32", "dev", "lo"])
    name = f"agyfixture-{os.getpid()}"
    group = route.CGROUP / name
    created_parent = not group.parent.exists()
    group.parent.mkdir(exist_ok=True)
    group.mkdir()
    try:
        with ExitStack() as resources:
            temporary = Path(resources.enter_context(tempfile.TemporaryDirectory()))
            socks = resources.enter_context(listener("127.0.0.1", socket.SOCK_STREAM))
            tcp = [resources.enter_context(listener(host, socket.SOCK_STREAM, port))
                   for host, port in [("127.0.0.1", 53), ("::1", 0), ("198.18.0.10", 0)]]
            udp = [resources.enter_context(listener(host, socket.SOCK_DGRAM, 53))
                   for host in ["127.0.0.1", "::1"]]
            endpoints = {"tcp": [sock.getsockname()[:2] for sock in tcp],
                         "udp": [sock.getsockname()[:2] for sock in udp]}
            profile = {"socksPort": socks.getsockname()[1], "denyDatagrams": True,
                       "expectedExits": ["192.0.2.3"], "exitCheckUrl": "http://route-fixture.invalid/exit"}
            (temporary / f"{name}.json").write_text(json.dumps(profile))
            chain = route.strict_route_chain(name, profile)
            batch = "\n".join([" ".join(TABLE) + " {", *chain, "}\n"])
            command(["nft", "-f", "-"], input=batch)
            rules = command(["nft", "list", *TABLE], capture_output=True).stdout
            route.require_route_rules(name, profile, rules)
            try:
                route.require_route_rules(name, profile, rules.replace(chain[-2], chain[-2].replace("reject", "accept")))
            except RuntimeError:
                pass
            else:
                raise AssertionError("Admission accepted an ineffective guard")

            attempt(endpoints, routed=False)
            for sock in udp:
                assert sock.recv(64) == b"fixture"
            command([sys.executable, "-B", __file__, "blocked", name, json.dumps(endpoints)])
            assert not select.select(udp, [], [], 0.2)[0], "Restricted client reached a UDP listener"

            with ThreadPoolExecutor(1) as pool:
                reply = pool.submit(serve_socks, socks)
                command([sys.executable, "-B", __file__, "probe", name, str(temporary)])
                reply.result()
    finally:
        subprocess.run(["nft", "delete", *TABLE], check=False, capture_output=True)
        group.rmdir()
        if created_parent:
            group.parent.rmdir()


if len(sys.argv) == 1:
    check()
else:
    action, profile_name, value = sys.argv[1:]
    if action == "probe":
        route.ROOT = Path(value)
        route.probe(profile_name)
    elif action == "blocked":
        (route.CGROUP / profile_name / "cgroup.procs").write_text(str(os.getpid()))
        attempt(json.loads(value), routed=True)
