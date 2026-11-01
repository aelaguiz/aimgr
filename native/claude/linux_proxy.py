#!/usr/bin/env python3
"""Linux native-Claude TCP routing. Chrome is deliberately not attached here.

install reads a non-secret profile manifest on stdin; run inherits the caller's
environment, working directory and file descriptors. SSH and sing-box remain
outside Claude's cgroup. nftables redirects native TCP even without proxy env.
"""
import json
import ctypes
import os
import pathlib
import pwd
import re
import select
import signal
import subprocess
import sys
import shutil
import fcntl
import time
import http.client
import urllib.parse
from contextlib import contextmanager

ROOT = pathlib.Path("/opt/aimgr-claude-proxy")
CGROUP = pathlib.Path("/sys/fs/cgroup/aimgr-claude")


@contextmanager
def installation_lock(exclusive=False):
    lock_path = ROOT / "install.lock"
    if exclusive:
        ROOT.mkdir(mode=0o755, exist_ok=True)
    # The shell installer holds descriptor 9 across binary installation too.
    inherited = pathlib.Path("/proc/self/fd/9")
    if exclusive and inherited.exists() and inherited.resolve() == lock_path:
        yield
        return
    with lock_path.open("a" if exclusive else "r") as lock:
        if exclusive:
            os.chmod(lock_path, 0o644)
        fcntl.flock(lock, (fcntl.LOCK_EX | fcntl.LOCK_NB) if exclusive else fcntl.LOCK_SH)
        yield


def stop_profile(name):
    validate_name(name)
    target = CGROUP / name / "cgroup.kill"
    if target.exists():
        command(["sudo", "-n", "tee", str(target)], input="1", text=True, stdout=subprocess.DEVNULL)


def probe(name):
    """Check the complete native path: cgroup -> redirect -> adapter -> SOCKS."""
    validate_name(name)
    profile = json.loads((ROOT / f"{name}.json").read_text())
    command(["sudo", "-n", "tee", str(CGROUP / name / "cgroup.procs")],
            input=str(os.getpid()), text=True, stdout=subprocess.DEVNULL)
    url = urllib.parse.urlsplit(profile.get("exitCheckUrl", "https://api.ipify.org?format=json"))
    if url.scheme not in ("http", "https") or not url.hostname or url.username:
        raise ValueError("invalid exit check URL")
    connection_type = http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection
    # Keep an ordinary slow exit lookup within the adapter's eight-second
    # overall deadline, allowing time for DNS and TLS setup.
    connection = connection_type(url.hostname, url.port, timeout=6)
    try:
        connection.request("GET", urllib.parse.urlunsplit(("", "", url.path or "/", url.query, "")), headers={"Connection": "close"})
        response = connection.getresponse()
        body = response.read(1024)
        if response.status != 200 or json.loads(body).get("ip") not in profile["expectedExits"]:
            raise ConnectionError("proxy exit mismatch")
    finally:
        connection.close()


def serve(name):
    validate_name(name)
    child = subprocess.Popen(["/usr/local/bin/sing-box", "run", "-c", str(ROOT / f"{name}-sing-box.json")])
    try:
        while True:
            try:
                child.wait(timeout=5)
                raise RuntimeError("native proxy adapter exited")
            except subprocess.TimeoutExpired:
                pass
            if "populated 1" in (CGROUP / name / "cgroup.events").read_text():
                # A short-lived probe joins the same route as Claude; checking
                # SSH alone would miss a live but stalled forwarding adapter.
                command([sys.executable, str(ROOT / "linux_proxy.py"), "probe", name], timeout=8)
    finally:
        child.terminate()
        try:
            child.wait(timeout=2)
        except subprocess.TimeoutExpired:
            child.kill()
            child.wait()


def command(args, **kwargs):
    return subprocess.run(args, check=True, **kwargs)


def validate_name(name):
    if not re.fullmatch(r"[a-z0-9][a-z0-9_-]*", name) or name in ("direct", "default"):
        raise ValueError("invalid proxy profile")
    return name


def apply_routes(manifest):
    user = pwd.getpwnam(manifest["user"])
    profiles = manifest["profiles"]
    rules = ["table inet aimgr_claude {", "chain output { type nat hook output priority dstnat; policy accept;"]
    blocked_routes = []
    CGROUP.mkdir(exist_ok=True)
    for name, profile in profiles.items():
        group = CGROUP / name
        group.mkdir(exist_ok=True)
        os.chown(group / "cgroup.procs", user.pw_uid, user.pw_gid)
        match = f'socket cgroupv2 level 2 "aimgr-claude/{name}"'
        other_ports = sorted({p[k] for other, p in profiles.items() if other != name for k in ("socksPort", "redirectPort")})
        if other_ports:
            ports = ", ".join(str(port) for port in other_ports)
            blocked_routes += [
                f'{match} ip daddr 127.0.0.0/8 tcp dport {{ {ports} }} reject',
                f'{match} ip6 daddr ::1 tcp dport {{ {ports} }} reject',
            ]
        rules += [
            f'{match} ip daddr != 127.0.0.0/8 meta l4proto tcp redirect to :{profile["redirectPort"]} comment "{name}"',
            f'{match} ip6 daddr != ::1 meta l4proto tcp redirect to :{profile["redirectPort"]} comment "{name}"',
        ]
    rules += ["}", "chain route_binding { type filter hook output priority filter; policy accept;", *blocked_routes, "}", "}"]
    exists = subprocess.run(["nft", "list", "table", "inet", "aimgr_claude"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL).returncode == 0
    batch = ("delete table inet aimgr_claude\n" if exists else "") + "\n".join(rules) + "\n"
    command(["nft", "-f", "-"], input=batch, text=True)


def require_stopped():
    if CGROUP.exists() and any(path.read_text().strip() for path in CGROUP.glob("*/cgroup.procs")):
        raise RuntimeError("stop native Claude sessions before changing routes")


def install():
    if os.geteuid() != 0:
        raise RuntimeError("install requires root")
    manifest = json.load(sys.stdin)
    user = pwd.getpwnam(manifest["user"])
    profiles = manifest["profiles"]
    require_stopped()
    manifest_path = ROOT / "manifest.json"
    if manifest_path.exists():
        previous = json.loads(manifest_path.read_text())
        if previous["user"] != manifest["user"]:
            raise ValueError("existing native routes belong to another user")
        manifest["profiles"] = {**previous["profiles"], **profiles}
    profiles = manifest["profiles"]
    ports = set()
    for name, profile in manifest["profiles"].items():
        validate_name(name)
        if profile.get("socksHost", "127.0.0.1") not in ("127.0.0.1", "::1"):
            raise ValueError("SOCKS listener must be loopback")
        if not profile.get("expectedExits"):
            raise ValueError("approved exit IP addresses are required")
        for key in ("socksPort", "redirectPort"):
            port = profile[key]
            if type(port) is not int or not 1 <= port <= 65535 or port in ports:
                raise ValueError("ports must be valid and distinct across profiles")
            ports.add(port)
    # No admitted session can overlap this installation. Stop old listeners
    # before replacing config so admission also stays closed during activation.
    for name in profiles:
        unit = f"aimgr-claude-proxy-{name}.service"
        if pathlib.Path(f"/etc/systemd/system/{unit}").exists():
            command(["systemctl", "stop", unit])
    ROOT.mkdir(mode=0o755, exist_ok=True)
    for name, profile in profiles.items():
        binding = {"socksHost": "127.0.0.1", **profile}
        (ROOT / f"{name}.json").write_text(json.dumps(binding))
        router = {
            "log": {"level": "error"},
            "inbounds": [{"type": "redirect", "tag": "native", "listen": "::", "listen_port": profile["redirectPort"]}],
            "outbounds": [{"type": "socks", "tag": "office", "server": binding["socksHost"], "server_port": profile["socksPort"], "version": "5"}],
            "route": {"final": "office"},
        }
        router_path = ROOT / f"{name}-sing-box.json"
        router_path.write_text(json.dumps(router))
        command(["/usr/local/bin/sing-box", "check", "-c", str(router_path)])
        service = f"""[Unit]
Description=Native Claude SOCKS adapter for {name}
Requires=aimgr-claude-routing.service
After=network.target aimgr-claude-routing.service
[Service]
User={user.pw_name}
ExecStart=/usr/bin/python3 {ROOT / "linux_proxy.py"} serve {name}
ExecStopPost=/usr/bin/python3 {ROOT / "linux_proxy.py"} stop {name}
Restart=no
[Install]
WantedBy=multi-user.target
"""
        pathlib.Path(f"/etc/systemd/system/aimgr-claude-proxy-{name}.service").write_text(service)
    # The manifest includes previously installed profiles omitted by this update.
    manifest_path.write_text(json.dumps(manifest))
    installed_helper = ROOT / "linux_proxy.py"
    if pathlib.Path(__file__).resolve() != installed_helper:
        shutil.copyfile(__file__, installed_helper)
    pathlib.Path("/etc/systemd/system/aimgr-claude-routing.service").write_text(f"""[Unit]
Description=Restore native Claude routes before its adapters start
Before=network.target
[Service]
Type=oneshot
ExecStart=/usr/bin/python3 {installed_helper} restore
RemainAfterExit=yes
[Install]
WantedBy=multi-user.target
""")
    # One-time installation grants only the privileged operations needed by
    # the ordinary user launcher. Daily sessions never ask for sudo input.
    tee = shutil.which("tee")
    nft = shutil.which("nft")
    permissions = [f"{nft} list table inet aimgr_claude"]
    for name in manifest["profiles"]:
        permissions += [f"{tee} {CGROUP / name / entry}" for entry in ("cgroup.procs", "cgroup.kill")]
    sudoers = ROOT / "sudoers"
    sudoers.write_text(f"{user.pw_name} ALL=(root) NOPASSWD: " + ", ".join(permissions) + "\n")
    command(["visudo", "-cf", str(sudoers)], stdout=subprocess.DEVNULL)
    shutil.copyfile(sudoers, "/etc/sudoers.d/aimgr-claude-proxy")
    os.chmod("/etc/sudoers.d/aimgr-claude-proxy", 0o440)
    apply_routes(manifest)
    command(["systemctl", "daemon-reload"])
    command(["systemctl", "enable", "aimgr-claude-routing.service"])
    for name in profiles:
        command(["systemctl", "enable", f"aimgr-claude-proxy-{name}.service"])


def activate():
    # Configuration/rules are complete and old listeners are stopped. Release
    # the installer lock before systemd starts restore in a separate process.
    manifest = json.loads((ROOT / "manifest.json").read_text())
    units = [f"aimgr-claude-proxy-{name}.service" for name in manifest["profiles"]]
    try:
        command(["systemctl", "start", "aimgr-claude-routing.service"])
        command(["systemctl", "start", *units])
        for profile in manifest["profiles"].values():
            deadline = time.monotonic() + 8
            while True:
                try:
                    listener_pid(profile["redirectPort"])
                    break
                except (subprocess.CalledProcessError, RuntimeError):
                    if time.monotonic() >= deadline:
                        raise RuntimeError("native proxy adapter did not become ready")
                    time.sleep(0.1)
    except Exception:
        subprocess.run(["systemctl", "stop", *units], check=False)
        raise


def listener_pid(port):
    result = command(["lsof", "-nP", "-t", f"-iTCP:{port}", "-sTCP:LISTEN"], capture_output=True, text=True)
    pids = set(result.stdout.split())
    if len(pids) != 1:
        raise RuntimeError("proxy listener is unavailable or ambiguous")
    return int(pids.pop())


def run(name, expected_binding, argv):
    validate_name(name)
    profile = json.loads((ROOT / f"{name}.json").read_text())
    expected = json.loads(expected_binding)
    # Admission holds the installation lock. The JS preflight may have run
    # before an update, so compare the operation's binding here as well.
    if any(profile.get(key, "127.0.0.1" if key == "socksHost" else None) != expected.get(key)
           for key in ("socksHost", "socksPort")) or sorted(profile["expectedExits"]) != sorted(expected["expectedExits"]):
        raise RuntimeError("native proxy binding changed before launch")
    group = CGROUP / name
    # Inspect only our installed table. Never infer protection from proxy env.
    rules = command(["sudo", "-n", "nft", "list", "table", "inet", "aimgr_claude"], capture_output=True, text=True).stdout
    if f'"aimgr-claude/{name}"' not in rules or f'redirect to :{profile["redirectPort"]}' not in rules:
        raise RuntimeError("native proxy routing is not installed")
    watched = [os.pidfd_open(listener_pid(profile[key])) for key in ("socksPort", "redirectPort")]
    poll = select.poll()
    for fd in watched:
        poll.register(fd, select.POLLIN)
    owner_pid = os.getpid()
    child = os.fork()
    if child == 0:
        try:
            if ctypes.CDLL(None, use_errno=True).prctl(1, signal.SIGTERM, 0, 0, 0) != 0:
                raise RuntimeError("could not bind native process lifetime")
            if os.getppid() != owner_pid:
                os._exit(125)
            command(["sudo", "-n", "tee", str(group / "cgroup.procs")],
                    input=str(os.getpid()), text=True, stdout=subprocess.DEVNULL)
            os.execvpe(argv[0], argv, os.environ)
        except Exception:
            os.write(2, b"Claude native proxy launch failed.\n")
            os._exit(125)
    child_fd = os.pidfd_open(child)
    poll.register(child_fd, select.POLLIN)
    def forward(signum, _frame):
        try:
            os.kill(child, signum)
        except ProcessLookupError:
            pass
    for signum in (signal.SIGTERM, signal.SIGINT, signal.SIGHUP, signal.SIGWINCH):
        signal.signal(signum, forward)
    failed = False
    while True:
        events = poll.poll()
        if any(fd in watched for fd, _event in events):
            failed = True
            os.write(2, f"Claude stopped: {name} tunnel or proxy exited. Repair it, then explicitly resume.\n".encode())
            # An outage drops every session using this route, including tool
            # descendants. Do not leave a graceful-shutdown retry window.
            command(["sudo", "-n", "tee", str(group / "cgroup.kill")],
                    input="1", text=True, stdout=subprocess.DEVNULL)
            break
        if any(fd == child_fd for fd, _event in events):
            break
    _pid, status = os.waitpid(child, 0)
    for fd in [*watched, child_fd]:
        os.close(fd)
    if failed:
        return 125
    code = os.waitstatus_to_exitcode(status)
    return code if code >= 0 else 128 - code


if __name__ == "__main__":
    try:
        if sys.argv[1] == "install":
            with installation_lock(exclusive=True):
                install()
        elif sys.argv[1] == "check-stopped":
            with installation_lock(exclusive=True):
                require_stopped()
        elif sys.argv[1] == "restore":
            with installation_lock(exclusive=True):
                require_stopped()
                apply_routes(json.loads((ROOT / "manifest.json").read_text()))
        elif sys.argv[1] == "activate":
            activate()
        elif sys.argv[1] == "probe":
            probe(sys.argv[2])
        elif sys.argv[1] == "serve":
            serve(sys.argv[2])
        elif sys.argv[1] == "stop":
            stop_profile(sys.argv[2])
        elif sys.argv[1] == "run" and len(sys.argv) >= 6 and sys.argv[4] == "--":
            with installation_lock():
                sys.exit(run(sys.argv[2], sys.argv[3], sys.argv[5:]))
        else:
            raise ValueError("usage: linux_proxy.py install | run PROFILE BINDING_JSON -- COMMAND [ARGS...]")
    except Exception as error:
        detail = str(error) if isinstance(error, RuntimeError) else type(error).__name__
        print(f"Claude proxy unavailable during {sys.argv[1]}: {detail}.", file=sys.stderr)
        sys.exit(125)
